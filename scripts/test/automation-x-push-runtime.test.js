'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const U = '222222222222222222';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('global startup policy stays batch-only while owner realtime cannot be granted by an environment value or plan name', () => {
    const { resolveXProcessingPolicy } = require('../../src/automation/x-processing-policy');
    assert.equal(resolveXProcessingPolicy(undefined), 'batch');
    assert.equal(resolveXProcessingPolicy('batch'), 'batch');
    for (const value of [null, '', 'per-event', 'realtime', 'Basic+', 'BATCH', true, { planId: 'Basic+', realtime: true }])
        assert.equal(resolveXProcessingPolicy(value), null);
});

function runtimeModule(t, plan) {
    const entitlements = require('../../src/automation/entitlements');
    t.mock.method(entitlements, 'inspectXPlan', async (_query, owner) => { assert.equal(owner, U); return plan(); });
    const path = require.resolve('../../src/automation/x-push-runtime');
    delete require.cache[path];
    t.after(() => { delete require.cache[path]; });
    return require(path);
}

function fixture(t, options = {}) {
    let now = 1000, intervalMinutes = options.intervalMinutes ?? 5, lastProcess = null, window = null, windowMode = null, cursor = '0', callbacks;
    let requestedMode = options.requestedMode || 'batch', realtimeEnabled = options.realtimeEnabled === true;
    let decryptGate = null, routeFailure = null, markFailure = null, stopped = false;
    const subscriptionId = randomUUID(), lease = { subscriptionId, ownerUserId: U, revision: 1, token: 'a'.repeat(64), expiresAtMs: Number.MAX_SAFE_INTEGER };
    const rows = [], routed = [], counters = { query: 0, candidates: 0, run: 0, begin: 0, complete: 0, advance: 0, decrypt: 0, assert: 0, mark: 0 };
    const db = { queryDatabase: async sql => {
        counters.query++;
        if (sql.startsWith('SELECT is_donor')) return [{ is_donor: options.donor ? 1 : 0 }];
        if (sql.startsWith('SELECT x_notification_processing_mode')) return [{ x_notification_processing_mode: requestedMode }];
        if (sql.startsWith('SELECT c.realtime_enabled')) return [{ realtime_enabled: realtimeEnabled ? 1 : 0, enabled: 1 }];
        throw new Error('unexpected unit SQL');
    } };
    const gateway = {
        run: input => { counters.run++; callbacks = input; input.onSession({ lease }); return new Promise(resolve => { input.signal.addEventListener('abort', () => { stopped = true; resolve(); }, { once: true }); }); },
        decryptInbox: async (_lease, row) => { counters.decrypt++; if (decryptGate) await decryptGate.promise; if (options.decryptFailure) throw options.decryptFailure; return row.payload; },
        store: {
            beginProcessing: async (_lease, minutes, options = {}) => {
                counters.begin++;
                assert.equal(typeof options.resolveProcessing, 'function', 'owner mode and plan are read inside the locked store callback');
                const processing = await options.resolveProcessing(db.queryDatabase);
                minutes = processing.effectiveMode === 'realtime' ? 0 : processing.intervalMinutes;
                assert.equal(processing.intervalMinutes, intervalMinutes);
                if (!Number.isSafeInteger(minutes) || minutes < (processing.effectiveMode === 'realtime' ? 0 : 1)) return { ready: false, code: 'X_MONITOR_NOT_CONFIGURED' };
                if (window !== null) {
                    if (processing.effectiveMode === 'batch' && windowMode === 'realtime' && now < (lastProcess ?? window) + minutes * 60000)
                        return { ready: false, dueAtMs: (lastProcess ?? window) + minutes * 60000 };
                    return { ready: true, windowAtMs: window, cursorId: cursor, processingMode: processing.effectiveMode };
                }
                const dueAtMs = lastProcess === null ? now : lastProcess + minutes * 60000;
                if (now < dueAtMs) return { ready: false, dueAtMs };
                window = now; windowMode = processing.effectiveMode; cursor = '0'; return { ready: true, windowAtMs: window, cursorId: cursor, processingMode: processing.effectiveMode };
            },
            getInbox: async ({ id }) => rows.find(row => row.id === id) || null,
            listInbox: async ({ afterId, limit }) => rows.filter(row => row.status === 'received' && BigInt(row.id) > BigInt(afterId)).slice(0, limit),
            assertLease: async () => { counters.assert++; },
            markRouted: async (_lease, id) => { counters.mark++; if (markFailure) throw markFailure; rows.find(row => row.id === id).status = 'routed'; },
            markUnsupported: async (_lease, id) => { rows.find(row => row.id === id).status = 'unsupported'; },
            advanceProcessing: async (_lease, input) => { counters.advance++; assert.equal(input.windowAtMs, window); cursor = input.cursorId; },
            completeProcessing: async (_lease, input) => { counters.complete++; assert.equal(input.windowAtMs, window); lastProcess = window; window = null; windowMode = null; cursor = '0'; },
        },
    };
    const router = { hasRealtimeTargets: async () => requestedMode === 'realtime' && realtimeEnabled, hasBatchTargets: async () => requestedMode !== 'realtime' || !realtimeEnabled, routeReceived: async input => {
        routed.push({ id: input.inbox.id, windowAtMs: window, atMs: now, processingMode: input.processingMode });
        if (routeFailure) throw routeFailure;
        return { state: options.pendingIds?.has(input.inbox.id) ? 'pending' : 'routed' };
    } };
    const { createXPushRuntime } = runtimeModule(t, () => ({ intervalMinutes, tier: 'paid', planId: 'ExplicitPlan', label: '任意のプラン名' }));
    const runtime = createXPushRuntime(db, {}, { enabled: true, gateway, router, clock: () => now,
        assertAllowed: () => {}, rolloutMode: 'public', pageSize: 2,
        listCandidates: async () => { counters.candidates++; return [{ id: subscriptionId, owner_user_id: U }]; }, ...options.runtime });
    t.after(() => runtime.stop());
    return { runtime, gateway, router, lease, rows, routed, counters, realtimeAllowed: () => realtimeEnabled,
        add: (receivedAtMs = now) => { const row = { id: String(rows.length + 1), ownerUserId: U, subscriptionId, status: 'received', receivedAtMs, payload: { synthetic: true } }; rows.push(row); return row; },
        advance: value => { now += value; }, interval: value => { intervalMinutes = value; },
        requestedMode: value => { requestedMode = value; }, realtimeEnabled: value => { realtimeEnabled = value; },
        state: () => ({ now, lastProcess, window, cursor, stopped }), callbacks: () => callbacks,
        setDecryptGate: value => { decryptGate = value; }, setRouteFailure: value => { routeFailure = value; }, setMarkFailure: value => { markFailure = value; } };
}

test('disabled receiver and unsupported processing policies perform zero I/O', async t => {
    const { createXPushRuntime, createXPushRuntimeFromEnvironment } = runtimeModule(t, () => assert.fail('plan read'));
    const noIo = new Proxy({}, { get: () => assert.fail('unexpected I/O') });
    for (const options of [{ enabled: false }, ...[null, '', 'guessed-default', 'per-event', 'realtime', { mode: 'realtime', plan: 'Basic+' }].map(processingPolicy => ({ enabled: true, processingPolicy }))]) {
        const runtime = createXPushRuntime(noIo, {}, { ...options, gateway: noIo, router: noIo, listCandidates: () => assert.fail('candidate read') });
        runtime.start();
        const result = await runtime.tick(); assert.equal(result.state, options.enabled ? 'not_configured' : 'disabled');
        assert.equal((await runtime.drain({})).state, 'not_configured'); await runtime.stop();
    }
    const disabled = createXPushRuntimeFromEnvironment(noIo, {}, { env: {} });
    assert.equal((await disabled.tick()).state, 'disabled'); await disabled.stop();
});

test('a persisted receipt with no callback is recovered through onSession and a periodic tick', async t => {
    const f = fixture(t); f.add();
    await f.runtime.tick(); await f.runtime.tick();
    assert.equal(f.counters.run, 1); assert.deepEqual(f.routed.map(row => row.id), ['1']);
    assert.equal(f.rows[0].status, 'routed'); assert.equal(f.runtime.status().sessions, 1);
});

test('batch pages keep one cutoff and defer later arrivals while all earlier pages drain', async t => {
    const f = fixture(t); for (let i = 0; i < 5; i++) f.add();
    assert.equal((await f.runtime.drain(f.lease)).processed, 2);
    f.advance(500); f.add();
    assert.equal((await f.runtime.drain(f.lease)).processed, 2);
    assert.equal((await f.runtime.drain(f.lease)).processed, 1);
    assert.equal(f.counters.complete, 1); assert.deepEqual(f.routed.map(row => row.windowAtMs), [1000, 1000, 1000, 1000, 1000]);
    assert.equal(f.rows[5].status, 'received');
    const waiting = await f.runtime.drain(f.lease); assert.equal(waiting.state, 'pending'); assert.equal(waiting.dueAtMs, 301000);
    f.advance(300000); assert.equal((await f.runtime.drain(f.lease)).processed, 1); assert.equal(f.rows[5].status, 'routed');
});

test('pending rows behind a processed cursor are reconsidered in the next completed window', async t => {
    const pendingIds = new Set(['1']), f = fixture(t, { pendingIds, runtime: { pageSize: 3 } }); f.add(); f.add();
    await f.runtime.drain(f.lease); assert.equal(f.rows[0].status, 'received'); assert.equal(f.rows[1].status, 'routed');
    assert.equal(f.state().cursor, '0'); pendingIds.clear();
    assert.equal((await f.runtime.drain(f.lease)).state, 'pending');
    f.advance(300000); await f.runtime.drain(f.lease);
    assert.deepEqual(f.routed.map(row => row.id), ['1', '2', '1']); assert.equal(f.rows[0].status, 'routed');
});

test('the approved default processes all retained notifications together without per-event spacing', async t => {
    const f = fixture(t, { runtime: { pageSize: 10 } }); f.add(); f.add(); f.add();
    assert.equal(f.runtime.status().processingPolicy, 'batch');
    assert.equal((await f.runtime.drain(f.lease)).processed, 3); assert.equal(f.counters.complete, 1);
    assert.deepEqual(f.routed.map(row => row.atMs), [1000, 1000, 1000]);
    f.add(); assert.equal((await f.runtime.drain(f.lease)).state, 'pending');
    assert.equal(f.rows[3].status, 'received');
    f.advance(300000); assert.equal((await f.runtime.drain(f.lease)).processed, 1);
});

test('current contract interval changes are read for every new window and missing intervals preserve receipts', async t => {
    const f = fixture(t); f.add(); await f.runtime.drain(f.lease); f.add();
    f.interval(30); f.advance(300000);
    const waiting = await f.runtime.drain(f.lease); assert.equal(waiting.state, 'pending'); assert.equal(waiting.dueAtMs, 1801000);
    f.interval(null); assert.equal((await f.runtime.drain(f.lease)).code, 'X_MONITOR_NOT_CONFIGURED'); assert.equal(f.rows[1].status, 'received');
    f.interval(5); assert.equal((await f.runtime.drain(f.lease)).processed, 1);
});

test('an explicitly eligible owner processes each received notification immediately and drains all retained pages', async t => {
    const f = fixture(t, { requestedMode: 'realtime', realtimeEnabled: true });
    for (let i = 0; i < 5; i++) f.add();
    assert.equal((await f.runtime.drain(f.lease)).processed, 5);
    assert.deepEqual(f.routed.map(row => row.atMs), [1000, 1000, 1000, 1000, 1000]);
    await f.runtime.tick();
    f.advance(1); f.add();
    await f.callbacks().onReceived({ lease: f.lease, inbox: f.rows.at(-1) });
    assert.equal(f.rows[5].status, 'routed'); assert.equal(f.routed.at(-1).atMs, 1001);
    f.interval(null); f.advance(1); f.add();
    await f.callbacks().onReceived({ lease: f.lease, inbox: f.rows.at(-1) });
    assert.equal(f.rows[6].status, 'routed'); assert.equal(f.routed.at(-1).atMs, 1002);
});

test('a received callback overlapping an active realtime window drains the later event before any periodic tick', async t => {
    const f = fixture(t, { requestedMode: 'realtime', realtimeEnabled: true }), gate = deferred(), entered = deferred();
    await f.runtime.tick(); f.add();
    let once = true;
    f.gateway.decryptInbox = async (_lease, row) => { if (once) { once = false; entered.resolve(); await gate.promise; } return row.payload; };
    const active = f.runtime.drain(f.lease); await entered.promise;
    f.advance(1); f.add();
    const received = f.callbacks().onReceived({ lease: f.lease, inbox: f.rows.at(-1) });
    gate.resolve(); await Promise.all([active, received]);
    assert.deepEqual(f.rows.map(row => row.status), ['routed', 'routed']);
    assert.deepEqual(f.routed.map(row => row.id), ['1', '2']); assert.equal(f.routed[1].atMs, 1001);
    assert.equal(f.counters.candidates, 1, 'there was no follow-up tick');
});

test('a receipt arriving during a batch-to-realtime change revisits the new mode before the next tick', async t => {
    const f = fixture(t, { realtimeEnabled: true }), gate = deferred(), entered = deferred();
    await f.runtime.tick(); f.add();
    let once = true;
    f.gateway.decryptInbox = async (_lease, row) => { if (once) { once = false; entered.resolve(); await gate.promise; } return row.payload; };
    const active = f.runtime.drain(f.lease); await entered.promise;
    f.requestedMode('realtime'); f.advance(1); f.add();
    const received = f.callbacks().onReceived({ lease: f.lease, inbox: f.rows.at(-1) }); gate.resolve();
    await Promise.all([active, received]);
    assert.deepEqual(f.rows.map(row => row.status), ['routed', 'routed']);
    assert.equal(f.routed[1].atMs, 1001); assert.equal(f.counters.candidates, 1);
});

test('realtime revocation within a loaded page preserves receipts and the existing batch deadline without changing its clock', async t => {
    const f = fixture(t, { realtimeEnabled: true, runtime: { pageSize: 10 } });
    await f.runtime.drain(f.lease); // establish a normal batch anchor
    f.requestedMode('realtime'); f.add(); f.add(); f.add();
    const original = f.gateway.store.markRouted;
    f.gateway.store.markRouted = async (...args) => { await original(...args); if (f.counters.mark === 1) f.realtimeEnabled(false); };
    // Model the same live qualification check performed by the real router/queue.
    const route = f.router.routeReceived;
    f.router.routeReceived = input => input.processingMode === 'realtime' && !f.realtimeAllowed()
        ? { state: 'pending' } : route(input);
    const result = await f.runtime.drain(f.lease);
    assert.equal(result.state, 'pending'); assert.equal(result.dueAtMs, 301000);
    assert.equal(f.state().cursor, '0'); assert.equal(f.counters.advance, 0);
    assert.deepEqual(f.rows.map(row => row.status), ['routed', 'received', 'received']);
    f.advance(300000); await f.runtime.drain(f.lease);
    assert(f.rows.every(row => row.status === 'routed'));
});

test('realtime leaves the batch anchor unchanged and selecting batch uses that current interval', async t => {
    const f = fixture(t, { realtimeEnabled: true });
    await f.runtime.drain(f.lease);
    f.requestedMode('realtime'); f.add(); await f.runtime.drain(f.lease);
    assert.equal(f.state().lastProcess, 1000); assert.equal(f.counters.advance, 0);
    f.advance(1); f.add(); f.requestedMode('batch');
    const waiting = await f.runtime.drain(f.lease); assert.equal(waiting.state, 'pending'); assert.equal(waiting.dueAtMs, 301000);
    f.requestedMode('realtime'); assert.equal((await f.runtime.drain(f.lease)).processed, 1);
    assert.equal(f.routed.at(-1).atMs, 1001);
});

test('concurrent drains share one in-flight subscription window', async t => {
    const f = fixture(t), gate = deferred(); f.add(); f.add(); f.setDecryptGate(gate);
    const tasks = Array.from({ length: 8 }, () => f.runtime.drain(f.lease));
    await Promise.resolve(); await Promise.resolve(); gate.resolve();
    const results = await Promise.all(tasks); assert(results.every(row => row.processed === 2));
    assert.equal(f.counters.begin, 1); assert.equal(f.counters.decrypt, 2); assert.equal(f.routed.length, 2);
});

test('shutdown and late gateway callbacks cannot open sessions or restart draining', async t => {
    const f = fixture(t); await f.runtime.tick(); const callbacks = f.callbacks(); assert(callbacks);
    await f.runtime.stop(); f.add();
    callbacks.onSession({ lease: f.lease, inbox: f.rows.at(-1) }); callbacks.onLease({ lease: { ...f.lease, revision: 2 } });
    await callbacks.onReceived({ lease: f.lease, inbox: f.rows.at(-1) }); f.runtime.start();
    assert.equal((await f.runtime.tick()).state, 'disabled'); assert.equal(f.counters.run, 1); assert.equal(f.routed.length, 0);
    assert.equal(f.runtime.status().sessions, 0); assert.equal(f.runtime.status().stopped, true);
});

test('shutdown during decryption prevents queue admission when the pending decrypt eventually returns', async t => {
    const f = fixture(t), gate = deferred(), entered = deferred(); f.add();
    f.gateway.decryptInbox = async () => { entered.resolve(); await gate.promise; return { synthetic: true }; };
    const draining = f.runtime.drain(f.lease); await entered.promise;
    const stopping = f.runtime.stop(); gate.resolve();
    await draining; await stopping;
    assert.equal(f.routed.length, 0); assert.equal(f.rows[0].status, 'received'); assert.equal(f.counters.advance, 0);
});

test('routing or audit/DB failure retains the encrypted receipt and the cursor for safe retry', async t => {
    const f = fixture(t); f.add(); f.setRouteFailure(Object.assign(new Error('safe fixture'), { code: 'ER_FIXTURE_AUDIT' }));
    await assert.rejects(f.runtime.drain(f.lease), { code: 'ER_FIXTURE_AUDIT' });
    assert.equal(f.rows[0].status, 'received'); assert.equal(f.state().cursor, '0'); assert.equal(f.counters.advance, 0);
    f.setRouteFailure(null); f.setMarkFailure(Object.assign(new Error('safe fixture'), { code: 'ER_FIXTURE_DB' }));
    await assert.rejects(f.runtime.drain(f.lease), { code: 'ER_FIXTURE_DB' });
    assert.equal(f.rows[0].status, 'received'); assert.equal(f.counters.advance, 0);
    f.setMarkFailure(null); await f.runtime.drain(f.lease); assert.equal(f.rows[0].status, 'routed');
});

test('unsupported payloads are quarantined by safe code and do not prevent subsequent retained events', async t => {
    const f = fixture(t, { runtime: { pageSize: 3 } }); f.add(); f.add();
    const original = f.gateway.decryptInbox;
    f.gateway.decryptInbox = async (lease, row) => {
        if (row.id === '1') throw Object.assign(new Error('must not be reflected'), { code: 'X_NOTIFICATION_UNSUPPORTED' });
        return original(lease, row);
    };
    assert.equal((await f.runtime.drain(f.lease)).processed, 2);
    assert.equal(f.rows[0].status, 'unsupported'); assert.equal(f.rows[1].status, 'routed'); assert.deepEqual(f.routed.map(row => row.id), ['2']);
});

test('busy or reenrollment gateway outcomes do not overwrite a persisted retry policy', async t => {
    for (const state of ['busy', 'requires_reenrollment']) {
        const f = fixture(t); f.gateway.run = async () => { f.counters.run++; return { state, reasonCode: 'X_PUSH_UAID_CHANGED' }; };
        f.gateway.store.status = () => assert.fail('busy/reenrollment must not inspect retry policy');
        f.gateway.store.recordRetry = () => assert.fail('busy/reenrollment must not record retries');
        await f.runtime.tick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.counters.run, 1); await f.runtime.stop();
    }
});

test('discarded session callbacks cannot replace a current session lease or regain ownership', async t => {
    const f = fixture(t, { requestedMode: 'realtime', realtimeEnabled: true, runtime: { jitter: () => 0 } }), callbacks = [];
    f.gateway.run = input => {
        f.counters.run++; callbacks.push(input);
        if (f.counters.run === 1) return Promise.reject(Object.assign(new Error('secret socket sentinel'), { code: 'X_PUSH_SOCKET_FAILED' }));
        input.onSession({ lease: f.lease, inbox: f.rows.at(-1) }); return new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
    };
    f.gateway.store.status = async () => ({ revision: 1, retryAttempt: 0 });
    f.gateway.store.recordRetry = async () => ({ recorded: true });
    await f.runtime.tick(); await new Promise(resolve => setImmediate(resolve)); await f.runtime.tick(); assert.equal(f.counters.run, 1);
    f.advance(5000); await f.runtime.tick(); assert.equal(f.counters.run, 2);
    f.add(); const before = f.counters.begin;
    callbacks[0].onSession({ lease: { ...f.lease, revision: 99 } }); callbacks[0].onLease({ lease: { ...f.lease, revision: 99 } });
    await callbacks[0].onReceived({ lease: f.lease, inbox: f.rows.at(-1) }); assert.equal(f.counters.begin, before); assert.equal(f.routed.length, 0);
    await callbacks[1].onReceived({ lease: f.lease, inbox: f.rows.at(-1) }); assert.equal(f.routed.length, 1);
});

test('a receipt callback reads its authoritative owned ciphertext and bypasses a larger pending batch backlog without touching its clock', async t => {
    const pendingIds = new Set(), f = fixture(t, { requestedMode: 'realtime', realtimeEnabled: true, pendingIds });
    for (let index = 0; index < 60; index++) pendingIds.add(f.add().id);
    await f.runtime.tick(); f.routed.length = 0;
    const incoming = f.add(), reads = [];
    const getInbox = f.gateway.store.getInbox;
    f.gateway.store.getInbox = async input => { reads.push(input); return getInbox(input); };
    await f.callbacks().onReceived({ lease: f.lease, inbox: { id: incoming.id }, payload: { forged: 'not trusted' } });
    assert.equal(f.routed[0].id, incoming.id); assert.equal(incoming.status, 'routed');
    assert.equal(reads[0].ownerUserId, U); assert.equal(reads[0].subscriptionId, f.lease.subscriptionId);
    assert.equal(f.counters.begin, 0); assert.equal(f.counters.advance, 0); assert.equal(f.counters.complete, 0);
    assert.equal(f.state().lastProcess, null); assert(f.rows.slice(0, 60).every(row => row.status === 'received'));
    const later = f.add();
    let once = true;
    f.gateway.store.getInbox = async input => {
        reads.push(input);
        if (once) { once = false; throw Object.assign(new Error('private DB failure'), { code: 'ER_FIXTURE_READ' }); }
        return getInbox(input);
    };
    await assert.rejects(f.callbacks().onReceived({ lease: f.lease, inbox: { id: later.id } }), { code: 'ER_FIXTURE_READ' });
    assert.equal(later.status, 'received');
    const beforeRetry = f.routed.length;
    await f.runtime.tick();
    assert.equal(f.routed[beforeRetry].id, later.id, 'failed exact-ID hints survive and bypass the backlog again on the next tick');
    assert.equal(later.status, 'routed'); assert.equal(f.counters.begin, 0);
    const before = f.routed.length;
    await f.callbacks().onReceived({ lease: f.lease, inbox: { id: '99999', payload: incoming.payload } });
    assert(!f.routed.slice(before).some(row => row.id === '99999'));
});

test('bounded realtime recovery scans rotate past pending head rows and later retry them without a batch cursor', async t => {
    const pendingIds = new Set(), f = fixture(t, { requestedMode: 'realtime', realtimeEnabled: true, pendingIds });
    for (let index = 0; index < 22; index++) pendingIds.add(f.add().id);
    const newest = f.add();
    await f.runtime.drain(f.lease); assert.equal(newest.status, 'received');
    await f.runtime.drain(f.lease); assert.equal(newest.status, 'routed');
    pendingIds.clear(); await f.runtime.drain(f.lease); await f.runtime.drain(f.lease);
    assert(f.rows.every(row => row.status === 'routed')); assert.equal(f.counters.begin, 0); assert.equal(f.counters.advance, 0);
});

test('batch receipt callbacks remain encrypted until the periodic batch window and do not open a window themselves', async t => {
    const f = fixture(t); await f.runtime.tick(); f.add();
    await f.callbacks().onReceived({ lease: f.lease, inbox: f.rows[0] });
    assert.equal(f.rows[0].status, 'received'); assert.equal(f.counters.begin, 0);
    await f.runtime.tick(); assert.equal(f.rows[0].status, 'routed'); assert.equal(f.counters.begin, 1);
});

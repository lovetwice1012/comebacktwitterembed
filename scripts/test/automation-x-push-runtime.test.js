'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const U = '222222222222222222';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('standard batch policy is shared and tentative realtime cannot be enabled by a name or arbitrary value', () => {
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
    let now = 1000, intervalMinutes = options.intervalMinutes ?? 5, lastProcess = null, window = null, cursor = '0', callbacks;
    let decryptGate = null, routeFailure = null, markFailure = null, stopped = false;
    const subscriptionId = randomUUID(), lease = { subscriptionId, ownerUserId: U, revision: 1, token: 'a'.repeat(64), expiresAtMs: Number.MAX_SAFE_INTEGER };
    const rows = [], routed = [], counters = { query: 0, candidates: 0, run: 0, begin: 0, complete: 0, advance: 0, decrypt: 0, assert: 0, mark: 0 };
    const db = { queryDatabase: async sql => { counters.query++; if (sql.startsWith('SELECT is_donor')) return [{ is_donor: options.donor ? 1 : 0 }]; throw new Error('unexpected unit SQL'); } };
    const gateway = {
        run: input => { counters.run++; callbacks = input; input.onSession({ lease }); return new Promise(resolve => { input.signal.addEventListener('abort', () => { stopped = true; resolve(); }, { once: true }); }); },
        decryptInbox: async (_lease, row) => { counters.decrypt++; if (decryptGate) await decryptGate.promise; if (options.decryptFailure) throw options.decryptFailure; return row.payload; },
        store: {
            beginProcessing: async (_lease, minutes, options = {}) => {
                counters.begin++;
                assert.equal(typeof options.resolveInterval, 'function', 'plan is read inside the locked store callback');
                minutes = await options.resolveInterval(db.queryDatabase); assert.equal(minutes, intervalMinutes);
                if (!Number.isSafeInteger(minutes) || minutes < 1) return { ready: false, code: 'X_MONITOR_NOT_CONFIGURED' };
                if (window !== null) return { ready: true, windowAtMs: window, cursorId: cursor };
                const dueAtMs = lastProcess === null ? now : lastProcess + minutes * 60000;
                if (now < dueAtMs) return { ready: false, dueAtMs };
                window = now; cursor = '0'; return { ready: true, windowAtMs: window, cursorId: cursor };
            },
            listInbox: async ({ afterId, limit }) => rows.filter(row => row.status === 'received' && BigInt(row.id) > BigInt(afterId)).slice(0, limit),
            assertLease: async () => { counters.assert++; },
            markRouted: async (_lease, id) => { counters.mark++; if (markFailure) throw markFailure; rows.find(row => row.id === id).status = 'routed'; },
            markUnsupported: async (_lease, id) => { rows.find(row => row.id === id).status = 'unsupported'; },
            advanceProcessing: async (_lease, input) => { counters.advance++; assert.equal(input.windowAtMs, window); cursor = input.cursorId; },
            completeProcessing: async (_lease, input) => { counters.complete++; assert.equal(input.windowAtMs, window); lastProcess = window; window = null; cursor = '0'; },
        },
    };
    const router = { routeReceived: async input => {
        routed.push({ id: input.inbox.id, windowAtMs: window, atMs: now });
        if (routeFailure) throw routeFailure;
        return { state: options.pendingIds?.has(input.inbox.id) ? 'pending' : 'routed' };
    } };
    const { createXPushRuntime } = runtimeModule(t, () => ({ intervalMinutes }));
    const runtime = createXPushRuntime(db, {}, { enabled: true, gateway, router, clock: () => now,
        assertAllowed: () => {}, rolloutMode: 'public', pageSize: 2,
        listCandidates: async () => { counters.candidates++; return [{ id: subscriptionId, owner_user_id: U }]; }, ...options.runtime });
    t.after(() => runtime.stop());
    return { runtime, gateway, lease, rows, routed, counters,
        add: (receivedAtMs = now) => { const row = { id: String(rows.length + 1), ownerUserId: U, subscriptionId, status: 'received', receivedAtMs, payload: { synthetic: true } }; rows.push(row); return row; },
        advance: value => { now += value; }, interval: value => { intervalMinutes = value; },
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
    callbacks.onSession({ lease: f.lease }); callbacks.onLease({ lease: { ...f.lease, revision: 2 } });
    await callbacks.onReceived({ lease: f.lease }); f.runtime.start();
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
    const f = fixture(t, { runtime: { jitter: () => 0 } }), callbacks = [];
    f.gateway.run = input => {
        f.counters.run++; callbacks.push(input);
        if (f.counters.run === 1) return Promise.reject(Object.assign(new Error('secret socket sentinel'), { code: 'X_PUSH_SOCKET_FAILED' }));
        input.onSession({ lease: f.lease }); return new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
    };
    f.gateway.store.status = async () => ({ revision: 1, retryAttempt: 0 });
    f.gateway.store.recordRetry = async () => ({ recorded: true });
    await f.runtime.tick(); await new Promise(resolve => setImmediate(resolve)); await f.runtime.tick(); assert.equal(f.counters.run, 1);
    f.advance(5000); await f.runtime.tick(); assert.equal(f.counters.run, 2);
    f.add(); const before = f.counters.begin;
    callbacks[0].onSession({ lease: { ...f.lease, revision: 99 } }); callbacks[0].onLease({ lease: { ...f.lease, revision: 99 } });
    await callbacks[0].onReceived({ lease: f.lease }); assert.equal(f.counters.begin, before); assert.equal(f.routed.length, 0);
    await callbacks[1].onReceived({ lease: f.lease }); assert.equal(f.routed.length, 1);
});

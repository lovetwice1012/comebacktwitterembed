'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createXPushRuntime, reconnectDelay, pruneExpiredCooldowns } = require('../../src/automation/x-push-runtime');
const U = '222222222222222222';
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options = {}) {
    let now = 1000, calls = 0, attempt = 0;
    const id = randomUUID(), retries = [];
    const gateway = { run: async () => { calls++; throw Object.assign(new Error('SAFE FAILURE SENTINEL'), { code: options.code || 'X_PUSH_SOCKET_FAILED' }); },
        store: { status: async () => ({ revision: options.statusRevision || 7, retryAttempt: attempt }),
            recordRetry: async (identity, reasonCode, delayMs) => {
                retries.push({ identity, reasonCode, delayMs });
                if (options.metadataFailure) throw Object.assign(new Error('DB unavailable fixture'), { code: 'X_PUSH_STORE_UNAVAILABLE' });
                attempt++;
                return { recorded: true, retryAtMs: now + delayMs, retryAttempt: attempt };
            } } };
    const runtime = createXPushRuntime({ queryDatabase: async () => assert.fail('unexpected query') }, {}, {
        enabled: true, processingPolicy: 'batch', rolloutMode: 'public', gateway,
        assertAllowed: () => {}, clock: () => now, jitter: () => 0,
        listCandidates: async () => [{ id, owner_user_id: U, revision: 7 }],
        listActiveSessions: async () => [{ id, owner_user_id: U, revision: 7 }],
    });
    t.after(() => runtime.stop());
    return { runtime, gateway, retries, id, calls: () => calls, advance: value => { now += value; } };
}

test('rejected AutoPush sessions persist failure attempts and cooldown before another connection', async t => {
    const f = fixture(t);
    await f.runtime.tick(); await flush();
    assert.equal(f.retries.length, 1);
    assert.equal(f.retries[0].reasonCode, 'X_PUSH_SOCKET_FAILED'); assert.equal(f.retries[0].delayMs, 5000);
    assert.deepEqual(f.retries[0].identity, { subscriptionId: f.id, ownerUserId: U, revision: 7 });
    await f.runtime.tick(); await flush(); assert.equal(f.calls(), 1);
    f.advance(4999); await f.runtime.tick(); await flush(); assert.equal(f.calls(), 1);
    f.advance(1); await f.runtime.tick(); await flush(); assert.equal(f.calls(), 2);
    assert.equal(f.retries[1].delayMs, 10000);
});

test('server close 4774 keeps a durable thirty-minute minimum delay after a rejected session', async t => {
    const f = fixture(t, { code: 'X_PUSH_BACKOFF' });
    await f.runtime.tick(); await flush();
    assert.equal(f.retries.length, 1); assert.equal(f.retries[0].reasonCode, 'X_PUSH_BACKOFF');
    assert(f.retries[0].delayMs >= 1800000);
    f.advance(1799999); await f.runtime.tick(); await flush(); assert.equal(f.calls(), 1);
    f.advance(1); await f.runtime.tick(); await flush(); assert.equal(f.calls(), 2);
});
test('Chrome login rejection remains on the bounded reconnect path', async t => {
    const f = fixture(t, { code: 'X_PUSH_CHROME_LOGIN_FAILED' });
    await f.runtime.tick(); await flush();
    assert.equal(f.retries.length, 1); assert.equal(f.retries[0].reasonCode, 'X_PUSH_CHROME_LOGIN_FAILED');
    assert.equal(f.retries[0].delayMs, 5000);
    await f.runtime.tick(); await flush(); assert.equal(f.calls(), 1);
    f.advance(5000); await f.runtime.tick(); await flush(); assert.equal(f.calls(), 2);
});

test('retry metadata never adopts a newer subscription revision from a late status read', async t => {
    const f = fixture(t, { statusRevision: 8 });
    let statusReads = 0;
    const status = f.gateway.store.status;
    f.gateway.store.status = async (...args) => { statusReads++; return status(...args); };
    await f.runtime.tick(); await flush();
    assert.equal(f.calls(), 1); assert.equal(statusReads, 1);
    assert(f.retries.every(row => row.identity.revision === 7));
});

test('failed retry metadata writes retain a local five-minute cooldown without repeated connection attempts', async t => {
    const f = fixture(t, { metadataFailure: true });
    await f.runtime.tick(); await flush(); assert.equal(f.calls(), 1); assert.equal(f.retries.length, 1);
    f.advance(299999); await f.runtime.tick(); await flush(); assert.equal(f.calls(), 1);
    f.advance(1); await f.runtime.tick(); await flush(); assert.equal(f.calls(), 2);
});

test('default candidate query enforces persisted retry deadlines and excludes reenrollment after process restart', async t => {
    const queries = [];
    const runtime = createXPushRuntime({ queryDatabase: async (sql, params) => { queries.push({ sql, params }); return []; } }, {}, {
        enabled: true, processingPolicy: 'batch', rolloutMode: 'public', gateway: { run: () => assert.fail('unexpected connection') },
        assertAllowed: () => {}, clock: () => 1000,
    });
    t.after(() => runtime.stop());
    await runtime.tick();
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /retry_at_ms/); assert.match(queries[0].sql, /requires_reenrollment/);
    assert(queries[0].params.includes(1000));
});

test('source-compatible reconnect delays cap failures and never jitter below server backoff', () => {
    assert.equal(reconnectDelay(1, 'X_PUSH_SOCKET_FAILED', () => 0), 5000);
    assert.equal(reconnectDelay(2, 'X_PUSH_SOCKET_FAILED', () => 0), 10000);
    assert.equal(reconnectDelay(64, 'X_PUSH_SOCKET_FAILED', () => 0), 300000);
    assert.equal(reconnectDelay(1, 'X_PUSH_BACKOFF', () => 0), 1800000);
    assert(reconnectDelay(1, 'X_PUSH_BACKOFF', (_minimum, maximum) => maximum - 1) >= 1800000);
});

test('expired local cooldowns are removed while future retry deadlines remain', () => {
    const cooldowns = new Map([['expired', 999], ['due', 1000], ['future', 1001], ['backoff', 1801000]]);
    pruneExpiredCooldowns(cooldowns, 1000);
    assert.deepEqual([...cooldowns], [['future', 1001], ['backoff', 1801000]]);
    pruneExpiredCooldowns(cooldowns, 1001);
    assert.deepEqual([...cooldowns], [['backoff', 1801000]]);
});

test('shutdown while rollout eligibility is pending cannot start a new receiver', async () => {
    let resolvePolicy, notifyEntered, starts = 0;
    const entered = new Promise(resolve => { notifyEntered = resolve; });
    const policy = new Promise(resolve => { resolvePolicy = resolve; });
    const gateway = { store: {}, run: () => { starts++; return Promise.resolve({ state: 'stopped' }); } };
    const runtime = createXPushRuntime({ queryDatabase: async () => { notifyEntered(); return policy; } }, {}, {
        enabled: true, processingPolicy: 'batch', rolloutMode: 'supporters', gateway, assertAllowed() {},
        listCandidates: async () => [{ id: 'candidate', owner_user_id: U, revision: 1 }], listActiveSessions: async () => [],
    });
    const tick = runtime.tick(); await entered;
    const stopping = runtime.stop(); resolvePolicy([{ is_donor: 1 }]);
    await Promise.all([tick, stopping]); await flush();
    assert.equal(starts, 0); assert.equal(runtime.status().sessions, 0);
});

test('shutdown after session registration but before the gateway microtask cannot open a receiver', async () => {
    let runtime, stopping, sessionsAtStop, starts = 0;
    const gateway = { store: {}, run: () => { starts++; return Promise.resolve({ state: 'stopped' }); } };
    runtime = createXPushRuntime({ queryDatabase: async () => {
        queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
            sessionsAtStop = runtime.status().sessions; stopping = runtime.stop();
        })));
        return [{ is_donor: 1 }];
    } }, {}, { enabled: true, processingPolicy: 'batch', rolloutMode: 'supporters', gateway, assertAllowed() {},
        listCandidates: async () => [{ id: 'candidate', owner_user_id: U, revision: 1 }], listActiveSessions: async () => [],
    });
    await runtime.tick(); await stopping; await flush();
    assert.equal(sessionsAtStop, 1); assert.equal(starts, 0); assert.equal(runtime.status().sessions, 0);
});

test('guardian authority is rechecked after rollout lookup before a receiver is registered', async t => {
    let resolvePolicy, notifyEntered, allowed = true, starts = 0;
    const entered = new Promise(resolve => { notifyEntered = resolve; });
    const policy = new Promise(resolve => { resolvePolicy = resolve; });
    const gateway = { store: {}, run: () => { starts++; return Promise.resolve({ state: 'stopped' }); } };
    const runtime = createXPushRuntime({ queryDatabase: async () => { notifyEntered(); return policy; } }, {}, {
        enabled: true, processingPolicy: 'batch', rolloutMode: 'supporters', gateway,
        assertAllowed() { if (!allowed) throw new Error('synthetic authority lost'); },
        listCandidates: async () => [{ id: 'candidate', owner_user_id: U, revision: 1 }], listActiveSessions: async () => [],
    });
    t.after(() => runtime.stop());
    const tick = runtime.tick(); await entered; allowed = false; resolvePolicy([{ is_donor: 1 }]);
    await assert.rejects(tick, /synthetic authority lost/); await flush();
    assert.equal(starts, 0); assert.equal(runtime.status().sessions, 0); assert.equal(runtime.status().pendingEligibilityRetries, 0);
});

test('guardian authority is rechecked before the delayed gateway microtask', async t => {
    let runtime, allowed = true, sessionsAtRevocation, starts = 0;
    const gateway = { store: {}, run: () => { starts++; return Promise.resolve({ state: 'stopped' }); } };
    runtime = createXPushRuntime({ queryDatabase: async () => {
        queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
            sessionsAtRevocation = runtime.status().sessions; allowed = false;
        })));
        return [{ is_donor: 1 }];
    } }, {}, { enabled: true, processingPolicy: 'batch', rolloutMode: 'supporters', gateway,
        assertAllowed() { if (!allowed) throw new Error('synthetic authority lost'); },
        listCandidates: async () => [{ id: 'candidate', owner_user_id: U, revision: 1 }], listActiveSessions: async () => [],
    });
    t.after(() => runtime.stop());
    await runtime.tick(); await flush();
    assert.equal(sessionsAtRevocation, 1); assert.equal(starts, 0); assert.equal(runtime.status().sessions, 0);
    assert.equal(runtime.status().pendingEligibilityRetries, 0);
});

test('transient rollout failure retries the affected candidate without blocking another user or waiting for a full scan', async t => {
    let now = 1000, failFirst = true;
    const rows = [{ id: 'a', owner_user_id: U, revision: 1 },
        { id: 'b', owner_user_id: '333333333333333333', revision: 1 },
        { id: 'c', owner_user_id: '444444444444444444', revision: 1 }];
    const starts = [], checks = [];
    const gateway = { store: {}, run: input => {
        starts.push(input.subscriptionId);
        return new Promise(resolve => input.signal.addEventListener('abort', () => resolve({ state: 'stopped' }), { once: true }));
    } };
    const runtime = createXPushRuntime({ queryDatabase: async (_sql, params) => {
        checks.push({ owner: params[0], now });
        if (params[0] === U && failFirst) { failFirst = false; throw new Error('synthetic DB failure'); }
        return [{ is_donor: 1 }];
    } }, {}, { enabled: true, processingPolicy: 'batch', rolloutMode: 'supporters', gateway, assertAllowed() {},
        pageSize: 1, clock: () => now, jitter: () => 0,
        listCandidates: async cursor => rows.filter(row => row.id > cursor).slice(0, 1),
        listActiveSessions: async ids => rows.filter(row => ids.includes(row.id)),
    });
    t.after(() => runtime.stop());
    await runtime.tick(); await flush(); assert.deepEqual(starts, []); assert.equal(runtime.status().pendingEligibilityRetries, 1);
    await runtime.tick(); await flush(); assert.deepEqual(starts, ['b']);
    assert.equal(checks.filter(entry => entry.owner === U).length, 1);
    now += 5000; await runtime.tick(); await flush();
    assert(starts.includes('a')); assert.equal(runtime.status().pendingEligibilityRetries, 0);
    assert.equal(checks.filter(entry => entry.owner === U).length, 2);
});

test('continuous refreshes and ordinary pages cannot starve a due eligibility retry', async t => {
    let now = 1000, failures = 0;
    const rows = [{ id: 'a', owner_user_id: U, revision: 1, updated_at_ms: 0 },
        { id: 'b', owner_user_id: '333333333333333333', revision: 1, updated_at_ms: 0 },
        { id: 'c', owner_user_id: '444444444444444444', revision: 1, updated_at_ms: 0 }];
    const starts = [];
    const gateway = { store: {}, run: input => {
        starts.push(input.subscriptionId);
        return new Promise(resolve => input.signal.addEventListener('abort', () => resolve({ state: 'stopped' }), { once: true }));
    } };
    const runtime = createXPushRuntime({ queryDatabase: async (_sql, params) => {
        if (params[0] === rows[1].owner_user_id && failures++ === 0) throw new Error('synthetic eligibility failure');
        return [{ is_donor: 1 }];
    } }, {}, { enabled: true, processingPolicy: 'batch', rolloutMode: 'supporters', gateway, assertAllowed() {},
        pageSize: 1, clock: () => now, jitter: () => 0,
        listCandidates: async cursor => rows.filter(row => row.id > cursor).slice(0, 1).map(row => ({ ...row })),
        listActiveSessions: async ids => rows.filter(row => ids.includes(row.id)).map(row => ({ ...row })),
    });
    t.after(() => runtime.stop());
    await runtime.tick(); await flush(); assert.deepEqual(starts, ['a']);
    await runtime.tick(); await flush(); assert.equal(runtime.status().pendingEligibilityRetries, 1);
    now += 5000;
    for (let i = 0; i < 12 && !starts.includes('b'); i++) {
        rows[0].updated_at_ms++;
        const before = starts.length;
        await runtime.tick(); await flush();
        assert(starts.length - before <= 1);
    }
    assert(starts.includes('b'), 'refreshes and ordinary candidates must not starve an eligible retry');
    assert.equal(runtime.status().pendingEligibilityRetries, 0);
});

test('continuous updates, repeated eligibility retries and ordinary pages all make progress', async t => {
    let now = 1000, bChecks = 0;
    const rows = [{ id: 'a', owner_user_id: U, revision: 1, updated_at_ms: 0 },
        { id: 'b', owner_user_id: '333333333333333333', revision: 1, updated_at_ms: 0 },
        ...Array.from({ length: 30 }, (_, index) => ({ id: `c${String(index).padStart(3, '0')}`,
            owner_user_id: '444444444444444444', revision: 1, updated_at_ms: 0 }))];
    const starts = [];
    const gateway = { store: {}, run: input => {
        starts.push(input.subscriptionId);
        return new Promise(resolve => input.signal.addEventListener('abort', () => resolve({ state: 'stopped' }), { once: true }));
    } };
    const runtime = createXPushRuntime({ queryDatabase: async (_sql, params) => {
        if (params[0] === rows[1].owner_user_id) { bChecks++; throw new Error('synthetic eligibility failure'); }
        return [{ is_donor: 1 }];
    } }, {}, { enabled: true, processingPolicy: 'batch', rolloutMode: 'supporters', gateway, assertAllowed() {},
        maxConnections: 100, pageSize: 1, clock: () => now, jitter: () => 0,
        listCandidates: async cursor => rows.filter(row => row.id > cursor).slice(0, 1).map(row => ({ ...row })),
        listActiveSessions: async ids => rows.filter(row => ids.includes(row.id)).map(row => ({ ...row })),
    });
    t.after(() => runtime.stop());
    await runtime.tick(); await flush();
    rows[0].updated_at_ms++; await runtime.tick(); await flush();
    await runtime.tick(); await flush(); assert.equal(bChecks, 1);
    for (let i = 0; i < 21; i++) {
        rows[0].updated_at_ms++; now += 400000;
        const before = starts.length; await runtime.tick(); await flush();
        assert(starts.length - before <= 1);
    }
    assert(starts.filter(id => id === 'a').length >= 4, 'updated receivers need repeated turns');
    assert(bChecks >= 4, 'a failing retry needs repeated turns');
    assert(starts.filter(id => id.startsWith('c')).length >= 4, 'ordinary new registrations need repeated turns');
});

test('the eligibility-check budget is bounded even when refreshed candidates all fail', async t => {
    let fail = false, checks = 0, now = 1000;
    const rows = Array.from({ length: 3 }, (_, index) => ({ id: String.fromCharCode(97 + index),
        owner_user_id: String(222222222222222222n + BigInt(index)), revision: 1, updated_at_ms: 0 }));
    const failedOwners = new Set(), starts = [];
    const gateway = { store: {}, run: input => {
        starts.push(input.subscriptionId);
        return new Promise(resolve => input.signal.addEventListener('abort', () => resolve({ state: 'stopped' }), { once: true }));
    } };
    const runtime = createXPushRuntime({ queryDatabase: async (_sql, params) => {
        checks++; if (fail) { failedOwners.add(params[0]); throw new Error('synthetic DB failure'); }
        return [{ is_donor: 1 }];
    } }, {}, { enabled: true, processingPolicy: 'batch', rolloutMode: 'supporters', gateway, assertAllowed() {},
        maxConnections: 5, pageSize: 1, clock: () => now, jitter: () => 0,
        listCandidates: async cursor => rows.filter(row => row.id > cursor).slice(0, 1).map(row => ({ ...row })),
        listActiveSessions: async ids => rows.filter(row => ids.includes(row.id)).map(row => ({ ...row })),
    });
    t.after(() => runtime.stop());
    for (let i = 0; i < 3; i++) { await runtime.tick(); await flush(); }
    assert.equal(starts.length, 3); fail = true; rows.forEach(row => { row.updated_at_ms++; });
    rows.push({ id: 'd', owner_user_id: '555555555555555555', revision: 1, updated_at_ms: 0 });
    for (let i = 0; i < 12 && failedOwners.size < 4; i++) {
        const before = checks; await runtime.tick(); await flush();
        assert(checks - before <= 1, 'failed checks must share the page-size budget');
    }
    assert.equal(failedOwners.size, 4, 'an unchecked ordinary page candidate must not be skipped');
    assert(runtime.status().pendingEligibilityRetries <= 10);
    fail = false; now += 300000;
    for (let i = 0; i < 15 && runtime.status().sessions < 4; i++) { await runtime.tick(); await flush(); }
    assert.equal(runtime.status().sessions, 4);
});

for (const mode of ['ineligible', 'removed']) test(`an eligibility retry is discarded when its owner becomes ${mode}`, async t => {
    let now = 1000, fail = true, present = true, starts = 0;
    const row = { id: 'a', owner_user_id: U, revision: 1 };
    const gateway = { store: {}, run: () => { starts++; return Promise.resolve({ state: 'stopped' }); } };
    const runtime = createXPushRuntime({ queryDatabase: async () => {
        if (fail) { fail = false; throw new Error('synthetic DB failure'); }
        return [{ is_donor: 0 }];
    } }, {}, { enabled: true, processingPolicy: 'batch', rolloutMode: 'supporters', gateway, assertAllowed() {},
        pageSize: 1, clock: () => now, jitter: () => 0,
        listCandidates: async cursor => present && row.id > cursor ? [row] : [],
        listActiveSessions: async ids => present && ids.includes(row.id) ? [row] : [],
    });
    t.after(() => runtime.stop());
    await runtime.tick(); assert.equal(runtime.status().pendingEligibilityRetries, 1);
    if (mode === 'removed') present = false;
    now += 5000; await runtime.tick(); await flush();
    assert.equal(starts, 0); assert.equal(runtime.status().pendingEligibilityRetries, 0);
});

test('a revoked refresh hint is discarded, and normal scanning can reconnect after eligibility returns', async t => {
    const row = { id: 'a', owner_user_id: U, revision: 1, updated_at_ms: 0 };
    let eligible = true, checks = 0, starts = 0;
    const gateway = { store: {}, run: input => {
        starts++;
        return new Promise(resolve => input.signal.addEventListener('abort', () => resolve({ state: 'stopped' }), { once: true }));
    } };
    const runtime = createXPushRuntime({ queryDatabase: async () => { checks++; return [{ is_donor: eligible ? 1 : 0 }]; } }, {}, {
        enabled: true, processingPolicy: 'batch', rolloutMode: 'supporters', gateway, assertAllowed() {}, pageSize: 1,
        listCandidates: async cursor => row.id > cursor ? [{ ...row }] : [],
        listActiveSessions: async ids => ids.includes(row.id) ? [{ ...row }] : [],
    });
    t.after(() => runtime.stop());
    await runtime.tick(); await flush(); assert.equal(starts, 1);
    eligible = false; row.updated_at_ms++;
    await runtime.tick(); await flush(); assert.equal(runtime.status().sessions, 0);
    for (let i = 0; i < 4; i++) {
        const before = checks; await runtime.tick(); await flush();
        assert(checks - before <= 1, 'an ineligible refresh must not be checked twice in one tick');
    }
    assert.equal(starts, 1); eligible = true;
    for (let i = 0; i < 3 && starts === 1; i++) { await runtime.tick(); await flush(); }
    assert.equal(starts, 2);
});

test('eligibility retries use the existing capped exponential reconnect schedule', async t => {
    let now = 1000, checks = 0, recovered = false, starts = 0;
    const row = { id: 'a', owner_user_id: U, revision: 1 };
    const gateway = { store: {}, run: input => { starts++; return new Promise(resolve => {
        input.signal.addEventListener('abort', () => resolve({ state: 'stopped' }), { once: true });
    }); } };
    const runtime = createXPushRuntime({ queryDatabase: async () => { checks++; if (!recovered) throw new Error('synthetic DB failure'); return [{ is_donor: 1 }]; } }, {}, {
        enabled: true, processingPolicy: 'batch', rolloutMode: 'supporters', gateway, assertAllowed() {}, clock: () => now, jitter: () => 0, pageSize: 1,
        listCandidates: async cursor => row.id > cursor ? [row] : [], listActiveSessions: async ids => ids.includes(row.id) ? [row] : [],
    });
    t.after(() => runtime.stop());
    await runtime.tick(); assert.equal(checks, 1);
    now += 4999; await runtime.tick(); await runtime.tick(); assert.equal(checks, 1);
    now += 1; await runtime.tick(); assert.equal(checks, 2);
    now += 9999; await runtime.tick(); await runtime.tick(); assert.equal(checks, 2);
    recovered = true; now += 1; await runtime.tick(); await flush();
    assert.equal(checks, 3); assert.equal(starts, 1); assert.equal(runtime.status().pendingEligibilityRetries, 0);
});

test('repeated eligibility failures are bounded and a fresh worker resumes normal database scanning', async () => {
    let now = 1000, checks = 0;
    const rows = Array.from({ length: 15 }, (_, index) => ({ id: String(index).padStart(2, '0'),
        owner_user_id: String(222222222222222222n + BigInt(index)), revision: 1 }));
    function build(fail) {
        return createXPushRuntime({ queryDatabase: async () => { checks++; if (fail) throw new Error('synthetic failure'); return [{ is_donor: 1 }]; } }, {}, {
            enabled: true, processingPolicy: 'batch', rolloutMode: 'supporters', gateway: { store: {}, run: input => new Promise(resolve => {
                input.signal.addEventListener('abort', () => resolve({ state: 'stopped' }), { once: true });
            }) }, assertAllowed() {}, pageSize: 1, maxConnections: 1, clock: () => now, jitter: () => 0,
            listCandidates: async cursor => rows.filter(row => row.id > cursor).slice(0, 1),
            listActiveSessions: async ids => rows.filter(row => ids.includes(row.id)),
        });
    }
    const failed = build(true);
    for (let i = 0; i < rows.length; i++) { await failed.tick(); assert(failed.status().pendingEligibilityRetries <= 2); }
    assert.equal(checks, rows.length); await failed.stop(); assert.equal(failed.status().pendingEligibilityRetries, 0);
    const successor = build(false); now += 1;
    try { await successor.tick(); await flush(); assert.equal(successor.status().sessions, 1); }
    finally { await successor.stop(); }
});

test('simultaneous subscription refreshes start at most one page per tick without losing candidates', async t => {
    const rows = Array.from({ length: 6 }, (_, index) => ({ id: String(index + 1).padStart(2, '0'),
        owner_user_id: U, revision: 1, updated_at_ms: 0 }));
    const starts = [];
    const gateway = { run: input => {
        starts.push(input.subscriptionId);
        return new Promise(resolve => { if (input.signal.aborted) return resolve({ state: 'stopped' });
            input.signal.addEventListener('abort', () => resolve({ state: 'stopped' }), { once: true }); });
    }, store: {} };
    const runtime = createXPushRuntime({ queryDatabase: async () => assert.fail('unexpected query') }, {}, {
        enabled: true, processingPolicy: 'batch', rolloutMode: 'public', gateway, assertAllowed: () => {}, pageSize: 2,
        listCandidates: async cursor => rows.filter(row => row.id > cursor).slice(0, 2).map(row => ({ ...row })),
        listActiveSessions: async ids => rows.filter(row => ids.includes(row.id)).map(row => ({ ...row })),
    });
    t.after(() => runtime.stop());
    for (let i = 0; i < 3; i++) { await runtime.tick(); await flush(); }
    assert.equal(runtime.status().sessions, 6);
    assert.deepEqual(starts, rows.map(row => row.id));
    rows.forEach(row => { row.updated_at_ms = 1; });
    rows.push({ id: '07', owner_user_id: U, revision: 1, updated_at_ms: 0 });
    for (let i = 0; i < 4; i++) {
        const before = starts.length;
        await runtime.tick(); await flush();
        assert(starts.length - before <= 2);
        if (i === 0) assert(starts.slice(before).includes('07'), 'new registrations must not be starved by refreshes');
    }
    assert.equal(runtime.status().sessions, 7);
    assert.deepEqual(starts.slice(6).sort(), rows.map(row => row.id));
});

for (const pageSize of [1, 2, 100]) test(`continuous refreshes do not starve the final new candidate with page size ${pageSize}`, async t => {
    const rows = Array.from({ length: pageSize }, (_, index) => ({ id: String(index + 1).padStart(2, '0'),
        owner_user_id: U, revision: 1, updated_at_ms: 0 }));
    const active = new Set(), starts = []; let duplicates = 0, peakActive = 0;
    const gateway = { store: {}, run: input => {
        if (active.has(input.subscriptionId)) duplicates++;
        active.add(input.subscriptionId); starts.push(input.subscriptionId);
        peakActive = Math.max(peakActive, active.size);
        return new Promise(resolve => {
            const finish = () => { active.delete(input.subscriptionId); resolve({ state: 'stopped' }); };
            if (input.signal.aborted) finish(); else input.signal.addEventListener('abort', finish, { once: true });
        });
    } };
    const runtime = createXPushRuntime({ queryDatabase: async () => assert.fail('unexpected query') }, {}, {
        enabled: true, processingPolicy: 'batch', rolloutMode: 'public', gateway, assertAllowed: () => {},
        pageSize, maxConnections: pageSize + 1,
        listCandidates: async cursor => rows.filter(row => row.id > cursor).slice(0, pageSize).map(row => ({ ...row })),
        listActiveSessions: async ids => rows.filter(row => ids.includes(row.id)).map(row => ({ ...row })),
    });
    t.after(() => runtime.stop());
    await runtime.tick(); await flush();
    assert.equal(active.size, pageSize);
    const newId = String(pageSize + 1).padStart(2, '0');
    rows.push({ id: newId, owner_user_id: U, revision: 1, updated_at_ms: 0 });
    for (let i = 0; i < 12 && !starts.includes(newId); i++) {
        for (const row of rows.slice(0, pageSize)) row.updated_at_ms++;
        const before = starts.length;
        await runtime.tick(); await flush();
        assert(starts.length - before <= pageSize, 'refreshes and registrations share the start limit');
        assert(active.size <= pageSize + 1, 'maxConnections stays enforced');
    }
    assert(starts.includes(newId), 'a new registration must not be skipped while refreshes keep arriving');
    assert.equal(duplicates, 0); assert(peakActive <= pageSize + 1);
    await runtime.stop(); assert.equal(active.size, 0);
});

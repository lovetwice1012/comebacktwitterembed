'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createXPushRuntime, reconnectDelay } = require('../../src/automation/x-push-runtime');
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

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { normalizeXNotification, matchesXMonitor, createXEventRouter } = require('../../src/automation/x-event-router');
const payload = (changes = {}) => ({ notificationType: 'tweet', url: 'https://x.com/example/status/1234567890123456789', author: { id: '12345', handle: 'example' }, title: '公開投稿', text: '本文', ...changes });

test('X public-post adapter emits only admitted event fields and never invents publication time or media', () => {
    const normalized = normalizeXNotification(payload(), { receivedAtMs: 1000 });
    assert.deepEqual(normalized, { authorAccountId: '12345', authorHandle: 'example', event: {
        providerId: 'twitter', kind: 'new', sourceKey: '12345', contentId: '1234567890123456789', url: 'https://x.com/example/status/1234567890123456789',
        author: 'example', title: '公開投稿', body: '本文', observedAtMs: 1000,
    } });
    assert(Object.isFrozen(normalized)); assert(Object.isFrozen(normalized.event));
    assert.equal(normalized.event.publishedAtMs, undefined); assert.equal(normalized.event.media, undefined);
    assert.deepEqual(normalizeXNotification(Buffer.from(JSON.stringify(payload())), { receivedAtMs: 1000 }), normalized);
});

test('X adapter rejects unknown, private, login, arbitrary JSON and noncanonical URLs without reflecting content', () => {
    const secret = 'private-secret-sentinel';
    const bad = [null, [], {}, '{invalid-json', Buffer.from([0xff]), 'a'.repeat(65537), { body: secret }, payload({ notificationType: 'dm', text: secret }), payload({ token: secret }),
        payload({ url: 'https://evil.example/example/status/1' }), payload({ url: 'http://x.com/example/status/1' }),
        payload({ url: 'https://x.com@example.net/example/status/1' }), payload({ url: 'https://x.com/example/status/1?redirect=secret' }),
        payload({ url: 'https://x.com/example/status/1#secret' }), payload({ url: 'https://x.com/i/web/status/1' }),
        payload({ url: 'https://x.com/%65xample/status/1' }), payload({ url: 'https://x.com/example/status/123456789012345678901' }),
        payload({ author: { id: 12345, handle: 'example' } }), payload({ author: { id: '12345', handle: 'someone' } }),
        payload({ title: 'a'.repeat(301) }), payload({ text: `bad\u0000${secret}` })];
    for (const value of bad) assert.throws(() => normalizeXNotification(value, { receivedAtMs: 1000 }), error => {
        assert.match(error.code, /^X_NOTIFICATION_/); assert(!error.message.includes(secret)); return true;
    });
});

test('numeric author identity overrides a matching handle and handle fallback requires a registered handle', () => {
    const normalized = normalizeXNotification(payload(), { receivedAtMs: 1000 });
    assert.equal(matchesXMonitor({ account_id: '12345', account_handle: null }, normalized), true);
    assert.equal(matchesXMonitor({ account_id: '999', account_handle: 'example' }, normalized), false);
    const withoutId = normalizeXNotification(payload({ author: { handle: 'ExAmPlE' } }), { receivedAtMs: 1000 });
    assert.equal(matchesXMonitor({ account_id: '12345', account_handle: 'example' }, withoutId), true);
    assert.equal(matchesXMonitor({ account_id: '12345', account_handle: null }, withoutId), false);
});

test('router selects only the inbox owner, bound subscription and matching public author', async () => {
    const ownerUserId = '222222222222222222', other = '333333333333333333', subscriptionId = randomUUID(), calls = [];
    const monitor = (id, owner, config = {}) => ({ id, owner_user_id: owner, account_id: '12345', account_handle: 'example', notification_settings_json: JSON.stringify({ subscriptionId, ...config }) });
    const db = { queryDatabase: async (sql, args) => { assert.match(sql, /owner_user_id=\?/); assert.deepEqual(args, [ownerUserId]); return [monitor('1', ownerUserId), monitor('2', other), monitor('3', ownerUserId, { subscriptionId: randomUUID() }), { ...monitor('4', ownerUserId), account_id: '999' }]; } };
    const router = createXEventRouter(db, { routeX: async input => { calls.push(input); return { state: 'routed' }; } }, { clock: () => 2000 });
    const result = await router.routeReceived({ lease: { ownerUserId, subscriptionId }, inbox: { id: '1', ownerUserId, subscriptionId, status: 'received', receivedAtMs: 1000 }, payload: payload() });
    assert.equal(result.state, 'routed'); assert.equal(calls.length, 1); assert.equal(calls[0].monitorId, '1'); assert.equal(calls[0].ownerUserId, ownerUserId);
    await assert.rejects(router.routeReceived({ lease: { ownerUserId, subscriptionId }, inbox: { id: '1', ownerUserId: other, subscriptionId, status: 'received', receivedAtMs: 1000 }, payload: payload() }), { code: 'X_NOTIFICATION_INBOX_INVALID' });
});

test('paused rules leave a received inbox retryable and unsupported payloads perform no DB or queue work', async () => {
    const ownerUserId = '222222222222222222', subscriptionId = randomUUID(); let reads = 0, routes = 0;
    const router = createXEventRouter({ queryDatabase: async () => { reads++; return [{ id: '1', owner_user_id: ownerUserId, account_id: '12345', notification_settings_json: JSON.stringify({ subscriptionId }) }]; } },
        { routeX: async () => { routes++; return { state: 'pending' }; } });
    const input = { lease: { ownerUserId, subscriptionId }, inbox: { id: '1', ownerUserId, subscriptionId, status: 'received', receivedAtMs: 1000 }, payload: payload() };
    assert.equal((await router.routeReceived(input)).state, 'pending');
    await assert.rejects(router.routeReceived({ ...input, payload: { notificationType: 'dm', text: 'private' } }), { code: 'X_NOTIFICATION_UNSUPPORTED' });
    assert.equal(reads, 1); assert.equal(routes, 1);
});

module.exports = { payload };

test('per-monitor router separates realtime fanout, retains matching batch/paused targets and passes trusted mode for locked admission', async t => {
    const policy = require('../../src/automation/x-processing-settings');
    t.mock.method(policy, 'inspectXMonitorProcessing', async (_query, row) => ({ effectiveMode: row.id === '1' ? 'realtime' : 'batch' }));
    const ownerUserId = '222222222222222222', subscriptionId = randomUUID(), calls = [];
    const monitor = (id, changes = {}) => ({ id, owner_user_id: ownerUserId, account_id: '12345', enabled: 1, state: 'ready',
        notification_settings_json: JSON.stringify({ subscriptionId }), ...changes });
    let rows = [monitor('1'), monitor('2'), monitor('3', { enabled: 0 }), monitor('4', { state: 'suspended' })];
    const router = createXEventRouter({ queryDatabase: async () => rows }, { routeX: async input => { calls.push(input); return { state: 'routed' }; } });
    const lease = { ownerUserId, subscriptionId }, inbox = { id: '1', ownerUserId, subscriptionId, status: 'received', receivedAtMs: 1000 };
    assert.equal(await router.hasRealtimeTargets(lease), true); assert.equal(await router.hasBatchTargets(lease), true);
    assert.equal((await router.routeReceived({ lease, inbox, payload: payload(), processingMode: 'realtime' })).state, 'pending');
    assert.deepEqual(calls.map(row => [row.monitorId, row.processingMode]), [['1', 'realtime']]);
    calls.length = 0;
    assert.equal((await router.routeReceived({ lease, inbox, payload: payload(), processingMode: 'batch' })).state, 'pending');
    assert.deepEqual(calls.map(row => [row.monitorId, row.processingMode]), [['1', 'batch'], ['2', 'batch']]);
    rows = [monitor('2')]; calls.length = 0;
    assert.equal((await router.routeReceived({ lease, inbox, payload: payload(), processingMode: 'realtime' })).state, 'pending');
    assert.equal(calls.length, 0);
    rows = [monitor('2', { account_id: '999' })];
    assert.equal((await router.routeReceived({ lease, inbox, payload: payload(), processingMode: 'realtime' })).state, 'unmatched');
    await assert.rejects(router.routeReceived({ lease, inbox, payload: payload(), processingMode: 'guessed' }), { code: 'X_NOTIFICATION_INBOX_INVALID' });
});

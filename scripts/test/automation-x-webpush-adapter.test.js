'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { normalizeXNotification, matchesXMonitor, createXEventRouter, inspectXWebPushPostCandidate } = require('../../src/automation/x-event-router');

// Synthetic values in the envelope declared by X's public service worker.
// This is a source-contract test, not a captured or delivered real X push.
const sourceEnvelope = (changes = {}) => ({ title: 'Example の投稿', body: '投稿本文', tag: 'source-contract-fixture',
    data: { uri: '/Example/status/1234567890123456789', tweet_id: '1234567890123456789', user_id: '99999' }, ...changes });
const inspect = inspectXWebPushPostCandidate;

test('official title/body/data envelope uses the explicit permalink and never treats user_id as its author', () => {
    const result = inspect(sourceEnvelope());
    assert.equal(result.authorAccountId, null);
    assert.equal(result.authorHandle, 'Example');
    assert.equal(result.postId, '1234567890123456789');
    assert.equal(result.postUrl, 'https://x.com/Example/status/1234567890123456789');
    assert.equal(result.body, '投稿本文');
    assert.equal(result.kind, undefined);
    assert.equal(result.event, undefined);
    assert.equal(result.publishedAtMs, undefined);
    assert.equal(JSON.stringify(result).includes('99999'), false);
    assert.equal(result.media, undefined);
    assert.equal(matchesXMonitor({ account_id: '99999', account_handle: null }, result), false);
    assert.equal(matchesXMonitor({ account_id: '12345', account_handle: 'example' }, result), true);
    assert.equal(matchesXMonitor({ account_id: '99999', account_handle: 'different' }, result), false);
});

test('absolute X permalink produces the same inspection candidate without source metadata', () => {
    const data = { ...sourceEnvelope().data, uri: 'https://x.com/Example/status/1234567890123456789',
        type: 'tweet', impression_id: 'SOURCE-IMPRESSION', scribe_target: 'tweet', lang: 'ja', silent: false, totalCount: 1,
        multi_title: '複数通知の表示文', multi_body: '複数通知の本文', multi_uri: '/notifications', bundle_text: '表示用ひな形' };
    const result = inspect(sourceEnvelope({ data, icon: 'https://pbs.twimg.com/profile_images/example.png', timestamp: '100' }));
    assert.deepEqual(result, inspect(sourceEnvelope()));
    assert.equal(JSON.stringify(result).includes('SOURCE-IMPRESSION'), false);
    assert.equal(JSON.stringify(result).includes('profile_images'), false);
    assert.equal(result.publishedAtMs, undefined);
});

test('DM, calls, account, login, silent and xchat notifications never enter post candidate inspection', () => {
    const original = sourceEnvelope();
    const bad = [
        { ...original, data: { ...original.data, xchat_message: {} } },
        { ...original, data: { ...original.data, xchat_delete: null } },
        { ...original, data: { ...original.data, silent: true } },
        { ...original, data: { ...original.data, silent: 'false' } },
        { ...original, data: { ...original.data, uri: '/i/chat/1-2' } },
    ];
    for (const field of ['type', 'scribe_target']) for (const kind of ['dm', 'dm_av', 'rweb_dm', 'avcall_created', 'xchat_message', 'login', 'authentication', 'security', 'system', 'account_alert'])
        bad.push({ ...original, data: { ...original.data, [field]: kind } });
    for (const value of bad) assert.throws(() => inspect(value), error => /^X_NOTIFICATION_/.test(error.code));
});

test('post identity requires a canonical handle permalink and the exact string tweet_id', () => {
    const original = sourceEnvelope();
    const uris = [undefined, '', '/notifications', '/i/web/status/1234567890123456789', '/i/status/1234567890123456789',
        '/intent/status/1234567890123456789', '/Example/status/2', '//x.com/Example/status/1234567890123456789',
        'http://x.com/Example/status/1234567890123456789', 'https://twitter.com/Example/status/1234567890123456789',
        'https://x.com@example.org/Example/status/1234567890123456789', 'https://example.org/Example/status/1234567890123456789',
        '/Example/status/1234567890123456789?foo=bar', '/Example/status/1234567890123456789#fragment',
        '/%45xample/status/1234567890123456789', '/Example/status/1234567890123456789/', '/Example/../Example/status/1234567890123456789'];
    for (const uri of uris) assert.throws(() => inspect({ ...original, data: { ...original.data, uri } }), error => error.code === 'X_NOTIFICATION_INVALID_POST');
    for (const tweet_id of [undefined, null, 1234567890123456700, '0', '-1', '01', '1'.repeat(21), '2'])
        assert.throws(() => inspect({ ...original, data: { ...original.data, tweet_id } }), error => error.code === 'X_NOTIFICATION_INVALID_POST');
});

test('malformed and oversized source envelopes fail before routing, without reflecting payload values', () => {
    const sentinel = 'PRIVATE-PAYLOAD-SENTINEL';
    const original = sourceEnvelope();
    const bad = [
        { data: original.data }, { title: null, data: original.data }, { ...original, body: sentinel + '\u0000' },
        { ...original, title: 'a'.repeat(301) }, { ...original, body: 'a'.repeat(10001) },
        { ...original, icon: 'a'.repeat(4097) }, { ...original, timestamp: {} }, { ...original, timestamp: Infinity },
        { ...original, data: [] }, { ...original, data: { ...original.data, totalCount: 2 } },
        { ...original, data: { ...original.data, type: {} } }, { ...original, data: { ...original.data, user_id: 99999 } },
        { ...original, data: { ...original.data, cookies: sentinel } }, { ...original, credentials: sentinel },
        { ...original, notificationType: 'dm' },
        Object.defineProperty({ ...original }, 'title', { get() { assert.fail('getters must never be invoked'); }, enumerable: true }),
    ];
    for (const value of bad) assert.throws(() => inspect(value), error => {
        assert.match(error.code, /^X_NOTIFICATION_/);
        assert.equal(error.message.includes(sentinel), false);
        return true;
    });
});

test('source envelopes and all unverified post-type strings stay outside delivery even with a canonical post link', async () => {
    const ownerUserId = '222222222222222222', subscriptionId = randomUUID();
    let queries = 0, routes = 0;
    const router = createXEventRouter({ queryDatabase: async () => { queries++; assert.fail('unverified envelopes must not read monitor data'); } },
        { routeX: async () => { routes++; assert.fail('unverified envelopes must not be admitted'); } });
    const input = { lease: { ownerUserId, subscriptionId }, inbox: { id: '1', ownerUserId, subscriptionId, status: 'received', receivedAtMs: 1000 }, payload: sourceEnvelope() };
    for (const type of [undefined, 'tweet', 'new_tweet', 'favorite', 'retweet', 'mention', 'reply', 'unknown', 'dm_av', 'system', 'login']) {
        const payload = sourceEnvelope({ data: { ...sourceEnvelope().data, ...(type === undefined ? {} : { type }) } });
        for (const value of [payload, JSON.stringify(payload), Buffer.from(JSON.stringify(payload))])
            assert.throws(() => normalizeXNotification(value, { receivedAtMs: 1000 }), { code: 'X_NOTIFICATION_UNSUPPORTED' });
        await assert.rejects(router.routeReceived({ ...input, payload }), { code: 'X_NOTIFICATION_UNSUPPORTED' });
    }
    assert.equal(queries, 0);
    assert.equal(routes, 0);
});

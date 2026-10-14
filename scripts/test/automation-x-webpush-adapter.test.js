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

test('candidate identity requires a canonical handle permalink and exact tweet_id whenever supplied', () => {
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
        { ...original, notificationType: 'dm' },
        Object.defineProperty({ ...original }, 'title', { get() { assert.fail('getters must never be invoked'); }, enumerable: true }),
    ];
    for (const value of bad) assert.throws(() => inspect(value), error => {
        assert.match(error.code, /^X_NOTIFICATION_/);
        assert.equal(error.message.includes(sentinel), false);
        return true;
    });
});

test('a source post-link candidate and its type string alone grant no delivery admission', async () => {
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

const POST_ID = '1234567890123456789';
// Synthetic placeholders reproduce only the safely inspected production shape:
// matching tweet/type/scribe/tag-ID, no tweet_id/user_id, and opaque extras.
// No real notification text, author, IDs or transfer credentials are copied.
const observedEnvelope = () => ({ title: 'Example の新しい投稿', body: '合成した公開本文',
    tag: `tweet-${POST_ID}`, icon: 'https://example.invalid/icon.png', timestamp: '2026-01-01T00:00:00Z',
    display_metadata: { synthetic: true },
    data: { type: 'tweet', scribe_target: 'tweet', uri: `/Example/status/${POST_ID}`, bundle_text: '合成表示ひな形',
        impression_id: 'SYNTHETIC-IMPRESSION', lang: 'ja', opaque_one: 'synthetic', opaque_two: 1, opaque_three: { valid: true } } });
const normalize = value => normalizeXNotification(value, { receivedAtMs: 1000 });
const rejected = value => assert.throws(() => normalize(value), error => /^X_NOTIFICATION_/.test(error.code));

test('the observed exact type/scribe/tweet-ID-tag envelope derives the post ID without a tweet_id field', () => {
    const original = observedEnvelope(), result = normalize(original);
    assert.deepEqual(result, { authorAccountId: null, authorHandle: 'Example', event: {
        providerId: 'twitter', kind: 'new', sourceKey: 'example', contentId: POST_ID,
        url: `https://x.com/Example/status/${POST_ID}`, author: 'Example', title: original.title,
        body: original.body, observedAtMs: 1000,
    } });
    assert(Object.isFrozen(result)); assert(Object.isFrozen(result.event));
    for (const encoded of [JSON.stringify(original), Buffer.from(JSON.stringify(original)), new Uint8Array(Buffer.from(JSON.stringify(original)))])
        assert.deepEqual(normalize(encoded), result);
    assert.equal(result.event.publishedAtMs, undefined); assert.equal(result.event.media, undefined);
    assert.equal(inspect({ ...original, timestamp: undefined }).postId, POST_ID);
});

test('each exact observed post discriminator and the canonical tag suffix must agree', () => {
    for (const field of ['type', 'scribe_target']) for (const value of [undefined, null, '', 'Tweet', 'new_tweet', 'rweb_tweet', 'favorite', 'retweet', 'mention', 'reply', 'quote', 'follow', 'dm', 'dm_av', 'login', 'unknown']) {
        const payload = observedEnvelope(); payload.data[field] = value; rejected(payload);
    }
    for (const tag of [undefined, null, '', 'tweet', 'tweet-2', `tweet-${POST_ID}-extra`, `rweb_tweet-${POST_ID}`,
        `favorite-${POST_ID}`, `reply-${POST_ID}`, `tweet_\u200b${POST_ID}`, `tweet-0${POST_ID}`, `Tweet-${POST_ID}`])
        rejected({ ...observedEnvelope(), tag });
    for (const field of ['type', 'scribe_target']) {
        const payload = observedEnvelope(); delete payload.data[field]; rejected(payload);
    }
});

test('optional tweet_id is checked when present and recipient user_id never establishes the author', () => {
    const original = observedEnvelope();
    assert.deepEqual(normalize({ ...original, data: { ...original.data, tweet_id: POST_ID } }), normalize(original));
    for (const tweet_id of [undefined, null, Number(POST_ID), '', '0', '2', `0${POST_ID}`])
        rejected({ ...original, data: { ...original.data, tweet_id } });
    const result = normalize({ ...original, data: { ...original.data, user_id: '99999' } });
    assert.equal(result.authorAccountId, null);
    assert.equal(matchesXMonitor({ account_id: '99999', account_handle: null }, result), false);
    assert.equal(matchesXMonitor({ account_id: '99999', account_handle: 'someone_else' }, result), false);
    assert.equal(matchesXMonitor({ account_id: '12345', account_handle: 'eXaMpLe' }, result), true);
});

test('canonical URI identity is mandatory even when every post discriminator agrees', () => {
    for (const uri of [undefined, '', '/notifications', `/i/status/${POST_ID}`, `/I/status/${POST_ID}`, `/intent/status/${POST_ID}`,
        `/i/web/status/${POST_ID}`, `/Example/status/${POST_ID}?redirect=1`, `/Example/status/${POST_ID}#fragment`,
        `/Example/status/${POST_ID}/`, `/Example/../Example/status/${POST_ID}`, `https://twitter.com/Example/status/${POST_ID}`,
        `http://x.com/Example/status/${POST_ID}`, `https://x.com@evil.invalid/Example/status/${POST_ID}`, `/Example/status/0${POST_ID}`]) {
        const payload = observedEnvelope(); payload.data.uri = uri; rejected(payload);
    }
    const absolute = observedEnvelope(); absolute.data.uri = `https://x.com/Example/status/${POST_ID}`;
    assert.deepEqual(normalize(absolute), normalize(observedEnvelope()));
});

test('private, silent and bundled notices stay excluded even when their post-looking fields agree', () => {
    for (const extra of [{ xchat_message: null }, { xchat_delete: {} }, { silent: true }, { silent: 'false' },
        { totalCount: 0 }, { totalCount: 2 }, { totalCount: '1' }]) {
        const payload = observedEnvelope(); Object.assign(payload.data, extra); rejected(payload);
    }
    const valid = observedEnvelope(); Object.assign(valid.data, { silent: false, totalCount: 1 });
    assert.deepEqual(normalize(valid), normalize(observedEnvelope()));
    rejected({ ...observedEnvelope(), notificationType: 'dm' });
});

test('bounded opaque metadata is ignored and is never publication time, author, media or normalized content', () => {
    const payload = observedEnvelope(), sentinel = 'OPAQUE-PRIVATE-SENTINEL';
    payload.extra = { credentials: sentinel, nested: [true, null, 17, { text: sentinel }] };
    payload.data.extra = { author: { id: '99999', handle: 'someone_else' }, url: 'https://evil.invalid/' };
    payload.timestamp = { ignored: sentinel }; payload.icon = { ignored: sentinel };
    const result = normalize(payload);
    assert.deepEqual(result, normalize(observedEnvelope()));
    assert.equal(JSON.stringify(result).includes(sentinel), false);
    assert.equal(result.event.observedAtMs, 1000);
    assert.equal(result.event.publishedAtMs, undefined); assert.equal(result.event.media, undefined);
});

test('wire bytes and decoded object payloads enforce the same 64 KiB bound including JSON escaping', () => {
    const payload = observedEnvelope(); payload.padding = '';
    payload.padding = 'a'.repeat(65536 - Buffer.byteLength(JSON.stringify(payload)));
    assert.equal(Buffer.byteLength(JSON.stringify(payload)), 65536);
    assert.equal(normalize(payload).event.contentId, POST_ID);
    assert.equal(normalize(JSON.stringify(payload)).event.contentId, POST_ID);
    payload.padding += 'a'; rejected(payload); rejected(JSON.stringify(payload));
    const escaped = observedEnvelope(); escaped.padding = '\u0000'.repeat(12000); rejected(escaped);
    const unicode = observedEnvelope(); unicode.padding = '界'.repeat(22000); rejected(unicode);
});

test('ignored metadata cannot invoke getters, toJSON, unusual prototypes or exceed depth and node bounds', () => {
    let invoked = 0;
    const accessor = () => Object.defineProperty({}, 'value', { enumerable: true, get() { invoked++; return 'private'; } });
    for (const extra of [accessor(), { nested: accessor() }, { toJSON() { invoked++; return {}; } }, new Date(), new Map(), 1n, Symbol('private')])
        rejected({ ...observedEnvelope(), extra });
    const proxy = new Proxy({}, { getPrototypeOf() { invoked++; throw new Error('private'); }, ownKeys() { invoked++; throw new Error('private'); } });
    rejected(proxy); rejected({ ...observedEnvelope(), extra: proxy });
    const top = observedEnvelope(); Object.defineProperty(top, 'title', { get() { invoked++; return 'private'; } }); rejected(top);
    const data = observedEnvelope(); Object.defineProperty(data.data, 'type', { get() { invoked++; return 'tweet'; } }); rejected(data);
    const cyclic = observedEnvelope(); cyclic.extra = cyclic; rejected(cyclic);
    const symbol = observedEnvelope(); symbol[Symbol('private')] = 'private'; rejected(symbol);
    let deep = null; for (let index = 0; index < 35; index++) deep = { nested: deep }; rejected({ ...observedEnvelope(), deep });
    rejected({ ...observedEnvelope(), many: Array(8192).fill(null) });
    assert.equal(invoked, 0);
});

test('a real-envelope post routes only matching active monitors of the inbox owner and returns unmatched explicitly', async () => {
    const ownerUserId = '222222222222222222', other = '333333333333333333', subscriptionId = randomUUID(), calls = [];
    const monitor = (id, changes = {}) => ({ id, owner_user_id: ownerUserId, account_id: '12345', account_handle: 'example', enabled: 1,
        state: 'ready', notification_settings_json: JSON.stringify({ subscriptionId }), ...changes });
    let rows = [monitor('1'), monitor('2', { owner_user_id: other }), monitor('3', { notification_settings_json: JSON.stringify({ subscriptionId: randomUUID() }) }),
        monitor('4', { account_handle: 'someone_else' }), monitor('5', { account_handle: null }), monitor('6', { enabled: 0 }), monitor('7', { state: 'suspended' })];
    const router = createXEventRouter({ queryDatabase: async (sql, values) => {
        assert.match(sql, /owner_user_id=\?.*state='ready'.*enabled=1/); assert.deepEqual(values, [ownerUserId]); return rows;
    } }, { routeX: async input => { calls.push(input); return { state: 'routed' }; } });
    const input = { lease: { ownerUserId, subscriptionId }, inbox: { id: '1', ownerUserId, subscriptionId, status: 'received', receivedAtMs: 1000 }, payload: observedEnvelope() };
    assert.equal((await router.routeReceived(input)).state, 'routed');
    assert.equal(calls.length, 1); assert.equal(calls[0].monitorId, '1');
    rows = rows.slice(1);
    assert.deepEqual(await router.routeReceived(input), { state: 'unmatched', results: [] });
    assert.equal(calls.length, 1);
    rows = []; assert.deepEqual(await router.routeReceived(input), { state: 'unmatched', results: [] });
});

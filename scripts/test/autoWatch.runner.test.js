'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tick, _internal } = require('../../src/providers/autoWatch/runner');
const { initialCursor } = require('../../src/providers/autoWatch');

function source(overrides = {}) {
    return {
        id: 'source-1', provider_id: 'youtube', source_key: 'channel:UC_x5XG1OV2P6uZZ5FSM9Ttw',
        source_url: 'https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw', state_json: '{}', cursor_json: null,
        initialized_at_ms: null, poll_interval_ms: 30000, failure_count: 0, lease_token: 'lease-1',
        ...overrides,
    };
}

function baseStore(sourceRows) {
    const calls = { complete: [], create: [], reschedule: [], sent: [], failure: [] };
    return {
        calls,
        activeSourceCounts: async () => new Map([['youtube', 1]]),
        claimDueSources: async () => sourceRows,
        computedPollInterval: () => 30000,
        policyFor: () => ({ requestCost: 1, globalSpacingMs: 0 }),
        reserveProviderRequest: async () => ({ allowed: true }),
        recordProviderRateLimit: async () => {},
        completeSource: async (_source, result) => calls.complete.push(result),
        async completeBacklog(source, result) { return this.completeSource(source, result); },
        createItemsAndDeliveries: async (_source, items) => calls.create.push(items),
        rescheduleSource: async (_source, when) => calls.reschedule.push(when),
        cooldownProvider: async () => {},
        failSource: async () => {},
        claimDueDeliveries: async () => [],
        markDeliverySent: async delivery => calls.sent.push(delivery),
        failDelivery: async (delivery, failure) => calls.failure.push({ delivery, failure }),
    };
}

test('first guest observation seeds the cursor without posting historical items', async () => {
    const store = baseStore([source()]);
    const result = await tick({
        now: 1000000,
        store,
        fetchSource: async () => ({
            items: [
                { contentId: 'old-1', url: 'https://example.test/old-1' },
                { contentId: 'old-2', url: 'https://example.test/old-2' },
            ],
            state: { channelId: 'UC_x5XG1OV2P6uZZ5FSM9Ttw' },
        }),
    });
    assert.equal(result.sources[0].status, 'seeded');
    assert.equal(store.calls.create.length, 0);
    assert.deepEqual(store.calls.complete[0].cursor.seenContentIds, ['old-1', 'old-2']);
});

test('initial YouTube tab baselines are not reported as new on the next observation', async () => {
    const historical = { contentId: 'post:old', url: 'https://example.test/post/old' };
    const oldVideo = { contentId: 'old-video', url: 'https://example.test/video/old' };
    const fresh = { contentId: 'post:new', url: 'https://example.test/post/new' };
    const store = baseStore([source()]);
    const first = await tick({ now: 1000000, store, fetchSource: async () => ({ items: [oldVideo], baselineItems: [historical], state: {} }) });
    assert.equal(first.sources[0].status, 'seeded');
    assert.deepEqual(store.calls.complete[0].cursor.seenContentIds, ['old-video', 'post:old']);
    assert.equal(store.calls.create.length, 0);

    store.claimDueSources = async () => [source({ initialized_at_ms: 1000000, cursor_json: JSON.stringify(store.calls.complete[0].cursor) })];
    const next = await tick({ now: 1030000, store, fetchSource: async () => ({ items: [fresh, historical, oldVideo], state: {} }) });
    assert.equal(next.sources[0].newItemCount, 1);
    assert.deepEqual(store.calls.create[0].map(item => item.contentId), ['post:new']);
});

test('unreadable discovery cursors preserve history and fail before fetching or admitting items', async () => {
    for (const [cursor, code] of [
        [null, 'AUTO_WATCH_INVALID_CURSOR'], ['', 'AUTO_WATCH_INVALID_CURSOR'], ['null', 'AUTO_WATCH_INVALID_CURSOR'],
        ['{"seenContentIds":', 'AUTO_WATCH_INVALID_CURSOR'],
        [JSON.stringify({ seenContentIds: 'not-an-array' }), 'AUTO_WATCH_INVALID_CURSOR'],
        [JSON.stringify({ seenContentIds: null }), 'AUTO_WATCH_INVALID_CURSOR'],
        [JSON.stringify({ seenContentIds: ['old', { invalid: true }] }), 'AUTO_WATCH_INVALID_CURSOR'],
        [JSON.stringify({ seenContentIds: ['old'], baselineMaxNumericContentId: 'invalid' }), 'AUTO_WATCH_INVALID_CURSOR'],
        [JSON.stringify({ seenContentIds: ['old'], deferredObservations: 'unreadable' }), 'AUTO_WATCH_INVALID_BACKLOG'],
        [JSON.stringify({ seenContentIds: ['old'], deferredObservations: [['pending', -1]] }), 'AUTO_WATCH_INVALID_BACKLOG'],
        [JSON.stringify({ seenContentIds: ['old'], deferredItems: 'unreadable' }), 'AUTO_WATCH_INVALID_BACKLOG'],
        [JSON.stringify({ seenContentIds: ['old'], deferredItems: null }), 'AUTO_WATCH_INVALID_BACKLOG'],
    ]) {
        const item = source({ initialized_at_ms: 1, cursor_json: cursor }), store = baseStore([item]);
        let fetched = 0, failure;
        store.failSource = async (_source, value) => { failure = value; };
        const result = await tick({ now: 1000000, store, fetchSource: async () => { fetched++; return { items: [] }; } });
        assert.equal(result.sources[0].status, 'failed'); assert.equal(result.sources[0].errorCode, code);
        assert.equal(failure.error.code, code); assert.equal(fetched, 0);
        assert.equal(store.calls.complete.length, 0); assert.equal(store.calls.create.length, 0); assert.equal(item.cursor_json, cursor);
    }
    for (const value of [null, undefined, '', '{}', 'null']) assert.deepEqual(_internal.parseCursor(value), { seenContentIds: [] });
    assert.deepEqual(_internal.parseCursor('{"seenContentIds":["old"]}').seenContentIds, ['old']);
});

test('incomplete provider items cannot commit validators or lose later recoverable notifications', async () => {
    const cursor = JSON.stringify({ seenContentIds: ['old'], admissionVersion: 1 });
    for (const invalid of [undefined, { not: 'an array' }, [{ contentId: 'new', url: 'https://example.test/new' }, { contentId: 'missing-url' }],
        [{ contentId: { corrupted: true }, url: 'https://example.test/new' }], [{ contentId: 'new', url: { corrupted: true } }]]) {
        const item = source({ initialized_at_ms: 1, cursor_json: cursor, etag: 'old-etag' }), store = baseStore([item]);
        let failure;
        store.failSource = async (_source, value) => { failure = value; };
        const bad = await tick({ now: 1000000, store, fetchSource: async () => ({ items: invalid, etag: 'new-etag', state: {} }) });
        assert.equal(bad.sources[0].errorCode, 'AUTO_WATCH_INVALID_RESPONSE');
        assert.equal(failure.error.code, 'AUTO_WATCH_INVALID_RESPONSE');
        assert.equal(store.calls.complete.length, 0); assert.equal(store.calls.create.length, 0); assert.equal(item.etag, 'old-etag');
        const good = await tick({ now: 1060000, store, fetchSource: async () => ({ items: [{ contentId: 'new', url: 'https://example.test/new' }], etag: 'new-etag', state: {} }) });
        assert.equal(good.sources[0].newItemCount, 1);
        assert.deepEqual(store.calls.create[0].map(value => value.contentId), ['new']);
    }
});

test('a partial GitHub response cannot advance its checkpoint and a repaired response is admitted', async () => {
    const cursor = JSON.stringify({ seenContentIds: ['old'], admissionVersion: 1 });
    const item = source({ provider_id: 'github', source_key: 'octocat', initialized_at_ms: 1, cursor_json: cursor, etag: 'old-etag' });
    const store = baseStore([item]); let healthy = false, failure;
    store.failSource = async (_source, value) => { failure = value; };
    const fetchSource = require('../../src/providers/autoWatch').fetchSource;
    const run = () => tick({ now: 1000000, store, fetchSource: request => fetchSource(request, { fetch: async () => ({
        ok: true, status: 200, headers: { get: name => name.toLowerCase() === 'etag' ? 'new-etag' : null },
        body: require('node:stream').Readable.from([Buffer.from(JSON.stringify([
            { id: 'new', type: 'PushEvent', repo: { name: 'octocat/project' } },
            ...(healthy ? [] : [{ id: 'partial', type: 'PushEvent' }]),
        ]))]),
    }) }) });
    const failed = await run();
    assert.equal(failed.sources[0].errorCode, 'AUTO_WATCH_INVALID_RESPONSE');
    assert.equal(failure.error.code, 'AUTO_WATCH_INVALID_RESPONSE');
    assert.equal(store.calls.complete.length, 0);
    assert.equal(store.calls.create.length, 0);
    assert.equal(item.etag, 'old-etag');
    healthy = true;
    const recovered = await run();
    assert.equal(recovered.sources[0].newItemCount, 1);
    assert.equal(store.calls.complete[0].etag, 'new-etag');
    assert.equal(store.calls.create[0][0].contentId, 'new');
});

test('a partial Pixiv index cannot advance its checkpoint and a repaired index is admitted', async () => {
    const cursor = JSON.stringify({ seenContentIds: ['100'], admissionVersion: 1 });
    const item = source({ provider_id: 'pixiv', source_key: '123', initialized_at_ms: 1, cursor_json: cursor, etag: 'old-etag' });
    const store = baseStore([item]); let healthy = false, failure;
    store.failSource = async (_source, value) => { failure = value; };
    const fetchSource = require('../../src/providers/autoWatch').fetchSource;
    const run = () => tick({ now: 1000000, store, fetchSource: request => fetchSource(request, { config: { enableGuestCrawls: true }, fetch: async () => ({
        ok: true, status: 200, headers: { get: name => name.toLowerCase() === 'etag' ? 'new-etag' : null },
        body: require('node:stream').Readable.from([Buffer.from(JSON.stringify({ error: false,
            body: { illusts: healthy ? { 101: null } : null, manga: [] } }))]),
    }) }) });
    const failed = await run();
    assert.equal(failed.sources[0].errorCode, 'AUTO_WATCH_GUEST_CONTENT_UNAVAILABLE');
    assert.equal(failure.error.code, 'AUTO_WATCH_GUEST_CONTENT_UNAVAILABLE');
    assert.equal(store.calls.complete.length, 0);
    assert.equal(store.calls.create.length, 0);
    assert.equal(item.etag, 'old-etag');
    healthy = true;
    const recovered = await run();
    assert.equal(recovered.sources[0].newItemCount, 1);
    assert.equal(store.calls.complete[0].etag, 'new-etag');
    assert.equal(store.calls.create[0][0].contentId, '101');
});

test('unreadable source state cannot silently reset a monitoring baseline', async () => {
    const { fetchSource } = require('../../src/providers/autoWatch');
    const { parseState } = require('../../src/providers/autoWatch/_shared');
    for (const raw of ['{"youtubeTabs":', '{"private":"FIXTURE_PRIVATE_SENTINEL', '[]', '"unexpected"', 42]) {
        const item = source({ initialized_at_ms: 1, cursor_json: '{"seenContentIds":["old"]}', state_json: raw, etag: 'old-etag' });
        const store = baseStore([item]); let fetched = 0, failure;
        store.failSource = async (_source, value) => { failure = value; };
        const result = await tick({ now: 1000000, store, fetchSource: request => fetchSource(request, { fetch: async () => { fetched++; throw new Error('unexpected fetch'); } }) });
        assert.equal(result.sources[0].errorCode, 'AUTO_WATCH_INVALID_STATE');
        assert.equal(failure.error.code, 'AUTO_WATCH_INVALID_STATE'); assert.equal(fetched, 0);
        assert.equal(JSON.stringify(require('../../src/adminSupport/telemetry').errorData(failure.error)).includes('FIXTURE_PRIVATE_SENTINEL'), false);
        assert.equal(store.calls.complete.length, 0); assert.equal(store.calls.create.length, 0); assert.equal(item.state_json, raw);
    }
    for (const raw of [null, undefined, '', '{}', 'null']) assert.deepEqual(parseState(raw), {});
});

test('new-content scheduler records only an aggregate delay for a due source', async () => {
    const metric = require('../../src/adminSupport/databaseMetrics').sourceLag.auto, before = metric.snapshot().count;
    const store = baseStore([source({ next_check_at_ms: 1000 })]);
    await tick({ now: 2000, store, fetchSource: async () => ({ items: [], state: {} }) });
    assert.equal(metric.snapshot().count, before + 1);
});

test('later observation queues only new items and preserves the known cursor', async () => {
    const store = baseStore([source({ initialized_at_ms: 1, cursor_json: JSON.stringify({ seenContentIds: ['old-1'] }) })]);
    const result = await tick({
        now: 1000000,
        store,
        fetchSource: async () => ({
            items: [
                { contentId: 'new-1', url: 'https://example.test/new-1' },
                { contentId: 'old-1', url: 'https://example.test/old-1' },
            ],
            state: {},
        }),
    });
    assert.equal(result.sources[0].newItemCount, 1);
    assert.deepEqual(store.calls.create[0].map(item => item.contentId), ['new-1']);
    assert.deepEqual(store.calls.complete[0].cursor.seenContentIds, ['new-1', 'old-1']);
});

test('Pixiv baseline high-water mark suppresses old artwork beyond the stored ID window', async () => {
    const store = baseStore([source({
        provider_id: 'pixiv',
        initialized_at_ms: 1,
        cursor_json: JSON.stringify({ seenContentIds: ['6000'], baselineMaxNumericContentId: '6000' }),
    })]);
    const result = await tick({
        now: 1000000,
        store,
        fetchSource: async () => ({
            items: [
                { contentId: '5999', url: 'https://www.pixiv.net/artworks/5999' },
                { contentId: '6001', url: 'https://www.pixiv.net/artworks/6001' },
            ],
            state: {},
        }),
    });
    assert.equal(result.sources[0].newItemCount, 1);
    assert.deepEqual(store.calls.create[0].map(item => item.contentId), ['6001']);
});

test('large Pixiv first observation records its full visible baseline without historical replay', () => {
    const items = Array.from({ length: 2293 }, (_unused, index) => ({
        contentId: String(index + 1), url: `https://www.pixiv.net/artworks/${index + 1}`,
    }));
    const cursor = {
        ..._internal.advanceCursor({ seenContentIds: [] }, items, items, { seed: true }),
        ...initialCursor('pixiv', items),
    };
    assert.equal(cursor.seenContentIds.length, 2293);
    assert.equal(cursor.baselineMaxNumericContentId, '2293');
});

test('provider pacing reschedules a source before any upstream request', async () => {
    const store = baseStore([source()]);
    store.reserveProviderRequest = async () => ({ allowed: false, nextCheckAtMs: 2000000, reason: 'provider_pacing' });
    let fetched = false;
    const result = await tick({ now: 1000000, store, fetchSource: async () => { fetched = true; return {}; } });
    assert.equal(result.sources[0].status, 'paced');
    assert.equal(fetched, false);
    assert.deepEqual(store.calls.reschedule, [2000000]);
});

test('guarded router throttling keeps a delivery pending for the server-specified retry delay', async () => {
    const store = baseStore([]);
    const delivery = { id: 'delivery-1', provider_id: 'youtube', webhook_url: 'https://discord.com/api/webhooks/1/secret', content_url: 'https://example.test/new', attempt_count: 0 };
    store.claimDueDeliveries = async () => [delivery];
    store.routeAutomation = async () => { throw Object.assign(new Error('Throttled guarded router'), { code: 'AUTO_WATCH_DISCORD_RATE_LIMITED', status: 429, retryAfterMs: 7000 }); };
    const result = await tick({
        now: 1000000,
        store,
        fetch: async () => { assert.fail('No unguarded direct webhook fallback'); },
    });
    assert.equal(result.deliveries[0].errorCode, 'AUTO_WATCH_DISCORD_RATE_LIMITED');
    assert.equal(store.calls.failure[0].failure.nextAttemptAtMs, 1007000);
    assert.equal(store.calls.failure[0].failure.permanent, false);
});

test('recovery quarantine record never contains the signed webhook URL', () => {
    const record = _internal.recoveryRecordFor({
        id: 'delivery-1', item_id: 'item-1', target_id: 'target-1', provider_id: 'youtube',
        content_url: 'https://example.test/content', webhook_url: 'https://discord.com/api/webhooks/1/secret-token',
    });
    assert.deepEqual(record, {
        id: 'delivery-1', item_id: 'item-1', target_id: 'target-1', provider_id: 'youtube', content_url: 'https://example.test/content',
    });
    assert.doesNotMatch(JSON.stringify(record), /secret-token/);
});

test('pacing defers until the next available request slot, not a whole source polling cycle', async () => {
    const store = baseStore([source()]);
    store.reserveProviderRequest = async () => ({ allowed: false, nextCheckAtMs: 1005000 });
    await tick({ now: 1000000, store });
    assert.deepEqual(store.calls.reschedule, [1005000]);
});

test('Discord retry delay falls back to its body when the header is absent', () => {
    assert.equal(_internal.retryAfterFromResponse({ headers: { get: () => null } }, { retry_after: 3.5 }), 3500);
});

test('partial admission clears both validators durably and drains after restart before accepting 304', async () => {
    let saved = source({ initialized_at_ms: 1, etag: 'old', last_modified: 'old-date', cursor_json: JSON.stringify({ seenContentIds: ['old'] }) });
    const rows = Array.from({ length: 25 }, (_, index) => ({ contentId: `new-${index}`, url: `https://example.test/${index}` }));
    const admitted = [], requests = [];
    const store = baseStore([]);
    store.atomicSourceCompletion = true;
    store.completeSource = async (_source, result) => {
        admitted.push(...result.items || []);
        saved = { ...saved, cursor_json: JSON.stringify(result.cursor), etag: result.etag, last_modified: result.lastModified };
    };
    const fetchSource = async current => {
        requests.push({ etag: current.etag, lastModified: current.last_modified });
        return current.etag === 'new' || current.last_modified === 'new-date'
            ? { notModified: true, state: {} }
            : { items: rows, state: {}, etag: 'new', lastModified: 'new-date' };
    };
    const run = now => _internal.processSource(structuredClone(saved), { now, store, config: {}, fetchSource, sourceCounts: new Map() });
    const first = await run(1000000);
    assert.equal(first.deferredItemCount, 5);
    assert.equal(saved.etag, null); assert.equal(saved.last_modified, null);
    assert.equal(JSON.parse(saved.cursor_json).deferredObservations.length, 5);
    assert.equal((await run(2000000)).newItemCount, 5);
    assert.equal(admitted.length, 25); assert.equal(new Set(admitted.map(item => item.contentId)).size, 25);
    assert(admitted.every(item => item.discoveredAtMs === 1000000));
    assert.equal(JSON.parse(saved.cursor_json).deferredObservations, undefined);
    assert.equal(requests.length, 1, 'Draining a complete checkpoint never fetches upstream');
    assert.equal((await run(3000000)).newItemCount, 0);
    assert.equal(saved.etag, 'new'); assert.equal(saved.last_modified, 'new-date');
    assert.deepEqual(requests[1], { etag: null, lastModified: null });
    assert.equal((await run(4000000)).status, 'not_modified');
});

test('HTTP 304 cannot seed a first baseline or discard unadmitted discoveries', async () => {
    for (const current of [source(), source({ initialized_at_ms: 1, cursor_json: JSON.stringify({ seenContentIds: ['old'], deferredObservations: [['pending', 900000]] }) })]) {
        const store = baseStore([current]);
        const result = await tick({ now: 1000000, store, fetchSource: async request => {
            assert.equal(request.etag, null); assert.equal(request.last_modified, null);
            return { notModified: true, state: {} };
        } });
        assert.equal(result.sources[0].errorCode, 'AUTO_WATCH_INCOMPLETE_NOT_MODIFIED');
        assert.equal(store.calls.complete.length, 0);
        assert.equal(store.calls.create.length, 0);
    }
});

test('first full baseline acknowledges every visible item even when its size exceeds the admission batch', async () => {
    const store = baseStore([source()]);
    const rows = Array.from({ length: 25 }, (_, i) => ({ contentId: String(i), url: `https://example.test/${i}` }));
    await tick({ now: 1000000, store, fetchSource: async () => ({ items: rows, etag: 'initial', lastModified: 'date', state: {} }) });
    assert.equal(store.calls.create.length, 0);
    assert.equal(store.calls.complete[0].cursor.seenContentIds.length, 25);
    assert.equal(store.calls.complete[0].etag, 'initial');
});

test('legacy cursor with an already-advanced validator gets one unconditional repair observation', async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ contentId: String(i), url: `https://example.test/${i}` }));
    let saved = source({ initialized_at_ms: 1, etag: 'current', last_modified: 'current-date', cursor_json: JSON.stringify({ seenContentIds: items.slice(0, 20).map(item => item.contentId) }) });
    const store = baseStore([]);
    store.atomicSourceCompletion = true;
    store.completeSource = async (_source, result) => {
        store.calls.complete.push(result);
        saved = { ...saved, cursor_json: JSON.stringify(result.cursor), etag: result.etag, last_modified: result.lastModified };
    };
    const run = () => _internal.processSource(saved, { now: 1000000, store, config: {}, sourceCounts: new Map(), fetchSource: async request => request.etag === 'current'
        ? { notModified: true, state: {} } : { items, state: {}, etag: 'current', lastModified: 'current-date' } });
    assert.equal((await run()).newItemCount, 5);
    assert.equal(JSON.parse(saved.cursor_json).admissionVersion, 1);
    assert.equal((await run()).status, 'not_modified');
    assert.equal(store.calls.complete[0].items.length, 5);
});

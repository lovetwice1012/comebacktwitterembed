'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sourceProvider, monitorState, filterMonitors } = require('../../src/automation/monitor-input');
const { createMonitors } = require('../../src/automation/monitors');
const { dispatch } = require('../../src/automation/api');
const actor = { userId: '222222222222222222', guildId: '111111111111111111', canView: true, canEdit: true };

test('monitor URL inference respects domain boundaries, credentials, protocol and short-link services', () => {
    for (const [url, provider] of [
        ['https://www.youtube.com/@YouTube', 'youtube'], ['https://youtu.be/jNQXAC9IVRw', 'youtube'],
        ['https://github.com/octocat', 'github'], ['https://www.twitch.tv/twitch', 'twitch'],
        ['https://open.spotify.com/artist/0TnOYISbd1XYRBk9myaseg', 'spotify'], ['https://www.pixiv.net/users/123', 'pixiv'],
        ['https://lilxyzw.booth.pm/', 'booth'], ['https://store.steampowered.com/app/730/', 'steam'],
        ['https://www.amazon.in/dp/B08N5WRWNW', 'amazon'], ['https://amzn.to/abc', 'amazon'], ['https://s.team/a/730', 'steam'],
    ]) assert.equal(sourceProvider(url), provider, url);
    for (const url of ['https://youtube.com.evil.test/@user', 'https://evil.test/youtube.com/@user', 'https://user:secret@youtube.com/@user',
        'file://youtube.com/@user', 'not a URL', 'https://booth.pm.evil.test/']) assert.equal(sourceProvider(url), undefined, url);
});

test('state labels distinguish initial baseline, pause, rate limit, corruption and ordinary failures', () => {
    const rows = [
        { name: '初回', enabled: true, lastCheckedAtMs: 0 },
        { name: '稼働', enabled: true, lastCheckedAtMs: 1 },
        { name: '停止', enabled: false, errorCode: 'AUTO_WATCH_RATE_LIMITED' },
        { name: '待機', enabled: true, errorCode: 'AUTO_WATCH_RATE_LIMITED' },
        { name: '履歴', enabled: true, errorCode: 'AUTO_WATCH_INVALID_CURSOR' },
        { name: '不存在', enabled: true, errorCode: 'AUTO_WATCH_SOURCE_NOT_FOUND' },
    ];
    assert.deepEqual(rows.map(row => monitorState(row).id), ['initial', 'active', 'paused', 'waiting', 'error', 'error']);
    assert(monitorState(rows[4]).description.includes('復旧'));
    assert.match(monitorState({ kind: 'price', enabled: true }).description, /初回の価格/);
    assert.deepEqual(filterMonitors(rows, '', 'attention').map(row => row.name), ['待機', '履歴', '不存在']);
    assert.deepEqual(filterMonitors(rows, '停止', 'paused').map(row => row.name), ['停止']);
    assert.deepEqual(filterMonitors(rows, '', 'active').map(row => row.name), ['初回', '稼働', '待機', '履歴', '不存在']);
    assert.equal(filterMonitors([{ enabled: true, providerId: 'YouTube', source: 'https://youtube.com/@sample' }], 'youtube', 'all').length, 1);
});

test('format normalization preview covers all guest and price sources without provider HTTP or resource mutation', async () => {
    const forbidden = () => assert.fail('Normalization must perform no resource storage or provider HTTP');
    // Admission is explicitly trusted only in this format-only unit fixture.
    // Durable operation admission is covered by service-policy SQL tests.
    const service = { withOperation: async (_actor, _group, work) => work() };
    const monitors = createMonitors({ queryDatabase: forbidden, withDatabaseTransaction: forbidden }, service, {});
    const cases = [
        ['auto', 'youtube', '@YouTube', 'https://www.youtube.com/@youtube'],
        ['auto', 'github', 'octocat', 'https://github.com/octocat'],
        ['auto', 'twitch', 'twitch', 'https://www.twitch.tv/twitch'],
        ['auto', 'pixiv', '123', 'https://www.pixiv.net/users/123'],
        ['auto', 'booth', 'lilxyzw', 'https://lilxyzw.booth.pm/items'],
        ['auto', 'spotify', '0TnOYISbd1XYRBk9myaseg', 'https://open.spotify.com/artist/0TnOYISbd1XYRBk9myaseg'],
        ['price', 'steam', 'https://store.steampowered.com/app/730/', 'https://store.steampowered.com/app/730'],
        ['price', 'amazon', 'https://www.amazon.com/dp/B08N5WRWNW', 'https://amazon.com/dp/B08N5WRWNW'],
    ];
    for (const [kind, providerId, source, expected] of cases) {
        const result = await dispatch({ method: 'POST', path: ['monitors', kind, 'preview'], body: { providerId, source, locale: 'ja' } }, actor, { service, monitors });
        assert.equal(result.source, expected); assert.equal(result.verified, 'format_only');
        assert(result.intervalMinutes > 0); assert.equal(result.providerId, providerId);
    }
    await assert.rejects(monitors.preview(null, 'auto', {}));
    await assert.rejects(monitors.preview(actor, 'invalid', {}), { code: 'INVALID_MONITOR' });
    await assert.rejects(monitors.preview(actor, 'auto', { providerId: 'twitter', source: 'user' }), { code: 'UNSUPPORTED_PROVIDER' });
    await assert.rejects(monitors.preview(actor, 'auto', { providerId: 'youtube', source: 'https://youtu.be/jNQXAC9IVRw' }), error => error.code === 'INVALID_SOURCE' && error.message.includes('チャンネル'));
    await assert.rejects(monitors.preview(actor, 'auto', { providerId: 'youtube', source: 'x'.repeat(2001) }), { code: 'INVALID_SOURCE' });
    await assert.rejects(monitors.preview(actor, 'price', { providerId: 'amazon', source: 'https://amzn.to/short' }), { code: 'INVALID_SOURCE' });
    await assert.rejects(monitors.preview(actor, 'auto', { providerId: 'github', source: 'octocat', locale: 'invalid_locale' }), { code: 'INVALID_LOCALE' });
});

test('SQL monitor search finds rows beyond the first page, treats wildcards literally and excludes other owners', { skip: !process.env.AUTOMATION_TEST_DB_PORT }, async () => {
    const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try {
        const A = actor.userId, B = '333333333333333333'; await grantTestDonor(db, A); await grantTestDonor(db, B);
        const monitors = createMonitors(db, {}, {}), now = Date.now();
        for (let index = 1; index <= 103; index++) {
            const source = await db.queryDatabase("INSERT INTO auto_watch_sources (provider_id,source_key,source_url,poll_interval_ms,created_at_ms,last_error_code) VALUES ('github',?,?,360000,?,?)", [`fixture${index}`, `https://github.com/fixture${index}`, now, index === 100 ? 'AUTO_WATCH_RATE_LIMITED' : null]);
            const target = await db.queryDatabase("INSERT INTO auto_watch_targets (source_id,user_id,destination_type,destination_key,created_at_ms,enabled) VALUES (?,?,'dm',?,?,?)", [source.insertId, index === 102 ? B : A, `dm:${index}`, now, index === 101 ? 0 : 1]);
            await db.queryDatabase("INSERT INTO automation_monitors (target_kind,target_id,name,scope,revision) VALUES ('auto',?,?,'private',1)",
                [target.insertId, index === 101 || index === 102 ? 'target_100%' : index === 103 ? 'targetX100Z' : `通知${index}`]);
        }
        const page = await monitors.list(actor, 'auto'); assert.equal(page.items.length, 100); assert(page.nextCursor);
        const remaining = await monitors.list(actor, 'auto', page.nextCursor); assert.equal(remaining.items.length, 2);
        const literal = await dispatch({ method: 'GET', path: ['monitors', 'auto'], search: new URLSearchParams({ query: 'target_100%', state: 'all' }) }, actor, { monitors });
        assert.deepEqual(literal.items.map(row => row.name), ['target_100%']); assert.equal(literal.items[0].ownerId, A);
        assert.equal(literal.nextCursor, null);
        assert.equal((await monitors.list(actor, 'auto', '0', { query: 'target_100%', state: 'active' })).items.length, 0);
        assert.equal((await monitors.list(actor, 'auto', '0', { query: 'target_100%', state: 'paused' })).items.length, 1);
        assert.equal((await monitors.list(actor, 'auto', '0', { state: 'attention' })).items[0].name, '通知100');
        const privateOther = await monitors.list({ ...actor, userId: B, isAdmin: true }, 'auto', '0', { query: 'target_100%' });
        assert.equal(privateOther.items.length, 1); assert.equal(privateOther.items[0].ownerId, B);
        await assert.rejects(monitors.list(actor, 'auto', '0', { state: 'bad' }), { code: 'INVALID_FILTER' });
        await assert.rejects(monitors.list(actor, 'auto', '0', { query: 'x'.repeat(2001) }), { code: 'INVALID_FILTER' });
        const source = await db.queryDatabase("INSERT INTO price_watch_sources (provider_id,product_key,product_url,source_locale,poll_interval_ms,created_at_ms) VALUES ('steam','app:730','https://store.steampowered.com/app/730','ja',1800000,?)", [now]);
        const target = await db.queryDatabase("INSERT INTO price_watch_targets (source_id,user_id,destination_type,destination_key,watch_mode,rule_key,created_at_ms) VALUES (?,?,'dm','fixture-price','change','change',?)", [source.insertId, A, now]);
        await db.queryDatabase("INSERT INTO automation_monitors (target_kind,target_id,name,scope,revision) VALUES ('price',?,'価格検索','private',1)", [target.insertId]);
        assert.equal((await monitors.list(actor, 'price', '0', { query: '価格検索', state: 'active' })).items.length, 1);
    } finally { await db.close(); }
});

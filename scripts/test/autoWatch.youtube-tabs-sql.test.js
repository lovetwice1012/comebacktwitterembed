'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const { fetchSource } = require('../../src/providers/autoWatch');
const { _internal: runner } = require('../../src/providers/autoWatch/runner');
const f = require('./helpers/youtube-watch-fixture.cjs');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (port !== 33621) throw Error('YouTube acceptance requires disposable AUTOMATION_TEST_DB_PORT=33621');

test('YouTube SQL settings, atomic baseline/admission, shared-source isolation, rollback and restart', async t => {
    const db = await createTestDatabase(port), binding = require('../../src/db');
    const originals = { queryDatabase: binding.queryDatabase, withDatabaseTransaction: binding.withDatabaseTransaction };
    let injectFailure = false;
    binding.queryDatabase = async (sql, params) => {
        if (injectFailure && /INSERT IGNORE INTO auto_watch_deliveries/.test(sql)) throw Object.assign(new Error('fixture SQL failure'), { code: 'FIXTURE_ROLLBACK' });
        return db.queryDatabase(sql, params);
    };
    binding.withDatabaseTransaction = db.withDatabaseTransaction;
    try {
        for (const sql of require('../../src/db_schema').SCHEMA_STATEMENTS.filter(sql => /CREATE TABLE IF NOT EXISTS auto_watch_provider_/.test(sql))) await db.queryDatabase(sql);
        const service = createService(db), monitors = createMonitors(db, service, {});
        const users = ['222222222222222222', '333333333333333333', '444444444444444444'];
        const registrations = [];
        for (const [i, userId] of users.entries()) {
            await grantTestDonor(db, userId);
            const destination = await service.saveDestination({ userId }, { name: 'Fixture DM', kind: 'dm' });
            const input = { name: 'millsage', providerId: 'youtube', source: f.channel, destinationId: destination.id,
                ...(i ? { youtubeOptions: { releases: i === 2, community: true } } : {}) };
            const saved = await monitors.save({ userId }, 'auto', input);
            registrations.push({ userId, input, ...saved });
        }
        let now = Date.now() + 1000;
        const store = { ...require('../../src/providers/autoWatch/store'), reserveProviderRequest: async () => ({ allowed: true }), recordProviderRateLimit: async () => {} };
        const run = async scenario => {
            await db.queryDatabase('UPDATE auto_watch_sources SET next_check_at_ms=?,lease_expires_at_ms=0', [now]);
            const [source] = await store.claimDueSources(now, 1);
            assert(source); assert.equal(Number(source.youtube_fetch_releases), 1);
            return runner.processSource(source, { now, store, config: {}, sourceCounts: new Map([['youtube', 1]]),
                fetchSource: request => fetchSource(request, { fetch: f.fetchFixture(scenario) }) });
        };
        const deliveries = async () => db.queryDatabase(`SELECT t.user_id,i.content_key,d.status FROM auto_watch_deliveries d
            JOIN auto_watch_targets t ON t.id=d.target_id JOIN auto_watch_items i ON i.id=d.item_id ORDER BY t.user_id,i.content_key`);
        await t.test('migration adds safe defaults to legacy targets and can be applied idempotently', async () => {
            const migration = readFileSync(require('node:path').join(__dirname, '../../migrations/20261020_add_youtube_watch_options.sql'), 'utf8');
            const schema = require('../../src/db_schema')._internal;
            // Build an actual old-form temporary table in this disposable DB.
            await db.queryDatabase('CREATE TABLE youtube_legacy_fixture LIKE auto_watch_targets');
            for (const name of ['include_releases', 'include_community', 'releases_since_ms', 'community_since_ms', 'releases_baseline_at_ms', 'community_baseline_at_ms']) await db.queryDatabase(`ALTER TABLE youtube_legacy_fixture DROP COLUMN youtube_${name}`);
            await db.queryDatabase(`INSERT INTO youtube_legacy_fixture (user_id,source_id,destination_key,created_at_ms) VALUES (?,1,'fixture',0)`, [users[0]]);
            for (let pass = 0; pass < 2; pass++) for (const sql of schema.splitSqlStatements(migration)) {
                const adapted = sql.replace('auto_watch_targets', 'youtube_legacy_fixture');
                const column = schema.parseAddColumnStatement(adapted);
                if (!(await db.queryDatabase(`SHOW COLUMNS FROM ${column.table} LIKE ?`, [column.column])).length) await db.queryDatabase(adapted);
            }
            const [legacy] = await db.queryDatabase('SELECT youtube_include_releases,youtube_include_community FROM youtube_legacy_fixture');
            assert.equal(Number(legacy.youtube_include_releases), 1); assert.equal(Number(legacy.youtube_include_community), 0);
        });
        await t.test('initial observation quietly seeds all lanes and leaves slots, cadence and destinations intact', async () => {
            // Adopt the new lanes on an already-running legacy video watch.
            await db.queryDatabase('UPDATE auto_watch_sources SET initialized_at_ms=?,cursor_json=?', [now - 1, JSON.stringify({ admissionVersion: 1, seenContentIds: [f.oldVideo] })]);
            await db.queryDatabase('UPDATE auto_watch_targets SET baseline_at_ms=?', [now - 1]);
            const result = await run({ releases: [f.release()], posts: [f.post()] });
            assert.equal(result.status, 'processed'); assert.equal(result.newItemCount, 0);
            assert.deepEqual(await deliveries(), []);
            const cursor = JSON.parse((await db.queryDatabase('SELECT cursor_json FROM auto_watch_sources'))[0].cursor_json);
            assert(cursor.seenContentIds.includes(f.video)); assert(cursor.seenContentIds.includes(`post:${f.postId}`));
            for (const entry of registrations) {
                const listed = (await monitors.list({ userId: entry.userId }, 'auto')).items[0];
                assert.deepEqual(listed.youtubeOptions, entry.input.youtubeOptions || { releases: true, community: false });
                assert.equal(listed.destinationId, entry.input.destinationId); assert.equal(listed.slotCost, 1);
                assert.equal(listed.intervalMinutes, 30);
            }
        });
        await t.test('later new releases and posts route only to eligible targets, then survive restart without duplicate admission', async () => {
            now += 1800000;
            const scenario = { releases: [f.release('newVideo123'), f.release()], posts: [f.post('UgkxNextPost123456789'), f.post()] };
            assert.equal((await run(scenario)).newItemCount, 2);
            const rows = await deliveries();
            assert.deepEqual(rows.map(row => [row.user_id, row.content_key]), [[users[0], 'newVideo123'], [users[1], 'post:UgkxNextPost123456789'],
                [users[2], 'newVideo123'], [users[2], 'post:UgkxNextPost123456789']]);
            now += 1800000;
            assert.equal((await run(scenario)).newItemCount, 0); assert.equal((await deliveries()).length, 4);
        });
        await t.test('delivery SQL failure rolls back items, cursor and tab baseline together, then retries once', async () => {
            const before = (await db.queryDatabase('SELECT cursor_json,state_json FROM auto_watch_sources'))[0];
            const scenario = { releases: [f.release('laterVid123')], posts: [] };
            now += 1800000; injectFailure = true;
            assert.equal((await run(scenario)).status, 'failed'); injectFailure = false;
            assert.deepEqual((await db.queryDatabase('SELECT cursor_json,state_json FROM auto_watch_sources'))[0], before);
            assert.equal(Number((await db.queryDatabase("SELECT COUNT(*) AS n FROM auto_watch_items WHERE content_key='laterVid123'"))[0].n), 0);
            assert.equal((await run(scenario)).newItemCount, 1); assert.equal((await deliveries()).length, 6);
        });
        await t.test('options can be edited with CAS; stale, unauthorized and malformed writes are rejected', async () => {
            const first = registrations[0];
            const changed = await monitors.save({ userId: first.userId }, 'auto', { ...first.input, expectedRevision: first.revision, youtubeOptions: { releases: false, community: true } }, first.id);
            assert.equal(changed.revision, first.revision + 1);
            const row = (await monitors.list({ userId: first.userId }, 'auto')).items[0];
            assert.deepEqual(row.youtubeOptions, { releases: false, community: true }); assert.equal(row.slotCost, 1); assert.equal(row.destinationId, first.input.destinationId);
            await assert.rejects(monitors.save({ userId: first.userId }, 'auto', { ...first.input, expectedRevision: first.revision }, first.id), { code: 'REVISION_CONFLICT' });
            await assert.rejects(monitors.save({ userId: users[1] }, 'auto', { expectedRevision: changed.revision, youtubeOptions: { community: false } }, first.id), { code: 'NOT_FOUND' });
            await assert.rejects(monitors.save({ userId: first.userId }, 'auto', { ...first.input, expectedRevision: changed.revision, youtubeOptions: { community: 'true' } }, first.id), { code: 'INVALID_YOUTUBE_OPTIONS', status: 400 });
            const audits = await db.queryDatabase("SELECT action,detail_json FROM automation_audit WHERE entity_id=? ORDER BY id", [`auto:${first.id}`]);
            assert.deepEqual(audits.map(row => row.action), ['monitor.create', 'monitor.update']);
            assert.deepEqual(JSON.parse(audits[1].detail_json).youtubeOptions, { releases: false, community: true });
        });
        await t.test('enabling a lane on a shared active source quietly baselines only that target, even after SQL retry', async () => {
            const first = registrations[0];
            const snapshot = { posts: [f.post('UgkxDuringDisabled12345')] };
            now += 1800000; injectFailure = true;
            assert.equal((await run(snapshot)).status, 'failed'); injectFailure = false;
            assert.equal((await db.queryDatabase('SELECT youtube_community_baseline_at_ms FROM auto_watch_targets WHERE id=?', [first.id]))[0].youtube_community_baseline_at_ms, null);
            assert.equal((await run(snapshot)).newItemCount, 1);
            const rows = await deliveries();
            assert.deepEqual(rows.filter(row => row.content_key === 'post:UgkxDuringDisabled12345').map(row => row.user_id), users.slice(1));
            now += 1800000;
            assert.equal((await run({ posts: [f.post('UgkxAfterEnabled123456')] })).newItemCount, 1);
            assert.deepEqual((await deliveries()).filter(row => row.content_key === 'post:UgkxAfterEnabled123456').map(row => row.user_id), users);
        });
        await t.test('concurrent option saves are fenced by revision and cannot silently overwrite each other', async () => {
            const first = registrations[0], current = (await monitors.list({ userId: first.userId }, 'auto')).items[0];
            const results = await Promise.allSettled([true, false].map(releases => monitors.save({ userId: first.userId }, 'auto', {
                ...first.input, expectedRevision: current.revision, youtubeOptions: { releases, community: true } }, first.id)));
            assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
            assert.equal(results.find(result => result.status === 'rejected').reason.code, 'REVISION_CONFLICT');
        });
        await t.test('an in-flight poll that did not fetch posts cannot establish the baseline of a newly enabled target', async () => {
            await db.queryDatabase('UPDATE auto_watch_targets SET youtube_include_community=0,youtube_community_baseline_at_ms=NULL');
            now += 1800000;
            await db.queryDatabase('UPDATE auto_watch_sources SET next_check_at_ms=?,lease_expires_at_ms=0', [now]);
            const [captured] = await store.claimDueSources(now, 1);
            assert.equal(Number(captured.youtube_fetch_community), 0);
            const first = registrations[0], current = (await monitors.list({ userId: first.userId }, 'auto')).items[0];
            await monitors.save({ userId: first.userId }, 'auto', { ...first.input, expectedRevision: current.revision, youtubeOptions: { releases: true, community: true } }, first.id);
            const result = await runner.processSource(captured, { now, store, config: {}, sourceCounts: new Map([['youtube', 1]]),
                fetchSource: request => fetchSource(request, { fetch: f.fetchFixture() }) });
            assert.equal(result.status, 'processed');
            assert.equal((await db.queryDatabase('SELECT youtube_community_baseline_at_ms FROM auto_watch_targets WHERE id=?', [first.id]))[0].youtube_community_baseline_at_ms, null);
            now += 1800000;
            const before = (await deliveries()).length;
            assert.equal((await run({ posts: [f.post('UgkxAfterRace12345678')] })).newItemCount, 0);
            assert.equal((await deliveries()).length, before);
            assert.notEqual((await db.queryDatabase('SELECT youtube_community_baseline_at_ms FROM auto_watch_targets WHERE id=?', [first.id]))[0].youtube_community_baseline_at_ms, null);
        });
    } finally {
        Object.assign(binding, originals); await db.close();
    }
});

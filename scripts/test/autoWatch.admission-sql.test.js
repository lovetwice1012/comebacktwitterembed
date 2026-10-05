'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const { _internal: runner } = require('../../src/providers/autoWatch/runner');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);

test('SQL partial source admission preserves validators, observation time, failed deliveries and new-target baselines across restart/failure', { skip: !port }, async () => {
    const db = await createTestDatabase(port), binding = require('../../src/db');
    const originalQuery = binding.queryDatabase, originalTransaction = binding.withDatabaseTransaction;
    let injectFailure = false;
    binding.queryDatabase = async (sql, params) => {
        if (injectFailure && /INSERT IGNORE INTO auto_watch_deliveries/.test(sql)) throw new Error('fixture admission failure');
        return db.queryDatabase(sql, params);
    };
    binding.withDatabaseTransaction = db.withDatabaseTransaction;
    try {
        const service = createService(db), monitors = createMonitors(db, service, {});
        const target = async userId => {
            await require('../lib/automation-test-db').grantTestDonor(db, userId);
            const actor = { userId }, destination = await service.saveDestination(actor, { name: 'fixture DM', kind: 'dm' });
            return monitors.save(actor, 'auto', { name: 'fixture watch', providerId: 'github', source: 'octocat', destinationId: destination.id });
        };
        const first = await target('222222222222222222'), second = await target('333333333333333333');
        const row = (await db.queryDatabase('SELECT * FROM auto_watch_targets WHERE id=?', [first.id]))[0];
        let now = Date.now(), observationAt = now;
        await db.queryDatabase('UPDATE auto_watch_targets SET created_at_ms=? WHERE source_id=?', [now - 1000, row.source_id]);
        await db.queryDatabase('UPDATE auto_watch_targets SET baseline_at_ms=? WHERE id=?', [now - 500, first.id]);
        await db.queryDatabase('UPDATE auto_watch_sources SET initialized_at_ms=?,cursor_json=?,etag=?,last_modified=? WHERE id=?', [now - 500, '{"seenContentIds":[]}', 'v1', 'date1', row.source_id]);
        const store = { ...require('../../src/providers/autoWatch/store'), computedPollInterval: () => 30000,
            reserveProviderRequest: async () => ({ allowed: true }), recordProviderRateLimit: async () => {} };
        let items = Array.from({ length: 25 }, (_, i) => ({ contentId: String(i), title: `new ${i}`, url: `https://github.com/octocat/repo/releases/tag/${i}` }));
        const run = async () => {
            await db.queryDatabase('UPDATE auto_watch_sources SET lease_token=?,lease_expires_at_ms=? WHERE id=?', [randomUUID(), Date.now() + 60000, row.source_id]);
            const source = (await db.queryDatabase('SELECT * FROM auto_watch_sources WHERE id=?', [row.source_id]))[0];
            return runner.processSource(source, { now, store, config: {}, sourceCounts: new Map(), fetchSource: async request => {
                if (JSON.parse(source.cursor_json).deferredObservations?.length) { assert.equal(request.etag, null); assert.equal(request.last_modified, null); }
                return { items, state: {}, etag: 'v2', lastModified: 'date2' };
            } });
        };
        assert.equal((await run()).deferredItemCount, 5);
        const checkpoint = (await db.queryDatabase('SELECT cursor_json,etag,last_modified FROM auto_watch_sources WHERE id=?', [row.source_id]))[0];
        assert.equal(checkpoint.etag, null); assert.equal(checkpoint.last_modified, null);
        assert.equal(JSON.parse(checkpoint.cursor_json).deferredObservations.length, 5);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM auto_watch_deliveries WHERE target_id=?', [first.id]))[0].n), 20);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM auto_watch_deliveries WHERE target_id=?', [second.id]))[0].n), 0);
        await db.queryDatabase("UPDATE auto_watch_deliveries SET status='failed' WHERE target_id=? ORDER BY id LIMIT 1", [first.id]);
        const third = await target('444444444444444444');
        await db.queryDatabase('UPDATE auto_watch_targets SET created_at_ms=? WHERE id=?', [observationAt + 1, third.id]);
        now += 60000;
        items = [...items, { contentId: '26', title: 'new after baseline', url: 'https://github.com/octocat/repo/releases/tag/26' }];
        injectFailure = true;
        assert.equal((await run()).status, 'failed');
        injectFailure = false;
        assert.deepEqual((await db.queryDatabase('SELECT cursor_json,etag,last_modified FROM auto_watch_sources WHERE id=?', [row.source_id]))[0], checkpoint);
        assert.equal((await db.queryDatabase('SELECT baseline_at_ms FROM auto_watch_targets WHERE id=?', [third.id]))[0].baseline_at_ms, null);
        assert.equal((await run()).newItemCount, 6);
        const counts = await db.queryDatabase('SELECT target_id,COUNT(*) AS n FROM auto_watch_deliveries GROUP BY target_id');
        assert.deepEqual(counts.map(r => [String(r.target_id), Number(r.n)]), [[first.id, 26], [second.id, 1]]);
        assert.equal(Number((await db.queryDatabase("SELECT COUNT(*) AS n FROM auto_watch_deliveries WHERE status='failed'"))[0].n), 1);
        const deferred = (await db.queryDatabase("SELECT discovered_at_ms FROM auto_watch_items WHERE source_id=? AND content_key='24'", [row.source_id]))[0];
        assert.equal(Number(deferred.discovered_at_ms), observationAt);
        const completed = (await db.queryDatabase('SELECT cursor_json,etag,last_modified FROM auto_watch_sources WHERE id=?', [row.source_id]))[0];
        assert.equal(JSON.parse(completed.cursor_json).deferredObservations, undefined);
        assert.equal(completed.etag, 'v2'); assert.equal(completed.last_modified, 'date2');
        assert.equal((await run()).newItemCount, 0);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM auto_watch_deliveries'))[0].n), 27);
    } finally {
        binding.queryDatabase = originalQuery; binding.withDatabaseTransaction = originalTransaction;
        await db.close();
    }
});

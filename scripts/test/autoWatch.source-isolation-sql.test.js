'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);

test('SQL leases cover slow isolated acquisition and resource retries retain cursor and enabled targets', { skip: !port }, async () => {
    const db = await createTestDatabase(port);
    try {
        const filename = require.resolve('../../src/providers/autoWatch/store');
        const actualRequire = createRequire(filename), mod = { exports: {} };
        compileFunction(readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(
            id => id === '../../db' ? db : actualRequire(id), mod, mod.exports);
        const store = mod.exports, now = Date.now(), user = '222222222222222222';
        for (const sql of require('../../src/db_schema').SCHEMA_STATEMENTS.filter(sql => /CREATE TABLE IF NOT EXISTS auto_watch_provider_/.test(sql))) await db.queryDatabase(sql);
        const runnerFile = require.resolve('../../src/providers/autoWatch/runner'), runnerModule = { exports: {} }, runnerRequire = createRequire(runnerFile);
        compileFunction(readFileSync(runnerFile, 'utf8'), ['require', 'module', 'exports'], { filename: runnerFile })(
            id => id === '../../errorTracking' ? { recordError: () => {} } : runnerRequire(id), runnerModule, runnerModule.exports);
        const runner = runnerModule.exports._internal;
        await grantTestDonor(db, user);
        const cursor = JSON.stringify({ admissionVersion: 1, seenContentIds: ['oldVideo123'] });
        await db.queryDatabase("INSERT INTO auto_watch_sources (provider_id,source_key,source_url,poll_interval_ms,next_check_at_ms,created_at_ms,initialized_at_ms,cursor_json) VALUES ('youtube','fixture','https://www.youtube.com/channel/fixture',300000,?,?,?,?)", [now, now, now - 1000, cursor]);
        const id = (await db.queryDatabase('SELECT id FROM auto_watch_sources'))[0].id;
        await db.queryDatabase("INSERT INTO auto_watch_targets (source_id,user_id,destination_type,destination_key,enabled,created_at_ms,baseline_at_ms) VALUES (?,?,'dm',?,1,?,?)", [id, user, `dm:${user}`, now - 1000, now - 1000]);
        const [source] = await store.claimDueSources(now, 1, { timeoutMs: 120000 });
        assert.equal(Number(source.lease_expires_at_ms), now + 390000);
        assert.deepEqual(await store.claimDueSources(now + 120001), []);
        const result = await runner.processSource(source, { now, store, config: {}, sourceCounts: new Map([['youtube', 1]]),
            fetchSource: async () => { throw Object.assign(new Error('Isolated metadata pressure'), { code: 'AUTO_WATCH_RESOURCE_PRESSURE', retryAfterMs: 60000 }); } });
        assert.equal(result.status, 'failed');
        const saved = (await db.queryDatabase('SELECT * FROM auto_watch_sources WHERE id=?', [id]))[0];
        assert.equal(saved.cursor_json, cursor); assert.equal(Number(saved.initialized_at_ms), now - 1000);
        assert.equal(Number(saved.next_check_at_ms), now + 60000);
        assert.equal(Number((await db.queryDatabase('SELECT enabled FROM auto_watch_targets WHERE source_id=?', [id]))[0].enabled), 1);
    } finally { await db.close(); }
});

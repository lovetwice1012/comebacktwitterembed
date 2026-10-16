'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const schema = require('../../src/db_schema');
const root = path.resolve(__dirname, '../..'), port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const owner = '222222222222222222', newcomer = '333333333333333333';
function load(relative, replacements = {}) {
    const filename = path.join(root, relative), native = createRequire(filename), mod = { exports: {} };
    compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(id => Object.hasOwn(replacements, id) ? replacements[id] : native(id), mod, mod.exports);
    return mod.exports;
}
const runner = () => load('src/providers/autoWatch/runner.js', { '../../errorTracking': { recordError: () => {} } })._internal;
async function fixture(observationAt = Date.now() - 10000) {
    const db = await createTestDatabase(port);
    try {
        await grantTestDonor(db, owner); await grantTestDonor(db, newcomer);
        let fault = '';
        const binding = { ...db, ensureUserExistsInDatabase: id => db.queryDatabase('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,0)', [id]),
            queryDatabase: async (sql, params) => {
                if (fault === 'insert' && /INSERT IGNORE INTO auto_watch_deliveries/.test(sql)) throw new Error('Synthetic backlog transaction failure');
                const result = await db.queryDatabase(sql, params);
                if (fault === 'lease' && /INSERT IGNORE INTO auto_watch_deliveries/.test(sql)) {
                    await db.queryDatabase("UPDATE auto_watch_sources SET lease_token='lost-during-transaction'"); fault = '';
                }
                return result;
            } };
        const native = load('src/providers/autoWatch/store.js', { '../../db': binding, '../../db_schema': { ...schema, ensureDatabaseSchema: async () => {} } });
        const registered = await native.registerTarget({ userId: owner, providerId: 'github', source: 'octocat', destinationType: 'dm' }, { initialJitterMs: 0 });
        const target = (await db.queryDatabase('SELECT * FROM auto_watch_targets WHERE id=?', [registered.id]))[0], sourceId = target.source_id;
        await db.queryDatabase('UPDATE auto_watch_targets SET created_at_ms=1,baseline_at_ms=1 WHERE id=?', [target.id]);
        await db.queryDatabase('UPDATE auto_watch_sources SET initialized_at_ms=1,cursor_json=? WHERE id=?', ['{"seenContentIds":[],"admissionVersion":1}', sourceId]);
        const lease = async () => {
            await db.queryDatabase('UPDATE auto_watch_sources SET lease_token=?,lease_expires_at_ms=? WHERE id=?', [randomUUID(), Date.now() + 120000, sourceId]);
            return (await db.queryDatabase('SELECT * FROM auto_watch_sources WHERE id=?', [sourceId]))[0];
        };
        const items = Array.from({ length: 100 }, (_, i) => ({ contentId: String(i), title: `Durable item ${i}`, url: `https://github.com/octocat/repo/commit/${i}`, metadata: { retained: true } }));
        const source = await lease(), store = { ...native, reserveProviderRequest: async () => ({ allowed: true }), recordProviderRateLimit: async () => {} };
        assert.equal((await runner().processSource(source, { now: observationAt, store, config: {}, sourceCounts: new Map(), fetchSource: async () => ({ items, state: { retainedRemoteState: true }, etag: 'v100', lastModified: 'remote-date' }) })).deferredItemCount, 80);
        const added = await native.registerTarget({ userId: newcomer, providerId: 'github', source: 'octocat', destinationType: 'dm' }, { initialJitterMs: 0 });
        return { db, binding, native, store, sourceId, targetId: registered.id, newcomerId: added.id, observationAt, lease, fault: value => { fault = value; } };
    } catch (error) { await db.close(); throw error; }
}
async function count(db, table) { return Number((await db.queryDatabase(`SELECT COUNT(*) n FROM ${table}`))[0].n); }
function cleanupRecoveryDirectory(directory) {
    const absolute = path.resolve(directory), prefix = path.resolve(os.tmpdir()) + path.sep + 'cbte-backlog-recovery-test-';
    if (!absolute.startsWith(prefix) || fs.realpathSync(absolute) !== absolute) throw new Error('Unsafe recovery fixture cleanup path');
    fs.rmSync(absolute, { recursive: true, force: true });
}

test('T1 SQL bounded CAS rescue claims a pre-upgrade future-due payload once, preserves remote metadata and cannot hot-loop failed local admission', { skip: !port }, async () => {
    const f = await fixture();
    try {
        const now = Date.now(), remoteAt = now + 6 * 3600000;
        const old = (await f.db.queryDatabase('SELECT cursor_json FROM auto_watch_sources WHERE id=?', [f.sourceId]))[0];
        const cursor = JSON.parse(old.cursor_json); delete cursor.nextRemoteCheckAtMs;
        await f.db.queryDatabase('UPDATE auto_watch_sources SET cursor_json=?,next_check_at_ms=?,lease_token=NULL,lease_expires_at_ms=0,last_error_code=?,failure_count=3,etag=?,last_modified=? WHERE id=?',
            [JSON.stringify(cursor), remoteAt, 'AUTO_WATCH_UPSTREAM_ERROR', 'retained-etag', 'retained-date', f.sourceId]);
        const untouched = [];
        for (const [index, badCursor] of ['{"seenContentIds":[],"deferredObservations":[["id-only",1]]}', '{invalid-json', '{"seenContentIds":[],"deferredItems":[{"contentId":"missing-url","discoveredAtMs":1}]}'].entries()) {
            const registration = await f.native.registerTarget({ userId: owner, providerId: 'github', source: `excluded-backlog-${index}`, destinationType: 'dm' }, { initialJitterMs: 0 });
            const target = (await f.db.queryDatabase('SELECT source_id FROM auto_watch_targets WHERE id=?', [registration.id]))[0];
            await f.db.queryDatabase('UPDATE auto_watch_sources SET cursor_json=?,initialized_at_ms=1,next_check_at_ms=? WHERE id=?', [badCursor, remoteAt, target.source_id]);
            untouched.push({ id: String(target.source_id), cursor: badCursor });
        }
        const receipts = async () => (await f.db.queryDatabase('SELECT state_json,last_checked_at_ms,last_error_code,failure_count,etag,last_modified FROM auto_watch_sources WHERE id=?', [f.sourceId]))[0];
        const before = await receipts(), scans = [], query = f.binding.queryDatabase;
        f.binding.queryDatabase = async (sql, params) => { if (/FROM auto_watch_sources WHERE id>\? ORDER BY id LIMIT \?/.test(sql)) scans.push(params); return query(sql, params); };
        const second = load('src/providers/autoWatch/store.js', { '../../db': f.binding, '../../db_schema': { ...schema, ensureDatabaseSchema: async () => {} } });
        const claims = (await Promise.all([f.native.claimDueSources(now, 1), second.claimDueSources(now, 1)])).flat();
        assert.equal(claims.length, 1); assert.equal(String(claims[0].id), String(f.sourceId));
        assert.equal(JSON.parse(claims[0].cursor_json).nextRemoteCheckAtMs, remoteAt);
        assert.deepEqual(await receipts(), before);
        const run = (source, at) => runner().processSource(source, { now: at, store: f.store, config: {}, sourceCounts: new Map(), fetchSource: async () => assert.fail('A rescued payload never calls upstream') });
        assert.equal((await run(claims[0], now)).newItemCount, 20);
        assert.equal((await f.native.claimDueSources(now + 1000, 1)).length, 0);
        const next = (await f.native.claimDueSources(now + 30000, 1))[0]; assert(next);
        f.fault('insert'); assert.equal((await run(next, now + 30000)).status, 'failed'); f.fault('');
        assert.equal(await count(f.db, 'auto_watch_items'), 40);
        for (let index = 0; index < 3; index++) assert.equal((await f.native.claimDueSources(now + 30000, 1)).length, 0, 'The durable repair marker respects local retry due after rollback');
        const resumed = (await f.native.claimDueSources(now + 60000, 1))[0]; assert(resumed);
        assert.equal((await run(resumed, now + 60000)).newItemCount, 20);
        assert.equal(await count(f.db, 'auto_watch_items'), 60);
        assert.deepEqual(await receipts(), before);
        assert(scans.length > 0); assert(scans.every(params => params[1] === 8), 'Every metadata scan uses a bounded primary-key page');
        for (const expected of untouched) {
            const actual = (await f.db.queryDatabase('SELECT cursor_json,next_check_at_ms FROM auto_watch_sources WHERE id=?', [expected.id]))[0];
            assert.equal(actual.cursor_json, expected.cursor); assert.equal(Number(actual.next_check_at_ms), remoteAt);
        }
    } finally { await f.db.close(); }
});

test('T1 SQL durable batches drain across fresh runner instances before unavailable permits/503/404 and retain remote diagnostics, validators and new-subscriber baseline', { skip: !port }, async () => {
    const f = await fixture();
    try {
        const afterObservation = (await f.db.queryDatabase('SELECT * FROM auto_watch_sources WHERE id=?', [f.sourceId]))[0];
        assert(Number(afterObservation.next_check_at_ms) <= f.observationAt + 30000, 'Durable admission resumes on a local tick, not the six-hour API poll');
        const remoteRetryAt = Date.now() + 3600000, priorCheckAt = f.observationAt + 100;
        const cursor = JSON.parse(afterObservation.cursor_json); delete cursor.nextRemoteCheckAtMs; // legacy durable checkpoint
        await f.db.queryDatabase('UPDATE auto_watch_sources SET cursor_json=?,last_checked_at_ms=?,last_error_code=?,last_error_at_ms=?,failure_count=4,etag=?,last_modified=?,next_check_at_ms=? WHERE id=?',
            [JSON.stringify(cursor), priorCheckAt, 'AUTO_WATCH_UPSTREAM_ERROR', priorCheckAt, 'prior-etag', 'prior-date', remoteRetryAt, f.sourceId]);
        const diagnostic = async () => (await f.db.queryDatabase('SELECT state_json,etag,last_modified,last_checked_at_ms,last_error_code,last_error_at_ms,failure_count,initialized_at_ms FROM auto_watch_sources WHERE id=?', [f.sourceId]))[0];
        const before = await diagnostic(); let fetches = 0, permits = 0;
        const pollReceipts = await f.db.queryDatabase('SELECT id,baseline_at_ms,last_polled_at_ms,next_poll_at_ms,last_notification_window_at_ms FROM auto_watch_targets WHERE source_id=? ORDER BY id', [f.sourceId]);
        for (const [index, unavailable] of ['503', '404', 'denied', 'permit-error'].entries()) {
            const store = { ...f.native, policyFor: () => { permits++; throw new Error('A local drain must not load remote policy'); },
                reserveProviderRequest: async () => { permits++; if (unavailable === 'permit-error') throw new Error('Permit DB unavailable'); return { allowed: false, nextCheckAtMs: remoteRetryAt }; } };
            const result = await runner().processSource(await f.lease(), { now: Date.now() + index * 30000, store, config: {}, sourceCounts: new Map(), fetchSource: async () => { fetches++; throw Object.assign(new Error('Remote unavailable'), { status: Number(unavailable), code: 'AUTO_WATCH_UPSTREAM_ERROR' }); } });
            assert.equal(result.newItemCount, 20); assert.equal(result.deferredItemCount, 60 - index * 20);
            assert.equal(result.backlogOnly, true); assert.equal(result.remoteChecked, false);
            assert.deepEqual(await diagnostic(), before);
            assert.deepEqual(await f.db.queryDatabase('SELECT id,baseline_at_ms,last_polled_at_ms,next_poll_at_ms,last_notification_window_at_ms FROM auto_watch_targets WHERE source_id=? ORDER BY id', [f.sourceId]), pollReceipts);
            assert.equal((await f.db.queryDatabase('SELECT baseline_at_ms FROM auto_watch_targets WHERE id=?', [f.newcomerId]))[0].baseline_at_ms, null);
        }
        assert.equal(fetches, 0); assert.equal(permits, 0);
        assert.equal(await count(f.db, 'auto_watch_items'), 100); assert.equal(await count(f.db, 'auto_watch_deliveries'), 100);
        assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM auto_watch_deliveries WHERE target_id=?', [f.newcomerId]))[0].n), 0);
        assert((await f.db.queryDatabase('SELECT discovered_at_ms,payload_json FROM auto_watch_items')).every(row => Number(row.discovered_at_ms) === f.observationAt && JSON.parse(row.payload_json).metadata.retained));
        const finished = (await f.db.queryDatabase('SELECT cursor_json,next_check_at_ms FROM auto_watch_sources WHERE id=?', [f.sourceId]))[0];
        assert.equal(JSON.parse(finished.cursor_json).deferredItems, undefined); assert.equal(Number(finished.next_check_at_ms), remoteRetryAt);
        for (const status of [503, 404]) {
            const source = await f.lease();
            const failed = await runner().processSource(source, { now: Date.now(), store: f.store, config: {}, sourceCounts: new Map(), fetchSource: async () => { fetches++; throw Object.assign(new Error('Remote unavailable'), { status, code: 'AUTO_WATCH_UPSTREAM_ERROR' }); } });
            assert.equal(failed.status, 'failed'); assert.equal(failed.backlogOnly, undefined);
        }
        assert.equal(fetches, 2, 'Normal remote failure handling resumes once the durable backlog is empty');
    } finally { await f.db.close(); }
});

test('T1 SQL local backlog failures and lost leases roll back items, deliveries and cursor together; the configured admission cap remains active', { skip: !port }, async () => {
    const f = await fixture(), originalCap = process.env.AUTO_WATCH_MAX_NEW_ITEMS_PER_SOURCE;
    try {
        const checkpoint = (await f.db.queryDatabase('SELECT cursor_json,state_json,etag,last_modified,last_checked_at_ms,last_error_code,failure_count FROM auto_watch_sources WHERE id=?', [f.sourceId]))[0];
        const run = source => runner().processSource(source, { now: Date.now(), store: f.store, config: {}, sourceCounts: new Map(), fetchSource: async () => assert.fail('No upstream request during backlog admission') });
        for (const fault of ['insert', 'lease']) {
            f.fault(fault); const result = await run(await f.lease()); f.fault('');
            assert.equal(result.status, 'failed'); assert.equal(result.remoteChecked, false);
            assert.deepEqual((await f.db.queryDatabase('SELECT cursor_json,state_json,etag,last_modified,last_checked_at_ms,last_error_code,failure_count FROM auto_watch_sources WHERE id=?', [f.sourceId]))[0], checkpoint);
            assert.equal(await count(f.db, 'auto_watch_items'), 20); assert.equal(await count(f.db, 'auto_watch_deliveries'), 20);
        }
        const lost = await f.lease();
        await f.db.queryDatabase("UPDATE auto_watch_sources SET lease_token='another-owner' WHERE id=?", [f.sourceId]);
        assert.equal((await run(lost)).errorCode, 'AUTO_WATCH_LEASE_LOST');
        assert.equal(await count(f.db, 'auto_watch_items'), 20);
        process.env.AUTO_WATCH_MAX_NEW_ITEMS_PER_SOURCE = '7';
        assert.equal((await run(await f.lease())).newItemCount, 7);
        assert.equal(await count(f.db, 'auto_watch_items'), 27); assert.equal(await count(f.db, 'auto_watch_deliveries'), 27);
        assert.equal((await f.db.queryDatabase('SELECT baseline_at_ms FROM auto_watch_targets WHERE id=?', [f.newcomerId]))[0].baseline_at_ms, null);
        process.env.AUTO_WATCH_MAX_NEW_ITEMS_PER_SOURCE = '20';
        const intervalMigration = fs.readFileSync(path.join(root, 'migrations/20261006_add_user_auto_watch_intervals.sql'), 'utf8');
        await f.db.queryDatabase(schema._internal.splitSqlStatements(intervalMigration).find(sql => sql.startsWith('CREATE TABLE')));
        await require('../../src/providers/autoWatch/intervalPolicy').createPolicy(f.db).set(owner, 5, '999999999999999999');
        for (let index = 0; index < 4; index++) assert.equal((await run(await f.lease())).remoteChecked, false);
        assert.equal(await count(f.db, 'auto_watch_items'), 100);
        const completed = (await f.db.queryDatabase('SELECT cursor_json,next_check_at_ms,last_checked_at_ms FROM auto_watch_sources WHERE id=?', [f.sourceId]))[0];
        assert.equal(JSON.parse(completed.cursor_json).deferredItems, undefined);
        assert.equal(Number(completed.next_check_at_ms), Number(completed.last_checked_at_ms) + 5 * 60000, 'The next real poll honors an interval changed during local backlog admission');
    } finally { if (originalCap === undefined) delete process.env.AUTO_WATCH_MAX_NEW_ITEMS_PER_SOURCE; else process.env.AUTO_WATCH_MAX_NEW_ITEMS_PER_SOURCE = originalCap; await f.db.close(); }
});

test('T1/R32 SQL a restored old discovery retains its original cutoff time when a new local drain creates its delivery after bootstrap', { skip: !port }, async () => {
    const f = await fixture(Date.now() - 7 * 3600000), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cbte-backlog-recovery-test-'));
    const saved = Object.fromEntries(['CBTE_RECOVERY_BOOTSTRAP_ID', 'CBTE_RECOVERY_BOOTSTRAP_DIR', 'CBTE_FLEET_NODE'].map(key => [key, process.env[key]]));
    try {
        process.env.CBTE_RECOVERY_BOOTSTRAP_ID = randomBytes(12).toString('hex'); process.env.CBTE_RECOVERY_BOOTSTRAP_DIR = directory; process.env.CBTE_FLEET_NODE = 'oci';
        const recovery = load('src/recoveryBootstrap.js'), started = recovery.begin().startedAtMs;
        const restoredRunner = load('src/providers/autoWatch/runner.js', { '../../errorTracking': { recordError: () => {} }, '../../recoveryBootstrap': recovery })._internal;
        const beforeDeliveryIds = new Set((await f.db.queryDatabase('SELECT id FROM auto_watch_deliveries')).map(row => String(row.id)));
        const processed = await restoredRunner.processSource(await f.lease(), { now: started + 1000, store: f.store, config: {}, sourceCounts: new Map(), fetchSource: async () => assert.fail('Restored payloads do not need upstream') });
        assert.equal(processed.newItemCount, 20);
        const fresh = (await f.native.claimDueDeliveries(started + 1000, 100)).find(row => !beforeDeliveryIds.has(String(row.id))); assert(fresh);
        assert.equal(Number(fresh.discovered_at_ms), f.observationAt); assert(f.observationAt < started);
        const result = await restoredRunner.deliverOne(fresh, { now: started + 1000, store: { ...f.native, routeAutomation: async () => assert.fail('An old restored observation must not reach queue admission') } });
        assert.equal(result.status, 'suppressed');
        assert.equal((await f.db.queryDatabase('SELECT status FROM auto_watch_deliveries WHERE id=?', [fresh.id]))[0].status, 'suppressed');
        assert.equal(await count(f.db, 'automation_jobs'), 0);
        assert(fs.readdirSync(path.join(directory, 'quarantine')).some(name => name.endsWith('.json')));
        assert.equal(JSON.parse((await f.db.queryDatabase('SELECT cursor_json FROM auto_watch_sources WHERE id=?', [f.sourceId]))[0].cursor_json).deferredItems.length, 60);
    } finally {
        for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        await f.db.close();
        cleanupRecoveryDirectory(directory);
    }
});

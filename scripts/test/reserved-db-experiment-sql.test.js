'use strict';
// Research-only: all schema and traffic use a disposable loopback database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createReservedDbExperiment } = require('../../experiments/chrome-push/reserved-db-experiment.cjs');
const { insertSubscription, encrypted, vault, ownerUserId } = require('./helpers/x-push-fixture.cjs');
const { createXPushStore } = require('../../src/automation/x-push-store');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { createXPushRuntime } = require('../../src/automation/x-push-runtime');
const { createQueue } = require('../../src/automation/queue');
const entitlements = require('../../src/automation/entitlements');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function query(connection, sql, params = []) {
    return new Promise((resolve, reject) => connection.query(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}
async function fixture(t, queryTimeoutMs = 15000) {
    const db = await createTestDatabase(port);
    const credentials = { host: '127.0.0.1', port, user: 'root', password: process.env.AUTOMATION_TEST_DB_PASSWORD || '', database: db.schema };
    const pool = mysql.createPool({ ...credentials, connectionLimit: 4, queueLimit: 32, waitForConnections: true, supportBigNumbers: true, bigNumberStrings: true });
    const control = mysql.createConnection(credentials);
    const background = createReservedDbExperiment({ pool, connectionLimit: 4, reservedConnections: 1, queryTimeoutMs });
    t.after(async () => {
        background.stop();
        await new Promise(resolve => control.end(resolve));
        await new Promise(resolve => pool.end(resolve));
        await db.close();
    });
    return { db, pool, control, background };
}

test('one real pool cannot acquire two independent reservation quotas', { skip: !port, timeout: 30000 }, async t => {
    const f = await fixture(t);
    assert.throws(() => createReservedDbExperiment({ pool: f.pool, connectionLimit: 4, reservedConnections: 1 }),
        { code: 'RESERVED_DB_POOL_IN_USE' });
    assert.equal(Number((await f.background.runBackground(() => f.background.queryDatabase('SELECT 1 AS n')))[0].n), 1);
    f.background.stop();
    const replacement = createReservedDbExperiment({ pool: f.pool, connectionLimit: 4, reservedConnections: 1 });
    try {
        assert.equal(Number((await replacement.runBackground(() => replacement.queryDatabase('SELECT 2 AS n')))[0].n), 2);
    } finally { replacement.stop(); }
});

test('same pool reserves one client connection when three background SQL calls are stalled', { skip: !port, timeout: 30000 }, async t => {
    const f = await fixture(t), names = Array.from({ length: 3 }, (_, i) => `reserved-${i}-${f.db.schema}`), jobs = [];
    const controller = new AbortController();
    try {
        for (const name of names) assert.equal(Number((await query(f.control, 'SELECT GET_LOCK(?,5) AS n', [name]))[0].n), 1);
        for (const name of names) jobs.push(f.background.runBackground(() => f.background.queryDatabase('SELECT GET_LOCK(?,10) AS n', [name])));
        let waiting = 0;
        for (let i = 0; i < 200 && waiting < 3; i++) {
            waiting = Number((await query(f.control, "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE DB=? AND INFO LIKE 'SELECT GET_LOCK(%'", [f.db.schema]))[0].n);
            if (waiting < 3) await pause(10);
        }
        assert.equal(waiting, 3); assert.equal(f.background.status().active, 3);
        const queued = f.background.runBackground(() => f.background.queryDatabase('SELECT 5'), { signal: controller.signal });
        const rejected = assert.rejects(queued, { code: 'RESERVED_DB_STOPPED' });
        assert.equal(f.background.status().waiting, 1);
        const started = Date.now(), result = await query(f.pool, 'SELECT 42 AS n');
        assert.equal(Number(result[0].n), 42); assert(Date.now() - started < 2000, 'normal query waited for stalled background work');
        controller.abort(); await rejected;
    } finally {
        controller.abort();
        for (const name of names) { try { await query(f.control, 'SELECT RELEASE_LOCK(?)', [name]); } catch {} }
        await Promise.allSettled(jobs);
    }
    assert.equal(f.background.status().active, 0);
});

test('a real driver timeout permanently consumes a background slot but leaves normal access available', { skip: !port, timeout: 30000 }, async t => {
    const f = await fixture(t, 200);
    await assert.rejects(f.background.runBackground(() => f.background.queryDatabase('SELECT SLEEP(1.5) AS n')),
        { code: 'PROTOCOL_SEQUENCE_TIMEOUT' });
    assert.equal(f.background.status().poisoned, 1); assert.equal(f.background.status().active, 0);
    const queryCount = Number((await query(f.control, "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE DB=? AND INFO LIKE 'SELECT SLEEP(%'", [f.db.schema]))[0].n);
    assert.equal(Number((await query(f.pool, 'SELECT 42 AS n'))[0].n), 42);
    // This observation is diagnostic only: driver disconnect does not prove
    // that every DB server will stop the already-executing SQL promptly.
    t.diagnostic(`synthetic timed-out SQL still executing at observation: ${queryCount > 0}`);
    await pause(1600);
});

test('an autocommit write can finish after its background owner has returned', { skip: !port, timeout: 30000 }, async t => {
    const f = await fixture(t);
    await f.db.queryDatabase('CREATE TABLE reserved_late_write_fixture (id INT PRIMARY KEY)');
    let observed, outcome;
    await f.background.runBackground(async () => {
        const pending = f.background.queryDatabase('INSERT INTO reserved_late_write_fixture (id) SELECT 1 WHERE SLEEP(1.5)=0');
        // Capture the eventual result so a rejected delayed query never becomes
        // an unhandled rejection. Only a fixed code is retained for the test.
        outcome = pending.then(() => 'success', error => error?.code || 'failed');
        for (let i = 0; i < 100 && !observed; i++) {
            observed = Number((await query(f.control, "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE DB=? AND INFO LIKE 'INSERT INTO reserved_late_write_fixture%'", [f.db.schema]))[0].n);
            if (!observed) await pause(10);
        }
        assert.equal(observed, 1, 'synthetic insert was not observed before its owner returned');
        // Models a higher-level deadline ending the callback while SQL is still
        // executing; this intentionally does not roll the statement back.
    });
    assert.equal(await outcome, 'RESERVED_DB_STOPPED');
    assert.equal(Number((await query(f.pool, 'SELECT COUNT(*) AS n FROM reserved_late_write_fixture'))[0].n), 1);
    assert.equal(f.background.status().active, 0);
});

test('an aborted background transaction waits for its SQL and rolls back before returning its reservation', { skip: !port, timeout: 30000 }, async t => {
    const f = await fixture(t), name = `reserved-tx-${f.db.schema}`, controller = new AbortController();
    await f.db.queryDatabase('CREATE TABLE reserved_fixture (id INT PRIMARY KEY)');
    assert.equal(Number((await query(f.control, 'SELECT GET_LOCK(?,5) AS n', [name]))[0].n), 1);
    const pending = f.background.runBackground(() => f.background.withDatabaseTransaction(async run => {
        await run('INSERT INTO reserved_fixture (id) VALUES (1)');
        await run('SELECT GET_LOCK(?,10) AS n', [name]);
    }), { signal: controller.signal });
    const rejected = assert.rejects(pending, { code: 'RESERVED_DB_STOPPED' });
    try {
        let waiting = 0;
        for (let i = 0; i < 200 && !waiting; i++) {
            waiting = Number((await query(f.control, "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE DB=? AND INFO LIKE 'SELECT GET_LOCK(%'", [f.db.schema]))[0].n);
            if (!waiting) await pause(10);
        }
        assert.equal(waiting, 1); controller.abort();
        assert.equal(f.background.status().active, 1);
        assert.equal(Number((await query(f.pool, 'SELECT COUNT(*) AS n FROM reserved_fixture'))[0].n), 0);
    } finally {
        await query(f.control, 'SELECT RELEASE_LOCK(?)', [name]);
        await rejected;
    }
    assert.equal(f.background.status().active, 0); assert.equal(f.background.status().poisoned, 0);
    assert.equal(Number((await query(f.pool, 'SELECT COUNT(*) AS n FROM reserved_fixture'))[0].n), 0);
});

test('the actual encrypted inbox routes once through the reserved adapter on the same writer', { skip: !port, timeout: 30000 }, async t => {
    const f = await fixture(t), now = Date.parse('2026-10-14T03:00:00Z'), clock = () => now;
    let runtime;
    t.after(async () => runtime?.stop());
    await f.db.withDatabaseTransaction(run => entitlements.savePlanPolicy(run, { userId: '666666666666666666', isAdmin: true },
        { planId: 'free', label: 'fixture', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));
    const subscription = await insertSubscription(f.db);
    const monitor = await f.db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'12345','synthetic','fixture',1,'ready','free',?,'bound',1,?,?)",
        [ownerUserId, JSON.stringify({ subscriptionId: subscription.subscriptionId }), now, now]);
    await f.db.withDatabaseTransaction(run => entitlements.assignSlot(run, ownerUserId, 'x', String(monitor.insertId)));
    const store = createXPushStore(f.background, { now: clock, leaseMs: 300000 });
    const lease = await f.background.runBackground(() => store.claim({ ...subscription, workerId: 'reserved-experiment' }));
    const wire = await encrypted(subscription.file, { notificationType: 'tweet', text: 'synthetic',
        url: 'https://x.com/synthetic/status/1234567890123456789', author: { handle: 'synthetic', id: '12345' } });
    const inbox = await f.background.runBackground(() => store.recordFrame(lease,
        { version: 'fixture', data: wire.data, headers: wire.headers, status: 'received', ackCode: 100 }));
    await f.db.queryDatabase('UPDATE automation_x_push_receivers SET last_process_at_ms=? WHERE subscription_id=?', [now - 301000, lease.subscriptionId]);
    const gateway = createXPushGateway(f.background, { enabled: true, store, privateWorkerVault: vault, now: clock, rolloutMode: 'public' });
    const queue = createQueue(f.background, {}, { clock, rolloutMode: 'public' });
    runtime = createXPushRuntime(f.background, queue, { enabled: true, gateway, clock, rolloutMode: 'public', processingPolicy: 'batch', assertAllowed() {} });
    const guard = new AbortController();
    const result = await f.background.runBackground(() => runtime.drain(lease, { recoverySignal: guard.signal }), { signal: guard.signal });
    assert.equal(result.processed, 1);
    assert.equal(Number((await query(f.pool, 'SELECT COUNT(*) AS n FROM automation_jobs'))[0].n), 1);
    assert.equal((await f.background.runBackground(() => store.getInbox({ ...subscription, id: inbox.id }))).status, 'routed');
    assert.equal(f.background.status().active, 0); assert.equal(f.background.status().poisoned, 0);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const sourceFile = path.join(__dirname, 'automation-x-push-processing-sql.test.js');
const source = fs.readFileSync(sourceFile, 'utf8');
const U = '222222222222222222';

// Execute the actual fixture function with isolated dependencies. Suppressing
// node:test registration avoids recursively running its SQL suite here. No
// production source or fixture implementation is copied into this test.
function harness({ failStage, stopFailure = false, closeFailure = false, createDatabase } = {}) {
    const events = [], failure = Object.assign(Error(`Synthetic fixture failure: ${failStage}`), { code: 'FIXTURE_SETUP_FAILURE' });
    const stopError = Object.assign(Error('Synthetic runtime-stop failure'), { code: 'FIXTURE_STOP_FAILURE' });
    const closeError = Object.assign(Error('Synthetic database-close failure'), { code: 'FIXTURE_CLOSE_FAILURE' });
    let ownedDatabase;
    const step = name => { events.push(name); if (failStage === name) throw failure; };
    const query = async (sql, args) => {
        if (sql.startsWith('INSERT INTO automation_x_monitors')) step('monitor');
        return ownedDatabase ? ownedDatabase.queryDatabase(sql, args) : { insertId: 1 };
    };
    const db = {
        withDatabaseTransaction: async work => ownedDatabase ? ownedDatabase.withDatabaseTransaction(work) : work(query),
        close: async () => { events.push('close'); if (ownedDatabase) await ownedDatabase.close(); if (closeFailure) throw closeError; },
    };
    Object.defineProperty(db, 'queryDatabase', { get() { step('query-access'); return query; } });
    const lease = { token: 'synthetic', expiresAtMs: Number.MAX_SAFE_INTEGER };
    const store = { claim: async () => { step('claim'); return lease; }, markState: async () => { step('markState'); } };
    const mocks = {
        'node:test': () => {},
        '../lib/automation-test-db': { createTestDatabase: async () => { step('database'); if (createDatabase) ownedDatabase = await createDatabase(); return db; } },
        './helpers/x-push-fixture.cjs': { ownerUserId: U, vault: {}, insertSubscription: async () => {
            step('subscription'); return { subscriptionId: '11111111-1111-4111-8111-111111111111', ownerUserId: U, file: {} };
        } },
        '../../src/automation/entitlements': { savePlanPolicy: async () => step('plan'), assignSlot: async () => step('assignSlot') },
        '../../src/automation/x-push-store': { createXPushStore: () => { step('store'); return store; } },
        '../../src/automation/queue': { createQueue: () => { step('queue'); return {}; } },
        '../../src/automation/x-event-router': { createXEventRouter: () => { step('router'); return {}; } },
        '../../src/automation/x-push-gateway': { createXPushGateway: () => { step('gateway'); return {}; } },
        '../../src/automation/x-push-runtime': { createXPushRuntime: () => {
            step('runtime'); return { stop: async () => { events.push('stop'); if (stopFailure) throw stopError; } };
        } },
    };
    const loaded = new Module(sourceFile, module);
    loaded.filename = sourceFile; loaded.paths = Module._nodeModulePaths(path.dirname(sourceFile));
    const fallback = loaded.require.bind(loaded);
    loaded.require = name => Object.hasOwn(mocks, name) ? mocks[name] : name.startsWith('../../src/automation/') ? {} : fallback(name);
    loaded._compile(`${source}\nmodule.exports = { fixture };\n`, sourceFile);
    return { fixture: loaded.exports.fixture, events, failure, stopError, closeError, ownedDatabase: () => ownedDatabase };
}

test('every acquired processing fixture database closes when any initialization stage fails', async t => {
    for (const stage of ['query-access', 'subscription', 'plan', 'store', 'claim', 'markState', 'monitor', 'assignSlot', 'queue', 'router', 'gateway', 'runtime']) {
        await t.test(stage, async () => {
            const h = harness({ failStage: stage }); let workCalled = false;
            await assert.rejects(h.fixture(async () => { workCalled = true; }), error => error === h.failure);
            assert.equal(workCalled, false); assert.equal(h.events.filter(event => event === 'close').length, 1);
            assert.equal(h.events.includes('stop'), false, 'a runtime that was never returned must not be stopped');
            assert.equal(h.events.at(-1), 'close');
        });
    }
});

test('database creation failure does not close an unacquired resource or start the runtime', async () => {
    const h = harness({ failStage: 'database' });
    await assert.rejects(h.fixture(async () => assert.fail('work must not run')), error => error === h.failure);
    assert.deepEqual(h.events, ['database']);
});

test('normal completion stops the runtime and then closes its database once', async () => {
    const h = harness(); let workCalled = false;
    await h.fixture(async f => { workCalled = true; assert.ok(f.runtime()); assert.equal(f.subscription.ownerUserId, U); });
    assert.equal(workCalled, true); assert.deepEqual(h.events.slice(-2), ['stop', 'close']);
});

test('a failed test body still stops the runtime and closes the database', async () => {
    const h = harness(), workError = Error('Synthetic test-body failure');
    await assert.rejects(h.fixture(async () => { throw workError; }), error => error === workError);
    assert.deepEqual(h.events.slice(-2), ['stop', 'close']);
});

test('runtime-stop failure cannot skip database cleanup', async () => {
    const h = harness({ stopFailure: true });
    await assert.rejects(h.fixture(async () => {}), error => error === h.stopError);
    assert.deepEqual(h.events.slice(-2), ['stop', 'close']);
    assert.equal(h.events.filter(event => event === 'close').length, 1);
});

test('database-close failure is surfaced after the runtime-stop attempt', async () => {
    const h = harness({ closeFailure: true });
    await assert.rejects(h.fixture(async () => {}), error => error === h.closeError);
    assert.deepEqual(h.events.slice(-2), ['stop', 'close']);
});

test('both cleanup failures still attempt both resources exactly once', async () => {
    const h = harness({ stopFailure: true, closeFailure: true });
    await assert.rejects(h.fixture(async () => {}), error => error === h.closeError);
    assert.deepEqual(h.events.slice(-2), ['stop', 'close']);
});

const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
test('real disposable schemas are dropped after initialization failure and runtime-stop failure', { skip: !port, timeout: 30000 }, async t => {
    assert.equal(port, 33621, 'Cleanup SQL must use the explicit disposable fixture port');
    const { createTestDatabase } = require('../lib/automation-test-db');
    const mysql = require('mysql');
    for (const failure of ['subscription', 'stop']) await t.test(failure, async () => {
        let owned;
        const h = harness({ failStage: failure === 'subscription' ? failure : undefined, stopFailure: failure === 'stop', createDatabase: async () => { owned = await createTestDatabase(port); return owned; } });
        try {
            await assert.rejects(h.fixture(async () => {}), error => error === (failure === 'stop' ? h.stopError : h.failure));
            assert.equal(h.events.filter(event => event === 'close').length, 1);
            assert.match(owned.schema, /^cbte_automation_test_[0-9a-f]{20}$/);
            const admin = mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: process.env.AUTOMATION_TEST_DB_PASSWORD || '', supportBigNumbers: true, bigNumberStrings: true });
            try {
                const rows = await new Promise((resolve, reject) => admin.query('SELECT COUNT(*) n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [owned.schema], (error, rows) => error ? reject(error) : resolve(rows)));
                assert.equal(Number(rows[0].n), 0, 'the failed fixture must leave no randomly named schema');
            } finally { await new Promise(resolve => admin.end(resolve)); }
        } finally {
            // The regression test must also clean its own resource if it is
            // deliberately run against the broken pre-fix fixture lifecycle.
            if (owned) await owned.close();
        }
    });
});

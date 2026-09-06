'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bootstrapPath = require.resolve('../../src/recoveryBootstrap');
const tableNames = { autoExtractTargets: 'fixture_targets', deregisterNotifications: 'fixture_deregister', botErrorAlerts: 'fixture_alerts' };

async function fixture(work) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cbte-recovery-bootstrap-'));
    const names = ['CBTE_RECOVERY_BOOTSTRAP_ID', 'CBTE_RECOVERY_BOOTSTRAP_DIR', 'CBTE_FLEET_NODE'];
    const environment = new Map(names.map(name => [name, process.env[name]]));
    const cached = require.cache[bootstrapPath];
    process.env.CBTE_RECOVERY_BOOTSTRAP_ID = 'a'.repeat(24);
    process.env.CBTE_RECOVERY_BOOTSTRAP_DIR = path.join(directory, 'bootstrap');
    process.env.CBTE_FLEET_NODE = 'oci';
    delete require.cache[bootstrapPath];
    try { await work(require(bootstrapPath), directory); }
    finally {
        for (const [name, value] of environment) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
        if (cached) require.cache[bootstrapPath] = cached; else delete require.cache[bootstrapPath];
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test('ordinary primary/development startup does not activate recovery filtering', async () => {
    await fixture(async bootstrap => {
        delete process.env.CBTE_RECOVERY_BOOTSTRAP_ID;
        delete process.env.CBTE_RECOVERY_BOOTSTRAP_DIR;
        assert.equal(bootstrap.begin(), null);
        assert.equal(await bootstrap.initialize({ query: () => { throw new Error('Unexpected database access'); } }), null);
        assert.equal(bootstrap.notificationAllowed('booth_sale', { id: 'old' }, '2000-01-01T00:00:00Z'), true);
    });
});

test('restored outgoing rows and targets are quarantined read-only and completion survives Bot restart', async () => {
    await fixture(async (bootstrap, directory) => {
        const started = bootstrap.begin().startedAtMs;
        const rows = {
            fixture_targets: [{ id: '9', last_extracted_at_ms: started - 86400000, created_at_ms: started - 86400000 }],
            fixture_deregister: [{ notification_id: '3', created_at_ms: started - 5000, dm_sent: 0 }],
            fixture_alerts: [{ alert_key: 'provider_extract:twitter', active: 1, detected_at_ms: started - 5000 }],
        };
        const old = { id: 'old-booth', userId: 'fixture-user', registeredAt: new Date(started - 5000).toISOString(), notified: false };
        const calls = [];
        const query = async (sql, params, options) => {
            calls.push({ sql, params });
            assert.ok(sql.startsWith('SELECT *'));
            assert.ok(sql.endsWith('LIMIT 200'));
            assert.ok(options.timeoutMs <= 5000);
            return Object.entries(rows).find(([table]) => sql.includes(table))[1];
        };
        const state = await bootstrap.initialize({ query, tables: tableNames, subscriptions: { load: () => [old] } });
        assert.equal(state.complete, true);
        assert.equal(calls.length, 3);
        assert.equal(old.notified, false);
        const evidence = fs.readdirSync(path.join(directory, 'bootstrap/quarantine')).map(name => JSON.parse(fs.readFileSync(path.join(directory, 'bootstrap/quarantine', name), 'utf8')));
        assert.equal(evidence.length, 4);
        assert.ok(evidence.every(item => item.delivered === false));
        assert.equal(evidence.find(item => item.kind === 'autoextract_targets').original.rows[0].last_extracted_at_ms, started - 86400000);
        delete require.cache[bootstrapPath];
        const restarted = require(bootstrapPath);
        assert.equal((await restarted.initialize({ query: () => { throw new Error('Completed bootstrap must not rescan'); } })).startedAtMs, started);
        assert.equal(restarted.notificationAllowed('booth_sale', old, old.registeredAt), false);
        assert.equal(restarted.notificationAllowed('booth_sale', { id: 'new' }, started + 1), true);
        assert.match(state.feedPolling, /No autoextract feed poller/);
    });
});

test('candidate mismatch, corrupted state and unknown notification age fail closed', async () => {
    await fixture(async (bootstrap, directory) => {
        bootstrap.begin();
        assert.equal(bootstrap.notificationAllowed('booth_sale', { id: 'undated' }, undefined), false);
        process.env.CBTE_RECOVERY_BOOTSTRAP_ID = 'b'.repeat(24);
        assert.throws(() => bootstrap.begin(), { code: 'RECOVERY_BOOTSTRAP_REQUIRED' });
        delete require.cache[bootstrapPath];
        assert.throws(() => require(bootstrapPath).begin(), { code: 'RECOVERY_BOOTSTRAP_REQUIRED' });
        process.env.CBTE_RECOVERY_BOOTSTRAP_ID = 'a'.repeat(24);
        fs.writeFileSync(path.join(directory, 'bootstrap/bootstrap.json'), '{corrupt');
        delete require.cache[bootstrapPath];
        assert.throws(() => require(bootstrapPath).begin());
        assert.equal(fs.readFileSync(path.join(directory, 'bootstrap/bootstrap.json'), 'utf8'), '{corrupt');
    });
});

test('failed durable completion does not enable timers or skip retry on the same process', async () => {
    await fixture(async bootstrap => {
        bootstrap.begin();
        const rename = fs.renameSync;
        let injected = false;
        fs.renameSync = function (source, target) {
            if (!injected && path.basename(String(target)) === 'bootstrap.json' && JSON.parse(fs.readFileSync(source, 'utf8')).complete) {
                injected = true;
                throw Object.assign(new Error('Fixture failed durable write'), { code: 'EIO' });
            }
            return rename.apply(this, arguments);
        };
        const options = { query: async () => [], tables: tableNames, subscriptions: { load: () => [] } };
        try { await assert.rejects(bootstrap.initialize(options), { code: 'EIO' }); }
        finally { fs.renameSync = rename; }
        assert.equal(bootstrap.begin().complete, false);
        assert.equal((await bootstrap.initialize(options)).complete, true);
    });
});

test('paged database evidence resumes after failure and never changes restored cursor or delivery rows', async () => {
    await fixture(async bootstrap => {
        let fail = true;
        const calls = [];
        const query = async (sql, params) => {
            calls.push(sql);
            if (sql.includes('fixture_targets')) {
                if (params.at(-1) === '0') return Array.from({ length: 200 }, (_, index) => ({ id: String(index + 1), last_extracted_at_ms: 1 }));
                if (fail) throw new Error('Fixture read timeout');
                return [{ id: '201', last_extracted_at_ms: 1 }];
            }
            return [];
        };
        const options = { query, tables: tableNames, subscriptions: { load: () => [] } };
        await assert.rejects(bootstrap.initialize(options), /Fixture read timeout/);
        assert.equal(bootstrap.begin().tables.autoextract_targets.cursor, '200');
        fail = false;
        assert.equal((await bootstrap.initialize(options)).tables.autoextract_targets.rows, 201);
        assert.ok(calls.every(sql => sql.startsWith('SELECT')));
    });
});

test('Booth lifecycle delivers only new candidate-era subscriptions and retains old pending records', async () => {
    await fixture(async (bootstrap, directory) => {
        const started = bootstrap.begin().startedAtMs;
        const old = { id: 'restored', userId: 'old-user', itemId: 'old-item', registeredAt: new Date(started - 1000).toISOString(), notifyAt: new Date(started - 1000).toISOString(), notified: false };
        const fresh = { id: 'fresh', userId: 'new-user', itemId: 'new-item', registeredAt: new Date(started + 1).toISOString(), notifyAt: new Date(started - 1000).toISOString(), notified: false };
        fs.mkdirSync(path.join(directory, 'data'));
        const file = path.join(directory, 'data/booth_sale_notifications.json');
        fs.writeFileSync(file, JSON.stringify([old, fresh]));
        const subsPath = require.resolve('../../src/providers/booth/_notifications');
        const notifierPath = require.resolve('../../src/lifecycle/boothSaleNotifier');
        const saved = new Map([subsPath, notifierPath].map(key => [key, require.cache[key]]));
        const cwd = process.cwd();
        const delivered = [], marked = [];
        try {
            process.chdir(directory);
            delete require.cache[subsPath]; delete require.cache[notifierPath];
            const subs = require(subsPath);
            assert.equal(subs.hasActiveSubscription(old.userId, old.itemId), false);
            subs.markNotified = id => { marked.push(id); };
            subs.pruneOld = () => {};
            const notifier = require(notifierPath);
            await notifier.tick({ users: { fetch: async userId => ({ send: async payload => { delivered.push({ userId, payload }); } }) } });
            assert.deepEqual(delivered.map(row => row.userId), ['new-user']);
            assert.deepEqual(marked, ['fresh']);
            assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [old, fresh]);
        } finally {
            process.chdir(cwd);
            for (const [key, value] of saved) { if (value) require.cache[key] = value; else delete require.cache[key]; }
        }
    });
});

test('restored error incidents cannot produce resolution messages and current metrics start after recovery', async () => {
    await fixture(async bootstrap => {
        const started = bootstrap.begin().startedAtMs;
        const notifierPath = require.resolve('../../src/lifecycle/errorRateNotifier');
        const dbPath = require.resolve('../../src/db');
        const saved = new Map([notifierPath, dbPath].map(key => [key, require.cache[key]]));
        const calls = [];
        require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { queryDatabase: async (sql, params) => {
            calls.push({ sql, params });
            if (sql.includes('WHERE active = 1')) return [{ alert_key: 'old', active: 1, detected_at_ms: started - 86400000, incident_id: 'old-primary-incident' }];
            return [];
        } } };
        delete require.cache[notifierPath];
        try {
            const notifier = require(notifierPath);
            let sent = 0;
            await notifier.tick({ send: async () => { sent++; } }, started + 300000);
            assert.equal(sent, 0);
            assert.ok(calls.every(row => row.sql.trimStart().startsWith('SELECT')));
            const current = calls.filter(row => row.params?.length === 3 && row.params[2] === started + 300000);
            assert.ok(current.length > 0);
            assert.ok(current.every(row => row.params[1] === Math.ceil(started / 60000) * 60000));
            assert.equal(bootstrap.incidentAllowed({ detectedAtMs: started - 1 }), false);
            assert.equal(bootstrap.incidentAllowed({ detectedAtMs: started + 1 }), true);
        } finally {
            for (const [key, value] of saved) { if (value) require.cache[key] = value; else delete require.cache[key]; }
        }
    });
});

test('ready lifecycle does not start any notification timers when quarantine cannot finish', async () => {
    const readyPath = require.resolve('../../src/handlers/ready');
    const paths = [readyPath, bootstrapPath, ...['deregisterNotifier', 'statsPoster', 'consoleFlush', 'boothSaleNotifier', 'errorRateNotifier', 'mediaDeliveryServer', 'runtimeDiagnostics'].map(name => require.resolve(`../../src/lifecycle/${name}`))];
    const saved = new Map(paths.map(key => [key, require.cache[key]]));
    const started = [];
    const stub = (key, exports) => { require.cache[key] = { id: key, filename: key, loaded: true, exports }; };
    for (const filename of paths.slice(2)) stub(filename, { start: () => { started.push(path.basename(filename)); } });
    stub(bootstrapPath, { begin: () => {}, initialize: async () => { throw new Error('Fixture quarantine read failed'); } });
    delete require.cache[readyPath];
    try {
        const ready = require(readyPath);
        await assert.rejects(ready._internal.initialize({ user: { tag: 'fixture-bot' }, application: { commands: { set: async () => { started.push('commands'); } } } }, null, null), /Fixture quarantine read failed/);
        assert.deepEqual(started, ['runtimeDiagnostics.js']);
    } finally {
        for (const [key, value] of saved) { if (value) require.cache[key] = value; else delete require.cache[key]; }
    }
});

'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const bootstrapPath = require.resolve('../../src/recoveryBootstrap'), subscriptionsPath = require.resolve('../../src/providers/booth/_notifications');
const kinds = ['automation_pending_jobs', 'automation_pending_steps', 'automation_open_batches', 'automation_unprojected_sends', 'x_push_pending_inbox'];
const tables = ['automation_jobs', 'automation_flow_steps', 'automation_flow_batches', 'automation_flow_sends', 'automation_x_push_inbox'];
async function fixture(work, complete = true, leafLink = false, nativeComplete = true) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cbte-managed-recovery-')), release = path.join(root, 'release'), shared = path.join(root, 'shared-data');
    const names = ['CBTE_RECOVERY_BOOTSTRAP_ID', 'CBTE_RECOVERY_BOOTSTRAP_DIR', 'CBTE_FLEET_NODE', 'CBTE_FLEET_LEASE_FILE', 'CBTE_FLEET_EPOCH'], previous = new Map(names.map(name => [name, process.env[name]]));
    const saved = new Map([bootstrapPath, subscriptionsPath].map(id => [id, require.cache[id]])), cwd = process.cwd();
    try {
        fs.mkdirSync(release); fs.mkdirSync(shared); fs.symlinkSync(shared, path.join(release, 'data'), process.platform === 'win32' ? 'junction' : 'dir');
        process.env.CBTE_RECOVERY_BOOTSTRAP_ID = 'c'.repeat(24); process.env.CBTE_RECOVERY_BOOTSTRAP_DIR = path.join(root, 'bootstrap'); process.env.CBTE_FLEET_NODE = 'oci';
        delete process.env.CBTE_FLEET_LEASE_FILE; delete process.env.CBTE_FLEET_EPOCH;
        process.chdir(release); delete require.cache[bootstrapPath]; delete require.cache[subscriptionsPath];
        let bootstrap = require(bootstrapPath), state = bootstrap.begin(), cutoff = state.startedAtMs, receipt = path.join(state.directory, 'bootstrap.json');
        if (complete) {
            // Oldest complete receipts contain only the original three SQL
            // scopes plus the implicit completed BOOTH snapshot. Later native
            // SQL completion is explicit, never inferred from complete alone.
            const scopes = ['autoextract_targets', 'deregister_pending', 'error_incidents', ...(nativeComplete ? ['auto_watch_pending_deliveries', 'price_watch_pending_deliveries'] : [])];
            state = { ...state, complete: true, completedAtMs: cutoff, tables: Object.fromEntries(scopes.map(kind => [kind, { cursor: '0', pages: 0, rows: 0, complete: true }])) };
            fs.writeFileSync(receipt, JSON.stringify(state)); delete require.cache[bootstrapPath]; bootstrap = require(bootstrapPath);
        }
        const old = { id: 'restored', userId: 'old-user', itemId: 'old-item', registeredAt: new Date(cutoff - 1000).toISOString(), notifyAt: new Date(cutoff - 1000).toISOString(), notified: false };
        const fresh = { id: 'new', userId: 'new-user', itemId: 'new-item', registeredAt: new Date(cutoff + 1).toISOString(), notifyAt: new Date(cutoff - 1000).toISOString(), notified: false };
        const file = path.join(shared, 'booth_sale_notifications.json'), bytes = JSON.stringify([old, fresh]), physical = leafLink ? path.join(root, 'physical-booth.json') : file;
        fs.writeFileSync(physical, bytes); if (leafLink) fs.symlinkSync(physical, file, 'file');
        bootstrap.notificationAllowed('booth_sale', old, old.registeredAt);
        const quarantine = path.join(state.directory, 'quarantine'), originalEvidence = new Map(fs.readdirSync(quarantine).map(name => [name, fs.readFileSync(path.join(quarantine, name), 'utf8')]));
        const subscriptions = require(subscriptionsPath), load = subscriptions.load; let loads = 0;
        subscriptions.load = () => { loads++; return load(); };
        const calls = [], query = async sql => { assert(sql.startsWith('SELECT ')); calls.push(sql); return []; };
        await work({ root, release, shared, bootstrap, receipt, cutoff, old, fresh, file, physical, bytes, subscriptions, load, loads: () => loads, calls, query, quarantine, originalEvidence });
        assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'shared subscription file stays byte-identical');
        assert.equal(fs.readFileSync(physical, 'utf8'), bytes, 'physical subscription file stays byte-identical');
        for (const [name, value] of originalEvidence) assert.equal(fs.readFileSync(path.join(quarantine, name), 'utf8'), value, 'existing quarantine evidence stays byte-identical');
    } finally {
        process.chdir(cwd);
        for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
        for (const [id, value] of saved) { if (value) require.cache[id] = value; else delete require.cache[id]; }
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('cbte-managed-recovery-'));
        fs.rmSync(root, { recursive: true, force: true });
    }
}

for (const leafLink of [false, true]) test(`completed legacy recovery upgrades only new fences with the actual BOOTH provider and managed ${leafLink ? 'directory plus leaf links' : 'shared-data directory link'}`, async () => fixture(async f => {
    assert(fs.lstatSync(path.join(f.release, 'data')).isSymbolicLink()); assert.equal(f.subscriptions.FILE, path.join(f.release, 'data', 'booth_sale_notifications.json'));
    assert.equal(fs.lstatSync(f.file).isSymbolicLink(), leafLink); assert.equal(fs.realpathSync(f.subscriptions.FILE), fs.realpathSync(f.physical));
    const state = await f.bootstrap.initialize({ query: f.query });
    assert.equal(state.notificationFenceVersion, 2); assert.equal(state.complete, true); assert.equal(state.startedAtMs, f.cutoff);
    assert.equal(f.calls.length, tables.length); assert(f.calls.every(sql => tables.some(table => sql.includes(`FROM ${table} `)))); assert.equal(f.loads(), 0);
    assert.deepEqual(f.load(), [f.old, f.fresh]); assert.deepEqual(f.subscriptions.findDue(new Date(f.cutoff + 2)), [f.fresh], 'actual outgoing selector still quarantines pre-cutoff records');
    assert(kinds.every(kind => state.tables[kind].complete));
    delete require.cache[bootstrapPath]; const restarted = require(bootstrapPath); assert.equal((await restarted.initialize({ query: () => { throw new Error('complete v2 must not rescan'); } })).startedAtMs, f.cutoff);
}, true, leafLink));

for (const leafLink of [false, true]) test(`fresh incomplete recovery keeps strict BOOTH ${leafLink ? 'directory plus leaf' : 'directory'} link validation and never marks the new fences complete`, async () => fixture(async f => {
    await assert.rejects(f.bootstrap.initialize({ query: f.query }), error => error.code === 'RECOVERY_BOOTSTRAP_REQUIRED' && /symbolic links/.test(error.message));
    assert.equal(f.loads(), 0); const state = JSON.parse(fs.readFileSync(f.receipt, 'utf8')); assert.equal(state.complete, false); assert.equal(state.notificationFenceVersion, undefined); assert.equal(state.startedAtMs, f.cutoff);
}, false, leafLink));

test('legacy fence SQL failure checkpoints only new scopes and primary restart resumes without changing restored SQL rows', { skip: !port }, async () => fixture(async f => {
    const db = await createTestDatabase(port);
    try {
        const runId = randomUUID(), jobId = randomUUID(), oldAt = f.cutoff - 1;
        await db.queryDatabase("INSERT INTO automation_runs(id,dedupe_key,owner_user_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES(?,?,?,'private','auto',1,'{}','[]','queued',?)", [runId, require('../../src/automation/service').hash(runId), '222222222222222222', oldAt]);
        await db.queryDatabase("INSERT INTO automation_jobs(id,run_id,plan_json,due_at_ms,state,created_at_ms,updated_at_ms) VALUES(?,?,'{}',?,'pending',?,?)", [jobId, runId, oldAt, oldAt, oldAt]);
        const before = await db.queryDatabase('SELECT * FROM automation_jobs WHERE id=?', [jobId]);
        const calls = [];
        await assert.rejects(f.bootstrap.initialize({ query: async (sql, params) => { calls.push(sql); assert(sql.startsWith('SELECT ')); if (sql.includes('FROM automation_flow_steps ')) throw new Error('injected SQL read outage'); return db.queryDatabase(sql, params); } }), /injected SQL read outage/);
        const pending = JSON.parse(fs.readFileSync(f.receipt, 'utf8')); assert.equal(pending.complete, true); assert.equal(pending.notificationFenceVersion, undefined); assert.equal(pending.tables.automation_pending_jobs.complete, true); assert.equal(pending.tables.automation_pending_jobs.rows, 1); assert.equal(pending.startedAtMs, f.cutoff);
        assert.equal(f.loads(), 0); assert(calls.every(sql => !sql.includes('FROM autoextract_targets ')));
        delete require.cache[bootstrapPath]; process.env.CBTE_FLEET_NODE = 'primary'; const resumed = require(bootstrapPath), remaining = [];
        const upgraded = await resumed.initialize({ query: async (sql, params) => { remaining.push(sql); assert(sql.startsWith('SELECT ')); return db.queryDatabase(sql, params); } });
        assert.equal(upgraded.notificationFenceVersion, 2); assert.equal(upgraded.startedAtMs, f.cutoff); assert.equal(remaining.length, 4); assert(remaining.every(sql => !sql.includes('FROM automation_jobs ')));
        assert.deepEqual(await db.queryDatabase('SELECT * FROM automation_jobs WHERE id=?', [jobId]), before);
        assert.equal(resumed.notificationAllowed('automation_job', { id: jobId }, oldAt), false); assert.equal(resumed.notificationAllowed('automation_job', { id: 'new-job' }, f.cutoff + 1), true);
    } finally { await db.close(); }
}));

for (const partial of [false, true]) test(`historical three-scope receipt scans ${partial ? 'partial' : 'missing'} native delivery scopes and resumes a failed price quarantine`, { skip: !port }, async () => fixture(async f => {
    const db = await createTestDatabase(port);
    try {
        const { createService } = require('../../src/automation/service'), { createMonitors } = require('../../src/automation/monitors');
        const actor = { userId: '222222222222222222' }, service = createService(db); await require('../lib/automation-test-db').grantTestDonor(db, actor.userId);
        const destination = await service.saveDestination(actor, { name: 'Native quarantine fixture', kind: 'dm' }), monitors = createMonitors(db, service, {});
        const auto = await monitors.save(actor, 'auto', { name: 'Old new-item notification', providerId: 'github', source: 'octocat', destinationId: destination.id });
        const price = await monitors.save(actor, 'price', { name: 'Old price notification', providerId: 'steam', source: 'https://store.steampowered.com/app/730', mode: 'change', destinationId: destination.id });
        const source = (await db.queryDatabase('SELECT source_id FROM auto_watch_targets WHERE id=?', [auto.id]))[0];
        const item = await db.queryDatabase("INSERT INTO auto_watch_items(source_id,content_key,content_url,title,payload_json,discovered_at_ms) VALUES(?,'restored','https://github.com/old/release','Old event','{}',?)", [source.source_id, f.cutoff - 1000]);
        await db.queryDatabase("INSERT INTO auto_watch_deliveries(item_id,target_id,status,next_attempt_at_ms) VALUES(?,?,'pending',?)", [item.insertId, auto.id, f.cutoff - 1000]);
        await db.queryDatabase("INSERT INTO price_watch_deliveries(target_id,event_key,message_text,event_json,status,next_attempt_at_ms) VALUES(?,?,'Old price',?,'pending',?)", [price.id, 'a'.repeat(64), JSON.stringify({ observedAtMs: f.cutoff - 1000 }), f.cutoff - 1000]);
        const beforeAuto = await db.queryDatabase('SELECT * FROM auto_watch_deliveries'), beforePrice = await db.queryDatabase('SELECT * FROM price_watch_deliveries');
        if (partial) { const receipt = JSON.parse(fs.readFileSync(f.receipt, 'utf8')); receipt.tables.price_watch_pending_deliveries = { cursor: '0', pages: 0, rows: 0, complete: false }; fs.writeFileSync(f.receipt, JSON.stringify(receipt)); }
        delete require.cache[bootstrapPath]; process.env.CBTE_FLEET_NODE = 'primary'; const bootstrap = require(bootstrapPath), calls = [];
        await assert.rejects(bootstrap.initialize({ query: async (sql, params) => { calls.push(sql); assert(sql.startsWith('SELECT ')); if (sql.includes('FROM price_watch_deliveries ')) throw new Error('interrupted native price quarantine'); return db.queryDatabase(sql, params); } }), /interrupted native price quarantine/);
        assert.equal(calls.length, 2); assert(calls[0].includes('FROM auto_watch_deliveries ')); assert(calls[1].includes('FROM price_watch_deliveries '));
        const pending = JSON.parse(fs.readFileSync(f.receipt, 'utf8')); assert.equal(pending.notificationFenceVersion, undefined); assert.equal(pending.startedAtMs, f.cutoff); assert.equal(pending.tables.auto_watch_pending_deliveries.complete, true); assert.equal(pending.tables.auto_watch_pending_deliveries.rows, 1);
        delete require.cache[bootstrapPath]; const restarted = require(bootstrapPath), remaining = [];
        const state = await restarted.initialize({ query: async (sql, params) => { remaining.push(sql); assert(sql.startsWith('SELECT ')); return db.queryDatabase(sql, params); } });
        assert.equal(state.notificationFenceVersion, 2); assert.equal(state.startedAtMs, f.cutoff); assert.equal(remaining.length, 6); assert(remaining[0].includes('FROM price_watch_deliveries ')); assert.equal(state.tables.price_watch_pending_deliveries.rows, 1);
        const evidence = fs.readdirSync(f.quarantine).map(name => JSON.parse(fs.readFileSync(path.join(f.quarantine, name), 'utf8')));
        for (const [kind, rows] of [['auto_watch_pending_deliveries', beforeAuto], ['price_watch_pending_deliveries', beforePrice]]) { const record = evidence.find(row => row.kind === kind); assert(record); assert.equal(record.delivered, false); assert.equal(record.original.rows.length, 1); assert.equal(String(record.original.rows[0].id), String(rows[0].id)); }
        assert.deepEqual(await db.queryDatabase('SELECT * FROM auto_watch_deliveries'), beforeAuto); assert.deepEqual(await db.queryDatabase('SELECT * FROM price_watch_deliveries'), beforePrice); assert.equal(f.loads(), 0);
        assert.deepEqual(f.subscriptions.findDue(new Date(f.cutoff + 2)), [f.fresh]);
    } finally { await db.close(); }
}, true, true, false));

test('failed durable fence completion retains the legacy cutoff and retries without reopening shared BOOTH data', async () => fixture(async f => {
    const rename = fs.renameSync;
    fs.renameSync = function (from, to) { if (to === f.receipt && JSON.parse(fs.readFileSync(from, 'utf8')).notificationFenceVersion === 2) throw Object.assign(new Error('injected fence EIO'), { code: 'EIO' }); return rename.apply(this, arguments); };
    try { await assert.rejects(f.bootstrap.initialize({ query: f.query }), { code: 'EIO' }); }
    finally { fs.renameSync = rename; }
    const saved = JSON.parse(fs.readFileSync(f.receipt, 'utf8')); assert.equal(saved.complete, true); assert.equal(saved.notificationFenceVersion, undefined); assert.equal(saved.startedAtMs, f.cutoff); assert.equal(f.bootstrap.begin().notificationFenceVersion, undefined); assert.equal(f.loads(), 0);
    assert.equal((await f.bootstrap.initialize({ query: () => { throw new Error('durable scopes must not be rescanned'); } })).notificationFenceVersion, 2); assert.equal(f.loads(), 0);
}));

for (const complete of [true, false]) test(`actual ready lifecycle ${complete ? 'starts all workloads after the compatible fence upgrade' : 'keeps workloads stopped for incomplete linked BOOTH recovery'}`, async () => fixture(async f => {
    const readyPath = require.resolve('../../src/handlers/ready'), dbPath = require.resolve('../../src/db');
    const lifecycle = ['deregisterNotifier', 'statsPoster', 'consoleFlush', 'boothSaleNotifier', 'errorRateNotifier', 'mediaDeliveryServer', 'runtimeDiagnostics'].map(name => require.resolve(`../../src/lifecycle/${name}`));
    const workers = ['../providers/autoWatch/runner', '../providers/priceWatch/runner', '../automation/runtime', '../personalLinks/runner'].map(name => require.resolve(`../../src/handlers/${name}`));
    const ids = [readyPath, dbPath, ...lifecycle, ...workers], saved = new Map(ids.map(id => [id, require.cache[id]])), started = [];
    const stub = (id, exports) => { require.cache[id] = { id, filename: id, loaded: true, exports }; };
    try {
        for (const id of [...lifecycle, ...workers]) stub(id, { start: () => { started.push(id); } });
        stub(dbPath, { queryDatabase: f.query }); delete require.cache[readyPath];
        const ready = require(readyPath), client = { user: { tag: 'isolated-ready' }, application: { commands: { set: async () => { started.push('commands'); } } } };
        if (!complete) { await assert.rejects(ready._internal.initialize(client, null, null), /symbolic links/); assert.deepEqual(started, [require.resolve('../../src/lifecycle/runtimeDiagnostics')]); return; }
        await ready._internal.initialize(client, null, null); assert.equal(started.length, lifecycle.length + workers.length + 1); assert([...lifecycle, ...workers].every(id => started.includes(id))); assert.equal(f.loads(), 0);
        const leaseFile = path.join(f.root, 'lease.json'), now = Date.now(), lease = { state: 'active', node: 'oci', epoch: 4, validUntilUnixMs: now + 60000 };
        process.env.CBTE_FLEET_LEASE_FILE = leaseFile; process.env.CBTE_FLEET_EPOCH = '4'; fs.writeFileSync(leaseFile, JSON.stringify(lease));
        const recoveryLease = require('../../src/recoveryLease'); let submissions = 0;
        class LocalREST { queueRequest() { submissions++; return 'fake ACK'; } }
        recoveryLease.guardDiscord({ REST: LocalREST }); const rest = new LocalREST(); assert.equal(rest.queueRequest(), 'fake ACK');
        fs.writeFileSync(leaseFile, JSON.stringify({ ...lease, validUntilUnixMs: now - 1 })); assert.throws(() => rest.queueRequest(), { code: 'FLEET_LEASE_INVALID' }); assert.equal(submissions, 1);
        fs.writeFileSync(leaseFile, JSON.stringify(lease)); assert.equal(rest.queueRequest(), 'fake ACK'); assert.equal(submissions, 2);
        assert.deepEqual(f.subscriptions.findDue(new Date(f.cutoff + 2)), [f.fresh]); assert.equal(f.bootstrap.notificationAllowed('booth_sale', f.old, f.old.registeredAt), false);
    } finally { for (const [id, value] of saved) { if (value) require.cache[id] = value; else delete require.cache[id]; } }
}, complete));

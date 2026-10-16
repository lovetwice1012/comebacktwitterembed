'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomBytes, randomUUID, createCipheriv, createDecipheriv } = require('node:crypto');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const { createService, hash } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const { createQueue } = require('../../src/automation/queue');
const { createGraphStore } = require('../../src/automation/graph-store');
const { createFlowRuntime } = require('../../src/automation/flow-runtime');
const { createEvaluator } = require('../../src/automation/evaluation');
const { createRunner } = require('../../src/automation/runtime');
const { createXPushStore } = require('../../src/automation/x-push-store');
const { createXPushRuntime } = require('../../src/automation/x-push-runtime');
const entitlements = require('../../src/automation/entitlements');
const { newWorkflow, NODE_TYPES } = require('../../src/automation/schema');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT), U = '222222222222222222';
const bootstrapPath = require.resolve('../../src/recoveryBootstrap');

test('R32-1 restored flow and encrypted X origins cannot become new deliverable jobs after recovery', { skip: !port, timeout: 60000 }, async t => {
    const db = await createTestDatabase(port); let evaluator, flow, xRuntime;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cbte-recovery-runtime-'));
    const names = ['CBTE_RECOVERY_BOOTSTRAP_ID','CBTE_RECOVERY_BOOTSTRAP_DIR','CBTE_FLEET_NODE','CBTE_FLEET_LEASE_FILE','CBTE_FLEET_EPOCH'];
    const previous = new Map(names.map(name => [name, process.env[name]])), previousBootstrap = require.cache[bootstrapPath];
    for (const name of names) delete process.env[name]; delete require.cache[bootstrapPath];
    try {
        let now = Date.now() - 180000;
        const oldAt = now, actor = { userId: U }, admin = { userId: '666666666666666666', isAdmin: true }, query = db.queryDatabase;
        const service = createService(db), monitors = createMonitors(db, service, {});
        await grantTestDonor(db, U);
        await db.withDatabaseTransaction(async transaction => {
            for (const planId of ['free','supporter']) await entitlements.savePlanPolicy(transaction, admin, { planId, label: planId, slotLimit: 10, minuteLimit: 5, dayLimit: 24, priority: 1, intervalMinutes: 5 });
        });
        const destination = await service.saveDestination(actor, { name: 'Recovery fixture DM', kind: 'dm' });
        const aggregate = newWorkflow('Restored aggregate'); aggregate.nodes.splice(1, 0, { id: 'batch', type: 'aggregate', config: { ...NODE_TYPES.aggregate.defaults, key: 'all', minutes: 1 } }); aggregate.edges = [{ id: 'a', source: 'start', target: 'batch', port: 'out' }, { id: 'b', source: 'batch', target: 'send', port: 'out' }];
        const rule = await service.createWorkflow(actor, { definition: aggregate }); await service.activateWorkflow(actor, rule.id, { expectedRevision: 1 });
        const batchTarget = await monitors.save(actor, 'auto', { name: 'Aggregate', providerId: 'github', source: 'octocat', destinationId: destination.id }); await service.attach(actor, rule.id, 'auto', batchTarget.id);
        const directTarget = await monitors.save(actor, 'auto', { name: 'Normal', providerId: 'github', source: 'github', destinationId: destination.id });
        const priceTarget = await monitors.save(actor, 'price', { name: 'Price', providerId: 'steam', source: 'https://store.steampowered.com/app/730', mode: 'change', destinationId: destination.id });
        const newFlowTarget = await monitors.save(actor, 'auto', { name: 'New flow', providerId: 'github', source: 'microsoft', destinationId: destination.id });
        const newRule = await service.createWorkflow(actor, { definition: newWorkflow('New flow') }); await service.activateWorkflow(actor, newRule.id, { expectedRevision: 1 }); await service.attach(actor, newRule.id, 'auto', newFlowTarget.id);
        evaluator = createEvaluator(service.dictionaryData);
        const queue = createQueue(db, evaluator, { clock: () => now, rolloutMode: 'public', graph: { enabled: true, store: createGraphStore(db) } });
        const newFlow = adapter => createFlowRuntime(adapter, evaluator, createGraphStore(adapter), { assertEnabled: () => require('../../src/recoveryLease').assertAllowed() });
        flow = newFlow(db);
        async function drain(selected = flow) { for (let i = 0; i < 50; i++) { const result = await selected.tick(now); if (result.state === 'idle' && !result.projected) break; } }
        async function native(target, title, discoveredAtMs = now) {
            const source = (await query('SELECT source_id FROM auto_watch_targets WHERE id=?', [target.id]))[0], token = randomUUID(), key = randomUUID();
            const item = await query('INSERT INTO auto_watch_items (source_id,content_key,content_url,title,payload_json,discovered_at_ms) VALUES (?,?,?,?,?,?)', [source.source_id, key, 'https://github.com/recovery/fixture', title, '{}', discoveredAtMs]);
            const delivery = await query("INSERT INTO auto_watch_deliveries (item_id,target_id,status,next_attempt_at_ms,lease_token,lease_expires_at_ms) VALUES (?,?,'pending',?,?,?)", [item.insertId, target.id, now, token, now + 60000]);
            const input = { id: String(delivery.insertId), target_id: target.id, lease_token: token, provider_id: 'github', source_key: 'fixture', content_key: key, content_url: 'https://github.com/recovery/fixture', title, payload_json: '{}', discovered_at_ms: discoveredAtMs };
            return { input, result: await queue.route('auto', input, now) };
        }
        async function price(title, observedAtMs = now) {
            const token = randomUUID(), event = { providerId: 'steam', kind: 'price', url: 'https://store.steampowered.com/app/730', title, observedAtMs };
            const delivery = await query("INSERT INTO price_watch_deliveries (target_id,event_key,message_text,event_json,status,next_attempt_at_ms,lease_token,lease_expires_at_ms) VALUES (?,?,?,?,'pending',?,?,?)", [priceTarget.id, hash(randomUUID()), title, JSON.stringify(event), now, token, now + 60000]);
            return queue.route('price', { id: String(delivery.insertId), target_id: priceTarget.id, lease_token: token, event_json: JSON.stringify(event), message_text: title }, now);
        }
        const oldFlow = await native(batchTarget, 'Old aggregate member'); await drain();
        const oldBatch = (await query('SELECT * FROM automation_flow_batches'))[0]; assert.equal(oldBatch.state, 'open');
        now++; const oldDirect = await native(directTarget, 'Old normal control');
        const oldJob = (await query('SELECT * FROM automation_jobs WHERE run_id=?', [oldDirect.result.runId]))[0]; assert(oldJob);
        now++; const oldCompletedFlow = await native(newFlowTarget, 'Old projected flow'); await drain();
        const oldFlowJob = (await query('SELECT * FROM automation_jobs WHERE run_id=?', [oldCompletedFlow.result.runId]))[0]; assert(oldFlowJob); assert.equal(Number(oldFlowJob.execution_version), 2);
        const historicalJobs = [];
        for (const state of ['sent','unknown','partial']) {
            const id = randomUUID(); await query('INSERT INTO automation_jobs (id,run_id,execution_version,plan_json,due_at_ms,state,sent_steps,discord_message_id,created_at_ms,updated_at_ms) VALUES (?,?,1,?,?,?,?,?,?,?)',
                [id, oldDirect.result.runId, oldJob.plan_json, oldAt, state, state === 'unknown' ? 0 : 1, state === 'unknown' ? null : '799999999999999999', oldAt, oldAt]); historicalJobs.push(id);
        }
        const historicalReceipts = await query('SELECT * FROM automation_jobs WHERE id IN (?) ORDER BY id', [historicalJobs]);

        // Ciphertext remains encrypted in SQL. The local decrypter substitutes
        // only for the external X protocol; ownership/receipt/leases are real.
        const key = randomBytes(32);
        const seal = value => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url'); };
        const decryptions = [];
        const decrypt = async (_lease, inbox) => { decryptions.push(inbox.id); const bytes = Buffer.from(inbox.data, 'base64url'), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()); };
        const payload = title => ({ notificationType: 'tweet', url: `https://x.com/example/status/${title === 'Old X' ? '1234567890123456789' : '1234567890123456790'}`, author: { id: '12345', handle: 'example' }, title });
        const subscriptionId = randomUUID();
        await query('INSERT INTO automation_x_subscriptions (id,owner_user_id,uaid_hash,channel_hash,content_hash,sealed_json,key_id,browser_version,revision,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,1,?,?)', [subscriptionId, U, hash(randomUUID()), hash(randomUUID()), hash(randomUUID()), '{}', 'recovery-fixture', 'local', oldAt, oldAt]);
        await query("INSERT INTO automation_x_push_receivers (subscription_id,state,subscription_revision,updated_at_ms) VALUES (?,'stopped',1,?)", [subscriptionId, oldAt]);
        const xMonitor = await require('../../src/automation/x-monitor-quota').createXMonitorQuota(db, { registrationEnabled: true, rolloutMode: 'public' }).register(actor,
            { accountId: '12345', accountHandle: 'example', name: 'X fixture', notificationSettings: { subscriptionId, destinationId: destination.id }, processingMode: 'realtime', expectedRealtimeSlotCost: 5 });
        const xTargetId = xMonitor.id;
        const oldInbox = [];
        for (const status of ['received','unsupported']) oldInbox.push(String((await query('INSERT INTO automation_x_push_inbox (subscription_id,subscription_revision,version,data_ciphertext,headers_json,ack_code,status,received_at_ms) VALUES (?,1,?,?,?,100,?,?)', [subscriptionId, randomUUID(), seal(payload('Old X')), '{}', status, oldAt])).insertId));
        const originalInbox = await query('SELECT id,data_ciphertext,headers_json,ack_code,received_at_ms FROM automation_x_push_inbox ORDER BY id');
        const originalSubscriptions = await query('SELECT * FROM automation_x_subscriptions');
        const originalMonitors = await query('SELECT * FROM automation_x_monitors');
        const originalSlots = await query('SELECT * FROM automation_notification_slots ORDER BY slot_index');
        const originalBoosts = await query('SELECT * FROM automation_notification_boost_slots ORDER BY slot_index');
        const originalUnits = await query('SELECT id,payload_json,checksum FROM automation_flow_units ORDER BY id');

        const bootstrapDirectory = path.join(directory, 'bootstrap');
        process.env.CBTE_RECOVERY_BOOTSTRAP_ID = randomBytes(12).toString('hex'); process.env.CBTE_RECOVERY_BOOTSTRAP_DIR = bootstrapDirectory; process.env.CBTE_FLEET_NODE = 'oci';
        process.env.CBTE_FLEET_LEASE_FILE = path.join(directory, 'lease.json'); process.env.CBTE_FLEET_EPOCH = '1';
        fs.writeFileSync(process.env.CBTE_FLEET_LEASE_FILE, JSON.stringify({ state: 'active', node: 'oci', epoch: 1, validUntilUnixMs: Date.now() + 300000 }), { mode: 0o600 });
        delete require.cache[bootstrapPath]; const recovery = require(bootstrapPath), cutoff = recovery.begin().startedAtMs;
        const automationTables = { jobs: 'automation_jobs', steps: 'automation_flow_steps', batches: 'automation_flow_batches', sends: 'automation_flow_sends', inbox: 'automation_x_push_inbox' };
        const scanSql = []; let failScan = true;
        const bootstrapOptions = { tables: { autoExtractTargets: 'empty_targets', deregisterNotifications: 'empty_deregister', botErrorAlerts: 'empty_alerts' }, automationTables, subscriptions: { load: () => [] }, query: async (sql, params) => {
            scanSql.push(sql); if (sql.includes('empty_')) return [];
            if (sql.includes('automation_flow_steps') && failScan) { failScan = false; throw new Error('Fixture interrupted recovery scan'); }
            return query(sql, params);
        } };
        await assert.rejects(recovery.initialize(bootstrapOptions), /interrupted recovery scan/); assert.equal(recovery.begin().complete, false);
        const completed = await recovery.initialize(bootstrapOptions); assert.equal(completed.startedAtMs, cutoff); assert.equal(completed.complete, true); assert.equal(completed.notificationFenceVersion, 2);
        assert(scanSql.every(sql => sql.startsWith('SELECT '))); assert(completed.tables.automation_open_batches.rows); assert.equal(completed.tables.x_push_pending_inbox.rows, 2);
        await t.test('an existing completed v1 receipt upgrades the automation scan without moving its cutoff', async () => {
            const filename = path.join(bootstrapDirectory, 'bootstrap.json'), legacy = JSON.parse(fs.readFileSync(filename, 'utf8'));
            delete legacy.notificationFenceVersion;
            for (const kind of ['automation_pending_jobs','automation_pending_steps','automation_open_batches','automation_unprojected_sends','x_push_pending_inbox']) delete legacy.tables[kind];
            fs.writeFileSync(filename, JSON.stringify(legacy)); delete require.cache[bootstrapPath];
            const upgraded = require(bootstrapPath); failScan = true;
            await assert.rejects(upgraded.initialize(bootstrapOptions), /interrupted recovery scan/);
            assert.equal(upgraded.begin().startedAtMs, cutoff); assert.notEqual(upgraded.begin().notificationFenceVersion, 2);
            assert.equal((await upgraded.initialize(bootstrapOptions)).notificationFenceVersion, 2); assert.equal(upgraded.begin().startedAtMs, cutoff);
        });
        now = Date.now(); assert(now > cutoff);

        await t.test('old final control and post-cutoff jobs with old durable origins never prepare or send', async () => {
            let sends = 0, preparations = 0; const transport = { readiness: () => true, prepare: async () => { preparations++; return { payloads: [{}] }; }, sendStep: async () => { sends++; return '700000000000000001'; } };
            const runner = () => createRunner(db, queue, transport, { clock: () => now, sleep: async ms => { now += ms; } });
            assert.equal((await runner().tick()).state, 'cancelled'); assert.equal((await query('SELECT last_error_code FROM automation_jobs WHERE id=?', [oldJob.id]))[0].last_error_code, 'RECOVERY_QUARANTINED');
            // The final plan is a real graph projection. Reconstruct the
            // vulnerable version's post-cutoff creation timestamp while keeping
            // its original immutable run/unit/send identity and observed data.
            await query('UPDATE automation_jobs SET created_at_ms=? WHERE id=?', [now, oldFlowJob.id]);
            assert.equal((await runner().tick()).state, 'excluded'); assert.equal((await query('SELECT last_error_code FROM automation_jobs WHERE id=?', [oldFlowJob.id]))[0].last_error_code, 'RECOVERY_QUARANTINED');
            const reborn = randomUUID(); await query("INSERT INTO automation_jobs (id,run_id,execution_version,plan_json,due_at_ms,state,created_at_ms,updated_at_ms) VALUES (?,?,1,?,?,'pending',?,?)", [reborn, oldDirect.result.runId, oldJob.plan_json, now, now, now]);
            assert.equal((await runner().tick()).state, 'cancelled'); assert.equal((await query('SELECT last_error_code FROM automation_jobs WHERE id=?', [reborn]))[0].last_error_code, 'RECOVERY_QUARANTINED'); assert.equal(sends, 0); assert.equal(preparations, 0);
        });
        await t.test('file and DB failures leave old flow work intact and retry cannot re-age it', async () => {
            const rename = fs.renameSync; let failed = false;
            fs.renameSync = function (from, to) { if (!failed && String(to).startsWith(path.join(bootstrapDirectory, 'quarantine'))) { failed = true; throw Object.assign(new Error('Fixture quarantine write failed'), { code: 'EIO' }); } return rename.apply(this, arguments); };
            try { await assert.rejects(flow.tick(now), { code: 'EIO' }); } finally { fs.renameSync = rename; }
            assert.equal((await query('SELECT state FROM automation_flow_batches WHERE id=?', [oldBatch.id]))[0].state, 'open');
            const broken = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(transaction => work(async (sql, params) => { const result = await transaction(sql, params); if (sql.startsWith('UPDATE automation_flow_runs SET revoked_at_ms')) throw new Error('Fixture origin rollback'); return result; })) };
            const failingFlow = newFlow(broken); try { await assert.rejects(failingFlow.tick(now), /origin rollback/); } finally { failingFlow.clear(); }
            assert.equal((await query('SELECT revoked_at_ms FROM automation_flow_runs WHERE run_id=?', [oldFlow.result.runId]))[0].revoked_at_ms, null);
            await drain(); assert.equal((await query('SELECT revocation_code FROM automation_flow_runs WHERE run_id=?', [oldFlow.result.runId]))[0].revocation_code, 'RECOVERY_QUARANTINED');
            assert.equal((await query('SELECT * FROM automation_jobs WHERE run_id=?', [oldFlow.result.runId])).length, 0);
            assert.deepEqual(await query('SELECT id,payload_json,checksum FROM automation_flow_units ORDER BY id'), originalUnits);
        });
        const xStore = createXPushStore(db, { now: () => now, leaseMs: 300000 }), lease = await xStore.claim({ subscriptionId, ownerUserId: U, workerId: 'recovery-fixture' }); assert(lease);
        const xQueue = createQueue(db, evaluator, { clock: () => now, rolloutMode: 'public', graph: { enabled: true, store: createGraphStore(db) } });
        const runtime = store => createXPushRuntime(db, xQueue, { enabled: true, processingPolicy: 'batch', rolloutMode: 'public', clock: () => now, assertAllowed: () => require('../../src/recoveryLease').assertAllowed(), gateway: { store, decryptInbox: decrypt, decryptQuarantinedInbox: decrypt, run: async () => ({ state: 'stopped' }) } });
        await t.test('encrypted old inbox is fenced before decryption with transaction and lease protection', async () => {
            assert.equal((await xQueue.routeX({ ownerUserId: U, monitorId: xTargetId, inboxEventId: oldInbox[0], subscriptionId, payload: payload('Old X') }, now)).code, 'RECOVERY_QUARANTINED');
            const broken = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(transaction => work(async (sql, params) => { const result = await transaction(sql, params); if (sql.startsWith('INSERT INTO automation_audit') && params[2] === 'x.push.recovery.quarantine') throw new Error('Fixture inbox rollback'); return result; })) };
            const failing = runtime(createXPushStore(broken, { now: () => now, leaseMs: 300000 }));
            try { await assert.rejects(failing.drain(lease), { code: 'X_PUSH_STORE_UNAVAILABLE' }); } finally { await failing.stop(); }
            assert.deepEqual((await query('SELECT status FROM automation_x_push_inbox ORDER BY id')).map(row => row.status), ['received','unsupported']);
            xRuntime = runtime(xStore); await xRuntime.drain(lease);
            assert.equal(decryptions.length, 0); assert.deepEqual((await query('SELECT status FROM automation_x_push_inbox ORDER BY id')).map(row => row.status), ['recovery_quarantined','recovery_quarantined']);
            assert.deepEqual(await query('SELECT id,data_ciphertext,headers_json,ack_code,received_at_ms FROM automation_x_push_inbox ORDER BY id'), originalInbox);
            assert.equal((await query("SELECT * FROM automation_runs WHERE target_kind='x'")).length, 0);
            assert.equal((await xQueue.routeX({ ownerUserId: U, monitorId: xTargetId, inboxEventId: oldInbox[0], subscriptionId, payload: payload('Old X') }, now)).state, 'cancelled');
        });
        await t.test('fresh native, price, graph and X inputs on existing registrations remain deliverable', async () => {
            now = Date.now(); const stale = await native(directTarget, 'Restored deferred observation', oldAt); assert.equal(stale.result.state, 'suppressed');
            assert.equal((await price('Restored price observation inserted after recovery', oldAt)).state, 'suppressed');
            const freshPrice = await price('New price observation');
            const freshNormal = await native(directTarget, 'New normal'); const freshFlow = await native(newFlowTarget, 'New flow'); await drain();
            const currentFrame = await xStore.recordFrame(lease, { version: randomUUID(), data: seal(payload('New X')), headers: {}, ackCode: 100, status: 'received' }); assert(currentFrame.receivedAtMs > cutoff);
            await xRuntime.drain(lease); assert.deepEqual(decryptions, [currentFrame.id]);
            const xRun = (await query("SELECT id,created_at_ms FROM automation_runs WHERE target_kind='x'"))[0]; assert(Number(xRun.created_at_ms) > cutoff);
            const accepted = []; const transport = { readiness: () => true, prepare: async job => ({ payloads: [{ body: { content: job.plan.text } }] }), sendStep: async (_prepared, job) => { accepted.push(job.run_id); return String(700000000000000000n + BigInt(accepted.length)); } };
            for (let i = 0; i < 32; i++) {
                await createRunner(db, queue, transport, { clock: () => now, sleep: async ms => { now += ms; } }).tick();
                const pending = (await query("SELECT MIN(due_at_ms) AS due,COUNT(*) AS n FROM automation_jobs WHERE state='pending'"))[0]; if (!Number(pending.n)) break; now = Math.max(now + 1, Number(pending.due));
            }
            assert.deepEqual(new Set(accepted), new Set([freshNormal.result.runId, freshFlow.result.runId, freshPrice.runId, xRun.id]), JSON.stringify(await query('SELECT run_id,state,last_error_code FROM automation_jobs')));
            assert.deepEqual(await query('SELECT * FROM automation_x_subscriptions'), originalSubscriptions); assert.deepEqual(await query('SELECT * FROM automation_x_monitors'), originalMonitors); assert.deepEqual(await query('SELECT * FROM automation_notification_slots ORDER BY slot_index'), originalSlots); assert.deepEqual(await query('SELECT * FROM automation_notification_boost_slots ORDER BY slot_index'), originalBoosts);
            assert.deepEqual(await query('SELECT * FROM automation_jobs WHERE id IN (?) ORDER BY id', [historicalJobs]), historicalReceipts);
        });
        await t.test('restart and existing primary failback keep cutoff and never restore quarantined ciphertext', async () => {
            await xRuntime.stop(); await xStore.release(lease); delete require.cache[bootstrapPath];
            const restarted = require(bootstrapPath); assert.equal(restarted.begin().startedAtMs, cutoff); assert.equal((await restarted.initialize({ query: () => { throw new Error('Completed scope must not rescan'); } })).complete, true);
            process.env.CBTE_FLEET_NODE = 'primary'; delete require.cache[bootstrapPath]; assert.equal(require(bootstrapPath).begin().startedAtMs, cutoff); process.env.CBTE_FLEET_NODE = 'oci';
            const currentLease = await xStore.claim({ subscriptionId, ownerUserId: U, workerId: 'restart-fixture' }); assert(currentLease);
            await assert.rejects(xStore.markRecoveryQuarantined(lease, oldInbox[0]), { code: 'X_PUSH_LEASE_LOST' });
            assert.equal(await xStore.restoreQuarantinedInbox(currentLease, oldInbox[1]), false); assert.equal((await xStore.listQuarantinedInbox(currentLease)).length, 0);
            await xStore.release(currentLease);
        });
    } finally {
        await xRuntime?.stop(); flow?.clear(); try { await evaluator?.stop(); } finally { await db.close(); }
        for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
        if (previousBootstrap) require.cache[bootstrapPath] = previousBootstrap; else delete require.cache[bootstrapPath];
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert(path.basename(directory).startsWith('cbte-recovery-runtime-')); fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('R32-1 price cutoff uses the immutable observation in milliseconds and keeps legacy date fallback', () => {
    const { priceObservedAt } = require('../../src/automation/recovery-origin'), observedAtMs = Date.now(), coarse = new Date(Math.floor(observedAtMs / 1000) * 1000);
    assert.equal(priceObservedAt({ event_json: JSON.stringify({ observedAtMs }), created_at: coarse }), observedAtMs);
    for (const event_json of ['{}', '{invalid', JSON.stringify({ observedAtMs: -1 }), JSON.stringify({ observedAtMs: 'untrusted-string' })]) assert.equal(priceObservedAt({ event_json, created_at: coarse }), coarse.getTime());
    assert.equal(priceObservedAt({ event_json: '{}', created_at: 'invalid-date' }), undefined);
});

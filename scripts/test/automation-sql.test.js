'use strict';

// Opt-in integration test, always creates a new random schema on loopback.
// It cannot consume the Bot's DB config, DATABASE_URL or production schema.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createService } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const { createQueue, deliveryEvent } = require('../../src/automation/queue');
const { newWorkflow } = require('../../src/automation/schema');
const { evaluateWorkflow } = require('../../src/automation/engine');
const { createHistory } = require('../../src/automation/history');
const enabled = process.env.AUTOMATION_TEST_DB_PORT;

test('real SQL: management, immutable revisions, durable handoff, aggregation, rate gates and unknown send recovery', { skip: !enabled, timeout: 90000 }, async t => {
    const port = Number(enabled);
    assert(Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 3306, 'An explicit non-production loopback port is required');
    const mysql = require('mysql');
    const pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: process.env.AUTOMATION_TEST_DB_PASSWORD || '', connectionLimit: 8, supportBigNumbers: true, bigNumberStrings: true });
    const schema = `cbte_automation_test_${randomBytes(10).toString('hex')}`;
    const queryOn = connection => (sql, params = []) => new Promise((resolve, reject) => connection.query(sql, params, (err, result) => err ? reject(err) : resolve(result)));
    const acquire = () => new Promise((resolve, reject) => pool.getConnection((err, c) => err ? reject(err) : resolve(c)));
    const close = () => new Promise((resolve, reject) => pool.end(err => err ? reject(err) : resolve()));
    const context = new AsyncLocalStorage();
    let created = false;
    const admin = await acquire();
    try {
        await queryOn(admin)(`CREATE DATABASE ${mysql.escapeId(schema)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        created = true;
        const db = {
            queryDatabase: async (sql, params = []) => {
                if (context.getStore()) return context.getStore()(sql, params);
                const c = await acquire();
                try { await queryOn(c)(`USE ${mysql.escapeId(schema)}`); return await queryOn(c)(sql, params); }
                finally { c.release(); }
            },
            withDatabaseTransaction: async work => {
                if (context.getStore()) return work(context.getStore());
                const c = await acquire(), query = queryOn(c);
                try {
                    await query(`USE ${mysql.escapeId(schema)}`); await query('START TRANSACTION');
                    const result = await context.run(query, () => work(query));
                    await query('COMMIT'); return result;
                } catch (error) { await query('ROLLBACK'); throw error; }
                finally { c.release(); }
            },
        };
        const query = db.queryDatabase;
        const needed = /CREATE TABLE IF NOT EXISTS (?:users|webhook_endpoints|auto_watch_sources|auto_watch_targets|auto_watch_items|auto_watch_deliveries|price_watch_sources|price_watch_targets|price_watch_deliveries)\s*\(/;
        for (const sql of require('../../src/db_schema').SCHEMA_STATEMENTS.filter(sql => needed.test(sql))) await query(sql);
        for (const sql of require('../../src/automation/schema.sql').SCHEMA) await query(sql);
        const service = createService(db);
        const monitors = createMonitors(db, service, { verifyChannel: async () => ({ channel: { nsfw: false } }) });
        const actor = { userId: '222222222222222222', guildId: '111111111111111111', canView: true, canEdit: true };
        // This test owns its manually-created disposable schema.
        await query('INSERT INTO users (user_id,registered_at_ms,is_donor) VALUES (?,0,1)', [actor.userId]);
        const other = { ...actor, userId: '333333333333333333', isAdmin: true };
        const dm = await service.saveDestination(actor, { name: 'DM', kind: 'dm', scope: 'private' });
        const watch = await monitors.save(actor, 'auto', { name: 'GitHub', providerId: 'github', source: 'octocat', destinationId: dm.id, scope: 'private' });
        let now = Date.now();
        const evaluator = { evaluate: async (rule, event, _refs, time) => evaluateWorkflow(rule, event, { now: time }) };
        let queue = createQueue(db, evaluator, { clock: () => now });

        async function delivery(targetId = watch.id) {
            const [target] = await query('SELECT * FROM auto_watch_targets WHERE id=?', [targetId]);
            const contentId = randomUUID();
            const item = await query('INSERT INTO auto_watch_items (source_id,content_key,content_url,title,payload_json,discovered_at_ms) VALUES (?,?,?,?,?,?)', [target.source_id, contentId, 'https://github.com/octocat/example/releases/tag/v1', 'ReleaseEvent', JSON.stringify({ kind: 'ReleaseEvent', author: 'octocat' }), now]);
            const token = randomUUID();
            const result = await query("INSERT INTO auto_watch_deliveries (item_id,target_id,status,next_attempt_at_ms,lease_token,lease_expires_at_ms) VALUES (?,?,'pending',?,?,?)", [item.insertId, targetId, now, token, now + 60000]);
            return { id: String(result.insertId), item_id: String(item.insertId), target_id: targetId, lease_token: token, provider_id: 'github', content_url: 'https://github.com/octocat/example/releases/tag/v1', title: 'ReleaseEvent', discovered_at_ms: now, payload_json: JSON.stringify({ kind: 'ReleaseEvent', author: 'octocat' }) };
        }
        await t.test('Web-created private monitor is invisible to another admin; DM URL never appears', async () => {
            assert.equal((await monitors.list(actor, 'auto')).items.length, 1);
            assert.equal((await monitors.list(other, 'auto')).items.length, 0);
            await assert.rejects(monitors.save(other, 'auto', { expectedRevision: 1, enabled: false }, watch.id), { status: 404 });
            assert.equal((await service.list('destination', actor)).items[0].kind, 'dm');
        });
        await t.test('routing handoff is durable, unique, and recoverable from a new queue instance', async () => {
            const row = await delivery();
            const routed = await queue.route('auto', row, now);
            assert.equal(routed.state, 'routed');
            assert.equal((await query('SELECT status FROM auto_watch_deliveries WHERE id=?', [row.id]))[0].status, 'routed');
            queue = createQueue(db, evaluator, { clock: () => now });
            await queue.route('auto', row, now);
            assert.equal(Number((await query('SELECT COUNT(*) AS n FROM automation_runs'))[0].n), 1);
            const job = await queue.claim(now);
            assert.equal((await queue.check(job, now)).state, 'ready');
            assert.equal((await queue.beginSend(job, now)).state, 'sending');
            assert.equal(await queue.renewLease(job, now + 60000), true);
            assert.equal(Number((await query('SELECT lease_until_ms FROM automation_jobs WHERE id=?', [job.id]))[0].lease_until_ms), now + 180000);
            await queue.acknowledgeStep(job, '444444444444444444');
            await queue.transition(job, 'sent');
            assert.equal((await query('SELECT state FROM automation_jobs WHERE id=?', [job.id]))[0].state, 'sent');
        });
        let workflow;
        await t.test('applied definitions stay pinned while drafts change; paused rules do not bypass to legacy delivery', async () => {
            workflow = await service.createWorkflow(actor, { definition: newWorkflow('SQL test') });
            await service.activateWorkflow(actor, workflow.id, { expectedRevision: 1 });
            await service.attach(actor, workflow.id, 'auto', watch.id);
            await service.updateWorkflow(actor, workflow.id, { definition: newWorkflow('next draft'), expectedRevision: 1 });
            const row = await delivery();
            await queue.route('auto', row, now);
            const job = await queue.claim(now);
            assert.equal(Number(job.revision), 1);
            await queue.transition(job, 'cancelled');
            await service.setWorkflowState(actor, workflow.id, { expectedRevision: 2, enabled: false });
            const blocked = await delivery();
            assert.equal((await queue.route('auto', blocked, now)).state, 'pending');
            assert.equal((await query('SELECT status FROM auto_watch_deliveries WHERE id=?', [blocked.id]))[0].status, 'pending');
            await service.setWorkflowState(actor, workflow.id, { expectedRevision: 3, enabled: true });
        });
        await t.test('limits consume transactionally; sending-lease expiry becomes unknown, not a resend', async () => {
            const definition = newWorkflow('limit');
            definition.nodes.splice(1, 0, { id: 'gate', type: 'limit', config: { count: 1, minutes: 60, key: 'all', overflow: 'defer' } });
            definition.edges = [{ id: 'g1', source: 'start', target: 'gate', port: 'out' }, { id: 'g2', source: 'gate', target: 'send', port: 'out' }];
            await service.updateWorkflow(actor, workflow.id, { definition, expectedRevision: 4 });
            await service.activateWorkflow(actor, workflow.id, { expectedRevision: 5 });
            await queue.route('auto', await delivery(), now);
            await queue.route('auto', await delivery(), now);
            const first = await queue.claim(now), second = await queue.claim(now);
            assert.equal((await queue.beginSend(first, now)).state, 'sending');
            const gate = await queue.beginSend(second, now);
            assert.equal(gate.code, 'RATE_GATE_DEFERRED');
            await queue.transition(second, gate.state, gate.code, gate.dueAtMs);
            await query('UPDATE automation_jobs SET lease_until_ms=? WHERE id=?', [now - 1, first.id]);
            await queue.claim(now);
            assert.equal((await query('SELECT state FROM automation_jobs WHERE id=?', [first.id]))[0].state, 'unknown');
            assert.equal(await queue.renewLease(first, now), false);
            assert.equal(await queue.transition(first, 'pending', 'LATE_RATE_LIMIT', now + 60000), false);
            await assert.rejects(queue.acknowledgeStep(first, '444444444444444444'), { code: 'DELIVERY_UNKNOWN' });
            assert.equal((await query('SELECT state FROM automation_jobs WHERE id=?', [first.id]))[0].state, 'unknown');
        });
        await t.test('aggregation persists member snapshots; monitor changes cancel every pending member', async () => {
            const definition = newWorkflow('aggregate');
            definition.nodes.splice(1, 0, { id: 'group', type: 'aggregate', config: { minutes: 10, key: 'all', mode: 'all', maxItems: 10 } });
            definition.edges = [{ id: 'a1', source: 'start', target: 'group', port: 'out' }, { id: 'a2', source: 'group', target: 'send', port: 'out' }];
            await service.updateWorkflow(actor, workflow.id, { definition, expectedRevision: 5 });
            await service.activateWorkflow(actor, workflow.id, { expectedRevision: 6 });
            await queue.route('auto', await delivery(), now); await queue.route('auto', await delivery(), now);
            const jobs = await query('SELECT * FROM automation_jobs WHERE group_key IS NOT NULL');
            assert.equal(jobs.length, 2);
            const parent = jobs.find(j => !j.parent_job_id);
            assert.equal(JSON.parse(parent.plan_json).members.length, 2);
            now = Number(parent.due_at_ms) + 1;
            // The first limit-deferred job may come earlier; inspect explicitly.
            const candidate = { ...parent, target_kind: 'auto', target_id: watch.id, workflow_id: workflow.id, owner_user_id: actor.userId, plan: JSON.parse(parent.plan_json) };
            assert.equal((await queue.check(candidate, now)).state, 'ready');
            await monitors.save(actor, 'auto', { expectedRevision: 1, enabled: false }, watch.id);
            assert.equal((await queue.check(candidate, now)).state, 'cancelled');
            assert.equal((await query('SELECT state FROM automation_jobs WHERE id=?', [parent.id]))[0].state, 'cancelled');
        });
        await t.test('price observations preserve missing metadata instead of treating it as zero', () => {
            const event = deliveryEvent('price', { event_json: JSON.stringify({ priceAmount: 0, previousPriceAmount: null, priceDelta: null }) }, now);
            assert.equal(event.priceAmount, 0); assert.equal(event.priceDelta, undefined);
        });
        await t.test('history protects private events, rejects stale edits and never replays unknown deliveries', async () => {
            const history = createHistory(db, service);
            assert.equal((await history.list(other)).items.length, 0);
            const unknown = (await history.list(actor, { state: 'unknown' })).items[0];
            assert(unknown);
            await assert.rejects(history.change(actor, unknown.id, { action: 'retry', expectedVersion: unknown.version }), { code: 'DELIVERY_NOT_REPLAYABLE' });
            const additional = await monitors.save(actor, 'auto', { name: 'second', providerId: 'github', source: 'octocat2', destinationId: dm.id });
            await queue.route('auto', await delivery(additional.id), now);
            const pending = (await history.list(actor, { state: 'pending' })).items[0];
            assert(pending);
            await assert.rejects(history.detail(other, pending.id), { status: 404 });
            await history.change(actor, pending.id, { action: 'reschedule', expectedVersion: pending.version, dueAtMs: Date.now() + 7200000 });
            await assert.rejects(history.change(actor, pending.id, { action: 'cancel', expectedVersion: pending.version }), { code: 'REVISION_CONFLICT' });
            const refreshed = await history.detail(actor, pending.id);
            assert.equal(refreshed.event.kind, 'ReleaseEvent');
            await history.change(actor, refreshed.id, { action: 'cancel', expectedVersion: refreshed.version });
            assert.equal((await history.detail(actor, refreshed.id)).state, 'cancelled');
        });
        await t.test('old safety holds terminate without releasing possibly sent jobs', async () => {
            const fresh = (await query("SELECT id FROM automation_jobs WHERE sent_steps=0 AND parent_job_id IS NULL LIMIT 1"))[0];
            const sent = (await query("SELECT id FROM automation_jobs WHERE sent_steps>0 LIMIT 1"))[0];
            assert(fresh); assert(sent);
            await query("UPDATE automation_jobs SET state='held',last_error_code='SAFETY_VERIFIER_UNAVAILABLE' WHERE id IN (?,?)", [fresh.id, sent.id]);
            const history = createHistory(db, service);
            for (const row of [fresh, sent]) {
                const held = await history.detail(actor, row.id);
                await assert.rejects(history.change(actor, row.id, { action: 'reschedule', expectedVersion: held.version, dueAtMs: Date.now() + 3600000 }), { code: row === sent ? 'DELIVERY_NOT_REPLAYABLE' : 'NOT_PENDING' });
            }
            await queue.claim(now);
            assert.equal((await query('SELECT state FROM automation_jobs WHERE id=?', [fresh.id]))[0].state, 'failed');
            assert.equal((await query('SELECT state FROM automation_jobs WHERE id=?', [sent.id]))[0].state, 'partial');
            await query("UPDATE automation_jobs SET state='held',sent_steps=0,discord_message_id='444444444444444444' WHERE id=?", [sent.id]);
            await queue.claim(now);
            assert.equal((await query('SELECT state FROM automation_jobs WHERE id=?', [sent.id]))[0].state, 'partial');
            const partial = await history.detail(actor, sent.id);
            await assert.rejects(history.change(actor, sent.id, { action: 'retry', expectedVersion: partial.version }), { code: 'DELIVERY_NOT_REPLAYABLE' });
        });
        await t.test('legacy aggregate members follow terminal parents without moving scheduled pending jobs', async () => {
            const parent = (await query('SELECT * FROM automation_jobs WHERE group_key IS NOT NULL AND parent_job_id IS NULL LIMIT 1'))[0];
            assert(parent);
            await query("UPDATE automation_jobs SET state='held',sent_steps=0,discord_message_id=NULL WHERE id=?", [parent.id]);
            await query("UPDATE automation_jobs SET state='aggregated' WHERE parent_job_id=?", [parent.id]);
            const future = (await query('SELECT id FROM automation_jobs WHERE id<>? AND parent_job_id IS NULL LIMIT 1', [parent.id]))[0];
            const due = now + 86400000;
            await query("UPDATE automation_jobs SET state='pending',due_at_ms=?,sent_steps=0,discord_message_id=NULL WHERE id=?", [due, future.id]);
            await queue.claim(now);
            const members = await query('SELECT state FROM automation_jobs WHERE parent_job_id=?', [parent.id]);
            assert(members.length > 0); assert(members.every(member => member.state === 'failed'));
            const scheduled = (await query('SELECT state,due_at_ms FROM automation_jobs WHERE id=?', [future.id]))[0];
            assert.equal(scheduled.state, 'pending'); assert.equal(Number(scheduled.due_at_ms), due);
        });
        await t.test('a corrupt legacy queue snapshot cannot roll back hold cleanup or starve later jobs', async () => {
            const held = (await query('SELECT id FROM automation_jobs WHERE parent_job_id IS NULL LIMIT 1'))[0];
            for (const plan of ['{broken', 'null', '{"schedules":{}}']) {
                await query("UPDATE automation_jobs SET state='held',sent_steps=0,discord_message_id=NULL WHERE id=?", [held.id]);
                const broken = randomUUID();
                await query(`INSERT INTO automation_jobs (id,run_id,plan_json,due_at_ms,state,created_at_ms,updated_at_ms)
                    SELECT ?,run_id,?,0,'pending',?,? FROM automation_jobs WHERE id=?`, [broken, plan, now, now, held.id]);
                assert.equal(await queue.claim(now), null);
                const bad = (await query('SELECT state,last_error_code FROM automation_jobs WHERE id=?', [broken]))[0];
                assert.equal(bad.state, 'failed'); assert.equal(bad.last_error_code, 'QUEUE_PLAN_INVALID');
                assert.equal((await query('SELECT state FROM automation_jobs WHERE id=?', [held.id]))[0].state, 'failed');
            }
        });
    } finally {
        if (created && /^cbte_automation_test_[0-9a-f]{20}$/.test(schema)) await queryOn(admin)(`DROP DATABASE ${mysql.escapeId(schema)}`);
        admin.release(); await close();
    }
});

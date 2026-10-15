'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createQueue, targetIdentity } = require('../../src/automation/queue');
const { createMonitors } = require('../../src/automation/monitors');
const { createXMonitorQuota } = require('../../src/automation/x-monitor-quota');
const { createService, hash } = require('../../src/automation/service');
const entitlements = require('../../src/automation/entitlements');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (port !== 33621) throw new Error('Revision delivery SQL requires disposable AUTOMATION_TEST_DB_PORT=33621');
const U = '224444444444444444', ADMIN = { userId: '444444444444444444', isAdmin: true };
const actor = { userId: U, canView: true, canEdit: true };

test('persisted native, X and mixed graph jobs survive audited display-label edits while functional edits remain fenced', { timeout: 60000 }, async t => {
    const db = await createTestDatabase(port), query = db.queryDatabase, now = Date.now(); t.after(() => db.close());
    await query('INSERT INTO users (user_id,registered_at_ms,is_donor,additional_auto_extract_slots) VALUES (?,0,1,1)', [U]);
    await db.withDatabaseTransaction(async transactionQuery => {
        for (const planId of ['free', 'supporter']) await entitlements.savePlanPolicy(transactionQuery, ADMIN, { planId, label: planId, slotLimit: 5, minuteLimit: 7, dayLimit: 31, priority: 9, intervalMinutes: 5 });
    });
    const queue = createQueue(db, {}, { clock: () => now, rolloutMode: 'public' });
    const service = createService(db), monitors = createMonitors(db, service, {});
    const api = createXMonitorQuota(db, { registrationEnabled: true, rolloutMode: 'public' });
    const entries = [];
    for (const kind of ['auto', 'price']) {
        const table = kind === 'auto' ? 'auto_watch' : 'price_watch';
        const source = kind === 'auto'
            ? await query("INSERT INTO auto_watch_sources (provider_id,source_key,source_url,poll_interval_ms,created_at_ms) VALUES ('github',?,'https://github.com/synthetic/revision',3600000,0)", [randomUUID()])
            : await query("INSERT INTO price_watch_sources (provider_id,product_key,product_url,source_locale,poll_interval_ms,created_at_ms) VALUES ('steam',?,'https://store.steampowered.com/app/123/','ja',3600000,0)", [randomUUID()]);
        const extra = kind === 'price' ? ",watch_mode,rule_key" : '';
        const values = kind === 'price' ? ",'change','synthetic-rule'" : '';
        const target = await query(`INSERT INTO ${table}_targets (source_id,user_id,destination_type,destination_key,enabled,created_at_ms${extra}) VALUES (?,?,'dm',?,1,0${values})`, [source.insertId, U, `dm:${U}`]);
        const id = String(target.insertId);
        await query("INSERT INTO automation_monitors (target_kind,target_id,name,scope,revision) VALUES (?,?,?,'private',1)", [kind, id, `Original ${kind}`]);
        await db.withDatabaseTransaction(transactionQuery => entitlements.assignSlot(transactionQuery, U, kind, id));
        entries.push({ kind, id, identity: targetIdentity((await query(`SELECT * FROM ${table}_targets WHERE id=?`, [id]))[0]) });
    }
    const subscriptionId = randomUUID();
    await query('INSERT INTO automation_x_subscriptions (id,owner_user_id,uaid_hash,channel_hash,content_hash,sealed_json,key_id,browser_version,revision,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,1,0,0)', [subscriptionId, U, hash(randomUUID()), hash(randomUUID()), hash(randomUUID()), '{}', 'synthetic-key', 'synthetic-browser']);
    await query("INSERT INTO automation_x_push_receivers (subscription_id,state,subscription_revision,updated_at_ms) VALUES (?,'listening',1,?)", [subscriptionId, now]);
    const x = await api.register(actor, { accountHandle: 'label_fixture', processingMode: 'batch', notificationSettings: { subscriptionId } });
    const rawX = (await query('SELECT * FROM automation_x_monitors WHERE id=?', [x.id]))[0];
    entries.push({ kind: 'x', id: x.id, identity: targetIdentity({ ...rawX, source_id: `${rawX.account_id}:${subscriptionId}:1`, destination_key: `dm:${U}`, user_id: U, guild_id: null }) });

    async function persisted(members, graph = false) {
        const runId = randomUUID(), jobId = randomUUID(), lease = randomUUID(), first = members[0];
        await query("INSERT INTO automation_runs (id,dedupe_key,owner_user_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES (?,?,?,'private',?,?,'{}','[]','queued',?)", [runId, hash(runId), U, first.kind, first.id, now]);
        const plan = { monitorRevision: 1, targetIdentity: first.identity, context: { userId: U }, schedules: [], dictionaryRefs: {}, event: {}, text: 'Synthetic retained notification', display: { format: 'text', media: 'inherit' } };
        if (graph) {
            plan.members = members.map(entry => ({ id: randomUUID(), runId, targetKind: entry.kind, targetId: entry.id, monitorRevision: 1, targetIdentity: entry.identity,
                context: { userId: U }, schedules: [], dictionaryRefs: {}, event: {}, text: 'Synthetic retained member', display: { format: 'text', media: 'inherit' } }));
            plan.flowV2 = { members: plan.members.map(member => ({ memberId: member.id, runId })) };
        }
        await query("INSERT INTO automation_jobs (id,run_id,plan_json,due_at_ms,state,lease_token,lease_until_ms,created_at_ms,updated_at_ms) VALUES (?,?,?,?,'leased',?,?,?,?)", [jobId, runId, JSON.stringify(plan), now, lease, now + 120000, now, now]);
        return { id: jobId, run_id: runId, owner_user_id: U, scope: 'private', target_kind: first.kind, target_id: first.id, workflow_id: null,
            plan, due_at_ms: now, lease_token: lease, lease_until_ms: now + 120000 };
    }
    const jobs = await Promise.all(entries.map(entry => persisted([entry]))), mixed = await persisted(entries, true);
    const frozen = await query('SELECT id,plan_json FROM automation_jobs ORDER BY id');

    await t.test('real producers rename all three kinds and ordinary and mixed preflight retain frozen plans', async () => {
        for (const entry of entries) {
            if (entry.kind === 'x') await api.update(actor, entry.id, { expectedRevision: 1, name: 'New X display label' });
            else await monitors.save(actor, entry.kind, { expectedRevision: 1, name: `New ${entry.kind} display label` }, entry.id);
        }
        for (const job of [...jobs, mixed]) assert.equal((await queue.check(job, now)).state, 'ready');
        assert.deepEqual(await query('SELECT id,plan_json FROM automation_jobs ORDER BY id'), frozen);
        const refreshed = await queue.refreshFlowJob(mixed, now); assert.equal(refreshed.state, 'ready'); assert.equal(refreshed.job.plan.members.length, 3);
    });

    await t.test('missing, foreign, duplicate and damaged native/X rename history cannot authorize retained jobs', async () => {
        for (const [index, entry] of entries.entries()) {
            const audit = (await query("SELECT * FROM automation_audit WHERE entity_id=? AND action IN ('monitor.rename','x.monitor.rename') ORDER BY id DESC LIMIT 1", [`${entry.kind}:${entry.id}`]))[0];
            const detail = JSON.parse(audit.detail_json);
            for (const replacement of [JSON.stringify({ ...detail, ownerUserId: '333333333333333333' }), JSON.stringify({ ...detail, metadataOnly: false }), JSON.stringify({ ...detail, afterRevision: 3 }), '{corrupt']) {
                await query('UPDATE automation_audit SET detail_json=? WHERE id=?', [replacement, audit.id]);
                assert.equal((await queue.check(jobs[index], now)).state, 'cancelled');
                assert.equal((await queue.check(mixed, now)).code, 'FLOW_MEMBERSHIP_CHANGED');
            }
            await query('UPDATE automation_audit SET detail_json=? WHERE id=?', [audit.detail_json, audit.id]);
            await query("UPDATE automation_audit SET action='synthetic.missing' WHERE id=?", [audit.id]);
            assert.equal((await queue.check(jobs[index], now)).state, 'cancelled');
            await query('UPDATE automation_audit SET action=? WHERE id=?', [audit.action, audit.id]);
            const duplicate = await query('INSERT INTO automation_audit (actor_user_id,entity_id,action,detail_json,created_at_ms) VALUES (?,?,?,?,?)', [U, audit.entity_id, audit.action, audit.detail_json, now]);
            assert.equal((await queue.check(jobs[index], now)).state, 'cancelled');
            await query('DELETE FROM automation_audit WHERE id=?', [duplicate.insertId]);
            assert.equal((await queue.check(jobs[index], now)).state, 'ready');
        }
    });

    await t.test('identity checks and actual configuration changes retain their cancellation policy after a valid rename', async () => {
        for (const job of jobs) {
            const changed = structuredClone(job); changed.plan.targetIdentity = 'synthetic-foreign-identity';
            assert.equal((await queue.check(changed, now)).state, 'cancelled');
        }
        assert.equal((await queue.beginSend(mixed, now)).state, 'sending');
        const current = (await api.list(actor)).items.find(row => row.id === x.id);
        await api.update(actor, x.id, { expectedRevision: current.revision, accountHandle: 'changed_target' });
        assert.equal((await queue.check(jobs[2], now)).state, 'cancelled');
        assert.equal((await queue.check(mixed, now)).code, 'FLOW_MEMBERSHIP_CHANGED');
        assert.equal(Number((await query('SELECT COUNT(*) n FROM automation_jobs'))[0].n), 4, 'edit fences retain durable records rather than deleting queued notifications');
    });
});

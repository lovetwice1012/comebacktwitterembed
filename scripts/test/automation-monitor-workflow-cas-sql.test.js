'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService, hash } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const { createQueue, targetIdentity } = require('../../src/automation/queue');
const { createRunner } = require('../../src/automation/runtime');
const { createRateLimiter } = require('../../src/automation/rate-limits');
const entitlements = require('../../src/automation/entitlements');
const { newWorkflow } = require('../../src/automation/schema');
const { dispatch } = require('../../src/automation/api');

const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (port !== 33621) throw Error('Workflow CAS SQL requires disposable AUTOMATION_TEST_DB_PORT=33621');
const U = '225555555555555555', V = '226666666666666666';
const actor = { userId: U }, ADMIN = { userId: '444444444444444444', isAdmin: true };
const tableFor = kind => kind === 'auto' ? 'auto_watch' : 'price_watch';
const guards = (revision = 1, workflowId = null) => ({ expectedRevision: revision, expectedWorkflowId: workflowId });

test('workflow-only native edits use atomic target/assignment CAS and preserve unrelated deliveries', { timeout: 120000 }, async t => {
    const db = await createTestDatabase(port), query = db.queryDatabase; t.after(() => db.close());
    const serviceFor = adapter => createService(adapter, { rateLimiter: createRateLimiter(adapter, { policy: { operations: { write: { minute: 1000, hour: 10000 }, monitor: { minute: 1000, hour: 10000 } } } }) });
    const service = serviceFor(db), monitors = createMonitors(db, service, {});
    await query('INSERT INTO users (user_id,registered_at_ms,is_donor) VALUES (?,0,1)', [U]);
    await db.withDatabaseTransaction(async transactionQuery => {
        for (const planId of ['free', 'supporter']) await entitlements.savePlanPolicy(transactionQuery, ADMIN, { planId, label: planId, slotLimit: 1000, minuteLimit: 7, dayLimit: 31, priority: 9, intervalMinutes: 5 });
    });
    const rule = (who = actor) => service.createWorkflow(who, { definition: newWorkflow('Synthetic workflow CAS') });
    async function target(kind, who = actor, metadata = true) {
        await query('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,0)', [who.userId]);
        const key = randomUUID(), table = tableFor(kind);
        const source = kind === 'auto'
            ? await query("INSERT INTO auto_watch_sources (provider_id,source_key,source_url,poll_interval_ms,created_at_ms) VALUES ('github',?,'https://github.com/synthetic/workflow',3600000,0)", [key])
            : await query("INSERT INTO price_watch_sources (provider_id,product_key,product_url,source_locale,poll_interval_ms,created_at_ms) VALUES ('steam',?,'https://store.steampowered.com/app/123/','ja',3600000,0)", [key]);
        const extra = kind === 'price' ? ',watch_mode,rule_key' : '';
        const values = kind === 'price' ? ",'change','synthetic-rule'" : '';
        const inserted = await query(`INSERT INTO ${table}_targets (source_id,user_id,destination_type,destination_key,enabled,created_at_ms${extra}) VALUES (?,?,'dm',?,1,0${values})`, [source.insertId, who.userId, `dm:${who.userId}`]);
        const id = String(inserted.insertId);
        if (metadata) await query("INSERT INTO automation_monitors (target_kind,target_id,name,scope,revision) VALUES (?,?,?,'private',1)", [kind, id, `Original ${kind}`]);
        return { id, kind, sourceId: source.insertId, owner: who.userId };
    }
    const metadata = async entry => (await query('SELECT * FROM automation_monitors WHERE target_kind=? AND target_id=?', [entry.kind, entry.id]))[0];
    const assignment = async entry => (await query('SELECT workflow_id FROM automation_assignments WHERE target_kind=? AND target_id=?', [entry.kind, entry.id]))[0]?.workflow_id ?? null;
    async function nativeDelivery(entry, state = 'pending') {
        if (entry.kind === 'price') return (await query('INSERT INTO price_watch_deliveries (target_id,event_key,message_text,status) VALUES (?,?,?,?)', [entry.id, hash(randomUUID()), 'Synthetic pending price', state])).insertId;
        const item = await query("INSERT INTO auto_watch_items (source_id,content_key,content_url,title,payload_json,discovered_at_ms) VALUES (?,?,'https://github.com/synthetic/workflow','Synthetic native item','{}',0)", [entry.sourceId, randomUUID()]);
        return (await query('INSERT INTO auto_watch_deliveries (item_id,target_id,status) VALUES (?,?,?)', [item.insertId, entry.id, state])).insertId;
    }
    async function run(entry, workflowId = null) {
        const id = randomUUID();
        await query("INSERT INTO automation_runs (id,dedupe_key,owner_user_id,scope,workflow_id,revision,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES (?,?,?,'private',?,?,?,?, '{}','[]','queued',0)", [id, hash(id), entry.owner, workflowId, workflowId ? 1 : null, entry.kind, entry.id]);
        return id;
    }
    async function job(entry, state = 'pending', workflowId = null, execution = 1) {
        const runId = await run(entry, workflowId), id = randomUUID(), now = Date.now(), lease = randomUUID();
        const plan = { monitorRevision: Number((await metadata(entry))?.revision || 1), context: { userId: entry.owner }, schedules: [], dictionaryRefs: {}, event: {}, text: 'Synthetic old queued job' };
        await query('INSERT INTO automation_jobs (id,run_id,execution_version,plan_json,due_at_ms,state,lease_token,lease_until_ms,sent_steps,discord_message_id,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [id, runId, execution, JSON.stringify(plan), now, state, lease, now + 120000, ['sent', 'partial'].includes(state) ? 1 : 0, state === 'sent' ? '555555555555555555' : null, now, now]);
        return { id, runId, lease, now, plan };
    }

    for (const kind of ['auto', 'price']) {
        await t.test(`${kind}: two competing workflow choices from one editor version admit exactly one`, async () => {
            const entry = await target(kind), one = await rule(), two = await rule();
            const results = await Promise.allSettled([service.attach(actor, one.id, kind, entry.id, guards()), service.attach(actor, two.id, kind, entry.id, guards())]);
            assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
            assert.equal(results.find(result => result.status === 'rejected').reason.code, 'REVISION_CONFLICT');
            assert.equal(Number((await metadata(entry)).revision), 2);
            const winner = results.findIndex(result => result.status === 'fulfilled'); assert.equal(await assignment(entry), [one.id, two.id][winner]);
        });

        await t.test(`${kind}: a stale monitor revision or old assignment cannot replace the newer choice`, async () => {
            const entry = await target(kind), one = await rule(), two = await rule();
            await service.attach(actor, one.id, kind, entry.id, guards());
            await assert.rejects(service.attach(actor, two.id, kind, entry.id, guards(1, one.id)), { code: 'REVISION_CONFLICT', status: 409 });
            await assert.rejects(service.attach(actor, two.id, kind, entry.id, guards(2, null)), { code: 'REVISION_CONFLICT', status: 409 });
            // A separately committed destination edit changes the metadata CAS.
            await query('UPDATE automation_monitors SET destination_id=?,revision=revision+1 WHERE target_kind=? AND target_id=?', [randomUUID(), kind, entry.id]);
            await assert.rejects(service.attach(actor, two.id, kind, entry.id, guards(2, one.id)), { code: 'REVISION_CONFLICT' });
            assert.equal(await assignment(entry), one.id); assert.equal(Number((await metadata(entry)).revision), 3);
        });

        await t.test(`${kind}: guarded attach/detach advance revisions and unchanged assignments are safe no-ops`, async () => {
            const entry = await target(kind), workflow = await rule();
            const changed = await service.attach(actor, workflow.id, kind, entry.id, guards()); assert.deepEqual(changed, { attached: true, revision: 2 });
            const queued = await job(entry), pending = await nativeDelivery(entry);
            assert.deepEqual(await service.attach(actor, workflow.id, kind, entry.id, guards(2, workflow.id)), { attached: true, unchanged: true, revision: 2 });
            assert.equal((await query('SELECT state FROM automation_jobs WHERE id=?', [queued.id]))[0].state, 'pending');
            assert.equal((await query(`SELECT status FROM ${tableFor(kind)}_deliveries WHERE id=?`, [pending]))[0].status, 'pending');
            await assert.rejects(monitors.detach(actor, kind, entry.id, 2, { expectedWorkflowId: null }), { code: 'REVISION_CONFLICT' });
            const detached = await monitors.detach(actor, kind, entry.id, 2, { expectedWorkflowId: workflow.id }); assert.deepEqual(detached, { detached: true, revision: 3 });
            assert.equal(await assignment(entry), null); assert.equal((await query('SELECT state FROM automation_jobs WHERE id=?', [queued.id]))[0].state, 'cancelled');
            assert.deepEqual(await monitors.detach(actor, kind, entry.id, 3, { expectedWorkflowId: null }), { detached: true, unchanged: true, revision: 3 });
            assert.equal((await metadata(entry)).name, `Original ${kind}`);
        });

        await t.test(`${kind}: a simultaneous guarded detach cannot erase a newer workflow choice`, async () => {
            const entry = await target(kind), old = await rule(), next = await rule();
            await service.attach(actor, old.id, kind, entry.id);
            const revision = Number((await metadata(entry)).revision);
            const results = await Promise.allSettled([service.attach(actor, next.id, kind, entry.id, guards(revision, old.id)), monitors.detach(actor, kind, entry.id, revision, { expectedWorkflowId: old.id })]);
            assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
            assert.equal(results.find(result => result.status === 'rejected').reason.code, 'REVISION_CONFLICT');
            assert.equal(Number((await metadata(entry)).revision), revision + 1);
            assert.equal(await assignment(entry), results[0].status === 'fulfilled' ? next.id : null);
        });

        await t.test(`${kind}: legacy unguarded calls retain their flags while fencing newer choices and cancelling obsolete jobs`, async () => {
            const entry = await target(kind), one = await rule(), two = await rule(), queued = await job(entry);
            assert.deepEqual(await service.attach(actor, one.id, kind, entry.id), { attached: true, revision: 2 });
            assert.deepEqual(await service.attach(actor, two.id, kind, entry.id), { attached: true, revision: 3 });
            assert.equal(await assignment(entry), two.id); assert.equal(Number((await metadata(entry)).revision), 3);
            assert.equal((await query('SELECT state FROM automation_jobs WHERE id=?', [queued.id]))[0].state, 'cancelled');
            await assert.rejects(monitors.detach(actor, kind, entry.id, 1), { code: 'REVISION_CONFLICT' });
            assert.deepEqual(await monitors.detach(actor, kind, entry.id, 3), { detached: true, revision: 4 });
            assert.equal(await assignment(entry), null); assert.equal(Number((await metadata(entry)).revision), 4);
        });

        await t.test(`${kind}: private ownership remains required for guarded changes even for an administrator`, async () => {
            const entry = await target(kind), workflow = await rule(), other = { userId: V, isAdmin: true }, foreign = await rule(other);
            await assert.rejects(service.attach(other, foreign.id, kind, entry.id, guards()), { code: 'NOT_FOUND', status: 404 });
            await assert.rejects(service.attach(actor, foreign.id, kind, entry.id, guards()), { code: 'NOT_FOUND', status: 404 });
            await service.attach(actor, workflow.id, kind, entry.id, guards());
            await assert.rejects(monitors.detach(other, kind, entry.id, 2, { expectedWorkflowId: workflow.id }), { code: 'NOT_FOUND', status: 404 });
            assert.equal(await assignment(entry), workflow.id);
        });

        await t.test(`${kind}: an audit failure rolls back assignment, revision and all pending cancellation`, async () => {
            const entry = await target(kind), workflow = await rule(), queued = await job(entry), pending = await nativeDelivery(entry);
            const fault = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(transactionQuery => work(async (sql, params) => {
                const result = await transactionQuery(sql, params);
                if (sql.startsWith('INSERT INTO automation_audit') && ['workflow.attach', 'monitor.detach'].includes(params[3])) await transactionQuery("SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic guarded assignment audit failure'");
                return result;
            })) };
            const brokenService = serviceFor(fault), brokenMonitors = createMonitors(fault, brokenService, {});
            await assert.rejects(brokenService.attach(actor, workflow.id, kind, entry.id, guards()));
            assert.equal(await assignment(entry), null); assert.equal(Number((await metadata(entry)).revision), 1);
            assert.equal((await query('SELECT state FROM automation_jobs WHERE id=?', [queued.id]))[0].state, 'pending');
            assert.equal((await query(`SELECT status FROM ${tableFor(kind)}_deliveries WHERE id=?`, [pending]))[0].status, 'pending');
            await service.attach(actor, workflow.id, kind, entry.id);
            const afterAttach = await job(entry), freshPending = await nativeDelivery(entry);
            await assert.rejects(brokenMonitors.detach(actor, kind, entry.id, 2, { expectedWorkflowId: workflow.id }));
            assert.equal(await assignment(entry), workflow.id); assert.equal(Number((await metadata(entry)).revision), 2);
            assert.equal((await query('SELECT state FROM automation_jobs WHERE id=?', [queued.id]))[0].state, 'cancelled');
            assert.equal((await query('SELECT state FROM automation_jobs WHERE id=?', [afterAttach.id]))[0].state, 'pending');
            assert.equal((await query(`SELECT status FROM ${tableFor(kind)}_deliveries WHERE id=?`, [freshPending]))[0].status, 'pending');
        });

        await t.test(`${kind}: cancellation affects only the edited target; unknown/sent records and v2 peers remain intact`, async () => {
            const entry = await target(kind), peer = await target(kind), old = await rule(), next = await rule();
            await service.activateWorkflow(actor, old.id, { expectedRevision: old.revision });
            await service.attach(actor, old.id, kind, entry.id); await service.attach(actor, old.id, kind, peer.id);
            const states = ['pending', 'held', 'leased', 'aggregated', 'unknown', 'partial', 'sent', 'sending'];
            const jobs = await Promise.all(states.map(state => job(entry, state, old.id))), peerJob = await job(peer, 'pending', old.id);
            const pending = await nativeDelivery(entry), peerPending = await nativeDelivery(peer);
            const primaryRun = await run(entry, old.id), peerRun = await run(peer, old.id), graphId = randomUUID(), now = Date.now(), lease = randomUUID();
            for (const runId of [primaryRun, peerRun]) await query("INSERT INTO automation_flow_runs (run_id,namespace_key,context_json) VALUES (?,?,'{}')", [runId, hash('workflow-cas-shared-namespace')]);
            const members = [];
            for (const [selected, runId] of [[entry, primaryRun], [peer, peerRun]]) {
                await db.withDatabaseTransaction(transactionQuery => entitlements.assignSlot(transactionQuery, U, kind, selected.id));
                const raw = (await query(`SELECT * FROM ${tableFor(kind)}_targets WHERE id=?`, [selected.id]))[0];
                members.push({ id: randomUUID(), runId, targetKind: kind, targetId: selected.id, monitorRevision: Number((await metadata(selected)).revision), targetIdentity: targetIdentity(raw), context: { userId: U }, event: {}, schedules: [], text: 'Synthetic peer member' });
            }
            const plan = { members, flowV2: { members: members.map(member => ({ memberId: member.id, runId: member.runId })) }, context: { userId: U }, dictionaryRefs: {}, schedules: [], text: 'Synthetic shared batch', event: {} };
            await query("INSERT INTO automation_jobs (id,run_id,execution_version,plan_json,due_at_ms,state,lease_token,lease_until_ms,created_at_ms,updated_at_ms) VALUES (?,?,2,?,?,'leased',?,?,?,?)", [graphId, primaryRun, JSON.stringify(plan), now, lease, now + 120000, now, now]);
            await service.attach(actor, next.id, kind, entry.id, guards(2, old.id));
            for (let index = 0; index < states.length; index++) assert.equal((await query('SELECT state FROM automation_jobs WHERE id=?', [jobs[index].id]))[0].state, index < 4 ? 'cancelled' : states[index]);
            assert.equal((await query('SELECT state FROM automation_jobs WHERE id=?', [peerJob.id]))[0].state, 'pending');
            assert.equal((await query(`SELECT status FROM ${tableFor(kind)}_deliveries WHERE id=?`, [pending]))[0].status, 'cancelled');
            assert.equal((await query(`SELECT status FROM ${tableFor(kind)}_deliveries WHERE id=?`, [peerPending]))[0].status, 'pending');
            assert.ok((await query('SELECT revoked_at_ms FROM automation_flow_runs WHERE run_id=?', [primaryRun]))[0].revoked_at_ms);
            assert.equal((await query('SELECT revoked_at_ms FROM automation_flow_runs WHERE run_id=?', [peerRun]))[0].revoked_at_ms, null);
            assert.equal((await query('SELECT state FROM automation_jobs WHERE id=?', [graphId]))[0].state, 'leased');
            const refreshed = await createQueue(db, {}, { clock: () => now }).refreshFlowJob({ id: graphId, owner_user_id: U, workflow_id: old.id, target_kind: kind, target_id: entry.id, plan, lease_token: lease }, now);
            assert.equal(refreshed.state, 'ready'); assert.deepEqual(refreshed.job.plan.members.map(member => member.targetId), [peer.id]);
            assert.equal((await query('SELECT COUNT(*) n FROM automation_jobs WHERE id IN (?)', [jobs.map(job => job.id)]))[0].n, String(states.length));
        });
    }

    await t.test('legacy targets without saved metadata acquire a CAS revision without replacing their display-label fallback', async () => {
        const entry = await target('price', actor, false), workflow = await rule();
        const before = (await monitors.list(actor, 'price')).items.find(item => item.id === entry.id);
        await service.attach(actor, workflow.id, 'price', entry.id, guards());
        const after = (await monitors.list(actor, 'price')).items.find(item => item.id === entry.id);
        assert.equal(after.name, before.name); assert.equal(after.revision, 2); assert.equal((await metadata(entry)).name, '');
    });

    await t.test('HTTP attach and detach validate complete guards and forward the current previous assignment', async () => {
        const entry = await target('auto'), workflow = await rule(), services = { db, service, monitors };
        const attach = body => dispatch({ method: 'POST', path: ['workflows', workflow.id, 'attach'], body: { targetKind: 'auto', targetId: entry.id, ...body } }, actor, services);
        for (const input of [{ expectedRevision: 1 }, { expectedWorkflowId: null }, guards('1'), guards(1, ''), guards(0), guards(1, 'foreign')]) await assert.rejects(attach(input), { code: 'INVALID_ASSIGNMENT_GUARD' });
        const attached = await attach(guards()); assert.equal(attached.revision, 2);
        const detached = await dispatch({ method: 'POST', path: ['monitors', 'auto', entry.id], body: { action: 'detach', ...guards(2, workflow.id) } }, actor, services);
        assert.equal(detached.revision, 3); assert.equal(await assignment(entry), null);
        await assert.rejects(dispatch({ method: 'POST', path: ['monitors', 'auto', entry.id], body: { action: 'detach', expectedWorkflowId: null } }, actor, services), { code: 'INVALID_ASSIGNMENT_GUARD' });
        assert.equal((await attach({})).attached, true, 'unguarded HTTP clients remain supported');
    });

    await t.test('a known transaction deadlock before physical send preserves either the cancelled new choice or the complete old delivery', async () => {
        const entry = await target('auto'), old = await rule(), next = await rule();
        await service.activateWorkflow(actor, old.id, { expectedRevision: old.revision });
        await service.attach(actor, old.id, 'auto', entry.id);
        const initialRevision = Number((await metadata(entry)).revision);
        const queued = await job(entry, 'leased', old.id), raw = (await query('SELECT * FROM auto_watch_targets WHERE id=?', [entry.id]))[0];
        queued.plan.targetIdentity = targetIdentity(raw);
        await query('UPDATE automation_jobs SET plan_json=? WHERE id=?', [JSON.stringify(queued.plan), queued.id]);
        let workerHasJob, guardHasTarget, workerRequestsTarget;
        const jobLocked = new Promise(resolve => { workerHasJob = resolve; }), targetLocked = new Promise(resolve => { guardHasTarget = resolve; });
        const targetRequested = new Promise(resolve => { workerRequestsTarget = resolve; });
        const deadlocks = [];
        const workerDb = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(transactionQuery => work(async (sql, params) => {
            try {
                if (sql.startsWith('SELECT * FROM automation_jobs WHERE id=? FOR UPDATE')) {
                    const result = await transactionQuery(sql, params); workerHasJob(); await targetLocked; return result;
                }
                if (sql.includes('FROM auto_watch_targets t LEFT JOIN automation_monitors') && sql.endsWith('FOR UPDATE')) {
                    const pending = transactionQuery(sql, params); workerRequestsTarget(); return await pending;
                }
                return await transactionQuery(sql, params);
            } catch (error) { if (error.code === 'ER_LOCK_DEADLOCK') deadlocks.push('worker'); throw error; }
        })) };
        const guardedDb = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(transactionQuery => work(async (sql, params) => {
            try {
                const result = await transactionQuery(sql, params);
                if (sql.includes('m.revision AS monitor_revision FROM auto_watch_targets') && sql.endsWith('FOR UPDATE')) {
                    guardHasTarget(); await targetRequested;
                }
                return result;
            } catch (error) { if (error.code === 'ER_LOCK_DEADLOCK') deadlocks.push('guard'); throw error; }
        })) };
        let time = queued.now, claims = 0, sends = 0, releases = 0;
        const queue = createQueue(workerDb, {}, { clock: () => time });
        const jobObject = { id: queued.id, owner_user_id: U, workflow_id: old.id, revision: 1, target_kind: 'auto', target_id: entry.id,
            scope: 'private', plan: queued.plan, lease_token: queued.lease, due_at_ms: time, created_at_ms: time, attempts: 0 };
        const runner = createRunner(workerDb, { ...queue, claim: async () => claims++ === 0 ? jobObject : null }, {
            prepare: async () => ({ payloads: [{}] }), release: async () => { releases++; },
            sendStep: async () => { sends++; return '555555555555555555'; },
        }, { clock: () => time, sleep: async ms => { time += ms; }, assertAllowed: () => {}, notificationAllowed: () => true });
        const sending = runner.tick(); await jobLocked;
        const attaching = serviceFor(guardedDb).attach(actor, next.id, 'auto', entry.id, guards(initialRevision, old.id));
        const results = await Promise.allSettled([sending, attaching]);
        assert.ok(deadlocks.length > 0, 'the fixture must exercise a real InnoDB transaction-abort conflict');
        assert.equal(results[0].status, 'fulfilled');
        const stored = (await query('SELECT * FROM automation_jobs WHERE id=?', [queued.id]))[0];
        if (results[1].status === 'fulfilled') {
            assert.equal(await assignment(entry), next.id); assert.equal(Number((await metadata(entry)).revision), initialRevision + 1);
            assert.equal(stored.state, 'cancelled'); assert.equal(sends, 0);
        } else {
            assert.equal(results[1].reason.code, 'ER_LOCK_DEADLOCK');
            assert.equal(await assignment(entry), old.id); assert.equal(Number((await metadata(entry)).revision), initialRevision);
            assert.equal(stored.state, 'sent'); assert.equal(sends, 1);
        }
        assert.equal(releases, 1); assert.notEqual(stored.state, 'unknown'); assert.notEqual(stored.state, 'partial');
        assert.equal((await runner.tick()).state, 'idle'); assert.ok(sends <= 1);
    });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { hash, createService } = require('../../src/automation/service');
const { newWorkflow, NODE_TYPES } = require('../../src/automation/schema');
const entitlements = require('../../src/automation/entitlements');
const { createQueue } = require('../../src/automation/queue');
const { createXEventRouter } = require('../../src/automation/x-event-router');
const { createGraphStore } = require('../../src/automation/graph-store');
const { createFlowRuntime } = require('../../src/automation/flow-runtime');
const { createTransport } = require('../../src/automation/transport');
const { createRunner } = require('../../src/automation/runtime');
const { DeliveryGateError } = require('../../src/automation/delivery-gate');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const U = '222222222222222222', V = '333333333333333333', C = '444444444444444444', M = '555555555555555555';
const ADMIN = { userId: '666666666666666666', isAdmin: true };
const publicPost = (id = '1234567890123456789') => ({ notificationType: 'tweet', url: `https://x.com/example/status/${id}`, author: { id: '12345', handle: 'example' }, title: '公開された投稿', text: '公開本文 @everyone' });

async function fixture(work) {
    const db = await createTestDatabase(port), query = db.queryDatabase, service = createService(db);
    await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, ADMIN, { planId: 'free', label: '無料', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));
    let now = Date.now();
    const clock = () => now, advance = value => { now += value; };
    const graphStore = createGraphStore(db);
    const evaluator = { evaluate: async (definition, event, _bindings, at) => require('../../src/automation/engine').evaluateWorkflow(definition, event, { now: at }) };
    const queue = createQueue(db, evaluator, { clock, rolloutMode: 'public', graph: { enabled: true, store: graphStore } });
    const router = createXEventRouter(db, queue, { clock });
    const flow = createFlowRuntime(db, evaluator, graphStore, { assertEnabled: () => {} });
    async function subscription(owner = U) {
        await query('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,?)', [owner, now]);
        const id = randomUUID();
        await query('INSERT INTO automation_x_subscriptions (id,owner_user_id,uaid_hash,channel_hash,content_hash,sealed_json,key_id,browser_version,revision,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,1,?,?)', [id, owner, hash(`uaid:${id}`), hash(`channel:${id}`), hash(`content:${id}`), '{}', 'test-key', 'test-browser', now, now]);
        await query("INSERT INTO automation_x_push_receivers (subscription_id,state,subscription_revision,updated_at_ms) VALUES (?,'listening',1,?)", [id, now]);
        return id;
    }
    async function monitor(subscriptionId, options = {}) {
        const owner = options.owner || U, config = { subscriptionId, ...options.settings };
        const result = await query("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,?,?,'X fixture',1,'ready',?,?,'bound',1,?,?)", [owner, options.accountId || '12345', options.accountHandle === undefined ? 'example' : options.accountHandle, options.pool || 'free', JSON.stringify(config), now, now]);
        const id = String(result.insertId);
        await db.withDatabaseTransaction(query => entitlements.assignSlot(query, owner, 'x', id));
        return id;
    }
    async function inbox(subscriptionId, owner = U, version = randomUUID()) {
        const result = await query("INSERT INTO automation_x_push_inbox (subscription_id,subscription_revision,version,data_ciphertext,headers_json,ack_code,status,received_at_ms) VALUES (?,1,?,'Y2lwaGVydGV4dA','{}',100,'received',?)", [subscriptionId, version, now]);
        return { id: String(result.insertId), subscriptionId, ownerUserId: owner, revision: 1, status: 'received', receivedAtMs: now };
    }
    async function receive(subscriptionId, options = {}) {
        const ownerUserId = options.owner || U, row = options.inbox || await inbox(subscriptionId, ownerUserId);
        return router.routeReceived({ lease: { ownerUserId, subscriptionId, revision: 1 }, inbox: row, payload: options.payload || publicPost(options.postId) });
    }
    const sent = [], requests = [];
    let sendError = null, beforeSend = null;
    const transport = createTransport(db, {}, { options: { jsonTransformer: value => value } }, {
        clock, safety: { assertNotification: async () => {} },
        rest: { post: async (route, args) => {
            requests.push({ route, args });
            if (route === '/users/@me/channels') return { id: C, recipients: [{ id: U }] };
            if (sendError) throw sendError;
            sent.push(args.body); return { id: M, channel_id: C };
        } },
        beforeSubmit: async job => {
            if (beforeSend) await beforeSend();
            const result = await queue.check(job, clock());
            if (result.state !== 'ready') throw new DeliveryGateError(result.state, result.code, result.dueAtMs);
        },
    });
    const runner = createRunner(db, queue, transport, { clock, assertAllowed: () => {}, notificationAllowed: () => true, sleep: async ms => advance(ms) });
    async function project() {
        for (let i = 0; i < 30; i++) {
            await flow.tick(clock());
            if ((await query("SELECT id FROM automation_jobs WHERE state='pending' LIMIT 1")).length) return;
        }
        assert.fail('graph did not project a notification');
    }
    try { await work({ db, query, service, queue, router, flow, graphStore, clock, advance, subscription, monitor, inbox, receive, project, runner, sent, requests,
        setSendError: value => { sendError = value; }, setBeforeSend: value => { beforeSend = value; } }); }
    finally { flow.clear(); await db.close(); }
}

test('real SQL: X uses the shared queue, graph, entitlements and mocked physical Discord path', { skip: !port, timeout: 120000 }, async t => {
    await t.test('committed owner notification reaches default DM once and replay/new-push-version deduplicates by public post', () => fixture(async f => {
        const subscriptionId = await f.subscription(), monitorId = await f.monitor(subscriptionId);
        const row = await f.inbox(subscriptionId);
        const routed = await Promise.all([f.receive(subscriptionId, { inbox: row }), f.receive(subscriptionId, { inbox: row })]);
        assert(routed.every(result => result.state === 'routed'));
        await f.receive(subscriptionId);
        assert.equal(Number((await f.query('SELECT COUNT(*) n FROM automation_runs'))[0].n), 1);
        assert.equal(Number((await f.query('SELECT COUNT(*) n FROM automation_jobs'))[0].n), 1);
        const job = (await f.query('SELECT plan_json FROM automation_jobs'))[0];
        assert.equal(JSON.parse(job.plan_json).display.format, 'normal');
        assert.equal(NODE_TYPES.transform.defaults.format, 'normal', 'current main defaults remain unchanged');
        const run = (await f.query('SELECT * FROM automation_runs'))[0];
        assert.equal(run.target_kind, 'x'); assert.equal(String(run.target_id), monitorId); assert.equal(run.owner_user_id, U);
        assert.equal((await f.runner.tick()).state, 'sent');
        assert.equal(f.sent.length, 1); assert.match(f.sent[0].content, /https:\/\/x\.com\/example\/status\/1234567890123456789/);
        assert.deepEqual(f.sent[0].allowed_mentions.parse, []); assert.equal(f.sent[0].enforce_nonce, true);
        assert.equal((await f.runner.tick()).state, 'idle');
    }));

    await t.test('same author in another owner is isolated, unbound/incorrect-author monitors receive nothing', () => fixture(async f => {
        const subscriptionId = await f.subscription(), otherSubscription = await f.subscription(V);
        const monitorId = await f.monitor(subscriptionId); await f.monitor(otherSubscription, { owner: V });
        await f.monitor(subscriptionId, { accountId: '999', accountHandle: 'different' });
        const row = await f.inbox(subscriptionId);
        const result = await f.receive(subscriptionId, { inbox: row }); assert.equal(result.results.length, 1);
        assert.deepEqual((await f.query('SELECT owner_user_id,target_id FROM automation_runs')).map(row => [row.owner_user_id, String(row.target_id)]), [[U, monitorId]]);
        assert.equal((await f.queue.routeX({ ownerUserId: V, monitorId, subscriptionId, inboxEventId: row.id, payload: publicPost() })).code, 'X_NOTIFICATION_INBOX_CHANGED');
        await assert.rejects(f.receive(subscriptionId, { payload: { notificationType: 'dm', text: 'private sentinel' } }), { code: 'X_NOTIFICATION_UNSUPPORTED' });
        assert.equal(Number((await f.query('SELECT COUNT(*) n FROM automation_jobs'))[0].n), 1);
    }));

    await t.test('queued stop/delete, subscription generation changes and lost binding cancel before preparation', async () => {
        for (const change of ["UPDATE automation_x_monitors SET enabled=0,revision=revision+1", "UPDATE automation_x_monitors SET state='deleted',enabled=0,revision=revision+1", 'UPDATE automation_x_subscriptions SET revision=revision+1', "UPDATE automation_x_push_receivers SET state='requires_reenrollment'", "UPDATE automation_x_monitors SET notification_settings_json='{}',revision=revision+1"]) {
            await fixture(async f => {
                const subscriptionId = await f.subscription(); await f.monitor(subscriptionId); await f.receive(subscriptionId);
                await f.query(change); assert.equal((await f.runner.tick()).state, 'cancelled'); assert.equal(f.requests.length, 0); assert.equal(f.sent.length, 0);
            });
        }
    });

    await t.test('committed notifications remain processable after a connection stops', () => fixture(async f => {
        const subscriptionId = await f.subscription(); await f.monitor(subscriptionId); const row = await f.inbox(subscriptionId);
        await f.query("UPDATE automation_x_push_receivers SET state='stopped'");
        assert.equal((await f.receive(subscriptionId, { inbox: row })).results[0].state, 'routed');
        assert.equal((await f.runner.tick()).state, 'sent'); assert.equal(f.sent.length, 1);
    }));

    await t.test('missing contract interval preserves received inbox data until an administrator configures the plan', () => fixture(async f => {
        const subscriptionId = await f.subscription(); await f.monitor(subscriptionId); const row = await f.inbox(subscriptionId);
        await f.query("UPDATE automation_notification_plans SET confirmation_interval_minutes=NULL WHERE plan_id='free'");
        const waiting = await f.receive(subscriptionId, { inbox: row }); assert.equal(waiting.state, 'pending'); assert.equal(waiting.results[0].code, 'X_MONITOR_NOT_CONFIGURED');
        assert.equal(Number((await f.query('SELECT COUNT(*) n FROM automation_jobs'))[0].n), 0);
        assert.equal((await f.query('SELECT status FROM automation_x_push_inbox WHERE id=?', [row.id]))[0].status, 'received');
        await f.query("UPDATE automation_notification_plans SET confirmation_interval_minutes=5 WHERE plan_id='free'");
        assert.equal((await f.receive(subscriptionId, { inbox: row })).state, 'routed');
    }));

    await t.test('explicit existing owner destinations work and forged foreign destinations cannot enter a runnable queue', () => fixture(async f => {
        const subscriptionId = await f.subscription(), otherSubscription = await f.subscription(V);
        const own = await f.service.saveDestination({ userId: U }, { name: '本人 DM', kind: 'dm' });
        const foreign = await f.service.saveDestination({ userId: V }, { name: '別利用者 DM', kind: 'dm' });
        const monitorId = await f.monitor(subscriptionId, { settings: { destinationId: own.id } });
        await f.receive(subscriptionId); assert.equal((await f.runner.tick()).state, 'sent'); assert.equal(f.sent.length, 1);
        await f.query('UPDATE automation_x_monitors SET notification_settings_json=?,revision=revision+1 WHERE id=?', [JSON.stringify({ subscriptionId, destinationId: foreign.id }), monitorId]);
        const rejected = await f.receive(subscriptionId, { postId: '2234567890123456789' }); assert.equal(rejected.results[0].state, 'cancelled');
        assert.equal(Number((await f.query('SELECT COUNT(*) n FROM automation_jobs'))[0].n), 1);
        assert(otherSubscription);
    }));

    await t.test('X free contract quality ignores a donor badge and daily message quota remains durable across retries', () => fixture(async f => {
        const subscriptionId = await f.subscription(); await f.query('UPDATE users SET is_donor=1 WHERE user_id=?', [U]);
        const monitorId = await f.monitor(subscriptionId);
        await f.query("UPDATE automation_notification_plans SET minute_limit=1,day_limit=1 WHERE plan_id='free'");
        await f.db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, ADMIN, { planId: 'supporter', label: '支援者', slotLimit: 5, minuteLimit: 99, dayLimit: 999, priority: 99 }));
        const quality = await entitlements.resolveNotificationEntitlement(f.db, { ownerUserId: U, targetKind: 'x', targetId: monitorId });
        assert.equal(quality.tier, 'free'); assert.equal(quality.minuteLimit, 1); assert.equal(quality.dayLimit, 1); assert.equal(quality.priority, 0);
        await f.receive(subscriptionId); assert.equal((await f.runner.tick()).state, 'sent');
        await f.receive(subscriptionId, { postId: '2234567890123456789' }); f.advance(60001);
        const limited = await f.runner.tick(); assert.equal(limited.state, 'pending'); assert.equal(limited.code, 'AUTOMATION_RATE_LIMITED'); assert.equal(f.sent.length, 1);
        const restarted = createQueue(f.db, {}, { clock: f.clock, rolloutMode: 'public' });
        assert.equal(await restarted.claim(f.clock()), null);
    }));

    await t.test('workflow pause retries the encrypted received event; resumed graph handles default owner DM', () => fixture(async f => {
        const subscriptionId = await f.subscription(), workflow = await f.service.createWorkflow({ userId: U }, { definition: newWorkflow('X graph') });
        await f.service.activateWorkflow({ userId: U }, workflow.id, { expectedRevision: workflow.revision });
        await f.monitor(subscriptionId, { settings: { workflowId: workflow.id } }); const row = await f.inbox(subscriptionId);
        await f.query('UPDATE automation_workflows SET enabled=0 WHERE id=?', [workflow.id]);
        assert.equal((await f.receive(subscriptionId, { inbox: row })).state, 'pending');
        assert.equal(Number((await f.query('SELECT COUNT(*) n FROM automation_runs'))[0].n), 0);
        await f.query('UPDATE automation_workflows SET enabled=1 WHERE id=?', [workflow.id]);
        assert.equal((await f.receive(subscriptionId, { inbox: row })).results[0].execution, 'flow_v2');
        await f.project(); assert.equal((await f.query('SELECT execution_version,destination_id FROM automation_jobs'))[0].execution_version, 2);
        assert.equal((await f.runner.tick()).state, 'sent'); assert.equal(f.sent.length, 1);
    }));

    await t.test('graph delay keeps existing timing semantics; later monitor edit cancels projected members', () => fixture(async f => {
        const subscriptionId = await f.subscription(), definition = newWorkflow('delay');
        definition.nodes.splice(1, 0, { id: 'delay', type: 'delay', config: { ...NODE_TYPES.delay.defaults, minutes: 5 }, position: { x: 200, y: 80 } });
        definition.edges = [{ id: 'e1', source: 'start', target: 'delay', port: 'out' }, { id: 'e2', source: 'delay', target: 'send', port: 'out' }];
        const workflow = await f.service.createWorkflow({ userId: U }, { definition });
        await f.service.activateWorkflow({ userId: U }, workflow.id, { expectedRevision: workflow.revision });
        await f.monitor(subscriptionId, { settings: { workflowId: workflow.id } }); await f.receive(subscriptionId);
        for (let i = 0; i < 5; i++) await f.flow.tick(f.clock());
        assert.equal((await f.runner.tick()).state, 'idle'); assert.equal(f.sent.length, 0);
        f.advance(5 * 60000); await f.project();
        await f.query('UPDATE automation_x_monitors SET revision=revision+1');
        assert.equal((await f.runner.tick()).state, 'cancelled'); assert.equal(f.sent.length, 0);
    }));

    await t.test('current paid plan and supporter-pool qualification are rechecked at the physical-send boundary', () => fixture(async f => {
        const subscriptionId = await f.subscription();
        await f.query('UPDATE users SET is_donor=1,additional_auto_extract_slots=1 WHERE user_id=?', [U]);
        const monitorId = await f.monitor(subscriptionId, { pool: 'supporter' });
        await f.db.withDatabaseTransaction(async query => {
            await entitlements.savePlanPolicy(query, ADMIN, { planId: 'xTestPaid', label: 'Fixture paid', slotLimit: 9, minuteLimit: 8, dayLimit: 90, priority: 7, intervalMinutes: 5 });
            await entitlements.setUserPlan(query, ADMIN, U, 'xTestPaid');
        });
        assert.equal((await entitlements.resolveNotificationEntitlement(f.db, { ownerUserId: U, targetKind: 'x', targetId: monitorId })).minuteLimit, 8);
        await f.receive(subscriptionId);
        f.setBeforeSend(async () => { await f.query('UPDATE users SET is_donor=0,additional_auto_extract_slots=0 WHERE user_id=?', [U]); });
        const result = await f.runner.tick(); assert.equal(result.state, 'excluded'); assert.equal(result.code, 'X_MONITOR_NOT_AVAILABLE'); assert.equal(f.sent.length, 0);
        await f.db.withDatabaseTransaction(query => entitlements.setUserPlan(query, ADMIN, U, null));
        const free = await entitlements.resolveNotificationEntitlement(f.db, { ownerUserId: U, targetKind: 'x', targetId: monitorId });
        assert.equal(free.tier, 'free'); assert.equal(free.minuteLimit, 5); assert.equal(free.dayLimit, 24); assert.equal(free.priority, 0);
    }));

    await t.test('subscription removal, receiver renewal and the final queue fence share owner-first locks', { timeout: 15000 }, () => fixture(async f => {
        const { createXPushStore } = require('../../src/automation/x-push-store');
        const { createXSetup } = require('../../src/automation/x-setup');
        const subscriptionId = await f.subscription(); await f.monitor(subscriptionId); await f.receive(subscriptionId);
        const store = createXPushStore(f.db, { now: f.clock });
        const lease = await store.claim({ subscriptionId, ownerUserId: U, workerId: 'queue-race' });
        const job = await f.queue.claim(f.clock()); assert(job);
        let subscriptionLocked, continueRemoval, sendWaiting;
        const locked = new Promise(resolve => { subscriptionLocked = resolve; });
        const continueGate = new Promise(resolve => { continueRemoval = resolve; });
        const waiting = new Promise(resolve => { sendWaiting = resolve; });
        const removingDb = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(query => work(async (sql, args) => {
            const value = await query(sql, args);
            if (sql.startsWith('SELECT id,revision FROM automation_x_subscriptions')) { subscriptionLocked(); await continueGate; }
            return value;
        })) };
        const sendingDb = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(query => work(async (sql, args) => {
            if (sql.startsWith('INSERT INTO users ')) sendWaiting();
            return query(sql, args);
        })) };
        const removing = createXSetup(removingDb, { rolloutMode: 'public' }).remove({ userId: U }, subscriptionId, { expectedRevision: 1 });
        await locked;
        const sending = createQueue(sendingDb, {}, { clock: f.clock, rolloutMode: 'public' }).beginSend(job, f.clock());
        await waiting;
        const renewing = store.renew(lease);
        continueRemoval();
        const results = await Promise.allSettled([removing, sending, renewing]);
        assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'fulfilled');
        assert.equal(results[1].value.state, 'cancelled');
        assert.equal(results[2].status, 'rejected'); assert.equal(results[2].reason.code, 'X_PUSH_SUBSCRIPTION_NOT_FOUND');
        assert.equal(f.sent.length, 0); assert.equal(Number((await f.query('SELECT COUNT(*) n FROM automation_x_subscriptions'))[0].n), 0);
    }));

    await t.test('Discord 429 remains retryable and timeout remains unknown without implicit duplicate submission', async () => {
        for (const [error, expected] of [[Object.assign(new Error('secret'), { status: 429, retryAfter: 60000 }), 'pending'], [Object.assign(new Error('secret'), { code: 'ETIMEDOUT' }), 'unknown']]) {
            await fixture(async f => {
                const subscriptionId = await f.subscription(); await f.monitor(subscriptionId); await f.receive(subscriptionId);
                f.setSendError(error); assert.equal((await f.runner.tick()).state, expected); assert.equal(f.sent.length, 0);
                const row = (await f.query('SELECT * FROM automation_jobs'))[0]; assert(!JSON.stringify(row).includes('secret'));
                f.setSendError(null); f.advance(120000);
                assert.equal((await f.runner.tick()).state, expected === 'pending' ? 'sent' : 'idle');
                assert.equal(f.sent.length, expected === 'pending' ? 1 : 0);
            });
        }
    });
});

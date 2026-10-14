'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { insertSubscription, encrypted, vault, ownerUserId: U } = require('./helpers/x-push-fixture.cjs');
const { createXPushStore } = require('../../src/automation/x-push-store');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { createXPushRuntime } = require('../../src/automation/x-push-runtime');
const { createQueue } = require('../../src/automation/queue');
const { createXEventRouter } = require('../../src/automation/x-event-router');
const entitlements = require('../../src/automation/entitlements');
const capacity = require('../../src/automation/push-capacity');
const { createXMonitorQuota } = require('../../src/automation/x-monitor-quota');
const { createXProcessingSettings } = require('../../src/automation/x-processing-settings');
const { createRateLimiter } = require('../../src/automation/rate-limits');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT), ADMIN = { userId: '666666666666666666', isAdmin: true };
const post = id => ({ notificationType: 'tweet', author: { id: '12345', handle: 'example' }, url: `https://x.com/example/status/${1234567890123456700n + BigInt(id)}`, title: `公開投稿 ${id}`, text: '公開本文' });
// Structure observed in an owned production receipt; values are synthetic.
const webPost = (id, handle = 'example') => ({ title: '合成の投稿通知', body: '合成の公開本文', icon: 'opaque display metadata',
    timestamp: '2026-10-14T12:00:00Z', tag: `tweet-${id}`, data: { type: 'tweet', scribe_target: 'tweet',
        uri: `/${handle}/status/${id}`, bundle_text: 'synthetic', impression_id: 'synthetic', lang: 'ja', extra: { ignored: true } }, metadata: true });

async function fixture(work, runtimeOptions = {}) {
    const db = await createTestDatabase(port), query = db.queryDatabase;
    let now = Date.now(), sequence = 0, lease, runtime, callbacks, auditFailure = false, auditHook = null, markFailure = false, ownerLockAttempt = null;
    const clock = () => now, subscription = await insertSubscription(db);
    await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, ADMIN, { planId: 'free', label: '無料', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));
    const storeDb = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, args) => {
        if (ownerLockAttempt && sql.startsWith('INSERT INTO users ')) ownerLockAttempt();
        const result = await query(sql, args);
        if (auditHook && sql.startsWith('INSERT INTO automation_audit')) auditHook();
        if (auditFailure && sql.startsWith('INSERT INTO automation_audit')) throw Object.assign(new Error('SQL_PRIVATE_SENTINEL'), { code: 'ER_FIXTURE_AUDIT' });
        return result;
    })) };
    const store = createXPushStore(storeDb, { now: clock, leaseMs: 300000 });
    lease = await store.claim({ ...subscription, workerId: 'processing-fixture' });
    await store.markState(lease, 'listening');
    const monitor = await query("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'12345','example','Processing fixture',1,'ready','free',?,'bound',1,?,?)", [U, JSON.stringify({ subscriptionId: subscription.subscriptionId }), now, now]);
    await db.withDatabaseTransaction(query => entitlements.assignSlot(query, U, 'x', String(monitor.insertId)));
    const queue = createQueue(db, {}, { clock, rolloutMode: 'public', useLegacyUserInterval: runtimeOptions.useLegacyUserInterval === true });
    const realRouter = createXEventRouter(db, queue, { clock });
    let routeOverride = null;
    const gateway = createXPushGateway(db, { enabled: true, store, privateWorkerVault: vault, now: clock,
        createSocket: () => assert.fail('processing fixture must never create a vendor socket') });
    const runtimeGateway = { ...gateway, store: { ...store, markRouted: async (...args) => {
        if (markFailure) throw Object.assign(new Error('private DB sentinel'), { code: 'X_PUSH_STORE_UNAVAILABLE' });
        return store.markRouted(...args);
    } }, run: input => {
        callbacks = input; input.onSession({ lease });
        return new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
    } };
    function makeRuntime(options = {}) {
        runtime = createXPushRuntime(db, queue, { enabled: true, gateway: runtimeGateway, clock,
            router: { hasRealtimeTargets: realRouter.hasRealtimeTargets, hasBatchTargets: realRouter.hasBatchTargets, routeReceived: input => routeOverride ? routeOverride(input, realRouter) : realRouter.routeReceived(input) },
            rolloutMode: 'public', assertAllowed: () => {}, pageSize: 2,
            listCandidates: async () => [{ id: subscription.subscriptionId, owner_user_id: U }], ...runtimeOptions, ...options });
        return runtime;
    }
    makeRuntime();
    async function record({ legacy = false, payload } = {}) {
        sequence++; const wire = await encrypted(subscription.file, payload || post(sequence), legacy);
        return store.recordFrame(lease, { version: `v${sequence}`, data: wire.data, headers: wire.headers, status: 'received', ackCode: 100 });
    }
    async function refreshLease() {
        if (lease.expiresAtMs <= now) lease = await store.claim({ ...subscription, workerId: 'processing-successor' });
        return lease;
    }
    const receiver = async () => (await query('SELECT * FROM automation_x_push_receivers WHERE subscription_id=?', [subscription.subscriptionId]))[0];
    const count = async table => Number((await query(`SELECT COUNT(*) n FROM ${table}`))[0].n);
    try { await work({ db, query, store, gateway, queue, subscription, clock, callbacks: () => callbacks, makeRuntime, runtime: () => runtime, lease: () => lease, refreshLease, record, receiver, count,
        advance: amount => { now += amount; }, setRoute: value => { routeOverride = value; }, setAuditFailure: value => { auditFailure = value; }, setAuditHook: value => { auditHook = value; }, setMarkFailure: value => { markFailure = value; },
        setOwnerLockAttempt: value => { ownerLockAttempt = value; } }); }
    finally { await runtime.stop(); await db.close(); }
}

async function realtime(f, intervalMinutes = 15) {
    await f.db.withDatabaseTransaction(async query => {
        await entitlements.savePlanPolicy(query, ADMIN, { planId: 'ExplicitRealtimePlan', label: '明示設定のプラン', slotLimit: 9, minuteLimit: 1, dayLimit: 2, priority: 17, intervalMinutes });
        const previous = await capacity.getPlanCapacity(query, ADMIN, 'ExplicitRealtimePlan');
        await capacity.savePlanCapacity(query, ADMIN, 'ExplicitRealtimePlan', { eligible: false, specialSlotLimit: 0, realtimeEnabled: true, expectedUpdatedAtMs: previous.updatedAtMs });
        await entitlements.setUserPlan(query, ADMIN, U, 'ExplicitRealtimePlan');
    });
    await createXProcessingSettings(f.db, { rolloutMode: 'public', now: f.clock }).save({ userId: U }, { mode: 'realtime', expectedMode: 'batch' });
}

test('real SQL: encrypted Push receipts are processed under explicit durable windows', { skip: !port, timeout: 120000 }, async t => {
    await t.test('actual-shaped encrypted quarantine recovers once through the same queue, ownership and batch policy', () => fixture(async f => {
        const receipt = await f.record({ payload: webPost('1190000000000000001') });
        await f.store.markUnsupported(f.lease(), receipt.id);
        assert.equal((await f.runtime().drain(f.lease())).processed, 1);
        assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.id })).status, 'routed');
        assert.equal(await f.count('automation_jobs'), 1);
        assert.equal(Number((await f.query("SELECT COUNT(*) n FROM automation_audit WHERE action='x.push.adapter.recovered'"))[0].n), 1);
        assert.equal((await f.runtime().drain(f.lease())).state, 'pending');
        await f.runtime().stop(); const restarted = f.makeRuntime();
        assert.equal((await restarted.drain(f.lease())).state, 'pending');
        assert.equal(await f.count('automation_jobs'), 1);
        assert.equal(await f.count('automation_notification_slots'), 1);
    }));

    await t.test('recognized post from another account becomes unmatched without any delivery job', () => fixture(async f => {
        const receipt = await f.record({ payload: webPost('1190000000000000002', 'other_author') });
        await f.store.markUnsupported(f.lease(), receipt.id);
        assert.equal((await f.runtime().drain(f.lease())).processed, 1);
        assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.id })).status, 'unmatched');
        assert.equal(await f.count('automation_runs'), 0); assert.equal(await f.count('automation_jobs'), 0);
        assert.equal(Number((await f.query("SELECT COUNT(*) n FROM automation_audit WHERE action='x.push.target.unmatched'"))[0].n), 1);
        assert.equal(await f.store.markUnmatched(f.lease(), receipt.id), false);
    }));

    await t.test('restoring quarantine and its audit are one transaction, idempotent and owner fenced', () => fixture(async f => {
        const receipt = await f.record({ payload: webPost('1190000000000000003') });
        await f.store.markUnsupported(f.lease(), receipt.id);
        const retained = await f.store.getInbox({ ...f.subscription, id: receipt.id });
        await assert.rejects(f.gateway.decryptInbox(f.lease(), retained), { code: 'X_PUSH_INBOX_INVALID' });
        await assert.rejects(f.gateway.decryptQuarantinedInbox(f.lease(), { ...retained, ownerUserId: '999999999999999999' }), { code: 'X_PUSH_INBOX_INVALID' });
        await assert.rejects(f.store.listQuarantinedInbox({ ...f.lease(), ownerUserId: '999999999999999999' }), { code: 'X_PUSH_SUBSCRIPTION_NOT_FOUND' });
        f.setAuditFailure(true);
        await assert.rejects(f.store.restoreQuarantinedInbox(f.lease(), receipt.id), { code: 'X_PUSH_STORE_UNAVAILABLE' });
        f.setAuditFailure(false);
        assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.id })).status, 'unsupported');
        assert.equal(await f.store.restoreQuarantinedInbox(f.lease(), receipt.id), true);
        assert.equal(await f.store.restoreQuarantinedInbox(f.lease(), receipt.id), false);
        assert.equal(Number((await f.query("SELECT COUNT(*) n FROM automation_audit WHERE action='x.push.adapter.recovered'"))[0].n), 1);
    }));

    await t.test('failed decryption and revoked owner cannot be restored into received state', () => fixture(async f => {
        const receipt = await f.record({ payload: webPost('1190000000000000004') });
        await f.store.markUnsupported(f.lease(), receipt.id);
        await assert.rejects(f.store.restoreQuarantinedInbox(f.lease(), receipt.id, { authorize: async () => { throw Error('revoked'); } }), { code: 'X_PUSH_STORE_UNAVAILABLE' });
        await f.query('UPDATE automation_x_push_inbox SET ack_code=101 WHERE id=?', [receipt.id]);
        assert.deepEqual(await f.store.listQuarantinedInbox(f.lease()), []);
        assert.equal(await f.store.restoreQuarantinedInbox(f.lease(), receipt.id), false);
        assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.id })).status, 'unsupported');
        assert.equal(await f.count('automation_jobs'), 0);
    }));

    await t.test('lease expiry after audit work rolls quarantine recovery back; stale tokens and revisions stay fenced', () => fixture(async f => {
        const receipt = await f.record({ payload: webPost('1190000000000000006') });
        await f.store.markUnsupported(f.lease(), receipt.id);
        const old = f.lease();
        f.setAuditHook(() => f.advance(300001));
        await assert.rejects(f.store.restoreQuarantinedInbox(old, receipt.id), { code: 'X_PUSH_LEASE_LOST' });
        f.setAuditHook(null);
        assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.id })).status, 'unsupported');
        assert.equal(Number((await f.query("SELECT COUNT(*) n FROM automation_audit WHERE action='x.push.adapter.recovered'"))[0].n), 0);
        await f.refreshLease();
        await assert.rejects(f.store.listQuarantinedInbox(old), { code: 'X_PUSH_LEASE_LOST' });
        await assert.rejects(f.store.restoreQuarantinedInbox({ ...f.lease(), revision: 2 }, receipt.id), { code: 'X_PUSH_LEASE_LOST' });
        assert.equal(await f.store.restoreQuarantinedInbox(f.lease(), receipt.id), true);
    }));

    await t.test('stop while quarantine decryption is pending does not restore data or open a processing window', () => fixture(async f => {
        const receipt = await f.record({ payload: webPost('1190000000000000007') });
        await f.store.markUnsupported(f.lease(), receipt.id);
        let finishDecrypt, entered;
        const waiting = new Promise(resolve => { entered = resolve; });
        const runtime = f.makeRuntime({ gateway: { ...f.gateway, decryptQuarantinedInbox: async () => {
            entered(); return new Promise(resolve => { finishDecrypt = resolve; });
        } } });
        const work = runtime.drain(f.lease()); await waiting;
        const stop = runtime.stop(); finishDecrypt(webPost('1190000000000000007'));
        assert.equal((await work).state, 'stopped'); await stop;
        assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.id })).status, 'unsupported');
        assert.equal((await f.receiver()).process_window_at_ms, null);
        assert.equal(await f.count('automation_jobs'), 0);
    }));

    await t.test('still-unsupported private data is retained and not repeatedly decrypted every tick', () => fixture(async f => {
        const receipt = await f.record({ payload: { title: 'private synthetic', body: 'private sentinel', data: { type: 'dm_av' } } });
        await f.store.markUnsupported(f.lease(), receipt.id);
        await f.runtime().drain(f.lease());
        const before = Number((await f.query("SELECT COUNT(*) n FROM automation_audit WHERE action='x.push.vault.open'"))[0].n);
        await f.runtime().drain(f.lease());
        assert.equal(Number((await f.query("SELECT COUNT(*) n FROM automation_audit WHERE action='x.push.vault.open'"))[0].n), before);
        assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.id })).status, 'unsupported');
        assert.equal(await f.count('automation_jobs'), 0);
        const audits = await f.query('SELECT detail_json FROM automation_audit');
        assert.ok(audits.every(row => !row.detail_json.includes('private sentinel')));
    }));

    await t.test('bounded recovery advances past unknown formats and honors the existing five-minute window', () => fixture(async f => {
        for (let i = 0; i < 2; i++) {
            const receipt = await f.record({ payload: { title: 'synthetic', data: { type: 'unknown' } } });
            await f.store.markUnsupported(f.lease(), receipt.id);
        }
        const valid = await f.record({ payload: webPost('1190000000000000005') });
        await f.store.markUnsupported(f.lease(), valid.id);
        await f.runtime().drain(f.lease());
        assert.equal((await f.store.getInbox({ ...f.subscription, id: valid.id })).status, 'unsupported');
        assert.equal((await f.runtime().drain(f.lease())).state, 'pending');
        assert.equal((await f.store.getInbox({ ...f.subscription, id: valid.id })).status, 'received');
        assert.equal(await f.count('automation_jobs'), 0);
        f.advance(300000); await f.refreshLease();
        assert.equal((await f.runtime().drain(f.lease())).processed, 1);
        assert.equal(await f.count('automation_jobs'), 1);
    }));

    await t.test('eligible realtime drains encrypted backlog and subsequent receipts immediately with the same contract quotas and priority', () => fixture(async f => {
        await realtime(f, null);
        for (let i = 0; i < 5; i++) await f.record();
        assert.equal((await f.runtime().drain(f.lease())).processed, 5);
        assert.equal(await f.count('automation_jobs'), 5);
        assert.equal((await f.receiver()).last_process_at_ms, null);
        assert.equal((await f.receiver()).process_window_at_ms, null);
        f.advance(1); const next = await f.record();
        assert.equal((await f.runtime().drain(f.lease())).processed, 1);
        assert.equal((await f.store.getInbox({ ...f.subscription, id: next.id })).status, 'routed');
        const target = (await f.query('SELECT id FROM automation_x_monitors WHERE owner_user_id=?', [U]))[0];
        const principal = await entitlements.resolveNotificationEntitlement(f.db, { ownerUserId: U, targetKind: 'x', targetId: String(target.id) });
        assert.equal(principal.priority, 17); assert.equal(principal.minuteLimit, 1); assert.equal(principal.dayLimit, 2); assert.equal(principal.baseSlotLimit, 9);
        assert.equal(await f.count('automation_notification_slots'), 1);
        const limiter = createRateLimiter(f.db, { clock: f.clock });
        let reservation = await limiter.reserveNotifications({ ...principal, ownerUserId: U }, 1); await limiter.commitNotification(reservation, 0);
        await assert.rejects(limiter.reserveNotifications({ ...principal, ownerUserId: U }, 1), error => error.code === 'AUTOMATION_RATE_LIMITED' && error.limit === 1);
        f.advance(60000); reservation = await limiter.reserveNotifications({ ...principal, ownerUserId: U }, 1); await limiter.commitNotification(reservation, 0);
        f.advance(60000); await assert.rejects(limiter.reserveNotifications({ ...principal, ownerUserId: U }, 1), error => error.code === 'AUTOMATION_RATE_LIMITED' && error.limit === 2);
    }));

    await t.test('revocation within one realtime page pauses retained rows, and a restarted worker respects the same batch deadline', () => fixture(async f => {
        const at = f.clock(); await f.runtime().drain(f.lease());
        await realtime(f);
        for (let i = 0; i < 3; i++) await f.record();
        let routed = 0;
        f.setRoute(async (input, real) => {
            const result = await real.routeReceived(input);
            if (++routed === 1) await f.query("UPDATE automation_push_plan_policy SET realtime_enabled=0 WHERE plan_id='ExplicitRealtimePlan'");
            return result;
        });
        const paused = await f.runtime().drain(f.lease());
        assert.equal(paused.state, 'pending'); assert.equal(paused.processed, 3); assert.equal(paused.dueAtMs, at + 15 * 60000);
        assert.equal(await f.count('automation_jobs'), 1);
        let receiver = await f.receiver(); assert.equal(receiver.process_window_mode, null); assert.equal(String(receiver.process_cursor_id), '0'); assert.equal(Number(receiver.last_process_at_ms), at);
        assert.equal((await f.store.listInbox(f.subscription)).length, 2);
        const queued = await f.queue.claim(f.clock());
        const sendCheck = await f.queue.check(queued, f.clock());
        assert.equal(sendCheck.state, 'pending'); assert.equal(sendCheck.code, 'X_NOTIFICATION_BATCH_WAIT');
        await f.runtime().stop(); f.setRoute(null); const restarted = f.makeRuntime();
        assert.equal((await restarted.drain(f.lease())).dueAtMs, at + 15 * 60000);
        assert.equal((await f.query('SELECT x_notification_processing_mode FROM users WHERE user_id=?', [U]))[0].x_notification_processing_mode, 'realtime');
        f.advance(15 * 60000); await f.refreshLease();
        assert.equal((await restarted.drain(f.lease())).processed, 2);
        assert.equal((await restarted.drain(f.lease())).processed, 0, 'finish the resumed batch at its original cutoff');
        assert.equal(await f.count('automation_jobs'), 3); receiver = await f.receiver();
        assert.equal(receiver.process_window_at_ms, null); assert.equal(receiver.process_window_mode, null);
        assert.equal((await f.store.listInbox(f.subscription)).length, 0);
        assert.equal(await f.count('automation_notification_slots'), 1);
    }));

    await t.test('a crash after one realtime receipt leaves the batch cursor unchanged and resumes every remaining page without an interval wait', () => fixture(async f => {
        await realtime(f);
        for (let i = 0; i < 5; i++) await f.record();
        let count = 0;
        f.setRoute((input, real) => { if (++count === 2) throw Object.assign(new Error('safe crash fixture'), { code: 'ER_FIXTURE_RESTART' }); return real.routeReceived(input); });
        await assert.rejects(f.runtime().drain(f.lease()), { code: 'ER_FIXTURE_RESTART' });
        assert.equal(String((await f.receiver()).process_cursor_id), '0');
        await f.runtime().stop(); f.advance(1); f.setRoute(null);
        const restarted = f.makeRuntime();
        assert.equal((await restarted.drain(f.lease())).processed, 4);
        assert.equal(await f.count('automation_runs'), 5); assert.equal(await f.count('automation_jobs'), 5);
        assert.equal((await f.receiver()).last_process_at_ms, null);
        const later = await f.record(); assert.equal((await restarted.drain(f.lease())).processed, 1);
        assert.equal((await f.store.getInbox({ ...f.subscription, id: later.id })).status, 'routed');
    }));
    await t.test('AES128 and legacy stored receipts survive a callback crash and recover through session/tick into the real queue', () => fixture(async f => {
        const modern = await f.record(), legacy = await f.record({ legacy: true });
        const ciphertext = await f.query('SELECT data_ciphertext FROM automation_x_push_inbox');
        assert(ciphertext.every(row => !row.data_ciphertext.includes('公開')));
        await f.runtime().tick(); await f.runtime().tick();
        assert.equal(await f.count('automation_runs'), 2); assert.equal(await f.count('automation_jobs'), 2);
        assert.equal((await f.store.getInbox({ ...f.subscription, id: modern.id })).status, 'routed');
        assert.equal((await f.store.getInbox({ ...f.subscription, id: legacy.id })).status, 'routed');
        assert.equal(Number((await f.query("SELECT COUNT(*) n FROM automation_audit WHERE action='x.push.vault.open'"))[0].n), 2);
        const event = JSON.parse((await f.query('SELECT event_json FROM automation_runs ORDER BY created_at_ms,id LIMIT 1'))[0].event_json);
        assert.equal(event.providerId, 'twitter'); assert.match(event.url, /^https:\/\/x\.com\/example\/status\/\d{19}$/);
    }));

    await t.test('page size two preserves one cutoff, drains all older pages, then waits before taking a later frame', () => fixture(async f => {
        const firstWindow = f.clock(); for (let i = 0; i < 5; i++) await f.record();
        assert.equal((await f.runtime().drain(f.lease())).processed, 2);
        let receiver = await f.receiver(); assert.equal(Number(receiver.process_window_at_ms), firstWindow); assert.equal(String(receiver.process_cursor_id), '2');
        f.advance(500); const newer = await f.record();
        assert.equal((await f.runtime().drain(f.lease())).processed, 2);
        assert.equal((await f.runtime().drain(f.lease())).processed, 1);
        receiver = await f.receiver(); assert.equal(receiver.process_window_at_ms, null); assert.equal(String(receiver.process_cursor_id), '0'); assert.equal(Number(receiver.last_process_at_ms), firstWindow);
        assert.equal(await f.count('automation_runs'), 5); assert.equal((await f.store.getInbox({ ...f.subscription, id: newer.id })).status, 'received');
        assert.equal((await f.runtime().drain(f.lease())).dueAtMs, firstWindow + 300000);
        f.advance(300000); await f.refreshLease(); await f.runtime().drain(f.lease()); assert.equal(await f.count('automation_runs'), 6);
    }));

    await t.test('pending early receipt is retried after a later row routed and the window cursor reset', () => fixture(async f => {
        const first = await f.record(); await f.record(); let wait = true;
        f.setRoute((input, real) => wait && input.inbox.id === first.id ? { state: 'pending' } : real.routeReceived(input));
        await f.runtime().drain(f.lease()); await f.runtime().drain(f.lease());
        assert.equal((await f.store.getInbox({ ...f.subscription, id: first.id })).status, 'received'); assert.equal(await f.count('automation_runs'), 1);
        assert.equal(String((await f.receiver()).process_cursor_id), '0'); wait = false;
        f.advance(300000); await f.refreshLease(); await f.runtime().drain(f.lease());
        assert.equal((await f.store.getInbox({ ...f.subscription, id: first.id })).status, 'routed'); assert.equal(await f.count('automation_runs'), 2);
    }));

    await t.test('an active page cursor survives worker reconstruction without resetting the original window', () => fixture(async f => {
        const at = f.clock(); for (let i = 0; i < 3; i++) await f.record();
        await f.runtime().drain(f.lease()); assert.equal(String((await f.receiver()).process_cursor_id), '2');
        await f.runtime().stop(); f.advance(1000); const restarted = f.makeRuntime();
        await restarted.drain(f.lease()); const row = await f.receiver();
        assert.equal(Number(row.last_process_at_ms), at); assert.equal(row.process_window_at_ms, null); assert.equal(await f.count('automation_runs'), 3);
    }));

    await t.test('new windows observe the current free contract interval even for donors and support configuration changes', () => fixture(async f => {
        const at = f.clock(); await f.record(); await f.runtime().drain(f.lease()); await f.record();
        await f.query('UPDATE users SET is_donor=1 WHERE user_id=?', [U]);
        await f.db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, ADMIN, { planId: 'supporter', label: '支援者', slotLimit: 5, minuteLimit: 9, dayLimit: 99, priority: 9, intervalMinutes: 5 }));
        await f.query("UPDATE automation_notification_plans SET confirmation_interval_minutes=30 WHERE plan_id='free'");
        f.advance(300000); await f.refreshLease();
        assert.equal((await f.runtime().drain(f.lease())).dueAtMs, at + 30 * 60000); assert.equal(await f.count('automation_runs'), 1);
        await f.query("UPDATE automation_notification_plans SET confirmation_interval_minutes=NULL WHERE plan_id='free'");
        assert.equal((await f.runtime().drain(f.lease())).code, 'X_MONITOR_NOT_CONFIGURED'); assert.equal((await f.store.listInbox(f.subscription)).length, 1);
        await f.query("UPDATE automation_notification_plans SET confirmation_interval_minutes=5 WHERE plan_id='free'");
        await f.runtime().drain(f.lease()); assert.equal(await f.count('automation_runs'), 2);
    }));

    await t.test('unsupported realtime or per-event policies preserve encrypted receipts without queue admission', () => fixture(async f => {
        await f.record(); await f.record(); await f.record();
        for (const processingPolicy of ['per-event', 'realtime']) {
            await f.runtime().stop(); const runtime = f.makeRuntime({ processingPolicy });
            assert.equal((await runtime.drain(f.lease())).state, 'not_configured');
            assert.equal((await runtime.tick()).state, 'not_configured');
            assert.equal(await f.count('automation_runs'), 0);
            assert.equal((await f.store.listInbox(f.subscription)).length, 3);
        }
    }));

    await t.test('an expired-lease successor resumes the original batch cutoff and cursor while fencing the previous token', () => fixture(async f => {
        const at = f.clock(), previousLease = f.lease();
        for (let i = 0; i < 5; i++) await f.record();
        assert.equal((await f.runtime().drain(previousLease)).processed, 2);
        await f.runtime().stop(); f.advance(300000);
        const successorLease = await f.refreshLease();
        assert(successorLease); assert.notEqual(successorLease.token, previousLease.token);
        let receiver = await f.receiver();
        assert.equal(Number(receiver.process_window_at_ms), at); assert.equal(String(receiver.process_cursor_id), '2');
        await assert.rejects(f.store.advanceProcessing(previousLease, { windowAtMs: at, cursorId: '3' }), { code: 'X_PUSH_LEASE_LOST' });
        await assert.rejects(f.store.completeProcessing(previousLease, { windowAtMs: at }), { code: 'X_PUSH_LEASE_LOST' });
        const newer = await f.record(), restarted = f.makeRuntime();
        assert.equal((await restarted.drain(successorLease)).processed, 2);
        assert.equal((await restarted.drain(successorLease)).processed, 1);
        receiver = await f.receiver();
        assert.equal(Number(receiver.last_process_at_ms), at); assert.equal(receiver.process_window_at_ms, null); assert.equal(String(receiver.process_cursor_id), '0');
        assert.equal(await f.count('automation_runs'), 5); assert.equal(await f.count('automation_jobs'), 5);
        assert.equal((await f.store.getInbox({ ...f.subscription, id: newer.id })).status, 'received');
        assert.equal((await restarted.drain(successorLease)).processed, 1);
        assert.equal(await f.count('automation_runs'), 6); assert.equal(await f.count('automation_jobs'), 6);
        assert.equal((await f.store.getInbox({ ...f.subscription, id: newer.id })).status, 'routed');
    }));

    await t.test('an open batch pauses for a missing interval and finishes its original cutoff before the changed next interval', () => fixture(async f => {
        const at = f.clock(); for (let i = 0; i < 3; i++) await f.record();
        assert.equal((await f.runtime().drain(f.lease())).processed, 2);
        await f.query("UPDATE automation_notification_plans SET confirmation_interval_minutes=NULL WHERE plan_id='free'");
        const paused = await f.runtime().drain(f.lease());
        assert.equal(paused.state, 'pending'); assert.equal(paused.code, 'X_MONITOR_NOT_CONFIGURED');
        let receiver = await f.receiver();
        assert.equal(Number(receiver.process_window_at_ms), at); assert.equal(String(receiver.process_cursor_id), '2'); assert.equal(receiver.last_process_at_ms, null);
        assert.equal(await f.count('automation_runs'), 2);
        await f.query("UPDATE automation_notification_plans SET confirmation_interval_minutes=30 WHERE plan_id='free'");
        f.advance(1000); const newer = await f.record();
        assert.equal((await f.runtime().drain(f.lease())).processed, 1);
        receiver = await f.receiver();
        assert.equal(Number(receiver.last_process_at_ms), at); assert.equal(receiver.process_window_at_ms, null); assert.equal(String(receiver.process_cursor_id), '0');
        assert.equal(await f.count('automation_runs'), 3); assert.equal((await f.store.getInbox({ ...f.subscription, id: newer.id })).status, 'received');
        assert.equal((await f.runtime().drain(f.lease())).dueAtMs, at + 30 * 60000);
        f.advance(299000); await f.refreshLease();
        assert.equal((await f.runtime().drain(f.lease())).dueAtMs, at + 30 * 60000); assert.equal(await f.count('automation_runs'), 3);
        f.advance(25 * 60000); await f.refreshLease();
        assert.equal((await f.runtime().drain(f.lease())).processed, 1);
        assert.equal(await f.count('automation_runs'), 4); assert.equal(await f.count('automation_jobs'), 4);
        assert.equal((await f.store.getInbox({ ...f.subscription, id: newer.id })).status, 'routed');
    }));

    await t.test('a plan change committed ahead of the owner lock controls the next window opening', () => fixture(async f => {
        const at = f.clock(); await f.record(); await f.runtime().drain(f.lease());
        const receipt = await f.record(); f.advance(300000); await f.refreshLease();
        let held, proceed, attempted, draining;
        const ownerHeld = new Promise(resolve => { held = resolve; }), continueChange = new Promise(resolve => { proceed = resolve; }), ownerAttempted = new Promise(resolve => { attempted = resolve; });
        const updating = f.db.withDatabaseTransaction(async query => {
            await entitlements.lockOwner(query, U); held(); await continueChange;
            await query("UPDATE automation_notification_plans SET confirmation_interval_minutes=30 WHERE plan_id='free'");
        });
        try {
            await ownerHeld; f.setOwnerLockAttempt(() => attempted());
            draining = f.runtime().drain(f.lease());
            const attemptedBeforeFinishing = await Promise.race([ownerAttempted.then(() => true), draining.then(() => false, () => false)]);
            assert.equal(attemptedBeforeFinishing, true);
            proceed(); await updating;
            const waiting = await draining;
            assert.equal(waiting.state, 'pending'); assert.equal(waiting.dueAtMs, at + 30 * 60000);
            const receiver = await f.receiver();
            assert.equal(Number(receiver.last_process_at_ms), at); assert.equal(receiver.process_window_at_ms, null); assert.equal(String(receiver.process_cursor_id), '0');
            assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.id })).status, 'received');
            assert.equal(await f.count('automation_runs'), 1); assert.equal(await f.count('automation_jobs'), 1);
        } finally { proceed(); f.setOwnerLockAttempt(null); await Promise.allSettled([updating, ...(draining ? [draining] : [])]); }
    }));

    await t.test('a delayed durable admission after lease takeover is marked by the successor without duplicating the queued job', () => fixture(async f => {
        const at = f.clock(), previousLease = f.lease(), previousRuntime = f.runtime(), receipt = await f.record();
        let entered, resume;
        const enteredRoute = new Promise(resolve => { entered = resolve; }), continueRoute = new Promise(resolve => { resume = resolve; });
        f.setRoute(async (input, real) => { entered(); await continueRoute; return real.routeReceived(input); });
        const draining = previousRuntime.drain(previousLease);
        const rejected = assert.rejects(draining, { code: 'X_PUSH_LEASE_LOST' });
        try {
            await enteredRoute; f.advance(300000);
            const successorLease = await f.refreshLease();
            assert(successorLease); assert.notEqual(successorLease.token, previousLease.token);
            resume(); await rejected;
            assert.equal(await f.count('automation_runs'), 1); assert.equal(await f.count('automation_jobs'), 1);
            assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.id })).status, 'received');
            let receiver = await f.receiver();
            assert.equal(Number(receiver.process_window_at_ms), at); assert.equal(String(receiver.process_cursor_id), '0');
            await previousRuntime.stop(); f.setRoute(null);
            const restarted = f.makeRuntime();
            assert.equal((await restarted.drain(successorLease)).processed, 1);
            assert.equal(await f.count('automation_runs'), 1); assert.equal(await f.count('automation_jobs'), 1);
            assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.id })).status, 'routed');
            receiver = await f.receiver();
            assert.equal(Number(receiver.last_process_at_ms), at); assert.equal(receiver.process_window_at_ms, null); assert.equal(String(receiver.process_cursor_id), '0');
        } finally { resume(); await Promise.allSettled([draining, rejected]); await previousRuntime.stop(); }
    }));

    await t.test('concurrent runtime drains admit one queue run per encrypted receipt', () => fixture(async f => {
        await f.record(); await f.record();
        const results = await Promise.all(Array.from({ length: 8 }, () => f.runtime().drain(f.lease())));
        assert(results.every(row => row.processed === 2)); assert.equal(await f.count('automation_runs'), 2); assert.equal(await f.count('automation_jobs'), 2);
    }));

    await t.test('audit failure and routed-marker DB failure retain ciphertext and retry without duplicate queue admission', () => fixture(async f => {
        const receipt = await f.record(); f.setAuditFailure(true);
        await assert.rejects(f.runtime().drain(f.lease()), error => error.code === 'X_PUSH_STORE_UNAVAILABLE' && !error.message.includes('SQL_PRIVATE_SENTINEL'));
        assert.equal(await f.count('automation_runs'), 0); assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.id })).status, 'received');
        f.setAuditFailure(false); f.setMarkFailure(true);
        await assert.rejects(f.runtime().drain(f.lease()), { code: 'X_PUSH_STORE_UNAVAILABLE' });
        assert.equal(await f.count('automation_runs'), 1); assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.id })).status, 'received');
        assert.equal(String((await f.receiver()).process_cursor_id), '0'); f.setMarkFailure(false);
        await f.runtime().drain(f.lease()); assert.equal(await f.count('automation_runs'), 1); assert.equal(await f.count('automation_jobs'), 1);
        assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.id })).status, 'routed');
    }));

    await t.test('unknown encrypted private notifications are quarantined without creating automation runs or plaintext audits', () => fixture(async f => {
        const secret = 'private_payload_sentinel'; const receipt = await f.record({ payload: { notificationType: 'dm', text: secret } });
        await f.runtime().drain(f.lease());
        assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.id })).status, 'unsupported'); assert.equal(await f.count('automation_runs'), 0);
        assert(!JSON.stringify(await f.query('SELECT * FROM automation_audit')).includes(secret));
        assert(!JSON.stringify(await f.query('SELECT * FROM automation_x_push_inbox')).includes(secret));
    }));

    await t.test('mixed duplicate-author monitors preserve explicit batch while owner default is realtime and deduplicate the later batch fanout', () => fixture(async f => {
        await realtime(f, null);
        const first = (await f.query('SELECT * FROM automation_x_monitors WHERE owner_user_id=?', [U]))[0];
        await f.query('UPDATE automation_x_monitors SET notification_settings_json=? WHERE id=?', [JSON.stringify({ subscriptionId: f.subscription.subscriptionId, processingMode: 'batch' }), first.id]);
        const second = await f.query("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'54321','EXAMPLE','Legacy duplicate author',1,'ready','free',?,'bound',1,?,?)", [U, JSON.stringify({ subscriptionId: f.subscription.subscriptionId, processingMode: 'realtime' }), f.clock(), f.clock()]);
        await f.db.withDatabaseTransaction(query => entitlements.assignSlot(query, U, 'x', String(second.insertId)));
        const receipt = await f.record({ payload: webPost('1190000000000000011') });
        const pending = await f.runtime().drain(f.lease());
        assert.equal(pending.code, 'X_MONITOR_NOT_CONFIGURED'); assert.equal(await f.count('automation_jobs'), 1);
        assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.id })).status, 'received');
        let receiver = await f.receiver(); assert.equal(receiver.last_process_at_ms, null); assert.equal(receiver.process_window_at_ms, null); assert.equal(String(receiver.process_cursor_id), '0');
        await f.query("UPDATE automation_notification_plans SET confirmation_interval_minutes=5 WHERE plan_id='ExplicitRealtimePlan'");
        await f.runtime().drain(f.lease());
        assert.equal(await f.count('automation_jobs'), 2); assert.equal(await f.count('automation_runs'), 2);
        assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.id })).status, 'routed');
        const targets = await f.query('SELECT target_id FROM automation_runs ORDER BY target_id');
        assert.deepEqual(targets.map(row => String(row.target_id)), [String(first.id), String(second.insertId)]);
        receiver = await f.receiver(); assert.equal(Number(receiver.last_process_at_ms), f.clock());
        await f.runtime().drain(f.lease()); assert.equal(await f.count('automation_jobs'), 2);
    }));

    await t.test('a free owner with five explicitly reserved slots delivers realtime through encrypted runtime with no batch interval', () => fixture(async f => {
        const api = createXMonitorQuota(f.db, { registrationEnabled: true, rolloutMode: 'public', now: f.clock });
        const monitor = (await api.list({ userId: U })).items[0];
        const saved = await api.update({ userId: U }, monitor.id, { expectedRevision: monitor.revision, processingMode: 'realtime', expectedRealtimeSlotCost: 5 });
        assert.equal(saved.processing.realtimeSource, 'slots'); assert.equal(saved.processing.slotCost, 5);
        await f.query("UPDATE automation_notification_plans SET confirmation_interval_minutes=NULL WHERE plan_id='free'");
        const receipt = await f.record(); await f.runtime().drain(f.lease());
        assert.equal(await f.count('automation_jobs'), 1); assert.equal(await f.count('automation_notification_boost_slots'), 4);
        assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.id })).status, 'routed');
        const receiver = await f.receiver(); assert.equal(receiver.last_process_at_ms, null); assert.equal(receiver.process_window_at_ms, null); assert.equal(String(receiver.process_cursor_id), '0');
    }));

    await t.test('existing donor in supporter pool delivers realtime at one personal slot with no paid contract or batch interval', () => fixture(async f => {
        await f.query('UPDATE users SET is_donor=1,additional_auto_extract_slots=1 WHERE user_id=?', [U]);
        await f.query('UPDATE automation_x_monitors SET pool_kind=\'supporter\',notification_settings_json=? WHERE owner_user_id=?', [JSON.stringify({ subscriptionId: f.subscription.subscriptionId, processingMode: 'realtime' }), U]);
        await f.query("UPDATE automation_notification_plans SET confirmation_interval_minutes=NULL WHERE plan_id='free'");
        const receipt = await f.record(); await f.runtime().drain(f.lease());
        assert.equal(await f.count('automation_jobs'), 1); assert.equal(await f.count('automation_notification_slots'), 1); assert.equal(await f.count('automation_notification_boost_slots'), 0);
        assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.id })).status, 'routed'); assert.equal((await f.receiver()).last_process_at_ms, null);
    }));

    await t.test('qualification lost after router inspection is rejected by locked queue admission and later batch processes the retained ciphertext', () => fixture(async f => {
        await f.runtime().drain(f.lease()); const at = f.clock(); await realtime(f);
        const receipt = await f.record(), original = f.queue.routeX;
        let once = true;
        f.queue.routeX = async (...args) => { if (once) { once = false; await f.query("UPDATE automation_push_plan_policy SET realtime_enabled=0 WHERE plan_id='ExplicitRealtimePlan'"); } return original(...args); };
        const pending = await f.runtime().drain(f.lease());
        assert.equal(pending.state, 'pending'); assert.equal(pending.dueAtMs, at + 15 * 60000);
        assert.equal(await f.count('automation_jobs'), 0); assert.equal(await f.count('automation_runs'), 0);
        assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.id })).status, 'received');
        f.advance(15 * 60000); await f.refreshLease(); await f.runtime().drain(f.lease());
        assert.equal(await f.count('automation_jobs'), 1); assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.id })).status, 'routed');
    }));

    await t.test('fresh callback ID bypasses retained batch backlog and keeps its clock, while restart recovers unmarked realtime without duplicate jobs', () => fixture(async f => {
        await realtime(f, null); await f.runtime().tick();
        for (let index = 0; index < 24; index++) await f.record({ payload: webPost(String(1190000000000000100n + BigInt(index)), 'batch_author') });
        // A second author remains explicit batch, so the older encrypted rows
        // are legitimate pending work rather than terminal unmatched notices.
        const second = await f.query("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'54321','batch_author','Batch backlog',1,'ready','free',?,'bound',1,?,?)", [U, JSON.stringify({ subscriptionId: f.subscription.subscriptionId, processingMode: 'batch' }), f.clock(), f.clock()]);
        await f.db.withDatabaseTransaction(query => entitlements.assignSlot(query, U, 'x', String(second.insertId)));
        const latest = await f.record();
        await f.callbacks().onReceived({ lease: f.lease(), inbox: { id: latest.id }, payload: { forged: true } });
        assert.equal(await f.count('automation_jobs'), 1); assert.equal((await f.store.getInbox({ ...f.subscription, id: latest.id })).status, 'routed');
        assert.equal((await f.store.listInbox(f.subscription)).length, 24); assert.equal((await f.receiver()).last_process_at_ms, null);
        const replay = await f.record(); f.setMarkFailure(true);
        await assert.rejects(f.callbacks().onReceived({ lease: f.lease(), inbox: { id: replay.id } }), { code: 'X_PUSH_STORE_UNAVAILABLE' });
        assert.equal(await f.count('automation_jobs'), 2); assert.equal((await f.store.getInbox({ ...f.subscription, id: replay.id })).status, 'received');
        await f.runtime().stop(); f.setMarkFailure(false); const restarted = f.makeRuntime();
        await restarted.drain(f.lease()); await restarted.drain(f.lease());
        assert.equal(await f.count('automation_jobs'), 2); assert.equal((await f.store.getInbox({ ...f.subscription, id: replay.id })).status, 'routed');
        assert.equal((await f.store.listInbox(f.subscription)).length, 24); assert.equal((await f.receiver()).last_process_at_ms, null);
    }));

});

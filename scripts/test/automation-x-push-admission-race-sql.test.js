'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const { insertSubscription, vault, ownerUserId, FakeSocket } = require('./helpers/x-push-fixture.cjs');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { createXPushRuntime } = require('../../src/automation/x-push-runtime');

const port = Number(process.env.AUTOMATION_TEST_DB_PORT), other = '333333333333333333';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
for (const mutation of ['subscription-deleted', 'owner-changed', 'donor-revoked'])
    test(`receiver cannot open after ${mutation} between candidate lookup and claim`, { timeout: 30000 }, async t => {
        const db = await createTestDatabase(port), entered = deferred(), release = deferred();
        let runtime;
        t.after(async () => { release.resolve(); await runtime?.stop(); await db.close(); });
        await grantTestDonor(db, ownerUserId); await grantTestDonor(db, other);
        const subscription = await insertSubscription(db);
        await db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'12345','fixture',1,'ready','free',?,'bound',1,0,0)",
            [ownerUserId, JSON.stringify({ subscriptionId: subscription.subscriptionId })]);
        let delayed = false, sockets = 0, syntheticSocketAllowed = false;
        const wrapped = { withDatabaseTransaction: db.withDatabaseTransaction, queryDatabase: async (sql, params) => {
            const rows = await db.queryDatabase(sql, params);
            if (!delayed && /^SELECT is_donor FROM users/.test(sql)) { delayed = true; entered.resolve(); await release.promise; }
            return rows;
        } };
        const gateway = createXPushGateway(wrapped, { enabled: true, privateWorkerVault: vault, rolloutMode: 'supporters',
            createSocket: () => {
                sockets++;
                if (!syntheticSocketAllowed) throw new Error('unexpected synthetic socket');
                return new FakeSocket((message, socket) => {
                    if (message.messageType === 'hello') socket.reply({ messageType: 'hello', status: 200, uaid: message.uaid, use_webpush: true });
                });
            } });
        runtime = createXPushRuntime(wrapped, {}, { enabled: true, gateway, router: { hasRealtimeTargets: async () => false, hasBatchTargets: async () => false }, rolloutMode: 'supporters',
            processingPolicy: 'batch', assertAllowed() {}, pageSize: 1 });
        const tick = runtime.tick(); await entered.promise;
        if (mutation === 'subscription-deleted') await db.queryDatabase('DELETE FROM automation_x_subscriptions WHERE id=?', [subscription.subscriptionId]);
        else if (mutation === 'owner-changed') await db.queryDatabase('UPDATE automation_x_subscriptions SET owner_user_id=? WHERE id=?', [other, subscription.subscriptionId]);
        else await db.queryDatabase('UPDATE users SET is_donor=0 WHERE user_id=?', [ownerUserId]);
        release.resolve(); await tick;
        for (let attempt = 0; attempt < 200 && runtime.status().sessions; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(runtime.status().sessions, 0); assert.equal(sockets, 0);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_x_push_receivers WHERE subscription_id=?', [subscription.subscriptionId]))[0].n), 0);
        if (mutation === 'donor-revoked') {
            // Eligibility can return later without recreating a subscription,
            // moving a slot or requiring the user to repeat the import.
            await db.queryDatabase('UPDATE users SET is_donor=1 WHERE user_id=?', [ownerUserId]);
            syntheticSocketAllowed = true;
            for (let attempt = 0; attempt < 4 && !sockets; attempt++) { await runtime.tick(); await new Promise(resolve => setTimeout(resolve, 10)); }
            let state;
            for (let attempt = 0; attempt < 200; attempt++) {
                state = await gateway.store.status(subscription);
                if (state?.state === 'listening') break;
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.equal(sockets, 1); assert.equal(state?.state, 'listening');
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_x_subscriptions WHERE id=? AND owner_user_id=?',
                [subscription.subscriptionId, ownerUserId]))[0].n), 1);
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_x_monitors WHERE owner_user_id=? AND state=?', [ownerUserId, 'ready']))[0].n), 1);
        }
    });

test('revocation immediately before claim prevents socket connection without removing the subscription', { timeout: 30000 }, async t => {
    const db = await createTestDatabase(port), entered = deferred(), release = deferred();
    t.after(async () => { release.resolve(); await db.close(); });
    await grantTestDonor(db, ownerUserId);
    const subscription = await insertSubscription(db);
    const before = (await db.queryDatabase('SELECT sealed_json,revision,owner_user_id FROM automation_x_subscriptions WHERE id=?', [subscription.subscriptionId]))[0];
    let waiting = false, sockets = 0, opens = 0;
    const wrapped = { queryDatabase: db.queryDatabase, withDatabaseTransaction: async work => {
        if (!waiting) { waiting = true; entered.resolve(); await release.promise; }
        return db.withDatabaseTransaction(work);
    } };
    const gateway = createXPushGateway(wrapped, { enabled: true, privateWorkerVault: { open(...args) { opens++; return vault.open(...args); } }, rolloutMode: 'supporters',
        createSocket: () => { sockets++; throw new Error('unexpected synthetic socket'); } });
    const run = gateway.run({ ...subscription, workerId: 'claim-revocation-fixture' });
    await entered.promise;
    await db.queryDatabase('UPDATE users SET is_donor=0 WHERE user_id=?', [ownerUserId]);
    release.resolve();
    await assert.rejects(run, { code: 'X_PUSH_ROLLOUT_WITHDRAWN' });
    assert.equal(sockets, 0); assert.equal(opens, 0);
    const receiver = (await db.queryDatabase('SELECT state,reason_code,lease_token FROM automation_x_push_receivers WHERE subscription_id=?', [subscription.subscriptionId]))[0];
    assert.equal(receiver?.state, 'error'); assert.equal(receiver?.reason_code, 'X_PUSH_ROLLOUT_WITHDRAWN'); assert.equal(receiver?.lease_token, null);
    assert.deepEqual((await db.queryDatabase('SELECT sealed_json,revision,owner_user_id FROM automation_x_subscriptions WHERE id=?', [subscription.subscriptionId]))[0], before);
    assert.equal(Number((await db.queryDatabase("SELECT COUNT(*) AS n FROM automation_audit WHERE entity_id=? AND action='x.push.vault.open'", [subscription.subscriptionId]))[0].n), 0);
});

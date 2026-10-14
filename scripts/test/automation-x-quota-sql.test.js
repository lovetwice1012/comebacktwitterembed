'use strict';
// Explicit fixture rollout; production defaults remain closed.
process.env.X_NOTIFICATION_ROLLOUT = 'public';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { createTestDatabase } = require('../lib/automation-test-db');
const capacity = require('../../src/automation/push-capacity');
const entitlements = require('../../src/automation/entitlements');
const { createRateLimiter } = require('../../src/automation/rate-limits');
const { createService } = require('../../src/automation/service');
const { newWorkflow } = require('../../src/automation/schema');
const { dispatch } = require('../../src/automation/api');
const { createXMonitorQuota } = require('../../src/automation/x-monitor-quota');
const grants = require('../../src/automation/push-support-grants');
const { getSquareDonationGrant } = require('../../src/automation/square-donations');

const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const ADMIN = { userId: '444444444444444444', isAdmin: true };
const actor = index => ({ userId: String(222222222222220000n + BigInt(index)) });
const account = index => ({ accountId: String(111111111111110000n + BigInt(index)), accountHandle: `fixture${index}`, name: `監視 ${index}` });
const request = (method, route, body = {}) => ({ method, path: route.split('/'), body });

async function setPools(db, freePoolLimit = 50, supporterPoolLimit = 100) {
    return db.withDatabaseTransaction(async query => {
        const previous = await capacity.getPoolPolicy(query, ADMIN);
        return capacity.savePoolPolicy(query, ADMIN, { freePoolLimit, supporterPoolLimit, expectedUpdatedAtMs: previous.updatedAtMs });
    });
}
async function setPaid(db, owner, changes = {}) {
    const planId = changes.planId || 'FixtureBasic';
    await db.withDatabaseTransaction(async query => {
        await entitlements.savePlanPolicy(query, ADMIN, { planId, label: 'Basic SQL fixture', slotLimit: 9, minuteLimit: 13, dayLimit: 123, priority: 17, intervalMinutes: 15, ...changes });
        const previous = await capacity.getPlanCapacity(query, ADMIN, planId);
        await capacity.savePlanCapacity(query, ADMIN, planId, { eligible: true, specialSlotLimit: 3, expectedUpdatedAtMs: previous.updatedAtMs });
        await entitlements.setUserPlan(query, ADMIN, owner.userId, planId);
    });
}
async function legacySupporter(db, owner, slots = 1) {
    // This is the existing authoritative legacy count, not a monetary-derived
    // grant and not a client-selectable allowance.
    await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms,is_donor,additional_auto_extract_slots) VALUES (?,0,1,?) ON DUPLICATE KEY UPDATE is_donor=1,additional_auto_extract_slots=VALUES(additional_auto_extract_slots)', [owner.userId, slots]);
}
async function notificationSettings(db, owner, label = '保持する通知設定') {
    const service = createService(db);
    const destination = await service.saveDestination(owner, { name: label, kind: 'dm' });
    const workflow = await service.createWorkflow(owner, { definition: newWorkflow(label) });
    return { destinationId: destination.id, workflowId: workflow.id };
}
async function nativeStores(db, work) {
    const paths = [require.resolve('../../src/db'), require.resolve('../../src/db_schema'), require.resolve('../../src/providers/autoWatch/store'), require.resolve('../../src/providers/priceWatch/store')];
    const originals = paths.map(path => require.cache[path]);
    try {
        const schema = require(paths[1]);
        require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: { ...db,
            ensureUserExistsInDatabase: userId => db.queryDatabase('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,0)', [userId]) } };
        require.cache[paths[1]] = { id: paths[1], filename: paths[1], loaded: true, exports: { ...schema, ensureDatabaseSchema: async () => {} } };
        delete require.cache[paths[2]]; delete require.cache[paths[3]];
        const nativeAuto = require(paths[2]), nativePrice = require(paths[3]);
        // The trusted fixture option isolates admission quota from the already
        // separately tested operation-rate policy. It changes no DB policy.
        const operationRateLimiter = createRateLimiter(db, { policy: { operations: { monitor: { minute: 1000, hour: 10000 } } } });
        return await work({
            auto: (owner, source) => nativeAuto.registerTarget({ userId: owner.userId, providerId: 'github', source, destinationType: 'dm' }, { operationRateLimiter }),
            price: (owner, id) => nativePrice.registerTarget({ userId: owner.userId, providerId: 'steam', productUrl: `https://store.steampowered.com/app/${id}/`, destinationType: 'dm', mode: 'change' }, { operationRateLimiter }),
            deleteAuto: (owner, id) => nativeAuto.deleteTarget(owner.userId, id),
            deletePrice: (owner, id) => nativePrice.deleteTarget(owner.userId, id),
        });
    } finally {
        paths.forEach((path, index) => { if (originals[index]) require.cache[path] = originals[index]; else delete require.cache[path]; });
    }
}

// Every scenario creates a real, randomly named, guarded MariaDB schema. The
// file intentionally requires an explicit fixture port and never skips SQL.
async function scenario(t, name, work) {
    await t.test(name, async child => {
        const db = await createTestDatabase(port);
        child.after(() => db.close());
        await work(db, createXMonitorQuota(db, { registrationEnabled: true }));
    });
}
function failAfterWrite(db, pattern) {
    let triggered = false;
    return {
        ...db,
        get triggered() { return triggered; },
        withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
            const result = await query(sql, params);
            if (!triggered && pattern.test(sql)) {
                triggered = true;
                // A real MariaDB statement fails after the preceding write. The
                // same connection must roll back the entire operation.
                await query("SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='quota fixture write failure'");
            }
            return result;
        })),
    };
}
function gateAfterQuery(db, pattern) {
    let markReached, openGate, intercepted = false;
    const reached = new Promise(resolve => { markReached = resolve; });
    const gate = new Promise(resolve => { openGate = resolve; });
    return {
        reached,
        release: () => openGate(),
        db: { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
            const result = await query(sql, params);
            if (!intercepted && pattern.test(sql)) { intercepted = true; markReached(); await gate; }
            return result;
        })) },
    };
}
async function gateReached(gate) {
    let timer;
    try { await Promise.race([gate.reached, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture transaction gate not reached')), 5000); })]); }
    finally { clearTimeout(timer); }
}
async function readInNewNodeProcess(db, owner) {
    const source = `
        'use strict';
        const [schema, portText, userId] = process.argv.slice(1);
        const port = Number(portText);
        if (!/^cbte_automation_test_[0-9a-f]{20}$/.test(schema) || !Number.isInteger(port) || port === 3306 || port < 1024 || port > 65535) throw new Error('Unsafe fixture DB');
        const mysql = require('mysql');
        const connection = mysql.createConnection({host:'127.0.0.1',port,user:'root',password:process.env.AUTOMATION_TEST_DB_PASSWORD || '',database:schema,supportBigNumbers:true,bigNumberStrings:true});
        const query = (sql,params=[]) => new Promise((resolve,reject) => connection.query(sql,params,(error,rows) => error ? reject(error) : resolve(rows)));
        const db = {queryDatabase:query,withDatabaseTransaction:async work => {
            await query('START TRANSACTION');
            try {const result=await work(query);await query('COMMIT');return result;}
            catch(error) {await query('ROLLBACK');throw error;}
        }};
        (async () => {
            try {
                const quota = require('./src/automation/x-monitor-quota').createXMonitorQuota(db,{registrationEnabled:true});
                process.stdout.write(JSON.stringify(await quota.list({userId})));
            } finally {connection.end();}
        })().catch(error=>{process.stderr.write(error.code || error.name);process.exitCode=1;});
    `;
    const stdout = await new Promise((resolve, reject) => execFile(process.execPath, ['-e', source, db.schema, String(port), owner.userId],
        { cwd: path.resolve(__dirname, '../..'), env: process.env, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => error ? reject(Object.assign(error, { fixtureError: stderr })) : resolve(stdout)));
    return JSON.parse(stdout);
}

test('X quota real MariaDB acceptance: independent pools, shared personal allowance, ownership and atomic recovery', { timeout: 240000 }, async t => {
    await scenario(t, 'Q01/Q02: 49 free registrations plus two concurrent owners admit exactly one; the fiftieth rejects the next free owner', async (db, quota) => {
        await setPools(db);
        for (let index = 1; index <= 49; index++) assert.equal((await quota.register(actor(index), account(index))).poolKind, 'free');
        const outcomes = await Promise.allSettled([50, 51].map(index => quota.register(actor(index), account(index))));
        assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
        assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.code, 'X_MONITOR_POOL_FULL');
        const rows = await db.queryDatabase("SELECT COUNT(*) n FROM automation_x_monitors WHERE pool_kind='free'");
        assert.equal(Number(rows[0].n), 50);
        await assert.rejects(quota.register(actor(52), account(52)), { code: 'X_MONITOR_POOL_FULL' });
        assert.equal((await entitlements.getEntitlementSummary(db, actor(52).userId)).usedSlots, 0);
    });
    await scenario(t, 'Q03/Q08: Basic spills to its configured special allocation without increasing its personal allowance', async (db, quota) => {
        await setPools(db, 0, 100);
        const owner = actor(60); await setPaid(db, owner, { slotLimit: 2 });
        const before = await entitlements.inspectPlan(db.queryDatabase, owner.userId);
        const first = await quota.register(owner, account(60)), second = await quota.register(owner, account(61));
        assert.equal(first.poolKind, 'special'); assert.equal(second.poolKind, 'special');
        const after = await entitlements.getEntitlementSummary(db, owner.userId);
        assert.equal(after.slotLimit, before.slotLimit); assert.equal(after.baseSlotLimit, 2); assert.equal(after.usedSlots, 2);
        await assert.rejects(quota.register(owner, account(62)), { code: 'X_MONITOR_PERSONAL_LIMIT' });
        assert.equal(Number((await db.queryDatabase("SELECT COUNT(*) n FROM automation_x_monitors WHERE pool_kind='supporter'"))[0].n), 0);
    });
    await scenario(t, 'Q04: historical supporters consume their additional allowance and the independent supporter pool', async (db, quota) => {
        await setPools(db, 0, 100);
        const owner = actor(70); await legacySupporter(db, owner, 2);
        const first = await quota.register(owner, account(70));
        assert.equal(first.poolKind, 'supporter');
        const entitlement = await entitlements.getEntitlementSummary(db, owner.userId);
        assert.equal(entitlement.slotLimit, entitlement.baseSlotLimit + 2);
        assert.equal(entitlement.usedSlots, 1);
        assert.equal(Number((await db.queryDatabase("SELECT COUNT(*) n FROM automation_x_monitors WHERE pool_kind='free'"))[0].n), 0);
    });
    await scenario(t, 'Q05/Q06: paid supporters allocate free then supporter then special and all retain current-plan service quality', async (db, quota) => {
        await setPools(db, 1, 2);
        await db.withDatabaseTransaction(async query => {
            await entitlements.savePlanPolicy(query, ADMIN, { planId: 'free', label: '無料テスト', slotLimit: 5, minuteLimit: 7, dayLimit: 29, priority: 2, intervalMinutes: 60 });
            await entitlements.savePlanPolicy(query, ADMIN, { planId: 'supporter', label: '旧支援者テスト', slotLimit: 7, minuteLimit: 500, dayLimit: 5000, priority: 99, intervalMinutes: 5 });
        });
        const owner = actor(80); await legacySupporter(db, owner, 2); await setPaid(db, owner);
        const expected = await entitlements.inspectPlan(db.queryDatabase, owner.userId);
        const registered = [];
        for (let index = 0; index < 5; index++) registered.push(await quota.register(owner, account(80 + index)));
        assert.deepEqual(registered.map(item => item.poolKind), ['free', 'supporter', 'supporter', 'special', 'special']);
        const personal = (await quota.summary(owner)).personal;
        assert.equal(personal.totalLimit, 11); assert.equal(personal.supporterExtraSlots, 2);
        for (const item of registered) {
            const policy = item.quality;
            for (const field of ['planId', 'priority', 'minuteLimit', 'dayLimit']) assert.equal(policy[field], expected[field], `${item.poolKind}/${field}`);
            assert.equal(policy.intervalMinutes, 15);
        }
        assert.equal(new Set(registered.map(item => item.quality.intervalMinutes)).size, 1);
        await db.withDatabaseTransaction(query => entitlements.setUserPlan(query, ADMIN, owner.userId, null));
        await quota.reconcile(owner);
        const downgraded = (await entitlements.listPlanPolicies(db.queryDatabase, ADMIN)).find(plan => plan.planId === 'free');
        const afterCancellation = (await quota.summary(owner)).personal;
        assert.equal(afterCancellation.totalLimit, 9); assert.equal(afterCancellation.supporterExtraSlots, 2);
        const current = (await quota.list(owner)).items;
        for (const item of registered.slice(0, 3)) {
            const policy = current.find(row => row.id === item.id).quality;
            for (const field of ['planId', 'priority', 'minuteLimit', 'dayLimit']) assert.equal(policy[field], downgraded[field]);
            assert.equal(policy.intervalMinutes, 60);
        }
    });
    await scenario(t, 'Q09: ten owners monitoring one X account consume ten distinct registrations and personal slots', async (db, quota) => {
        await setPools(db);
        const results = await Promise.all(Array.from({ length: 10 }, (_, index) => quota.register(actor(100 + index), account(100))));
        assert.equal(new Set(results.map(item => item.id)).size, 10);
        assert.ok(results.every(item => item.poolKind === 'free'));
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_x_monitors WHERE account_id=?', [account(100).accountId]))[0].n), 10);
        for (let index = 0; index < 10; index++) assert.equal((await entitlements.getEntitlementSummary(db, actor(100 + index).userId)).usedSlots, 1);
    });
    await scenario(t, 'Q10: duplicate release is idempotent and cannot release another user registration', async (db, quota) => {
        await setPools(db, 0, 100);
        const owner = actor(120); await legacySupporter(db, owner, 1);
        const registration = await quota.register(owner, account(120));
        await assert.rejects(quota.release(actor(121), registration.id), { code: 'NOT_FOUND' });
        assert.equal((await entitlements.getEntitlementSummary(db, owner.userId)).usedSlots, 1);
        await quota.release(owner, registration.id); await quota.release(owner, registration.id);
        assert.equal(Number((await db.queryDatabase("SELECT COUNT(*) n FROM automation_x_monitors WHERE state<>'deleted'"))[0].n), 0);
        assert.equal((await entitlements.getEntitlementSummary(db, owner.userId)).usedSlots, 0);
    });
    await scenario(t, 'Q11 override: a plan change preserves the assigned pool and metadata until the owner explicitly moves the suspended registration', async (db, quota) => {
        await setPools(db, 0, 0);
        const owner = actor(130); await setPaid(db, owner);
        const settings = await notificationSettings(db, owner);
        const registration = await quota.register(owner, { ...account(130), notificationSettings: settings });
        assert.equal(registration.poolKind, 'special');
        await db.withDatabaseTransaction(query => entitlements.setUserPlan(query, ADMIN, owner.userId, null));
        await setPools(db, 1, 0); await quota.reconcile(owner);
        const suspended = (await quota.list(owner)).items.find(item => item.id === registration.id);
        assert.equal(suspended.poolKind, 'special'); assert.equal(suspended.state, 'suspended');
        assert.deepEqual(suspended.notificationSettings, settings); assert.equal(suspended.accountId, registration.accountId);
        assert.equal((await entitlements.getEntitlementSummary(db, owner.userId)).usedSlots, 1);
        const moved = await quota.move(owner, registration.id, { poolKind: 'free', expectedRevision: suspended.revision });
        assert.equal(moved.poolKind, 'free'); assert.equal(moved.state, 'ready'); assert.deepEqual(moved.notificationSettings, settings);
        await assert.rejects(quota.register(actor(131), account(131)), { code: 'X_MONITOR_POOL_FULL' });
        const paid = actor(132); await setPaid(db, paid);
        const paidSettings = await notificationSettings(db, paid);
        const retained = await quota.register(paid, { ...account(132), notificationSettings: paidSettings });
        await db.withDatabaseTransaction(query => entitlements.setUserPlan(query, ADMIN, paid.userId, null));
        await quota.reconcile(paid);
        const retainedSuspended = (await quota.list(paid)).items.find(item => item.id === retained.id);
        assert.ok(retainedSuspended); assert.equal(retainedSuspended.poolKind, 'special'); assert.equal(retainedSuspended.state, 'suspended');
        assert.deepEqual(retainedSuspended.notificationSettings, paidSettings); assert.equal(retainedSuspended.accountId, retained.accountId);
        assert.equal((await entitlements.getEntitlementSummary(db, paid.userId)).usedSlots, 1);
        assert.equal((await quota.list(paid)).quota.x.available, 0);
        assert.deepEqual((await quota.integrity(ADMIN)).issues, []);
    });
    await scenario(t, 'contract expiry preserves permanent supporter allowances and delivery admission reevaluates the current plan', async (db, quota) => {
        await setPools(db, 0, 0);
        const owner = actor(135); await legacySupporter(db, owner, 1); await setPaid(db, owner);
        const expiresAtMs = Date.now() + 60000;
        await db.withDatabaseTransaction(query => entitlements.setUserPlan(query, ADMIN, owner.userId, 'FixtureBasic', { expiresAtMs }));
        const item = await quota.register(owner, account(135)); assert.equal(item.poolKind, 'special');
        const expired = createXMonitorQuota(db, { registrationEnabled: true, now: () => expiresAtMs + 1 });
        await assert.rejects(expired.validateDelivery(owner, item.id), { code: 'X_MONITOR_NOT_AVAILABLE' });
        let current = (await expired.list(owner)).items[0];
        assert.equal(current.poolKind, 'special'); assert.equal(current.state, 'suspended'); assert.equal(current.quality.planId, 'free');
        assert.equal((await expired.summary(owner)).personal.supporterExtraSlots, 1);
        await setPools(db, 0, 1); await expired.reconcile(owner);
        const beforeMove = (await expired.list(owner)).items[0]; assert.equal(beforeMove.poolKind, 'special'); assert.equal(beforeMove.state, 'suspended');
        await expired.move(owner, item.id, { poolKind: 'supporter', expectedRevision: beforeMove.revision });
        current = await expired.validateDelivery(owner, item.id);
        assert.equal(current.poolKind, 'supporter'); assert.equal(current.quality.planId, 'free');
        assert.equal((await expired.summary(owner)).personal.totalLimit, 6);
    });
    await scenario(t, 'Q15 override/Q16: free vacancy does not move another registration; an explicit move preserves metadata and survives a new process', async (db, quota) => {
        await setPools(db, 1, 100);
        const blocker = await quota.register(actor(140), account(140));
        const owner = actor(141); await legacySupporter(db, owner, 1); await setPaid(db, owner);
        const settings = await notificationSettings(db, owner);
        const registration = await quota.register(owner, { ...account(141), notificationSettings: settings });
        assert.equal(registration.poolKind, 'supporter');
        await db.queryDatabase("UPDATE automation_x_monitors SET subscription_state='connected' WHERE id=?", [registration.id]);
        const slots = (await entitlements.getEntitlementSummary(db, owner.userId)).slots;
        const before = (await quota.list(owner)).items.find(item => item.id === registration.id);
        await quota.release(actor(140), blocker.id);
        const stillAssigned = (await quota.list(owner)).items.find(item => item.id === registration.id);
        assert.equal(stillAssigned.poolKind, 'supporter'); assert.equal(stillAssigned.revision, before.revision);
        await quota.move(owner, registration.id, { poolKind: 'free', expectedRevision: stillAssigned.revision });
        const fresh = createXMonitorQuota(db, { registrationEnabled: true });
        const after = (await fresh.list(owner)).items.find(item => item.id === registration.id);
        assert.equal(after.poolKind, 'free');
        for (const field of ['id', 'accountId', 'accountHandle', 'name', 'state']) assert.equal(after[field], before[field]);
        assert.deepEqual(after.notificationSettings, settings);
        assert.deepEqual((await entitlements.getEntitlementSummary(db, owner.userId)).slots.map(item => item.slotId), slots.map(item => item.slotId));
        assert.deepEqual(after.quality, (await quota.list(owner)).items.find(item => item.id === registration.id).quality);
        // A fresh process has no module instance, local cache or prior state.
        // It must read the same persisted registration through the real DB.
        assert.deepEqual((await readInNewNodeProcess(db, owner)).items, (await fresh.list(owner)).items);
    });
    await scenario(t, 'Q17: ordinary auto/price and X share the same personal allowance and unchanged native registration behavior', async (db, quota) => {
        await setPools(db);
        await nativeStores(db, async native => {
            const owner = actor(150);
            const ordinary = await native.auto(owner, 'quotaexisting');
            await native.price(owner, 440); await native.auto(owner, 'quotaordinary'); await native.price(owner, 570);
            const final = await quota.register(owner, account(150));
            let info = await entitlements.getEntitlementSummary(db, owner.userId);
            assert.equal(info.usedSlots, 5); assert.equal(info.remainingSlots, 0);
            await assert.rejects(native.auto(owner, 'quotarejected'), { code: 'AUTOMATION_SLOT_LIMIT' });
            await assert.rejects(native.price(owner, 730), { code: 'AUTOMATION_SLOT_LIMIT' });
            await quota.release(owner, final.id);
            const replacement = await native.price(owner, 730);
            assert.ok(replacement.id); assert.equal((await native.auto(owner, 'quotaexisting')).id, ordinary.id);
            info = await entitlements.getEntitlementSummary(db, owner.userId); assert.equal(info.usedSlots, 5);
            const paid = actor(151); await setPaid(db, paid, { slotLimit: 2 });
            await native.price(paid, 440); await quota.register(paid, account(151));
            await assert.rejects(native.price(paid, 570), { code: 'AUTOMATION_SLOT_LIMIT' });
            assert.equal((await entitlements.getEntitlementSummary(db, paid.userId)).usedSlots, 2);
        });
    });
    await scenario(t, 'Q17 legacy compatibility: X opt-in preserves an existing twenty-slot supporter base while quality uses the free contract', async (db, quota) => {
        await setPools(db);
        await db.withDatabaseTransaction(async query => {
            await entitlements.savePlanPolicy(query, ADMIN, { planId: 'free', label: '無料', slotLimit: 5, minuteLimit: 7, dayLimit: 29, priority: 2, intervalMinutes: 60 });
            await entitlements.savePlanPolicy(query, ADMIN, { planId: 'supporter', label: '既存支援者', slotLimit: 20, minuteLimit: 100, dayLimit: 5000, priority: 99, intervalMinutes: 5 });
        });
        const owner = actor(155); await legacySupporter(db, owner, 2);
        await nativeStores(db, async native => {
            for (let index = 0; index < 6; index++) await native.price(owner, 8000 + index);
            const before = await entitlements.getEntitlementSummary(db, owner.userId);
            assert.equal(before.baseSlotLimit, 20); assert.equal(before.slotLimit, 22); assert.equal(before.usedSlots, 6);
            const x = await quota.register(owner, account(155));
            assert.equal(x.quality.planId, 'free'); assert.equal(x.quality.priority, 2); assert.equal(x.quality.intervalMinutes, 60);
            const current = await entitlements.getEntitlementSummary(db, owner.userId), summary = await quota.summary(owner);
            assert.equal(current.slotLimit, before.slotLimit); assert.equal(current.baseSlotLimit, before.baseSlotLimit); assert.equal(current.priority, before.priority);
            assert.equal(summary.personal.totalLimit, 22); assert.equal(summary.personal.supporterExtraSlots, 2); assert.equal(summary.personal.used, 7);
            assert.deepEqual(current.slots.filter(slot => slot.targetKind === 'price').map(slot => slot.slotId), before.slots.map(slot => slot.slotId));
            for (let index = 6; index < 21; index++) await native.price(owner, 8000 + index);
            assert.equal((await entitlements.getEntitlementSummary(db, owner.userId)).usedSlots, 22);
            await assert.rejects(native.price(owner, 8021), { code: 'AUTOMATION_SLOT_LIMIT' });
            await assert.rejects(quota.register(owner, account(156)), { code: 'X_MONITOR_PERSONAL_LIMIT' });
        });
    });
    await scenario(t, 'new-payment counts: a thousand-yen payment grants two shared personal slots even when the legacy financial policy computes ten', async (db, quota) => {
        await setPools(db);
        const owner = actor(157), now = Date.now(), attemptId = randomUUID();
        const scope = { configured: true, environment: 'sandbox', merchantId: 'QUOTA-FIXTURE-MERCHANT' };
        const billing = require('../../src/automation/square-billing'), originalScope = billing.getSquareScope;
        billing.getSquareScope = () => scope;
        try {
            await db.withDatabaseTransaction(query => grants.migrateLegacyGrants(query, owner.userId, { now, scope }));
            // Authoritative local verified-payment fixture. REST/signature and
            // replay verification belongs to the separate Square bridge suite.
            await db.queryDatabase(`INSERT INTO automation_square_donation_attempts
                (id,owner_user_id,environment,merchant_id,location_id,application_id,amount,currency,email,name,policy_updated_at_ms,state,payment_id,verified,expires_at_ms,completed_at_ms,created_at_ms,updated_at_ms)
                VALUES (?,?,?,?,?,?,1000,'JPY','fixture@example.invalid','quota fixture',1,'COMPLETED',?,1,?,?,?,?)`,
            [attemptId, owner.userId, scope.environment, scope.merchantId, 'QUOTA-FIXTURE-LOCATION', 'QUOTA-FIXTURE-APP', `PAYMENT-${attemptId}`, now + 60000, now, now, now]);
            await db.withDatabaseTransaction(query => grants.applyVerifiedDonationGrant(query, attemptId, { now, scope }));
            await db.queryDatabase('INSERT INTO automation_square_donation_policy (environment,merchant_id,enabled,currency,updated_at_ms,actor_user_id) VALUES (?,?,0,\'JPY\',1,?)', [scope.environment, scope.merchantId, ADMIN.userId]);
            await db.queryDatabase('INSERT INTO automation_square_donation_units_policy (environment,merchant_id,unit_amount,slots_per_unit,policy_updated_at_ms) VALUES (?,?,100,1,1)', [scope.environment, scope.merchantId]);
            await db.queryDatabase('INSERT INTO automation_square_donation_unit_grants (owner_user_id,environment,merchant_id,purchase_units,extra_slots,payment_count,policy_updated_at_ms,updated_at_ms) VALUES (?,?,?,10,10,1,1,?)', [owner.userId, scope.environment, scope.merchantId, now]);
            const financial = await getSquareDonationGrant(db.queryDatabase, owner.userId, now, scope);
            assert.equal(financial.purchaseUnits, 10); assert.equal(financial.extraSlots, 10);
            const holding = await grants.getSupporterHolding(db.queryDatabase, owner.userId, now, scope);
            assert.equal(holding.totalSupporterSlots, 2); assert.equal(holding.legacySquareSlots, 0);
            const ordinary = await entitlements.inspectPlan(db.queryDatabase, owner.userId, now), xPlan = await entitlements.inspectXPlan(db.queryDatabase, owner.userId, now);
            assert.equal(ordinary.slotLimit, ordinary.baseSlotLimit + 2); assert.equal(xPlan.slotLimit, xPlan.baseSlotLimit + 2);
            assert.equal(ordinary.slotLimit, xPlan.slotLimit);
            await nativeStores(db, async native => {
                await quota.register(owner, account(157));
                for (let index = 0; index < 6; index++) await native.price(owner, 8100 + index);
                const summary = await quota.summary(owner);
                assert.equal(summary.personal.totalLimit, 7); assert.equal(summary.personal.used, 7); assert.equal(summary.personal.available, 0);
                await assert.rejects(native.price(owner, 8106), { code: 'AUTOMATION_SLOT_LIMIT' });
                await assert.rejects(quota.register(owner, account(158)), { code: 'X_MONITOR_PERSONAL_LIMIT' });
            });
        } finally { billing.getSquareScope = originalScope; }
    });
    await scenario(t, 'shared-owner concurrency: one remaining personal slot admits either ordinary price or X, never both', async (db, quota) => {
        await setPools(db);
        await nativeStores(db, async native => {
            const owner = actor(160);
            for (let index = 0; index < 4; index++) await native.price(owner, 1000 + index);
            const outcomes = await Promise.allSettled([native.price(owner, 1004), quota.register(owner, account(160))]);
            assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
            assert.ok(['AUTOMATION_SLOT_LIMIT', 'X_MONITOR_PERSONAL_LIMIT'].includes(outcomes.find(item => item.status === 'rejected').reason.code));
            assert.equal((await entitlements.getEntitlementSummary(db, owner.userId)).usedSlots, 5);
        });
    });
    await scenario(t, 'duplicate registration concurrency: one owner/account consumes one allocation and one stable personal slot', async (db, quota) => {
        await setPools(db);
        const owner = actor(170);
        const outcomes = await Promise.all([quota.register(owner, account(170)), quota.register(owner, account(170))]);
        assert.equal(outcomes[0].id, outcomes[1].id);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_x_monitors'))[0].n), 1);
        assert.equal((await entitlements.getEntitlementSummary(db, owner.userId)).usedSlots, 1);
    });
    await scenario(t, 'supporter99 race: the independent 100-capacity supporter pool cannot be oversubscribed', async (db, quota) => {
        await setPools(db, 0, 100);
        for (let index = 1; index <= 101; index++) await legacySupporter(db, actor(200 + index), 1);
        for (let index = 1; index <= 99; index++) assert.equal((await quota.register(actor(200 + index), account(200 + index))).poolKind, 'supporter');
        const outcomes = await Promise.allSettled([100, 101].map(index => quota.register(actor(200 + index), account(200 + index))));
        assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
        assert.equal(outcomes.find(item => item.status === 'rejected').reason.code, 'X_MONITOR_POOL_FULL');
        assert.equal(Number((await db.queryDatabase("SELECT COUNT(*) n FROM automation_x_monitors WHERE pool_kind='supporter'"))[0].n), 100);
        assert.equal(Number((await db.queryDatabase("SELECT COUNT(*) n FROM automation_x_monitors WHERE pool_kind='free'"))[0].n), 0);
    });
    await scenario(t, 'manual moves may choose an eligible later pool while new registrations still consume free capacity first', async (db, quota) => {
        await setPools(db, 2, 100);
        const owner = actor(350); await legacySupporter(db, owner, 1); await setPaid(db, owner);
        const registered = await quota.register(owner, account(350)); assert.equal(registered.poolKind, 'free');
        const moved = await quota.move(owner, registered.id, { poolKind: 'special', expectedRevision: registered.revision });
        assert.equal(moved.poolKind, 'special'); assert.equal(moved.quality.planId, 'FixtureBasic');
        assert.equal((await quota.summary(owner)).pools.free.available, 2);
        const next = await quota.register(owner, account(351)); assert.equal(next.poolKind, 'free');
        const adminMove = await quota.move(ADMIN, moved.id, { poolKind: 'supporter', expectedRevision: moved.revision });
        assert.equal(adminMove.poolKind, 'supporter');
        assert.equal((await entitlements.getEntitlementSummary(db, owner.userId)).usedSlots, 2);
        assert.equal((await entitlements.getEntitlementSummary(db, ADMIN.userId)).usedSlots, 0);
        const audits = await db.queryDatabase("SELECT actor_user_id,detail_json FROM automation_audit WHERE action='x.quota.move' ORDER BY id");
        assert.equal(audits.length, 2); assert.equal(audits[1].actor_user_id, ADMIN.userId);
        assert.equal(JSON.parse(audits[1].detail_json).manual, true);
    });
    await scenario(t, 'HTTP API never automatically moves registrations after pool edits, releases, plan changes, reads or delivery reevaluation', async (db, quota) => {
        await setPools(db, 0, 100);
        const owner = actor(360); await legacySupporter(db, owner, 1); await setPaid(db, owner);
        const item = await quota.register(owner, account(360)); assert.equal(item.poolKind, 'supporter');
        const services = { db, xQuota: quota, service: createService(db, { rateOptions: { policy: { operations: { write: { minute: 1000, hour: 10000 } } } } }) };
        const prior = await capacity.getPoolPolicy(db.queryDatabase, ADMIN);
        await dispatch(request('PATCH', 'push-capacity', { freePoolLimit: 1, supporterPoolLimit: 100, expectedUpdatedAtMs: prior.updatedAtMs }), ADMIN, services);
        assert.equal((await quota.list(owner)).items[0].poolKind, 'supporter');
        const blocker = await quota.register(actor(361), account(361)); assert.equal(blocker.poolKind, 'free');
        await dispatch(request('DELETE', `x-monitors/${blocker.id}`), actor(361), services);
        await dispatch(request('POST', `entitlements/${owner.userId}`, { planId: null }), ADMIN, services);
        const listed = await dispatch(request('GET', 'x-monitors'), owner, services);
        assert.equal(listed.items[0].poolKind, 'supporter'); assert.equal(listed.items[0].quality.planId, 'free');
        assert.equal((await quota.validateDelivery(owner, item.id)).poolKind, 'supporter');
        assert.equal((await dispatch(request('GET', 'x-monitor-quota'), owner, services)).pools.free.available, 1);
        await assert.rejects(dispatch(request('POST', 'push-capacity/rebalance'), ADMIN, services), { code: 'NOT_FOUND', status: 404 });
        const beforeMove = (await quota.list(owner)).items[0];
        await assert.rejects(dispatch(request('POST', `x-monitors/${item.id}/move`, { poolKind: 'free', expectedRevision: beforeMove.revision }), actor(362), services), { code: 'NOT_FOUND', status: 404 });
        const moved = await dispatch(request('POST', `x-monitors/${item.id}/move`, { poolKind: 'free', expectedRevision: beforeMove.revision }), owner, services);
        assert.equal(moved.poolKind, 'free'); assert.equal(moved.quality.planId, 'free');
    });
    await scenario(t, 'two explicit moves into one remaining supporter capacity cannot double-allocate; the rejected source reservation survives', async (db, quota) => {
        await setPools(db, 0, 100);
        for (let index = 1; index <= 99; index++) {
            const owner = actor(600 + index); await legacySupporter(db, owner, 1);
            await quota.register(owner, account(600 + index));
        }
        await setPools(db, 2, 100);
        const owners = [actor(710), actor(711)], items = [];
        for (let index = 0; index < owners.length; index++) {
            await legacySupporter(db, owners[index], 1);
            items.push(await quota.register(owners[index], account(710 + index)));
        }
        const outcomes = await Promise.allSettled(items.map((item, index) => quota.move(owners[index], item.id, { poolKind: 'supporter', expectedRevision: item.revision })));
        assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
        assert.equal(outcomes.find(item => item.status === 'rejected').reason.code, 'X_MONITOR_DESTINATION_FULL');
        const usage = (await quota.summary(owners[0])).pools;
        assert.equal(usage.supporter.used, 100); assert.equal(usage.free.used, 1);
        for (let index = 0; index < owners.length; index++) {
            const current = (await quota.list(owners[index])).items[0];
            assert.equal(current.id, items[index].id); assert.equal(current.state, 'ready');
            assert.equal(current.poolKind, outcomes[index].status === 'fulfilled' ? 'supporter' : 'free');
            assert.equal((await entitlements.getEntitlementSummary(db, owners[index].userId)).usedSlots, 1);
        }
        assert.deepEqual((await quota.integrity(ADMIN)).issues, []);
    });
    await scenario(t, 'concurrent explicit moves use revision checks and an ineligible destination never frees the original pool', async (db, quota) => {
        await setPools(db);
        const owner = actor(720); await legacySupporter(db, owner, 1); await setPaid(db, owner);
        const item = await quota.register(owner, account(720));
        const outcomes = await Promise.allSettled(['supporter', 'special'].map(poolKind => quota.move(owner, item.id, { poolKind, expectedRevision: item.revision })));
        assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
        assert.equal(outcomes.find(item => item.status === 'rejected').reason.code, 'X_MONITOR_REVISION_CONFLICT');
        const freeOwner = actor(721), free = await quota.register(freeOwner, account(721));
        for (const poolKind of ['supporter', 'special']) await assert.rejects(quota.move(freeOwner, free.id, { poolKind, expectedRevision: free.revision }), { code: 'X_MONITOR_DESTINATION_INELIGIBLE' });
        assert.deepEqual((await quota.list(freeOwner)).items, [free]);
        assert.deepEqual((await quota.integrity(ADMIN)).issues, []);
    });
    await scenario(t, 'legacy interval overrides require a trusted service option; current-plan intervals remain the default', async (db, quota) => {
        await setPools(db);
        const owner = actor(730); await setPaid(db, owner, { intervalMinutes: 15 });
        const item = await quota.register(owner, account(730));
        await db.queryDatabase('UPDATE users SET auto_watch_interval_minutes=120 WHERE user_id=?', [owner.userId]);
        assert.equal((await quota.list(owner)).items[0].quality.intervalMinutes, 15);
        const legacy = createXMonitorQuota(db, { registrationEnabled: true, useLegacyUserInterval: true });
        assert.equal((await legacy.list(owner)).items[0].quality.intervalMinutes, 120);
        await assert.rejects(quota.update(owner, item.id, { expectedRevision: item.revision, useLegacyUserInterval: true }), { status: 422 });
        await setPaid(db, owner, { intervalMinutes: null });
        assert.equal((await quota.list(owner)).items[0].quality.intervalMinutes, null);
        assert.equal((await legacy.list(owner)).items[0].quality.intervalMinutes, 120);
    });
    await scenario(t, 'zero pools and personal limit report different reasons and do not reserve failed registrations', async (db, quota) => {
        await setPools(db, 0, 0);
        const noPool = actor(400);
        await assert.rejects(quota.register(noPool, account(400)), { code: 'X_MONITOR_POOL_FULL' });
        const poolSummary = await quota.summary(noPool);
        assert.equal(poolSummary.personal.used, 0); assert.equal(poolSummary.x.available, 0);
        assert.equal(poolSummary.x.reasonCode, 'X_MONITOR_POOL_FULL'); assert.ok(poolSummary.x.reason.length > 0);
        await setPools(db, 50, 100);
        const owner = actor(401);
        for (let index = 0; index < 5; index++) await quota.register(owner, account(401 + index));
        const full = await quota.summary(owner);
        assert.equal(full.personal.available, 0); assert.equal(full.x.available, 0);
        assert.equal(full.x.reasonCode, 'X_MONITOR_PERSONAL_LIMIT'); assert.notEqual(full.x.reason, poolSummary.x.reason);
        await assert.rejects(quota.register(owner, account(406)), { code: 'X_MONITOR_PERSONAL_LIMIT' });
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_x_monitors'))[0].n), 5);
    });
    await scenario(t, 'IDOR and server validation: owner-bound list/update/delete and administrator statistics fail closed', async (db, quota) => {
        await setPools(db);
        const owner = actor(410), other = actor(411), item = await quota.register(owner, account(410));
        assert.deepEqual((await quota.list(other)).items, []);
        await assert.rejects(quota.update(other, item.id, { expectedRevision: item.revision, name: 'stolen' }), { code: 'NOT_FOUND', status: 404 });
        await assert.rejects(quota.release(other, item.id), { code: 'NOT_FOUND', status: 404 });
        for (const untrusted of [other, { ...other, isAdmin: 'true' }]) {
            await assert.rejects(quota.move(untrusted, item.id, { poolKind: 'free', expectedRevision: item.revision }), { code: 'NOT_FOUND' });
            await assert.rejects(quota.integrity(untrusted), { code: 'AUTOMATION_FORBIDDEN' });
            await assert.rejects(quota.adminSummary(untrusted), { code: 'AUTOMATION_FORBIDDEN' });
        }
        await assert.rejects(quota.register(undefined, account(411)), { code: 'AUTH_REQUIRED' });
        await assert.rejects(quota.register(owner, { ...account(411), poolKind: 'special', ownerUserId: other.userId, slotLimit: 999 }), { status: 422 });
        await assert.rejects(quota.register(owner, { ...account(411), accountId: '1;DROP TABLE users' }), { status: 422 });
        const unchanged = (await quota.list(owner)).items[0]; assert.equal(unchanged.name, item.name); assert.equal(unchanged.poolKind, 'free');
    });
    await scenario(t, 'CAS concurrency: a stale owner edit cannot overwrite settings or erase subscription state', async (db, quota) => {
        await setPools(db);
        const owner = actor(420), config = await notificationSettings(db, owner), item = await quota.register(owner, { ...account(420), notificationSettings: config });
        const outcomes = await Promise.allSettled(['first', 'second'].map(name => quota.update(owner, item.id, { expectedRevision: item.revision, name })));
        assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
        assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.code, 'X_MONITOR_REVISION_CONFLICT');
        const current = (await quota.list(owner)).items[0]; assert.equal(current.revision, item.revision + 1);
        assert.deepEqual(current.notificationSettings, item.notificationSettings); assert.equal(current.subscriptionState, item.subscriptionState);
    });
    await scenario(t, 'database failure after monitor insertion rolls back the allocation, personal slot and audit together', async (db, quota) => {
        await setPools(db);
        const failing = failAfterWrite(db, /INSERT\s+INTO\s+automation_x_monitors/i);
        await assert.rejects(createXMonitorQuota(failing, { registrationEnabled: true }).register(actor(430), account(430)), { code: 'ER_SIGNAL_EXCEPTION' });
        assert.equal(failing.triggered, true);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_x_monitors'))[0].n), 0);
        assert.equal((await entitlements.getEntitlementSummary(db, actor(430).userId)).usedSlots, 0);
        assert.deepEqual((await quota.integrity(ADMIN)).issues, []);
        const retry = await quota.register(actor(430), account(430)); assert.equal(retry.poolKind, 'free');
    });
    await scenario(t, 'database failure after update rolls back the whole metadata change, revision and original allocation', async (db, quota) => {
        await setPools(db);
        const owner = actor(440), config = await notificationSettings(db, owner), replacement = await notificationSettings(db, owner, '変更先'), before = await quota.register(owner, { ...account(440), notificationSettings: config });
        const failing = failAfterWrite(db, /UPDATE\s+automation_x_monitors\s+SET/i);
        await assert.rejects(createXMonitorQuota(failing, { registrationEnabled: true }).update(owner, before.id, { expectedRevision: before.revision, name: 'changed', notificationSettings: replacement }), { code: 'ER_SIGNAL_EXCEPTION' });
        assert.equal(failing.triggered, true);
        const after = (await quota.list(owner)).items[0]; assert.deepEqual(after, before);
        assert.equal((await entitlements.getEntitlementSummary(db, owner.userId)).usedSlots, 1);
    });
    await scenario(t, 'database failure after delete retains the monitor, correct pool and its personal slot', async (db, quota) => {
        await setPools(db, 0, 100);
        const owner = actor(450); await legacySupporter(db, owner, 1);
        const item = await quota.register(owner, account(450));
        const failing = failAfterWrite(db, /(?:DELETE\s+FROM\s+automation_x_monitors|UPDATE\s+automation_x_monitors\s+SET)/i);
        await assert.rejects(createXMonitorQuota(failing, { registrationEnabled: true }).release(owner, item.id), { code: 'ER_SIGNAL_EXCEPTION' });
        assert.equal(failing.triggered, true);
        assert.deepEqual((await quota.list(owner)).items, [item]);
        assert.equal((await entitlements.getEntitlementSummary(db, owner.userId)).usedSlots, 1);
        assert.deepEqual((await quota.integrity(ADMIN)).issues, []);
    });
    await scenario(t, 'configuration cannot shrink occupied global capacity and must preserve all existing registrations', async (db, quota) => {
        await setPools(db, 2, 100);
        await quota.register(actor(460), account(460)); await quota.register(actor(461), account(461));
        const prior = await capacity.getPoolPolicy(db.queryDatabase, ADMIN);
        await assert.rejects(setPools(db, 1, 100), { code: 'AUTOMATION_PUSH_CAPACITY_IN_USE' });
        assert.deepEqual(await capacity.getPoolPolicy(db.queryDatabase, ADMIN), prior);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_x_monitors'))[0].n), 2);
        assert.deepEqual((await quota.integrity(ADMIN)).issues, []);
    });
    await scenario(t, 'an administrator shrinking capacity concurrently with registration cannot publish an overcommitted pool', async (db, quota) => {
        await setPools(db, 1, 100);
        const registerGate = gateAfterQuery(db, /SELECT[\s\S]*FROM\s+automation_push_pool_policy[\s\S]*FOR UPDATE/i);
        const adminGate = gateAfterQuery(db, /SELECT\s+\*\s+FROM\s+automation_push_pool_policy/i);
        const admitted = createXMonitorQuota(registerGate.db, { registrationEnabled: true }).register(actor(465), account(465));
        const admissionOutcome = Promise.allSettled([admitted]);
        let editOutcome;
        try {
            await gateReached(registerGate);
            // The administrator reads the prior policy while the registration
            // transaction holds the real singleton lock but has not inserted.
            editOutcome = Promise.allSettled([setPools(adminGate.db, 0, 100)]);
            await gateReached(adminGate);
            adminGate.release(); registerGate.release();
        } finally { adminGate.release(); registerGate.release(); }
        const [registration] = await admissionOutcome, [edit] = await editOutcome;
        assert.equal(registration.status, 'fulfilled');
        assert.equal(edit.status, 'rejected'); assert.equal(edit.reason.code, 'AUTOMATION_PUSH_CAPACITY_IN_USE');
        const policy = await capacity.getPoolPolicy(db.queryDatabase, ADMIN);
        const used = Number((await db.queryDatabase("SELECT COUNT(*) n FROM automation_x_monitors WHERE pool_kind='free'"))[0].n);
        assert.ok(used <= policy.freePoolLimit);
        assert.deepEqual((await quota.integrity(ADMIN)).issues, []);
    });
    await scenario(t, 'a failed explicit pool move rolls back destination/source occupancy and preserves all notification metadata', async (db, quota) => {
        await setPools(db, 0, 100);
        const owner = actor(480); await legacySupporter(db, owner, 2);
        await quota.register(owner, { ...account(480), notificationSettings: await notificationSettings(db, owner, '設定A') });
        await quota.register(owner, { ...account(481), notificationSettings: await notificationSettings(db, owner, '設定B') });
        await setPools(db, 2, 100);
        const before = await db.queryDatabase('SELECT * FROM automation_x_monitors ORDER BY id');
        const failing = failAfterWrite(db, /UPDATE\s+automation_x_monitors\s+SET/i);
        await assert.rejects(createXMonitorQuota(failing, { registrationEnabled: true }).move(owner, String(before[0].id), { poolKind: 'free', expectedRevision: Number(before[0].revision) }), { code: 'ER_SIGNAL_EXCEPTION' });
        assert.equal(failing.triggered, true);
        assert.deepEqual(await db.queryDatabase('SELECT * FROM automation_x_monitors ORDER BY id'), before);
        for (const row of before) await quota.move(owner, String(row.id), { poolKind: 'free', expectedRevision: Number(row.revision) });
        const after = await db.queryDatabase('SELECT * FROM automation_x_monitors ORDER BY id');
        assert.ok(after.every(row => row.pool_kind === 'free'));
        for (let index = 0; index < after.length; index++) {
            for (const field of ['id', 'owner_user_id', 'account_id', 'account_handle', 'name', 'enabled', 'notification_settings_json', 'subscription_state']) assert.equal(after[index][field], before[index][field]);
        }
    });
    await scenario(t, 'quota database read failure never admits an unverified allocation or changes the existing registration', async (db, quota) => {
        await setPools(db);
        const owner = actor(490), item = await quota.register(owner, account(490));
        const before = await db.queryDatabase('SELECT * FROM automation_x_monitors ORDER BY id');
        const failing = failAfterWrite(db, /SELECT[\s\S]*FROM\s+automation_x_monitors/i);
        await assert.rejects(createXMonitorQuota(failing, { registrationEnabled: true }).register(owner, account(491)), { code: 'ER_SIGNAL_EXCEPTION' });
        assert.equal(failing.triggered, true);
        assert.deepEqual(await db.queryDatabase('SELECT * FROM automation_x_monitors ORDER BY id'), before);
        assert.equal((await quota.list(owner)).items[0].id, item.id);
        assert.equal((await entitlements.getEntitlementSummary(db, owner.userId)).usedSlots, 1);
    });
    await scenario(t, 'audit failure prevents an unlogged allocation and integrity reports manually orphaned personal-slot mappings', async (db, quota) => {
        await setPools(db);
        const owner = actor(500), beforeAudit = await db.queryDatabase('SELECT COUNT(*) n FROM automation_audit');
        const failing = failAfterWrite(db, /INSERT\s+INTO\s+automation_audit/i);
        await assert.rejects(createXMonitorQuota(failing, { registrationEnabled: true }).register(owner, account(500)), { code: 'ER_SIGNAL_EXCEPTION' });
        assert.equal(failing.triggered, true);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_audit'))[0].n), Number(beforeAudit[0].n));
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_x_monitors'))[0].n), 0);
        const item = await quota.register(owner, account(500));
        assert.deepEqual((await quota.integrity(ADMIN)).issues, []);
        await db.queryDatabase("UPDATE automation_notification_slots SET target_kind=NULL,target_id=NULL WHERE target_kind='x' AND target_id=?", [item.id]);
        const broken = await quota.integrity(ADMIN);
        assert.ok(broken.issues.length > 0, 'orphaned X registration must be visible to the integrity checker');
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_x_monitors'))[0].n), 1);
    });
    await scenario(t, 'integrity detects a live monitor without allocation and stale supporter eligibility without deleting either record', async (db, quota) => {
        await setPools(db, 0, 100);
        const owner = actor(510); await legacySupporter(db, owner, 1);
        const item = await quota.register(owner, account(510));
        await db.queryDatabase('UPDATE automation_x_monitors SET pool_kind=NULL WHERE id=?', [item.id]);
        assert.ok((await quota.integrity(ADMIN)).issues.length > 0, 'ready monitor without an allocated pool must be detected');
        await db.queryDatabase("UPDATE automation_x_monitors SET pool_kind='supporter' WHERE id=?", [item.id]);
        await db.queryDatabase('UPDATE users SET is_donor=0,additional_auto_extract_slots=0 WHERE user_id=?', [owner.userId]);
        assert.ok((await quota.integrity(ADMIN)).issues.length > 0, 'supporter allocations in excess of current verified holdings must be detected');
        assert.equal(Number((await db.queryDatabase("SELECT COUNT(*) n FROM automation_x_monitors WHERE state<>'deleted'"))[0].n), 1);
    });
    await scenario(t, 'registration gating cannot be enabled by a client body or pool-capacity edits', async (db) => {
        await setPools(db, 50, 100);
        const dormant = createXMonitorQuota(db);
        assert.equal((await dormant.summary(actor(470))).featureEnabled, false);
        await assert.rejects(dormant.register(actor(470), account(470)), { code: 'X_MONITOR_UNAVAILABLE' });
        await assert.rejects(dormant.register(actor(470), { ...account(470), registrationEnabled: true }), { code: 'X_MONITOR_UNAVAILABLE' });
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_x_monitors'))[0].n), 0);
    });
});

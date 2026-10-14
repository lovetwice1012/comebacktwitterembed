'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createDonorAdmin } = require('../../src/automation/donor-admin');
const { createService } = require('../../src/automation/service');
const { dispatch } = require('../../src/automation/api');
const entitlements = require('../../src/automation/entitlements');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const ADMIN = { userId: '444444444444444444', isAdmin: true }, owner = i => String(222222222222222000n + BigInt(i));
const ENV = { SQUARE_ENVIRONMENT: 'sandbox', SQUARE_ACCESS_TOKEN: 'fixture-private', SQUARE_APPLICATION_ID: 'fixture-app', SQUARE_LOCATION_ID: 'LOCATION', SQUARE_MERCHANT_ID: 'MERCHANT', SQUARE_WEBHOOK_SIGNATURE_KEY: 'fixture-private', SQUARE_WEBHOOK_NOTIFICATION_URL: 'https://fixture.example/api/automation/square/webhook' };
const edit = (detail, changes = {}) => ({ isDonor: detail.manual.isDonor, extraSlots: detail.manual.extraSlots, paymentCount: detail.manual.paymentCount, purchaseUnits: detail.manual.purchaseUnits, displayName: detail.manual.displayName, note: detail.manual.note, reason: 'Fixture administrative correction', expectedUpdatedAtMs: detail.version.updatedAtMs, expectedLegacyIsDonor: detail.version.legacyIsDonor, expectedLegacyExtraSlots: detail.version.legacyExtraSlots, ...changes });
const packetJson = value => JSON.parse(JSON.stringify(value));

test('donor administration rejects non-administrators, invalid manual fields and provider mutations before database I/O', async () => {
    let queries = 0;
    const service = createDonorAdmin({ queryDatabase: async () => { queries++; throw new Error('No database request expected'); }, withDatabaseTransaction: async () => { queries++; throw new Error('No transaction expected'); } }, { env: {} });
    for (const method of ['list', 'get', 'history', 'audit']) await assert.rejects(service[method]({ userId: owner(1), isAdmin: false }, owner(2)), { code: 'AUTOMATION_FORBIDDEN', status: 403 });
    await assert.rejects(service.save({ userId: owner(1), isAdmin: false }, owner(2), {}), { code: 'AUTOMATION_FORBIDDEN' });
    await assert.rejects(service.get(ADMIN, "1' OR 1=1"), { code: 'DONOR_INVALID_USER' });
    const input = { isDonor: false, extraSlots: 0, paymentCount: 0, purchaseUnits: 0, displayName: '', note: '', reason: 'Reason', expectedUpdatedAtMs: null, expectedLegacyIsDonor: 0, expectedLegacyExtraSlots: 0 };
    for (const change of [{ extraSlots: -1 }, { extraSlots: 10001 }, { paymentCount: 1.5 }, { purchaseUnits: 1000001 }, { reason: '  ' }, { note: 'x'.repeat(2001) }, { displayName: 'x'.repeat(121) }, { expectedUpdatedAtMs: undefined }, { refundedAmount: 1 }, { square: { active: true } }, { isDonor: 1 }]) await assert.rejects(service.save(ADMIN, owner(1), { ...input, ...change }), { code: 'DONOR_INVALID_INPUT' });
    for (const pageSize of [0, 51, 1.5, '1 OR 1=1']) await assert.rejects(service.list(ADMIN, { pageSize }), { code: 'DONOR_INVALID_INPUT' });
    assert.equal(queries, 0);
});

test('real SQL donor manual management preserves automatic donations and legacy Bot behavior with read-only admin inspection', { skip: !port, timeout: 120000 }, async t => {
    const db = await createTestDatabase(port); let clock = Date.parse('2026-10-14T00:00:00Z');
    const make = (options = {}) => createDonorAdmin(db, { env: ENV, clock: () => clock, ...options }), service = make();
    const readDb = { ...db, queryDatabase: async (sql, params) => { assert.match(sql.trim(), /^SELECT\b/); return db.queryDatabase(sql, params); }, withDatabaseTransaction: async () => { throw new Error('GET must not start a write transaction'); } };
    const read = () => createDonorAdmin(readDb, { env: ENV, clock: () => clock });
    const seed = async (id, flag = 0, slots = 0) => db.queryDatabase('INSERT INTO users(user_id,registered_at_ms,is_donor,additional_auto_extract_slots) VALUES (?,0,?,?)', [id, flag, slots]);
    const payment = async (id, options = {}) => {
        const data = { environment: 'sandbox', merchant: 'MERCHANT', amount: 1000, currency: 'JPY', refunded: 0, verified: 1, state: 'COMPLETED', at: clock, ...options };
        const attempt = randomUUID();
        await db.queryDatabase(`INSERT INTO automation_square_donation_attempts(id,owner_user_id,environment,merchant_id,location_id,application_id,amount,currency,email,name,policy_updated_at_ms,state,source_digest,payment_id,refunded_amount,verified,expires_at_ms,completed_at_ms,created_at_ms,updated_at_ms)
            VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?)`, [attempt, id, data.environment, data.merchant, 'LOCATION', 'APP', data.amount, data.currency, 'private@example.com', 'Private buyer', data.state, 'a'.repeat(64), 'PAYMENT-' + attempt, data.refunded, data.verified, clock + 1000, data.at, data.at, clock]);
        return attempt;
    };
    try {
        await t.test('unknown-user GET is read-only and an audited manual edit creates a legacy-compatible permanent donor', async () => {
            const initial = await read().get(ADMIN, owner(1)); assert.equal(initial.exists, false); assert.equal(initial.version.updatedAtMs, null);
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM users WHERE user_id=?', [owner(1)]))[0].n), 0);
            const saved = await service.save(ADMIN, owner(1), edit(initial, { isDonor: true, extraSlots: 4, paymentCount: 2, purchaseUnits: 3, displayName: 'Fixture donor', note: 'Manual legacy records\nNo financial conversion' }));
            assert.equal(saved.exists, true); assert.equal(saved.entitlement.tier, 'supporter'); assert.equal(saved.entitlement.slotLimit, 9);
            const legacy = (await db.queryDatabase('SELECT is_donor,additional_auto_extract_slots FROM users WHERE user_id=?', [owner(1)]))[0]; assert.equal(Number(legacy.is_donor), 1); assert.equal(Number(legacy.additional_auto_extract_slots), 4);
            assert.equal((await entitlements.inspectPlan(db.queryDatabase, owner(1))).slotLimit, 9);
            const history = await read().audit(ADMIN, owner(1)); assert.equal(history.items.length, 1); assert.equal(history.items[0].before.updatedAtMs, null); assert.equal(history.items[0].after.purchaseUnits, 3); assert.equal(history.items[0].actorUserId, ADMIN.userId);
            await assert.rejects(service.save(ADMIN, owner(1), edit(initial, { isDonor: true, extraSlots: 4, paymentCount: 2, purchaseUnits: 3 })), { code: 'DONOR_EDIT_CONFLICT' });
            assert.equal((await read().audit(ADMIN, owner(1))).items.length, 1, 'lost ACK replay cannot duplicate counts or audit');
        });
        await t.test('simultaneous admins and old Discord field updates cannot overwrite unseen changes', async () => {
            const original = await service.get(ADMIN, owner(1));
            const outcomes = await Promise.allSettled([service.save(ADMIN, owner(1), edit(original, { extraSlots: 5 })), make().save({ ...ADMIN, userId: '555555555555555555' }, owner(1), edit(original, { extraSlots: 6 }))]);
            assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1); assert.equal(outcomes.find(item => item.status === 'rejected').reason.code, 'DONOR_EDIT_CONFLICT');
            const beforeLegacy = await service.get(ADMIN, owner(1));
            await db.queryDatabase('UPDATE users SET is_donor=0,additional_auto_extract_slots=7 WHERE user_id=?', [owner(1)]);
            await assert.rejects(service.save(ADMIN, owner(1), edit(beforeLegacy, { note: 'Stale legacy snapshot' })), { code: 'DONOR_EDIT_CONFLICT' });
            const fresh = await service.get(ADMIN, owner(1)); assert.equal(fresh.manual.isDonor, false); assert.equal(fresh.manual.extraSlots, 7);
            const rewritten = await service.save(ADMIN, owner(1), edit(fresh, { isDonor: true })); assert.ok(rewritten.version.updatedAtMs > fresh.version.updatedAtMs, 'same clock produces monotonic metadata revisions');
            await seed(owner(2), 2, -9); const odd = await service.get(ADMIN, owner(2)); assert.equal(odd.version.legacyIsDonor, 2); assert.equal(odd.version.legacyExtraSlots, -9); assert.equal(odd.entitlement.slotLimit, 5);
            await db.queryDatabase('UPDATE users SET is_donor=0 WHERE user_id=?', [owner(2)]);
            await assert.rejects(service.save(ADMIN, owner(2), edit(odd, { extraSlots: 0 })), { code: 'DONOR_EDIT_CONFLICT' });
        });
        await t.test('audit persistence failure rolls legacy fields, metadata and new owner creation back atomically', async () => {
            const broken = createDonorAdmin({ ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => { if (sql.startsWith('INSERT INTO automation_donor_audit')) throw new Error('Fixture audit storage fault'); return query(sql, params); })) }, { env: ENV, clock: () => clock });
            const before = await service.get(ADMIN, owner(1));
            await assert.rejects(broken.save(ADMIN, owner(1), edit(before, { extraSlots: 1, paymentCount: 900 })), /Fixture audit storage fault/);
            assert.deepEqual((await service.get(ADMIN, owner(1))).manual, before.manual);
            const empty = await service.get(ADMIN, owner(3)); await assert.rejects(broken.save(ADMIN, owner(3), edit(empty, { isDonor: true })), /Fixture audit storage fault/);
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM users WHERE user_id=?', [owner(3)]))[0].n), 0);
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_donor_profiles WHERE owner_user_id=?', [owner(3)]))[0].n), 0);
        });
        await t.test('lifetime verified payments remain visible without policy and after expiry; money stays separated by currency', async () => {
            await seed(owner(10));
            await payment(owner(10), { amount: 500, at: clock - 31 * 86400000 });
            await payment(owner(10), { amount: 1000, refunded: 100 });
            await payment(owner(10), { amount: 700, refunded: 700 });
            await payment(owner(10), { amount: 50, currency: 'USD' });
            await payment(owner(10), { amount: 200, verified: 0 });
            await payment(owner(10), { amount: 80000, environment: 'production' });
            await payment(owner(10), { amount: 90000, merchant: 'OTHER' });
            const noPolicy = await read().get(ADMIN, owner(10)); assert.equal(noPolicy.square.paymentCount, 3); assert.equal(noPolicy.square.grant.paymentCount, 0); assert.equal(noPolicy.square.active, false);
            assert.deepEqual(noPolicy.square.totalsByCurrency, [{ currency: 'JPY', amount: 2200, refundedAmount: 800, netAmount: 1400, paymentCount: 2 }, { currency: 'USD', amount: 50, refundedAmount: 0, netAmount: 50, paymentCount: 1 }]);
            assert.equal(noPolicy.square.history.length, 4);
            const forbidden = JSON.stringify(noPolicy); for (const secret of ['private@example.com', 'Private buyer', 'source_digest', 'payment_id', 'a'.repeat(64)]) assert.ok(!forbidden.includes(secret));
            await db.queryDatabase('INSERT INTO automation_square_donation_policy(environment,merchant_id,enabled,currency,supporter_threshold,validity_days,updated_at_ms,actor_user_id) VALUES (?,?,1,?,700,30,?,?)', ['sandbox', 'MERCHANT', 'JPY', clock, ADMIN.userId]);
            await db.queryDatabase('INSERT INTO automation_square_donation_units_policy(environment,merchant_id,unit_amount,slots_per_unit,policy_updated_at_ms) VALUES (?,?,300,2,?)', ['sandbox', 'MERCHANT', clock]);
            // Existing grants are authoritative counts. The permanent scheme
            // preserves this old recorded allocation without deriving it from
            // payment amounts or the current rolling policy.
            await db.queryDatabase(`INSERT INTO automation_square_donation_unit_grants
                (owner_user_id,environment,merchant_id,purchase_units,extra_slots,payment_count,units_valid_until_at_ms,policy_updated_at_ms,updated_at_ms)
                VALUES (?,?,?,3,6,1,?,?,?)`, [owner(10), 'sandbox', 'MERCHANT', clock + 30 * 86400000, clock, clock]);
            const grants = await read().get(ADMIN, owner(10)); assert.equal(grants.square.active, true); assert.equal(grants.square.grant.paymentCount, 1); assert.equal(grants.square.grant.purchaseUnits, 3); assert.equal(grants.square.grant.extraSlots, 6);
            const before = packetJson(await db.queryDatabase('SELECT * FROM automation_square_donation_attempts WHERE owner_user_id=? ORDER BY id', [owner(10)]));
            const saved = await service.save(ADMIN, owner(10), edit(grants, { isDonor: false, extraSlots: 3, paymentCount: 7, purchaseUnits: 99, displayName: 'Square and manual' }));
            assert.equal(saved.totals.paymentCount, 10); assert.equal(saved.manual.purchaseUnits, 99); assert.equal(saved.square.grant.purchaseUnits, 3); assert.equal(saved.entitlement.slotLimit, 14); assert.equal(saved.entitlement.tier, 'supporter');
            assert.deepEqual(packetJson(await db.queryDatabase('SELECT * FROM automation_square_donation_attempts WHERE owner_user_id=? ORDER BY id', [owner(10)])), before);
            const list = await read().list(ADMIN); assert.equal(list.items.find(item => item.userId === owner(10)).square.active, true);
            clock += 31 * 86400000;
            const expired = await read().get(ADMIN, owner(10)); assert.equal(expired.square.active, false); assert.equal(expired.square.paymentCount, 3); assert.equal(expired.totals.paymentCount, 10); assert.equal(expired.entitlement.tier, 'free'); assert.equal(expired.entitlement.slotLimit, 14);
            assert.equal((await read().list(ADMIN)).items.find(item => item.userId === owner(10)).square.active, false);
            const anotherScope = make({ env: { ...ENV, SQUARE_ENVIRONMENT: 'production' } }); assert.equal((await anotherScope.get(ADMIN, owner(10))).square.paymentCount, 1);
        });
        await t.test('paid plan capacity remains additive and lowering extras preserves native registrations, boosts and counters', async () => {
            await seed(owner(20), 1, 6);
            await entitlements.savePlanPolicy(db.queryDatabase, ADMIN, { planId: 'paid', label: 'Paid fixture', slotLimit: 3, minuteLimit: 5, dayLimit: 24, priority: 5 });
            await db.withDatabaseTransaction(query => entitlements.setUserPlan(query, ADMIN, owner(20), 'paid'));
            const source = await db.queryDatabase("INSERT INTO auto_watch_sources(provider_id,source_key,source_url,poll_interval_ms,created_at_ms) VALUES ('github','fixture','https://github.com/fixture',3600000,?)", [clock]);
            const target = await db.queryDatabase("INSERT INTO auto_watch_targets(user_id,source_id,destination_type,destination_key,premium_slot,enabled,created_at_ms) VALUES (?,?,'dm',?,0,0,?)", [owner(20), source.insertId, owner(20), clock]);
            for (let index = 1; index <= 3; index++) await db.queryDatabase("INSERT INTO automation_notification_boost_slots(owner_user_id,slot_index,target_kind,target_id) VALUES (?,?,'auto',?)", [owner(20), index + 1, target.insertId]);
            await db.queryDatabase("INSERT INTO automation_notification_boost_slots(owner_user_id,slot_index,target_kind,target_id) VALUES (?,9,'auto',999999)", [owner(20)]);
            await db.queryDatabase("INSERT INTO automation_counters(counter_key,used_count,expires_at_ms) VALUES (?,8,?)", ['b'.repeat(64), clock + 1000]);
            const before = await read().get(ADMIN, owner(20)); assert.equal(before.entitlement.tier, 'paid'); assert.equal(before.entitlement.slotLimit, 9); assert.equal(before.entitlement.usedSlots, 4);
            const saved = await service.save(ADMIN, owner(20), edit(before, { isDonor: false, extraSlots: 0 })); assert.equal(saved.entitlement.slotLimit, 3); assert.equal(saved.entitlement.usedSlots, 4); assert.equal(saved.entitlement.overLimit, true);
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM auto_watch_targets WHERE user_id=?', [owner(20)]))[0].n), 1);
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_notification_boost_slots WHERE owner_user_id=?', [owner(20)]))[0].n), 4);
            assert.equal(Number((await db.queryDatabase('SELECT used_count FROM automation_counters WHERE counter_key=?', ['b'.repeat(64)]))[0].used_count), 8);
        });
        await t.test('list uses stable keyset pagination and literal prefix-name/exact-ID search with bounded pages', async () => {
            for (let i = 30; i < 36; i++) {
                const initial = await service.get(ADMIN, owner(i)); await service.save(ADMIN, owner(i), edit(initial, { displayName: i === 30 ? 'Rate%_donor' : 'Rate usual ' + i }));
            }
            const ids = [], cursors = []; let cursor;
            do { const page = await read().list(ADMIN, { pageSize: 2, cursor }); assert.ok(page.items.length <= 2); ids.push(...page.items.map(item => item.userId)); cursors.push(page.nextCursor); cursor = page.nextCursor; } while (cursor);
            assert.equal(new Set(ids).size, ids.length); assert.deepEqual(ids, [...ids].sort());
            assert.equal((await read().list(ADMIN, { search: 'Rate%_' })).items.length, 1);
            assert.equal((await read().list(ADMIN, { search: owner(30) })).items[0].userId, owner(30));
            assert.equal((await read().list(ADMIN, { search: "' OR 1=1 --" })).total, 0);
            await assert.rejects(read().list(ADMIN, { search: 'Rate', cursor: cursors[0] }), { code: 'DONOR_INVALID_CURSOR' });
            assert.ok(ids.includes(owner(10)), 'verified historical Square donor remains listed after eligibility expiry');
            const scopeOnly = owner(99); await seed(scopeOnly); await payment(scopeOnly, { environment: 'production' }); assert.ok(!(await read().list(ADMIN)).items.some(item => item.userId === scopeOnly));
        });
        await t.test('history and this-screen audit pages keep tied timestamps stable and are scoped to exact owner', async () => {
            for (let i = 0; i < 23; i++) await payment(owner(10), { at: clock });
            const first = await read().history(ADMIN, owner(10), { pageSize: 10 }); assert.equal(first.items.length, 10);
            const second = await read().history(ADMIN, owner(10), { pageSize: 50, cursor: first.nextCursor }); assert.equal(new Set([...first.items, ...second.items].map(item => item.attemptId)).size, 27);
            await assert.rejects(read().history(ADMIN, owner(1), { cursor: first.nextCursor }), { code: 'DONOR_INVALID_CURSOR' });
            const initial = await service.get(ADMIN, owner(30)); let current = initial;
            for (let i = 0; i < 3; i++) current = await service.save(ADMIN, owner(30), edit(current, { note: 'Audit update ' + i }));
            const a = await read().audit(ADMIN, owner(30), { pageSize: 2 }), b = await read().audit(ADMIN, owner(30), { pageSize: 2, cursor: a.nextCursor });
            assert.equal(new Set([...a.items, ...b.items].map(item => item.id)).size, 4); assert.ok(a.items[0].createdAtMs > a.items[1].createdAtMs);
        });
        await t.test('real dispatcher denies body-forged administrators and shares durable write admission for donor edits', async () => {
            const services = { db, service: createService(db, { rateLimiter: { consumeOperation: async (actor, group) => { assert.equal(group, 'write'); }, getPolicy: () => ({}) } }), donors: service };
            const request = (method, path, body = {}, search = '') => ({ method, path: path.split('/'), body, search: new URLSearchParams(search) });
            await assert.rejects(dispatch(request('GET', 'donors', { isAdmin: true }), { userId: owner(1), isAdmin: false }, services), { code: 'AUTOMATION_FORBIDDEN' });
            await assert.rejects(dispatch(request('PATCH', 'donors/' + owner(1), { isAdmin: true }), { userId: owner(1), isAdmin: false }, services), { code: 'AUTOMATION_FORBIDDEN' });
            const data = await dispatch(request('GET', 'donors/' + owner(35)), ADMIN, services);
            const result = await dispatch(request('PATCH', 'donors/' + owner(35), edit(data, { isDonor: true })), ADMIN, services); assert.equal(result.manual.isDonor, true);
            assert.ok((await dispatch(request('GET', 'donors', {}, 'pageSize=2'), ADMIN, services)).items.length <= 2);
            await assert.rejects(dispatch(request('DELETE', 'donors/' + owner(35)), ADMIN, services), { code: 'NOT_FOUND' });
        });
    } finally { await db.close(); }
});

test('donor allowance inspection combines native and X registrations with attached cadence boosts across an allowance reduction', { skip: !port, timeout: 30000 }, async () => {
    const db = await createTestDatabase(port), user = owner(200), other = owner(201), instant = Date.parse('2026-10-14T00:00:00Z');
    const readDb = { ...db, queryDatabase: async (sql, params) => {
        assert.match(sql.trim(), /^SELECT\b/, 'admin inspection keeps its read-only contract');
        return db.queryDatabase(sql, params);
    }, withDatabaseTransaction: async () => { throw new Error('Inspection must not create a write transaction'); } };
    const read = createDonorAdmin(readDb, { env: {}, clock: () => instant });
    try {
        for (const id of [user, other]) await db.queryDatabase('INSERT INTO users(user_id,registered_at_ms,is_donor,additional_auto_extract_slots) VALUES (?,0,1,2)', [id]);
        const source = await db.queryDatabase("INSERT INTO auto_watch_sources(provider_id,source_key,source_url,poll_interval_ms,created_at_ms) VALUES ('github','donor-shared-usage','https://github.com/fixture',3600000,?)", [instant]);
        const target = await db.queryDatabase("INSERT INTO auto_watch_targets(user_id,source_id,destination_type,destination_key,premium_slot,enabled,created_at_ms) VALUES (?,?,'dm',?,0,0,?)", [user, source.insertId, user, instant]);
        const priceSource = await db.queryDatabase("INSERT INTO price_watch_sources(provider_id,product_key,product_url,source_locale,poll_interval_ms,created_at_ms) VALUES ('steam','donor-shared-usage','https://store.steampowered.com/app/1','ja',3600000,?)", [instant]);
        await db.queryDatabase("INSERT INTO price_watch_targets(source_id,user_id,destination_type,destination_key,watch_mode,rule_key,enabled,created_at_ms) VALUES (?,?,'dm',?,'price','fixture',1,?)", [priceSource.insertId, user, user, instant]);
        for (const index of [2, 3]) await db.queryDatabase("INSERT INTO automation_notification_boost_slots(owner_user_id,slot_index,target_kind,target_id) VALUES (?,?,'auto',?)", [user, index, target.insertId]);
        await db.queryDatabase("INSERT INTO automation_notification_boost_slots(owner_user_id,slot_index,target_kind,target_id) VALUES (?,99,'auto',999999)", [user]);
        await db.queryDatabase("INSERT INTO automation_notification_boost_slots(owner_user_id,slot_index,target_kind,target_id) VALUES (?,2,'auto',?)", [other, target.insertId]);
        for (const [id, account, state, enabled] of [[user, '100', 'ready', 1], [user, '101', 'suspended', 0], [user, '102', 'deleted', 0], [other, '103', 'ready', 1]]) {
            await db.queryDatabase('INSERT INTO automation_x_monitors(owner_user_id,account_id,name,enabled,state,pool_kind,notification_settings_json,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?)', [id, account, 'Preserved monitor ' + account, enabled, state, state === 'deleted' ? null : 'free', JSON.stringify({}), instant, instant]);
        }
        const registrations = packetJson(await db.queryDatabase('SELECT * FROM automation_x_monitors ORDER BY id'));
        const before = await read.get(ADMIN, user);
        assert.equal(before.entitlement.slotLimit, 7);
        assert.equal(before.entitlement.usedSlots, 6, 'auto + price + two attached boosts + ready X + suspended X');
        assert.equal(before.entitlement.remainingSlots, 1);
        assert.equal(before.entitlement.overLimit, false);
        const saved = await createDonorAdmin(db, { env: {}, clock: () => instant }).save(ADMIN, user, edit(before, { extraSlots: 0 }));
        assert.equal(saved.entitlement.slotLimit, 5);
        assert.equal(saved.entitlement.usedSlots, 6);
        assert.equal(saved.entitlement.remainingSlots, 0);
        assert.equal(saved.entitlement.overLimit, true);
        assert.deepEqual(packetJson(await db.queryDatabase('SELECT * FROM automation_x_monitors ORDER BY id')), registrations, 'inspection and manual allowance edits preserve X state, pool and settings');
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM auto_watch_targets WHERE user_id=?', [user]))[0].n), 1);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM price_watch_targets WHERE user_id=?', [user]))[0].n), 1);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_notification_boost_slots WHERE owner_user_id=?', [user]))[0].n), 3, 'an orphan boost is excluded without deletion');
    } finally { await db.close(); }
});

test('donor metadata migration is additive and replay-safe on both legacy and current schemas', { skip: !port, timeout: 30000 }, async () => {
    const db = await createTestDatabase(port);
    const schema = require('../../src/db_schema')._internal;
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../migrations/20261014_add_donor_admin_records.sql'), 'utf8');
    const apply = async () => { for (const sql of schema.splitSqlStatements(source)) if (!await schema.shouldSkipMigrationStatement(db.queryDatabase, sql)) await db.queryDatabase(sql); };
    try {
        await db.queryDatabase('INSERT INTO users(user_id,registered_at_ms,is_donor,additional_auto_extract_slots) VALUES (?,123,1,17)', [owner(100)]);
        const before = packetJson(await db.queryDatabase('SELECT * FROM users WHERE user_id=?', [owner(100)]));
        await db.queryDatabase('DROP TABLE automation_donor_audit'); await db.queryDatabase('DROP TABLE automation_donor_profiles');
        await db.queryDatabase('ALTER TABLE users DROP INDEX idx_users_donor,DROP INDEX idx_users_extra_slots');
        await db.queryDatabase('ALTER TABLE automation_square_donation_attempts DROP INDEX idx_square_donation_donors');
        await apply(); await apply();
        assert.deepEqual(packetJson(await db.queryDatabase('SELECT * FROM users WHERE user_id=?', [owner(100)])), before);
        assert.equal((await db.queryDatabase("SHOW INDEX FROM users WHERE Key_name='idx_users_donor'")).length, 2);
        assert.equal((await db.queryDatabase("SHOW INDEX FROM automation_square_donation_attempts WHERE Key_name='idx_square_donation_donors'")).length, 5);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_donor_audit'))[0].n), 0);
    } finally { await db.close(); }
});

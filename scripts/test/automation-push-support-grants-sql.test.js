'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHmac } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const grants = require('../../src/automation/push-support-grants');
const { createSquareDonations, getSquareDonationGrant } = require('../../src/automation/square-donations');
const { createSquareBilling } = require('../../src/automation/square-billing');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const ADMIN = { userId: '444444444444444444', isAdmin: true }, OWNER = '222222222222222222', OTHER = '333333333333333333';
const SCOPE = { configured: true, environment: 'sandbox', merchantId: 'FIXTURE-MERCHANT' };
const NOW = Date.parse('2026-10-14T00:00:00Z');
const OPTIONS = { now: NOW, scope: SCOPE };

async function attempt(db, owner, amount = 500, options = {}) {
    const id = randomUUID(), paymentId = options.paymentId || `P-${id}`;
    await db.queryDatabase(`INSERT INTO automation_square_donation_attempts
        (id,owner_user_id,environment,merchant_id,location_id,application_id,amount,currency,email,name,policy_updated_at_ms,state,payment_id,verified,expires_at_ms,completed_at_ms,created_at_ms,updated_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?,0,?,?,?)`, [id, owner, options.environment || SCOPE.environment, options.merchantId || SCOPE.merchantId, 'FIXTURE-LOCATION', 'FIXTURE-APP', amount,
        options.currency || 'JPY', 'fixture@example.invalid', 'Synthetic fixture', options.state || 'COMPLETED', paymentId, options.verified ?? 1,
        options.completedAtMs === null ? null : options.completedAtMs ?? NOW, NOW, NOW]);
    return { id, paymentId };
}
const holding = db => grants.getSupporterHolding(db.queryDatabase, OWNER, NOW, SCOPE);
const migrate = (db, userId = OWNER) => db.withDatabaseTransaction(query => grants.migrateLegacyGrants(query, userId, OPTIONS));
const apply = (db, id, options = OPTIONS) => db.withDatabaseTransaction(query => grants.applyVerifiedDonationGrant(query, id, options));

test('SQL supporter holdings: authoritative legacy counts and new permanent per-payment grants', { skip: !port, timeout: 90000 }, async t => {
    const db = await createTestDatabase(port); t.after(() => db.close());
    await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms,is_donor,additional_auto_extract_slots) VALUES (?,0,1,3),(?,0,0,0)', [OWNER, OTHER]);
    await db.queryDatabase(`INSERT INTO automation_square_donation_unit_grants
        (owner_user_id,environment,merchant_id,purchase_units,extra_slots,payment_count,units_valid_until_at_ms,policy_updated_at_ms,updated_at_ms)
        VALUES (?,?,?,2,2,3,?,1,?)`, [OWNER, SCOPE.environment, SCOPE.merchantId, NOW - 1, NOW]);
    const legacy = [];
    for (const amount of [500, 1500, 2500]) legacy.push(await attempt(db, OWNER, amount));
    await t.test('Q12 reads preserve three old manual purchases plus recorded Square slots without amount rederivation or GET writes', async () => {
        const result = await holding(db);
        assert.equal(result.manualLegacySlots, 3); assert.equal(result.legacySquareSlots, 2);
        assert.equal(result.newPaidSlots, 0); assert.equal(result.totalSupporterSlots, 5); assert.equal(result.isSupporter, true);
        assert.equal(result.migrationRequired, true);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_push_support_owner_snapshots'))[0].n), 0);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_push_support_grants'))[0].n), 0);
    });
    await t.test('migration is explicit and idempotent, freezes existing grant counts and classifies old replay sources', async () => {
        const first = await migrate(db), second = await migrate(db);
        assert.equal(first.createdScopeSnapshot, true); assert.equal(second.createdScopeSnapshot, false);
        assert.equal(first.totalSupporterSlots, 5); assert.equal(first.migrationRequired, false);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_push_support_legacy_attempts'))[0].n), 3);
        for (const row of legacy) assert.deepEqual(await apply(db, row.id), { inserted: false, legacy: true, grant: null });
        assert.equal((await holding(db)).newPaidSlots, 0, '1500/2500 old purchases must not become three/five new slots');
        await db.queryDatabase('UPDATE automation_square_donation_unit_grants SET extra_slots=9999,purchase_units=9999');
        assert.equal((await holding(db)).legacySquareSlots, 2, 'later rolling-policy recalculation does not rewrite the frozen old count');
    });
    await t.test('Q13 each new verified JPY payment grants floor(amount/500); small amounts never combine', async () => {
        for (const amount of [499, 300, 300]) assert.equal((await apply(db, (await attempt(db, OWNER, amount)).id)).grant, null);
        for (const [amount, slots] of [[500, 1], [999, 1], [1000, 2], [1499, 2], [2500, 5]]) {
            const row = await attempt(db, OWNER, amount), result = await apply(db, row.id);
            assert.equal(result.inserted, true); assert.equal(result.grant.slots, slots);
        }
        assert.equal((await holding(db)).newPaidSlots, 11);
        assert.equal((await holding(db)).canonicalSquareSlots, 13);
        assert.equal((await holding(db)).totalSupporterSlots, 16);
        assert.equal(Number((await db.queryDatabase('SELECT additional_auto_extract_slots FROM users WHERE user_id=?', [OWNER]))[0].additional_auto_extract_slots), 3);
    });
    await t.test('Q14 simultaneous replay grants exactly once, with durable idempotency after new helper calls', async () => {
        const row = await attempt(db, OWNER, 1500);
        const outcomes = await Promise.all([apply(db, row.id), apply(db, row.id)]);
        assert.equal(outcomes.filter(result => result.inserted).length, 1);
        assert.equal((await holding(db)).newPaidSlots, 14);
        assert.equal((await apply(db, row.id)).inserted, false);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_push_support_grants WHERE source_id=?', [row.paymentId]))[0].n), 1);
    });
    await t.test('unverified, failed, wrong currency/scope, missing completion and unmigrated rows cannot grant', async () => {
        for (const changes of [{ verified: 0 }, { state: 'FAILED' }, { state: 'PENDING' }, { completedAtMs: null }]) {
            await assert.rejects(apply(db, (await attempt(db, OWNER, 1000, changes)).id), { code: 'AUTOMATION_SUPPORT_PAYMENT_UNVERIFIED', status: 409 });
        }
        assert.equal((await apply(db, (await attempt(db, OWNER, 1000, { currency: 'USD' })).id)).grant, null);
        await assert.rejects(apply(db, (await attempt(db, OWNER, 1000, { environment: 'production' })).id), { code: 'AUTOMATION_SUPPORT_PAYMENT_UNVERIFIED' });
        await assert.rejects(apply(db, (await attempt(db, OTHER, 1000)).id), { code: 'AUTOMATION_SUPPORT_MIGRATION_REQUIRED', status: 409 });
        assert.equal((await holding(db)).newPaidSlots, 14);
    });
    await t.test('Q11 subscription removal, policy expiry and payment pause never remove holdings; scopes remain isolated', async () => {
        const before = await holding(db);
        await db.queryDatabase('DELETE FROM automation_square_subscriptions WHERE owner_user_id=?', [OWNER]);
        const after = await grants.getSupporterHolding(db.queryDatabase, OWNER, NOW + 365 * 86400000, { ...SCOPE, configured: false });
        assert.equal(after.totalSupporterSlots, before.totalSupporterSlots);
        const otherScope = await grants.getSupporterHolding(db.queryDatabase, OWNER, NOW, { configured: true, environment: 'production', merchantId: SCOPE.merchantId });
        assert.equal(otherScope.newPaidSlots, 0); assert.equal(otherScope.legacySquareSlots, 0); assert.equal(otherScope.manualLegacySlots, 3);
    });
    await t.test('refund observation keeps original paid slots and exposes an explicit financial review flag', async () => {
        const row = await attempt(db, OWNER, 1000), first = await apply(db, row.id);
        await db.queryDatabase('UPDATE automation_square_donation_attempts SET refunded_amount=1000 WHERE id=?', [row.id]);
        const refunded = await apply(db, row.id);
        assert.equal(refunded.grant.slots, first.grant.slots); assert.equal(refunded.grant.confirmedRefundedAmount, 1000);
        assert.equal(refunded.grant.financialReviewRequired, true);
        await db.queryDatabase('UPDATE automation_square_donation_attempts SET refunded_amount=0 WHERE id=?', [row.id]);
        assert.equal((await apply(db, row.id)).grant.confirmedRefundedAmount, 1000, 'stale observation cannot roll back confirmed financial history');
    });
    await t.test('historical administrator imports use exact counts, record already-counted evidence, and reject changed idempotency ownership', async () => {
        const input = { userId: OWNER, idempotencyKey: 'historical-product-2500-1', slots: 1, purchasedAtMs: NOW - 1000, reason: 'Verified one historical purchase' };
        const record = () => db.withDatabaseTransaction(query => grants.recordHistoricalSupportGrant(query, ADMIN, input, OPTIONS));
        const first = await record(); assert.equal(first.grant.slots, 1); assert.equal(first.grant.reason, input.reason); assert.equal((await record()).inserted, false);
        await assert.rejects(db.withDatabaseTransaction(query => grants.recordHistoricalSupportGrant(query, ADMIN, { ...input, slots: 5 }, OPTIONS)), { code: 'AUTOMATION_SUPPORT_GRANT_CONFLICT', status: 409 });
        await assert.rejects(db.withDatabaseTransaction(query => grants.recordHistoricalSupportGrant(query, ADMIN, { ...input, userId: OTHER }, OPTIONS)), { code: 'AUTOMATION_SUPPORT_GRANT_CONFLICT', status: 409 });
        const before = (await holding(db)).totalSupporterSlots;
        const evidence = await db.withDatabaseTransaction(query => grants.recordHistoricalSupportGrant(query, ADMIN, { userId: OWNER, idempotencyKey: 'old-purchases-already-in-counter', slots: 3, alreadyIncludedInLegacy: true }, OPTIONS));
        assert.equal(evidence.grant.slots, 0); assert.equal(evidence.grant.purchasedSlots, 3);
        assert.equal((await holding(db)).totalSupporterSlots, before);
        const deniedQuery = async () => { throw new Error('unauthorized DB access'); };
        await assert.rejects(grants.recordHistoricalSupportGrant(deniedQuery, { userId: OWNER }, { ...input, isAdmin: true }), { code: 'AUTOMATION_FORBIDDEN', status: 403 });
        await assert.rejects(db.withDatabaseTransaction(query => grants.recordHistoricalSupportGrant(query, ADMIN, { ...input, amount: 2500 }, OPTIONS)), { code: 'AUTOMATION_SUPPORT_GRANT_INVALID' });
        await assert.rejects(db.withDatabaseTransaction(query => grants.recordHistoricalSupportGrant(query, ADMIN, { ...input, reason: 'different basis' }, OPTIONS)), { code: 'AUTOMATION_SUPPORT_GRANT_CONFLICT' });
    });
    await t.test('simultaneous cross-owner reuse of an administrative source ID records one owner and a safe conflict', async () => {
        const results = await Promise.allSettled([OWNER, OTHER].map(userId => db.withDatabaseTransaction(query => grants.recordHistoricalSupportGrant(query, ADMIN, { userId, idempotencyKey: 'simultaneous-global-history-key', slots: 1, reason: 'One verified purchase' }, OPTIONS))));
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(results.find(result => result.status === 'rejected').reason.code, 'AUTOMATION_SUPPORT_GRANT_CONFLICT');
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_push_support_grants WHERE source_id=?', ['simultaneous-global-history-key']))[0].n), 1);
    });
    await t.test('audited manual counter edits preserve the baseline and support CAS/idempotent retries', async () => {
        const input = { userId: OWNER, idempotencyKey: 'manual-adjust-1', expectedManualSlots: 3, manualSlots: 4, reason: 'Verified old purchase correction' };
        const adjust = () => db.withDatabaseTransaction(query => grants.explicitAdminAdjustment(query, ADMIN, input, OPTIONS));
        assert.equal((await adjust()).grant.slots, 1); assert.equal((await adjust()).inserted, false);
        assert.equal((await holding(db)).manualLegacySlots, 4);
        assert.equal(Number((await db.queryDatabase('SELECT manual_slots FROM automation_push_support_owner_snapshots WHERE owner_user_id=?', [OWNER]))[0].manual_slots), 3);
        await assert.rejects(db.withDatabaseTransaction(query => grants.explicitAdminAdjustment(query, ADMIN, { ...input, idempotencyKey: 'stale-counter-change' }, OPTIONS)), { code: 'AUTOMATION_SUPPORT_GRANT_CONFLICT' });
    });
    await t.test('grant plus payment transaction and legacy migration roll back cleanly on failure', async () => {
        const row = await attempt(db, OWNER, 3000), before = await holding(db);
        await assert.rejects(db.withDatabaseTransaction(async query => { await grants.applyVerifiedDonationGrant(query, row.id, OPTIONS); throw new Error('synthetic grant DB failure'); }), /synthetic grant DB failure/);
        assert.equal((await holding(db)).totalSupporterSlots, before.totalSupporterSlots);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_push_support_grants WHERE source_id=?', [row.paymentId]))[0].n), 0);
        const fresh = '555555555555555555';
        await assert.rejects(db.withDatabaseTransaction(async query => { await grants.migrateLegacyGrants(query, fresh, OPTIONS); throw new Error('synthetic migration failure'); }), /synthetic migration failure/);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_push_support_owner_snapshots WHERE owner_user_id=?', [fresh]))[0].n), 0);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM users WHERE user_id=?', [fresh]))[0].n), 0);
    });
    await t.test('owner-scoped history has stable paging and omits merchant/payment identity and email', async () => {
        const found = [], options = { scope: SCOPE, limit: 2 }; let cursor;
        do {
            const page = await grants.getSupporterGrantHistory(db.queryDatabase, OWNER, { ...options, ...(cursor ? { cursor } : {}) });
            found.push(...page.items); cursor = page.nextCursor;
        } while (cursor);
        assert.equal(new Set(found.map(item => item.grantId)).size, found.length);
        assert.equal(found.length, Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_push_support_grants WHERE owner_user_id=?', [OWNER]))[0].n));
        const otherHistory = (await grants.getSupporterGrantHistory(db.queryDatabase, OTHER, { scope: SCOPE })).items;
        const otherRows = await db.queryDatabase('SELECT grant_id FROM automation_push_support_grants WHERE owner_user_id=?', [OTHER]);
        assert.deepEqual(otherHistory.map(row => row.grantId).sort(), otherRows.map(row => row.grant_id).sort());
        assert.ok(otherHistory.every(row => !found.some(own => own.grantId === row.grantId)));
        const serialized = JSON.stringify(found);
        assert.ok(!serialized.includes('fixture@example.invalid')); assert.ok(!serialized.includes('FIXTURE-MERCHANT')); assert.ok(!serialized.includes('P-'));
        await assert.rejects(grants.getSupporterGrantHistory(db.queryDatabase, OWNER, { cursor: 'forged' }), { code: 'AUTOMATION_SUPPORT_GRANT_INVALID' });
    });
    await t.test('support ledger writes have atomic independent audit records without payment/merchant/body leaks', async () => {
        const audit = await db.queryDatabase("SELECT * FROM automation_audit WHERE action='x.support.grant'");
        const ledger = await db.queryDatabase('SELECT grant_id FROM automation_push_support_grants');
        assert.equal(audit.length, ledger.length);
        for (const row of audit) {
            assert.match(row.entity_id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
            const detail = JSON.parse(row.detail_json); assert.ok(ledger.some(entry => entry.grant_id === detail.grantId));
        }
        assert.ok(!JSON.stringify(audit).includes('FIXTURE-MERCHANT')); assert.ok(!JSON.stringify(audit).includes('historical-product-2500-1'));
        const row = await attempt(db, OWNER, 2000);
        await db.queryDatabase("CREATE TRIGGER fixture_support_audit_failure BEFORE INSERT ON automation_audit FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture audit write unavailable'");
        try { await assert.rejects(apply(db, row.id), /fixture audit write unavailable/); }
        finally { await db.queryDatabase('DROP TRIGGER fixture_support_audit_failure'); }
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_push_support_grants WHERE source_id=?', [row.paymentId]))[0].n), 0);
    });
    await t.test('aggregate overflow rejects before commit, including simultaneous near-limit grants', async () => {
        const before = await holding(db);
        await assert.rejects(db.withDatabaseTransaction(query => grants.recordHistoricalSupportGrant(query, ADMIN, { userId: OWNER, idempotencyKey: 'overflow-rejected', slots: Number.MAX_SAFE_INTEGER, reason: 'Synthetic boundary test' }, OPTIONS)), { code: 'AUTOMATION_SUPPORT_GRANT_LIMIT', status: 422 });
        assert.equal((await holding(db)).totalSupporterSlots, before.totalSupporterSlots);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_push_support_grants WHERE source_id=?', ['overflow-rejected']))[0].n), 0);
        const boundaryOwner = '666666666666666666';
        await db.withDatabaseTransaction(query => grants.recordHistoricalSupportGrant(query, ADMIN, { userId: boundaryOwner, idempotencyKey: 'almost-max-boundary', slots: Number.MAX_SAFE_INTEGER - 1, reason: 'Synthetic boundary test' }, OPTIONS));
        const writes = await Promise.allSettled([1, 2].map(index => db.withDatabaseTransaction(query => grants.recordHistoricalSupportGrant(query, ADMIN, { userId: boundaryOwner, idempotencyKey: `max-boundary-${index}`, slots: 1, reason: 'Synthetic boundary test' }, OPTIONS))));
        assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(writes.find(result => result.status === 'rejected').reason.code, 'AUTOMATION_SUPPORT_GRANT_LIMIT');
        assert.equal((await grants.getSupporterHolding(db.queryDatabase, boundaryOwner, NOW, SCOPE)).totalSupporterSlots, Number.MAX_SAFE_INTEGER);
    });
    await t.test('legacy Discord exact-slot command is staff-scoped, transactional, audited and replay-safe', async () => {
        const commandPath = require.resolve('../../src/commands/handlers/autoextract/additionalautoextractslot'), dbPath = require.resolve('../../src/db');
        const originalDb = require.cache[dbPath], originalCommand = require.cache[commandPath];
        const calls = [], interaction = { id: '123456789012345678', guildId: '1132814274734067772', channelId: '1201521425756979352', user: { id: '796972193287503913' },
            locale: 'en-US', member: { permissions: { has: () => true } }, options: { getInteger: () => 7, getUser: () => ({ id: OWNER }) }, editReply: async data => calls.push(data), followUp: async data => calls.push(data) };
        require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db }; delete require.cache[commandPath];
        try {
            const command = require(commandPath), count = async () => Number((await db.queryDatabase("SELECT COUNT(*) n FROM automation_audit WHERE action='x.support.grant'"))[0].n);
            const prior = await count(); await command(interaction, {}); await command(interaction, {});
            assert.equal((await holding(db)).manualLegacySlots, 7); assert.equal(await count(), prior + 1);
            const user = (await db.queryDatabase('SELECT is_donor FROM users WHERE user_id=?', [OWNER]))[0]; assert.equal(Number(user.is_donor), 1);
            assert.ok(calls[0].embeds[0].description.includes(`<@${OWNER}>`));
            await command({ ...interaction, id: '123456789012345679', options: { ...interaction.options, getInteger: () => 2 } }, {});
            assert.equal((await holding(db)).manualLegacySlots, 2); assert.equal(await count(), prior + 2);
            await command({ ...interaction, id: '123456789012345680', channelId: '1201521425756979353' }, {});
            assert.equal((await holding(db)).manualLegacySlots, 2); assert.equal(await count(), prior + 2);
            assert.equal(Number((await db.queryDatabase('SELECT manual_slots FROM automation_push_support_owner_snapshots WHERE owner_user_id=?', [OWNER]))[0].manual_slots), 3);
        } finally {
            if (originalDb) require.cache[dbPath] = originalDb; else delete require.cache[dbPath];
            if (originalCommand) require.cache[commandPath] = originalCommand; else delete require.cache[commandPath];
        }
    });
});

const ENV = { SQUARE_ENVIRONMENT: 'sandbox', SQUARE_ACCESS_TOKEN: 'synthetic-support-token', SQUARE_APPLICATION_ID: 'FIXTURE-APP', SQUARE_LOCATION_ID: 'FIXTURE-LOCATION',
    SQUARE_MERCHANT_ID: SCOPE.merchantId, SQUARE_WEBHOOK_SIGNATURE_KEY: 'synthetic-support-signature', SQUARE_WEBHOOK_NOTIFICATION_URL: 'https://fixture.invalid/api/automation/square/webhook' };
function squareFixture() {
    const payments = new Map(), orders = new Map(), requests = [];
    const hooks = { beforePaymentRead: null };
    let status = 'COMPLETED';
    const fetch = async (url, options) => {
        assert.ok(url.startsWith('https://connect.squareupsandbox.com/v2/'));
        const path = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : null;
        requests.push({ path, method: options.method });
        let result;
        if (path === '/v2/locations/FIXTURE-LOCATION') result = { location: { id: ENV.SQUARE_LOCATION_ID, merchant_id: SCOPE.merchantId, status: 'ACTIVE', currency: 'JPY', timezone: 'Asia/Tokyo' } };
        else if (path === '/v2/payments' && options.method === 'POST') {
            const id = `NEW-PAYMENT-${payments.size + 1}`, orderId = `NEW-ORDER-${payments.size + 1}`, timestamp = new Date(NOW).toISOString();
            const payment = { id, order_id: orderId, reference_id: body.reference_id, location_id: body.location_id, amount_money: body.amount_money, total_money: body.amount_money,
                source_type: 'CARD', status, application_details: { application_id: ENV.SQUARE_APPLICATION_ID }, updated_at: timestamp, created_at: timestamp,
                card_details: { status: 'CAPTURED', card_payment_timeline: { captured_at: timestamp } } };
            payments.set(id, payment); orders.set(orderId, { id: orderId, location_id: body.location_id, total_money: body.amount_money, tenders: [{ payment_id: id }] }); result = { payment };
        } else if (path.startsWith('/v2/payments/')) { if (hooks.beforePaymentRead) await hooks.beforePaymentRead(); result = { payment: payments.get(path.slice('/v2/payments/'.length)) }; }
        else if (path.startsWith('/v2/orders/')) result = { order: orders.get(path.slice('/v2/orders/'.length)) };
        else if (path === '/v2/payments') result = { payments: [...payments.values()] };
        else throw new Error(`unexpected mocked Square path ${path}`);
        return { ok: true, status: 200, json: async () => structuredClone(result) };
    };
    return { payments, requests, fetch, hooks, setStatus: value => { status = value; } };
}
test('SQL verified Square bridge: fresh completion and signed webhook replay converge transactionally', { skip: !port, timeout: 90000 }, async t => {
    const db = await createTestDatabase(port); t.after(() => db.close());
    const square = squareFixture(), options = { env: ENV, fetch: square.fetch, clock: () => NOW };
    const donations = createSquareDonations(db, options), billing = createSquareBilling(db, options), actor = { userId: OWNER };
    await donations.savePolicy(ADMIN, { enabled: true, currency: 'JPY', minimumAmount: 100, maximumAmount: 10000, supporterThreshold: null, validityDays: 1,
        unitAmount: 500, slotsPerUnit: 3, expectedUpdatedAtMs: null });
    const quote = amount => donations.createQuote(actor, { amount, email: 'fixture@example.invalid', name: 'Synthetic fixture' });
    const submit = q => donations.donate(actor, { attemptId: q.attemptId, sourceId: 'cnon:synthetic', consent: true });
    await t.test('two fresh quotes before first migration both qualify under new per-payment rule', async () => {
        const first = await quote(1000), second = await quote(1500);
        await submit(first); await submit(second);
        const wallet = await holding(db);
        assert.equal(wallet.newPaidSlots, 5); assert.equal(wallet.legacySquareSlots, 0);
        const rolling = await getSquareDonationGrant(db.queryDatabase, OWNER, NOW, SCOPE);
        assert.equal(rolling.purchaseUnits, 5); assert.equal(rolling.extraSlots, 15, 'ordinary configured slot multiplier is unchanged');
        assert.equal((await donations.getAdmin(ADMIN)).policy.enabled, true, 'only this synthetic test explicitly enabled its policy');
    });
    await t.test('native and X personal allowances use identical canonical counts while raw rolling policy is preserved', async () => {
        const billingModule = require('../../src/automation/square-billing'), original = billingModule.getSquareScope;
        billingModule.getSquareScope = () => SCOPE;
        try {
            const plans = require('../../src/automation/entitlements');
            const ordinary = await plans.inspectPlan(db.queryDatabase, OWNER, NOW);
            const x = await plans.inspectXPlan(db.queryDatabase, OWNER, NOW);
            assert.equal(ordinary.slotLimit, ordinary.baseSlotLimit + 5);
            assert.equal(x.slotLimit, x.baseSlotLimit + 5);
            assert.equal((await getSquareDonationGrant(db.queryDatabase, OWNER, NOW, SCOPE)).extraSlots, 15);
            await db.queryDatabase('UPDATE automation_square_donation_units_policy SET slots_per_unit=10');
            const expandedNormal = await plans.inspectPlan(db.queryDatabase, OWNER, NOW), unchangedX = await plans.inspectXPlan(db.queryDatabase, OWNER, NOW);
            assert.equal(expandedNormal.slotLimit, expandedNormal.baseSlotLimit + 5);
            assert.equal(unchangedX.slotLimit, unchangedX.baseSlotLimit + 5);
            assert.equal((await getSquareDonationGrant(db.queryDatabase, OWNER, NOW, SCOPE)).extraSlots, 50);
        } finally { billingModule.getSquareScope = original; }
    });
    await t.test('signed webhook, duplicate event, and distinct replay event never grant twice', async () => {
        const payment = [...square.payments.values()][0];
        const fire = async eventId => {
            const raw = JSON.stringify({ event_id: eventId, merchant_id: SCOPE.merchantId, type: 'payment.updated', data: { id: payment.id, object: { payment: { id: payment.id } } } });
            const signature = createHmac('sha256', ENV.SQUARE_WEBHOOK_SIGNATURE_KEY).update(ENV.SQUARE_WEBHOOK_NOTIFICATION_URL).update(raw).digest('base64');
            return billing.handleWebhook(raw, signature);
        };
        await fire('support-verified-event-1'); await fire('support-verified-event-1'); await fire('support-verified-event-2');
        assert.equal((await holding(db)).newPaidSlots, 5);
        await assert.rejects(billing.handleWebhook('{"event_id":"unverified"}', 'forged'), { code: 'SQUARE_WEBHOOK_SIGNATURE_INVALID' });
        assert.equal((await holding(db)).newPaidSlots, 5);
    });
    await t.test('APPROVED first observation followed by trusted completion grants once', async () => {
        square.setStatus('APPROVED'); const q = await quote(1000); await submit(q); square.setStatus('COMPLETED');
        const payment = [...square.payments.values()].at(-1); payment.status = 'COMPLETED';
        const raw = JSON.stringify({ event_id: 'support-approved-completes', merchant_id: SCOPE.merchantId, type: 'payment.updated', data: { id: payment.id } });
        const signature = createHmac('sha256', ENV.SQUARE_WEBHOOK_SIGNATURE_KEY).update(ENV.SQUARE_WEBHOOK_NOTIFICATION_URL).update(raw).digest('base64');
        await billing.handleWebhook(raw, signature);
        assert.equal((await holding(db)).newPaidSlots, 7);
    });
    await t.test('payment grant locks policy before unit counters, avoiding concurrent admin-policy deadlock', async () => {
        const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
        const paymentRead = deferred(), allowPaymentRead = deferred(), policyHeld = deferred(), requestUnitUpdate = deferred(), unitUpdated = deferred(), releasePolicy = deferred(), paymentRequestedPolicy = deferred();
        let armed = false;
        const wrapped = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
            if (armed && sql.includes('SELECT p.*,u.unit_amount') && sql.includes('FOR UPDATE')) paymentRequestedPolicy.resolve();
            return query(sql, params);
        })) };
        const service = createSquareDonations(wrapped, options), q = await quote(500);
        square.hooks.beforePaymentRead = async () => { armed = true; paymentRead.resolve(); await allowPaymentRead.promise; };
        const payment = service.donate(actor, { attemptId: q.attemptId, sourceId: 'cnon:synthetic-lock-order', consent: true });
        let edit;
        try {
            await paymentRead.promise;
            edit = db.withDatabaseTransaction(async query => {
                await query('SELECT environment FROM automation_square_donation_policy WHERE environment=? AND merchant_id=? FOR UPDATE', [SCOPE.environment, SCOPE.merchantId]);
                policyHeld.resolve(); await requestUnitUpdate.promise;
                await query('UPDATE automation_square_donation_unit_grants SET extra_slots=extra_slots+1 WHERE owner_user_id=? AND environment=? AND merchant_id=?', [OWNER, SCOPE.environment, SCOPE.merchantId]);
                unitUpdated.resolve(); await releasePolicy.promise;
            });
            await policyHeld.promise; allowPaymentRead.resolve();
            await paymentRequestedPolicy.promise; requestUnitUpdate.resolve();
            let timeout;
            try { await Promise.race([unitUpdated.promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('policy-unit lock order inversion')), 2000); })]); }
            finally { clearTimeout(timeout); }
            releasePolicy.resolve(); await edit; await payment;
            assert.equal((await holding(db)).newPaidSlots, 8);
        } finally {
            square.hooks.beforePaymentRead = null;
            allowPaymentRead.resolve(); requestUnitUpdate.resolve(); releasePolicy.resolve();
            await Promise.allSettled([payment, edit].filter(Boolean));
        }
    });
});

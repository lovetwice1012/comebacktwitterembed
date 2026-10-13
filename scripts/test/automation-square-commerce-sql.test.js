'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createSquareCommerce } = require('../../src/automation/square-commerce');
const { createSquareBilling } = require('../../src/automation/square-billing');
const { savePlanPolicy } = require('../../src/automation/entitlements');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const ENV = { SQUARE_ENVIRONMENT: 'sandbox', SQUARE_ACCESS_TOKEN: 'fixture-token', SQUARE_APPLICATION_ID: 'fixture-app', SQUARE_LOCATION_ID: 'LOCATION',
    SQUARE_MERCHANT_ID: 'MERCHANT', SQUARE_WEBHOOK_SIGNATURE_KEY: 'fixture-secret', SQUARE_WEBHOOK_NOTIFICATION_URL: 'https://service.example/api/automation/square/webhook' };
const ADMIN = { userId: '444444444444444444', isAdmin: true }, actor = i => ({ userId: String(222222222222222000n + BigInt(i)) });
function mockSquare(clock) {
    const catalog = new Map(), keys = new Map(), customers = new Map(), cards = new Map(), subscriptions = new Map(), invoices = new Map(), requests = [];
    const state = { lost: null, reject: null, gate: null, mutate: null };
    const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(data) });
    async function fetch(url, options) {
        assert.ok(url.startsWith('https://connect.squareupsandbox.com/v2/')); const path = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : null; requests.push({ path, method: options.method, body });
        if (state.reject === path) { state.reject = null; return json({ errors: [{ detail: 'private fixture error' }] }, 422); }
        let result;
        if (path === '/v2/locations/LOCATION') result = { location: { id: 'LOCATION', merchant_id: 'MERCHANT', status: 'ACTIVE', timezone: 'Asia/Tokyo', currency: 'JPY' } };
        else if (path === '/v2/catalog/object' && options.method === 'POST') {
            result = keys.get(body.idempotency_key);
            if (!result) {
                const parent = 'PLAN-' + (catalog.size + 1), variationId = 'VAR-' + (catalog.size + 1), source = body.object.subscription_plan_data.subscription_plan_variations[0];
                const variation = structuredClone(source); variation.id = variationId; variation.version = clock(); variation.subscription_plan_variation_data.subscription_plan_id = parent;
                if (state.mutate) state.mutate(variation);
                catalog.set(variationId, variation); result = { catalog_object: { id: parent }, id_mappings: [{ client_object_id: source.id, object_id: variationId }] }; keys.set(body.idempotency_key, result);
            }
        } else if (path.startsWith('/v2/catalog/object/')) result = { object: catalog.get(path.slice('/v2/catalog/object/'.length)) };
        else if (path === '/v2/catalog/list') result = { objects: [...catalog.values()] };
        else if (path === '/v2/customers' && options.method === 'POST') {
            let customer = keys.get(body.idempotency_key); if (!customer) { customer = { id: 'CUSTOMER-' + (customers.size + 1), reference_id: body.reference_id, email_address: body.email_address }; customers.set(customer.id, customer); keys.set(body.idempotency_key, customer); } result = { customer };
        } else if (path === '/v2/customers/search') result = { customers: [...customers.values()].filter(customer => customer.reference_id === body.query.filter.reference_id.exact) };
        else if (path.startsWith('/v2/customers/')) result = { customer: customers.get(path.slice('/v2/customers/'.length)) };
        else if (path === '/v2/cards' && options.method === 'POST') { let card = keys.get(body.idempotency_key); if (!card) { card = { id: 'ccof:card-' + (cards.size + 1), ...body.card, enabled: true }; cards.set(card.id, card); keys.set(body.idempotency_key, card); } result = { card }; }
        else if (path === '/v2/cards') result = { cards: [...cards.values()].filter(card => card.customer_id === new URL(url).searchParams.get('customer_id')) };
        else if (path === '/v2/subscriptions/search') result = { subscriptions: [...subscriptions.values()].filter(sub => body.query.filter.customer_ids.includes(sub.customer_id)) };
        else if (path === '/v2/subscriptions' && options.method === 'POST') {
            let subscription = keys.get(body.idempotency_key);
            if (!subscription) {
                const id = 'SUB-' + (subscriptions.size + 1), invoiceId = 'INV-' + (invoices.size + 1), variation = catalog.get(body.plan_variation_id), first = variation.subscription_plan_variation_data.phases[0].pricing.price_money;
                subscription = { id, location_id: body.location_id, customer_id: body.customer_id, plan_variation_id: body.plan_variation_id, card_id: body.card_id, source: body.source, price_override_money: body.price_override_money,
                    status: 'ACTIVE', version: 1, charged_through_date: '2026-10-31', timezone: 'Asia/Tokyo', invoice_ids: [invoiceId] };
                invoices.set(invoiceId, { id: invoiceId, subscription_id: id, location_id: body.location_id, primary_recipient: { customer_id: body.customer_id }, status: 'PAID',
                    payment_requests: [{ computed_amount_money: first, total_completed_amount_money: first }] }); subscriptions.set(id, subscription); keys.set(body.idempotency_key, subscription);
            }
            result = { subscription };
        } else if (path.startsWith('/v2/subscriptions/')) result = { subscription: subscriptions.get(path.slice('/v2/subscriptions/'.length)) };
        else if (path.startsWith('/v2/invoices/')) result = { invoice: invoices.get(path.slice('/v2/invoices/'.length)) };
        else throw new Error('Unexpected fixture path ' + path);
        if (state.gate && options.method === 'POST') await state.gate(path);
        if (state.lost === path && options.method === 'POST') { state.lost = null; throw new Error('fixture wire ACK lost'); }
        return json(result);
    }
    return { fetch, requests, state, catalog, keys, subscriptions, invoices };
}
test('Square commerce fixtures default to unconfigured without secret access and require administrators', async () => {
    const service = createSquareCommerce({}, { env: {} }); assert.equal((await service.getAdmin(ADMIN)).configured, false);
    await assert.rejects(service.createCatalogQuote(actor(1), {}), { code: 'AUTOMATION_FORBIDDEN' }); await assert.rejects(service.saveCoupon(actor(1), {}), { code: 'AUTOMATION_FORBIDDEN' });
});
test('real SQL Square catalog creation and first-invoice coupons with mocked remote writes', { skip: !port, timeout: 120000 }, async t => {
    const db = await createTestDatabase(port); let clock = Date.parse('2026-10-13T00:00:00Z');
    const square = mockSquare(() => clock), commerce = () => createSquareCommerce(db, { env: ENV, fetch: square.fetch, clock: () => clock }), billing = () => createSquareBilling(db, { env: ENV, fetch: square.fetch, clock: () => clock });
    const plan = id => savePlanPolicy(db.queryDatabase, ADMIN, { planId: id, label: id, slotLimit: 10, minuteLimit: 10, dayLimit: 100, priority: 2 });
    const coupon = (code, changes = {}) => commerce().saveCoupon(ADMIN, { code, label: code, type: 'fixed', value: 100, currency: 'JPY', planIds: ['pro'], enabled: true, expiresAtMs: null, totalLimit: null, userLimit: null, expectedUpdatedAtMs: null, ...changes });
    const quote = (owner, code) => billing().createQuote(owner, { planId: 'pro', email: 'buyer@example.com', name: 'Fixture Buyer', couponCode: code });
    const submit = (owner, q) => billing().subscribe(owner, { checkoutId: q.checkoutId, sourceId: 'cnon:fixture', consent: true });
    const row = id => db.queryDatabase('SELECT * FROM automation_square_coupon_uses WHERE checkout_id=?', [id]).then(rows => rows[0]);
    try {
        await t.test('admin review quote has no catalog side effect; confirm verifies readback and binds exact policy once', async () => {
            await plan('pro'); const q = await commerce().createCatalogQuote(ADMIN, { planId: 'pro', name: 'Pro', amount: 1000, currency: 'JPY', cadence: 'MONTHLY' }); assert.equal(square.catalog.size, 0);
            await assert.rejects(commerce().confirmCatalogCreation(ADMIN, { creationId: q.creationId, consent: false }), { code: 'SQUARE_CONSENT_REQUIRED' });
            const result = await commerce().confirmCatalogCreation(ADMIN, { creationId: q.creationId, consent: true }); assert.equal(result.state, 'COMPLETE');
            const opts = await billing().getOptions(actor(1)); assert.equal(opts.plans[0].amount, 1000); assert.equal(opts.plans[0].variationId, result.variationId);
            await commerce().confirmCatalogCreation(ADMIN, { creationId: q.creationId, consent: true }); assert.equal(square.catalog.size, 1);
            await assert.rejects(commerce().createCatalogQuote(ADMIN, { planId: 'pro', name: 'Pro', amount: 1000, currency: 'JPY', cadence: 'MONTHLY' }), { code: 'SQUARE_CATALOG_ALREADY_BOUND' });
        });
        await t.test('unknown admin catalog result retries durable same request after restart without duplicate Square objects', async () => {
            await plan('recovery'); const q = await commerce().createCatalogQuote(ADMIN, { planId: 'recovery', name: 'Recovery', amount: 1500, currency: 'JPY', cadence: 'WEEKLY' }); square.state.lost = '/v2/catalog/object';
            await assert.rejects(commerce().confirmCatalogCreation(ADMIN, { creationId: q.creationId, consent: true }), { code: 'SQUARE_RESULT_UNKNOWN' }); assert.equal((await commerce().getCatalogCreation(ADMIN, q.creationId)).state, 'UNKNOWN');
            const before = square.catalog.size; const done = await commerce().confirmCatalogCreation(ADMIN, { creationId: q.creationId, consent: true }); assert.equal(done.state, 'COMPLETE'); assert.equal(square.catalog.size, before);
            const wires = square.requests.filter(item => item.path === '/v2/catalog/object' && item.body?.idempotency_key === q.creationId); assert.equal(wires.length, 2); assert.deepEqual(wires[0].body, wires[1].body);
        });
        await t.test('catalog readback price mismatch cannot bind, admin currency and expired consent are checked', async () => {
            await plan('bad'); await assert.rejects(commerce().createCatalogQuote(ADMIN, { planId: 'bad', name: 'Bad', amount: 1200, currency: 'USD', cadence: 'MONTHLY' }), { code: 'SQUARE_COMMERCE_CURRENCY_MISMATCH' });
            const q = await commerce().createCatalogQuote(ADMIN, { planId: 'bad', name: 'Bad', amount: 1200, currency: 'JPY', cadence: 'MONTHLY' });
            square.state.mutate = object => { object.subscription_plan_variation_data.phases[0].pricing.price_money.amount = 1; };
            await assert.rejects(commerce().confirmCatalogCreation(ADMIN, { creationId: q.creationId, consent: true }), { code: 'SQUARE_CATALOG_MISMATCH' }); square.state.mutate = null;
            assert.equal((await db.queryDatabase('SELECT * FROM automation_square_bindings WHERE plan_id=?', ['bad'])).length, 0);
            await plan('expired'); const expired = await commerce().createCatalogQuote(ADMIN, { planId: 'expired', name: 'Expired', amount: 1200, currency: 'JPY', cadence: 'MONTHLY' }); clock += 16 * 60000;
            await assert.rejects(commerce().confirmCatalogCreation(ADMIN, { creationId: expired.creationId, consent: true }), { code: 'SQUARE_CATALOG_QUOTE_EXPIRED' }); clock -= 16 * 60000;
        });
        await t.test('admin coupon policy is CAS protected with fixed and percentage minor-unit validation and plan targeting', async () => {
            const fixed = await coupon('SAVE'); assert.equal(fixed.value, 100); await assert.rejects(coupon('SAVE'), { code: 'SQUARE_COUPON_CONFLICT' });
            await assert.rejects(coupon('INVALID', { type: 'percent', value: 100 }), { code: 'SQUARE_COMMERCE_INVALID' });
            await assert.rejects(coupon('NO_PLAN', { planIds: ['missing'] }), { code: 'AUTOMATION_PLAN_NOT_FOUND' });
            await coupon('PERCENT', { type: 'percent', value: 33, currency: null });
            const q = await quote(actor(20), 'percent'); assert.equal(q.plan.firstAmount, 670); assert.equal(q.plan.regularAmount, 1000);
            await coupon('TOO_MUCH', { value: 1000 }); await assert.rejects(quote(actor(21), 'TOO_MUCH'), { code: 'SQUARE_COUPON_AMOUNT_INVALID' });
        });
        await t.test('quotes freeze initial and regular amounts and reserve usage atomically without public catalog writes', async () => {
            await coupon('LIMIT', { totalLimit: 2, userLimit: 1 });
            const before = square.requests.filter(item => item.path === '/v2/catalog/object' && item.method === 'POST').length;
            const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => quote(actor(30 + i), 'LIMIT')));
            assert.equal(results.filter(item => item.status === 'fulfilled').length, 2); assert.ok(results.filter(item => item.status === 'rejected').every(item => item.reason.code === 'SQUARE_COUPON_LIMIT'));
            assert.equal(square.requests.filter(item => item.path === '/v2/catalog/object' && item.method === 'POST').length, before);
            const first = results.find(item => item.status === 'fulfilled').value; assert.equal(first.plan.firstAmount, 900); assert.equal(first.plan.amount, 1000); assert.equal((await row(first.checkoutId)).state, 'RESERVED');
            const info = await commerce().getAdmin(ADMIN); const policy = info.coupons.find(item => item.code === 'LIMIT'); assert.equal(policy.used, 0); assert.equal(policy.reserved, 2);
        });
        await t.test('coupon phases discount exactly the first invoice, omit recurring override, and switch to full regular price', async () => {
            const own = actor(1), q = await quote(own, 'SAVE'); const result = await submit(own, q); assert.equal(result.subscription.active, true); assert.equal((await row(q.checkoutId)).state, 'COMMITTED');
            const wire = square.requests.find(item => item.path === '/v2/subscriptions' && item.body.source.name === 'cbte:' + q.checkoutId); assert.ok(!Object.hasOwn(wire.body, 'price_override_money'));
            const variation = square.catalog.get(wire.body.plan_variation_id), phases = variation.subscription_plan_variation_data.phases;
            assert.equal(phases[0].periods, 1); assert.equal(phases[0].pricing.price_money.amount, 900); assert.equal(phases[1].periods, undefined); assert.equal(phases[1].pricing.price_money.amount, 1000);
            const sub = [...square.subscriptions.values()].find(item => item.source.name === 'cbte:' + q.checkoutId), firstId = sub.invoice_ids[0], secondId = 'regular-' + sub.id;
            sub.invoice_ids.unshift(secondId); sub.charged_through_date = '2026-11-30'; sub.version++; square.invoices.set(secondId, { id: secondId, subscription_id: sub.id, location_id: 'LOCATION', primary_recipient: { customer_id: sub.customer_id }, status: 'PAID', payment_requests: [{ computed_amount_money: { amount: 900, currency: 'JPY' }, total_completed_amount_money: { amount: 900, currency: 'JPY' } }] });
            square.invoices.get(firstId).status = 'REFUNDED'; assert.equal((await billing().getStatus(own)).subscription.active, false, 'second invoice at first price must not grant');
            square.invoices.get(secondId).payment_requests[0].computed_amount_money.amount = 1000; square.invoices.get(secondId).payment_requests[0].total_completed_amount_money.amount = 1000; assert.equal((await billing().getStatus(own)).subscription.active, true);
            assert.equal((await row(q.checkoutId)).first_invoice_id, firstId); assert.equal((await row(q.checkoutId)).state, 'COMMITTED');
        });
        await t.test('disabled or expired coupon before consent releases unused reservation and never creates a card or contract', async () => {
            const policy = await coupon('DISABLED'), own = actor(3), q = await quote(own, 'DISABLED');
            await commerce().saveCoupon(ADMIN, { ...policy, enabled: false, expectedUpdatedAtMs: policy.updatedAtMs });
            const before = square.requests.length; await assert.rejects(submit(own, q), { code: 'SQUARE_COUPON_UNAVAILABLE' }); assert.equal((await row(q.checkoutId)).state, 'RELEASED');
            assert.ok(!square.requests.slice(before).some(item => item.method === 'POST'));
            await coupon('EXPIRES', { expiresAtMs: clock + 1000 }); const expired = await quote(actor(4), 'EXPIRES'); clock += 1001;
            await assert.rejects(submit(actor(4), expired), { code: 'SQUARE_COUPON_UNAVAILABLE' }); assert.equal((await row(expired.checkoutId)).state, 'RELEASED');
        });
        await t.test('unknown subscription holds coupon capacity; restart recovers one contract and refund never frees a used coupon', async () => {
            await coupon('UNKNOWN', { totalLimit: 1 }); const own = actor(5), q = await quote(own, 'UNKNOWN'); square.state.lost = '/v2/subscriptions';
            await assert.rejects(submit(own, q), { code: 'SQUARE_RESULT_UNKNOWN' }); assert.equal((await row(q.checkoutId)).state, 'SUBMITTING');
            await assert.rejects(quote(actor(6), 'UNKNOWN'), { code: 'SQUARE_COUPON_LIMIT' });
            const count = square.subscriptions.size, restored = await billing().getStatus(own); assert.equal(restored.subscription.active, true); assert.equal(square.subscriptions.size, count); assert.equal((await row(q.checkoutId)).state, 'COMMITTED');
            const sub = [...square.subscriptions.values()].find(item => item.source.name === 'cbte:' + q.checkoutId); square.invoices.get(sub.invoice_ids[0]).status = 'REFUNDED'; assert.equal((await billing().getStatus(own)).subscription.active, false);
            await assert.rejects(quote(actor(6), 'UNKNOWN'), { code: 'SQUARE_COUPON_LIMIT' });
        });
        await t.test('known pre-contract failures release usage; unsubmitted expired reservations are reclaimed', async () => {
            await coupon('RETRY', { totalLimit: 1 }); const own = actor(7), q = await quote(own, 'RETRY'); square.state.reject = '/v2/subscriptions';
            await assert.rejects(submit(own, q), { code: 'SQUARE_REQUEST_FAILED' }); assert.equal((await row(q.checkoutId)).state, 'RELEASED');
            const other = await quote(actor(8), 'RETRY'); clock += 16 * 60000; await quote(actor(9), 'RETRY'); assert.equal((await row(other.checkoutId)).state, 'RELEASED');
        });
        await t.test('parallel admin confirmations use one leased catalog write and cannot overwrite an independently changed binding', async () => {
            await plan('parallel'); const q = await commerce().createCatalogQuote(ADMIN, { planId: 'parallel', name: 'Parallel', amount: 1234, currency: 'JPY', cadence: 'MONTHLY' }); let enter, release;
            const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
            square.state.gate = async path => { if (path === '/v2/catalog/object') { enter(); await gate; } };
            const first = commerce().confirmCatalogCreation(ADMIN, { creationId: q.creationId, consent: true }); await entered;
            await assert.rejects(commerce().confirmCatalogCreation(ADMIN, { creationId: q.creationId, consent: true }), { code: 'SQUARE_CATALOG_BUSY' });
            release(); await first; square.state.gate = null;
            assert.equal(square.requests.filter(item => item.path === '/v2/catalog/object' && item.body.idempotency_key === q.creationId).length, 1);
            await plan('conflict'); const conflict = await commerce().createCatalogQuote(ADMIN, { planId: 'conflict', name: 'Conflict', amount: 1000, currency: 'JPY', cadence: 'MONTHLY' });
            const base = (await db.queryDatabase('SELECT * FROM automation_square_bindings WHERE plan_id=?', ['pro']))[0];
            await db.queryDatabase('INSERT INTO automation_square_bindings (plan_id,environment,merchant_id,variation_id,enabled,catalog_name,cadence,amount,currency,catalog_version,verified_at_ms,actor_user_id) VALUES (?,?,?,?,1,?,?,?,?,?,?,?)', ['conflict', 'sandbox', 'MERCHANT', 'independent-existing', 'Existing', 'MONTHLY', 1000, 'JPY', base.catalog_version, clock, ADMIN.userId]);
            await assert.rejects(commerce().confirmCatalogCreation(ADMIN, { creationId: conflict.creationId, consent: true }), { code: 'SQUARE_CATALOG_ALREADY_BOUND' });
            assert.equal((await db.queryDatabase('SELECT variation_id FROM automation_square_bindings WHERE plan_id=?', ['conflict']))[0].variation_id, 'independent-existing');
        });
        await t.test('catalog SQL ACK failure remains recoverable through the original idempotency request without another creation', async () => {
            await plan('dbfailure'); const q = await commerce().createCatalogQuote(ADMIN, { planId: 'dbfailure', name: 'DB failure', amount: 1200, currency: 'JPY', cadence: 'MONTHLY' }); let failing = true;
            const broken = createSquareCommerce({ ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
                if (failing && sql.startsWith('INSERT INTO automation_square_bindings')) { failing = false; throw new Error('fixture binding ACK failure'); } return query(sql, params);
            })) }, { env: ENV, fetch: square.fetch, clock: () => clock });
            await assert.rejects(broken.confirmCatalogCreation(ADMIN, { creationId: q.creationId, consent: true }), /fixture binding ACK failure/);
            assert.equal((await commerce().getCatalogCreation(ADMIN, q.creationId)).state, 'UNKNOWN'); const before = square.catalog.size;
            assert.equal((await commerce().confirmCatalogCreation(ADMIN, { creationId: q.creationId, consent: true })).state, 'COMPLETE'); assert.equal(square.catalog.size, before);
        });
        await t.test('coupon preparation with an unknown catalog ACK retries one immutable two-phase variation only after consent', async () => {
            await coupon('VARIANT'); const own = actor(50), q = await quote(own, 'VARIANT'), before = square.catalog.size; square.state.lost = '/v2/catalog/object';
            await assert.rejects(submit(own, q), { code: 'SQUARE_RESULT_UNKNOWN' }); assert.equal(square.catalog.size, before + 1); assert.equal((await row(q.checkoutId)).state, 'RESERVED');
            const count = square.catalog.size; assert.equal((await submit(own, q)).subscription.active, true); assert.equal(square.catalog.size, count); assert.equal((await row(q.checkoutId)).state, 'COMMITTED');
            assert.equal(square.requests.filter(item => item.path === '/v2/subscriptions' && item.body.source.name === 'cbte:' + q.checkoutId).length, 1);
        });
        await t.test('per-user coupon limits include reservations and paid uses; public plan selection cannot bypass coupon targeting', async () => {
            await coupon('USER_CAP', { userLimit: 1 }); const own = actor(60); const q = await quote(own, 'USER_CAP');
            await assert.rejects(quote(own, 'USER_CAP'), { code: 'SQUARE_COUPON_LIMIT' });
            await coupon('OTHER_ONLY', { planIds: ['recovery'] }); await assert.rejects(quote(actor(61), 'OTHER_ONLY'), { code: 'SQUARE_COUPON_UNAVAILABLE' });
            await submit(own, q); const history = await row(q.checkoutId); assert.equal(history.state, 'COMMITTED');
            const adminView = await commerce().getAdmin(ADMIN); const serialized = JSON.stringify(adminView); assert.ok(!serialized.includes(ENV.SQUARE_ACCESS_TOKEN)); assert.ok(!serialized.includes(ENV.SQUARE_WEBHOOK_SIGNATURE_KEY));
        });
        await t.test('coupon-revision changes invalidate an unsubmitted quote, and anchored or prorated base plans refuse first-invoice discounts', async () => {
            const c = await coupon('CHANGED'), q = await quote(actor(70), 'CHANGED'); await commerce().saveCoupon(ADMIN, { ...c, value: 200, expectedUpdatedAtMs: c.updatedAtMs });
            await assert.rejects(submit(actor(70), q), { code: 'SQUARE_COUPON_CHANGED' }); assert.equal((await row(q.checkoutId)).state, 'RELEASED');
            const baseRow = (await db.queryDatabase('SELECT variation_id FROM automation_square_bindings WHERE plan_id=?', ['pro']))[0], catalog = square.catalog.get(baseRow.variation_id);
            catalog.subscription_plan_variation_data.can_prorate = true; await assert.rejects(quote(actor(71), 'SAVE'), { code: 'SQUARE_COUPON_PRORATION_UNSUPPORTED' }); catalog.subscription_plan_variation_data.can_prorate = false;
            catalog.subscription_plan_variation_data.monthly_billing_anchor_date = 1; await assert.rejects(quote(actor(71), 'SAVE'), { code: 'SQUARE_COUPON_PRORATION_UNSUPPORTED' }); delete catalog.subscription_plan_variation_data.monthly_billing_anchor_date;
        });
        await t.test('known subscription rejection cleanup is atomic on SQL faults and a fresh factory recovers the durable rejection', async () => {
            await coupon('ATOMIC', { totalLimit: 1 }); const own = actor(80), q = await quote(own, 'ATOMIC'); let failRelease = true; square.state.reject = '/v2/subscriptions';
            const broken = createSquareBilling({ ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
                if (failRelease && sql.startsWith('UPDATE automation_square_coupon_uses SET state=') && params[0] === 'RELEASED') { failRelease = false; throw new Error('fixture release SQL failure'); }
                return query(sql, params);
            })) }, { env: ENV, fetch: square.fetch, clock: () => clock });
            await assert.rejects(broken.subscribe(own, { checkoutId: q.checkoutId, sourceId: 'cnon:fixture', consent: true }), /fixture release SQL failure/);
            const failed = (await db.queryDatabase('SELECT * FROM automation_square_checkouts WHERE id=?', [q.checkoutId]))[0];
            assert.equal(failed.state, 'KNOWN_REJECTED', 'atomic final FAILED write rolled back while definite remote rejection remains durable');
            assert.equal((await row(q.checkoutId)).state, 'SUBMITTING');
            assert.equal((await db.queryDatabase('SELECT current_checkout_id FROM automation_square_accounts WHERE owner_user_id=?', [own.userId]))[0].current_checkout_id, q.checkoutId);
            await assert.rejects(quote(actor(81), 'ATOMIC'), { code: 'SQUARE_COUPON_LIMIT' });
            const recovered = await billing().getStatus(own); assert.equal(recovered.pending, null); assert.equal(recovered.subscription, null);
            assert.equal((await db.queryDatabase('SELECT state FROM automation_square_checkouts WHERE id=?', [q.checkoutId]))[0].state, 'FAILED'); assert.equal((await row(q.checkoutId)).state, 'RELEASED');
            await quote(actor(81), 'ATOMIC');
            assert.equal(square.requests.filter(item => item.path === '/v2/subscriptions' && item.body.source.name === 'cbte:' + q.checkoutId).length, 1, 'recovery does not create a contract');
        });
        await t.test('preexisting FAILED coupon orphans are safely reclaimed while unknown checkout reservations remain held', async () => {
            await coupon('LEGACY', { totalLimit: 1 }); const own = actor(82), q = await quote(own, 'LEGACY');
            await db.queryDatabase("UPDATE automation_square_checkouts SET state='FAILED' WHERE id=?", [q.checkoutId]);
            await db.queryDatabase("UPDATE automation_square_coupon_uses SET state='SUBMITTING',expires_at_ms=0 WHERE checkout_id=?", [q.checkoutId]);
            await quote(actor(83), 'LEGACY'); assert.equal((await row(q.checkoutId)).state, 'RELEASED');
            await coupon('DO_NOT_RELEASE', { totalLimit: 1 }); const unknown = await quote(actor(84), 'DO_NOT_RELEASE');
            await db.queryDatabase("UPDATE automation_square_checkouts SET state='SUBSCRIPTION_SUBMITTING' WHERE id=?", [unknown.checkoutId]);
            await db.queryDatabase("UPDATE automation_square_coupon_uses SET state='SUBMITTING',expires_at_ms=0 WHERE checkout_id=?", [unknown.checkoutId]);
            await assert.rejects(quote(actor(85), 'DO_NOT_RELEASE'), { code: 'SQUARE_COUPON_LIMIT' }); assert.equal((await row(unknown.checkoutId)).state, 'SUBMITTING');
        });
    } finally { await db.close(); }
});

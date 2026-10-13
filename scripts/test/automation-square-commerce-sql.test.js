'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createSquareCommerce } = require('../../src/automation/square-commerce');
const { createSquareBilling } = require('../../src/automation/square-billing');
const { savePlanPolicy } = require('../../src/automation/entitlements');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const ENV = { SQUARE_ENVIRONMENT: 'sandbox', SQUARE_ACCESS_TOKEN: 'fixture-token', SQUARE_APPLICATION_ID: 'fixture-app', SQUARE_LOCATION_ID: 'LOCATION',
    SQUARE_MERCHANT_ID: 'MERCHANT', SQUARE_WEBHOOK_SIGNATURE_KEY: 'fixture-secret', SQUARE_WEBHOOK_NOTIFICATION_URL: 'https://service.example/api/automation/square/webhook' };
const ADMIN = { userId: '444444444444444444', isAdmin: true }, actor = i => ({ userId: String(222222222222222000n + BigInt(i)) });
function mockSquare(clock) {
    const catalog = new Map(), parents = new Map(), catalogRequests = new Map(), keys = new Map(), customers = new Map(), cards = new Map(), subscriptions = new Map(), invoices = new Map(), requests = [];
    const state = { lost: null, lostRepair: 0, reject: null, gate: null, mutate: null, mutateParent: null };
    const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(data) });
    async function fetch(url, options) {
        assert.ok(url.startsWith('https://connect.squareupsandbox.com/v2/')); const path = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : null; requests.push({ path, method: options.method, body });
        if (state.reject === path) { state.reject = null; return json({ errors: [{ detail: 'private fixture error' }] }, 422); }
        let result;
        if (path === '/v2/locations/LOCATION') result = { location: { id: 'LOCATION', merchant_id: 'MERCHANT', status: 'ACTIVE', timezone: 'Asia/Tokyo', currency: 'JPY' } };
        else if (path === '/v2/catalog/object' && options.method === 'POST') {
            if (catalogRequests.has(body.idempotency_key) && catalogRequests.get(body.idempotency_key) !== JSON.stringify(body)) return json({ errors: [{ code: 'IDEMPOTENCY_KEY_REUSED' }] }, 409);
            result = keys.get(body.idempotency_key);
            if (!result) {
                const incoming = body.object;
                if (incoming.id.startsWith('#')) {
                    const parentId = 'PLAN-' + (catalog.size + 1), variationId = 'VAR-' + (catalog.size + 1), source = incoming.subscription_plan_data.subscription_plan_variations[0];
                    const variation = structuredClone(source); variation.id = variationId; variation.version = clock(); variation.subscription_plan_variation_data.subscription_plan_id = parentId;
                    if (state.mutate) state.mutate(variation);
                    const parent = structuredClone(incoming); parent.id = parentId; parent.version = clock(); parent.subscription_plan_data.subscription_plan_variations = [structuredClone(variation)];
                    if (state.mutateParent) state.mutateParent(parent, variation);
                    catalog.set(variationId, variation); parents.set(parentId, parent);
                    result = { catalog_object: parent, id_mappings: [{ client_object_id: source.id, object_id: variationId }, { client_object_id: incoming.id, object_id: parentId }] };
                } else {
                    const parent = parents.get(incoming.id), variations = incoming.subscription_plan_data?.subscription_plan_variations;
                    if (!parent || String(incoming.version) !== String(parent.version) || !Array.isArray(variations)
                        || variations.some(item => !catalog.has(item.id) || String(item.version) !== String(catalog.get(item.id).version) || item.subscription_plan_variation_data.subscription_plan_id !== incoming.id))
                        return json({ errors: [{ code: 'VERSION_MISMATCH' }] }, 409);
                    const restored = structuredClone(incoming), version = Math.max(clock(), Number(parent.version) + 1, ...variations.map(item => Number(item.version) + 1));
                    restored.version = version;
                    restored.subscription_plan_data.subscription_plan_variations = variations.map(item => { const copy = structuredClone(item); copy.version = version; catalog.set(copy.id, copy); return structuredClone(copy); });
                    parents.set(restored.id, restored); result = { catalog_object: restored, id_mappings: [] };
                }
                catalogRequests.set(body.idempotency_key, JSON.stringify(body)); keys.set(body.idempotency_key, structuredClone(result));
            }
            if (!body.object.id.startsWith('#') && state.lostRepair > 0) { state.lostRepair--; throw new Error('fixture repair ACK lost'); }
        } else if (path.startsWith('/v2/catalog/object/')) {
            const objectId = decodeURIComponent(path.slice('/v2/catalog/object/'.length)), parent = parents.get(objectId);
            if (parent) { const copy = structuredClone(parent); copy.subscription_plan_data.subscription_plan_variations = copy.subscription_plan_data.subscription_plan_variations.map(item => structuredClone(catalog.get(item.id) || item)); result = { object: copy }; }
            else result = { object: catalog.get(objectId) };
        }
        else if (path === '/v2/catalog/list') result = { objects: [...catalog.values()] };
        else if (path === '/v2/customers' && options.method === 'POST') {
            let customer = keys.get(body.idempotency_key); if (!customer) { customer = { id: 'CUSTOMER-' + (customers.size + 1), reference_id: body.reference_id, email_address: body.email_address }; customers.set(customer.id, customer); keys.set(body.idempotency_key, customer); } result = { customer };
        } else if (path === '/v2/customers/search') result = { customers: [...customers.values()].filter(customer => customer.reference_id === body.query.filter.reference_id.exact) };
        else if (path.startsWith('/v2/customers/')) result = { customer: customers.get(path.slice('/v2/customers/'.length)) };
        else if (path === '/v2/cards' && options.method === 'POST') { let card = keys.get(body.idempotency_key); if (!card) { card = { id: 'ccof:card-' + (cards.size + 1), ...body.card, enabled: true }; cards.set(card.id, card); keys.set(body.idempotency_key, card); } result = { card }; }
        else if (path.startsWith('/v2/cards/')) result = { card: cards.get(decodeURIComponent(path.slice('/v2/cards/'.length))) };
        else if (path === '/v2/cards') result = { cards: [...cards.values()].filter(card => card.customer_id === new URL(url).searchParams.get('customer_id')) };
        else if (path === '/v2/subscriptions/search') result = { subscriptions: [...subscriptions.values()].filter(sub => body.query.filter.customer_ids.includes(sub.customer_id)) };
        else if (path === '/v2/subscriptions' && options.method === 'POST') {
            let subscription = keys.get(body.idempotency_key);
            if (!subscription) {
                const selected = catalog.get(body.plan_variation_id), parent = parents.get(selected?.subscription_plan_variation_data?.subscription_plan_id);
                if (!selected || selected.present_at_all_locations === false || !parent || parent.present_at_all_locations === false) return json({ errors: [{ code: 'INVALID_VALUE', detail: 'Subscription catalog is disabled' }] }, 422);
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
    return { fetch, requests, state, catalog, parents, keys, subscriptions, invoices };
}
test('Square commerce fixtures default to unconfigured without secret access and require administrators', async () => {
    const service = createSquareCommerce({}, { env: {} }); assert.equal((await service.getAdmin(ADMIN)).configured, false);
    await assert.rejects(service.createCatalogQuote(actor(1), {}), { code: 'AUTOMATION_FORBIDDEN' }); await assert.rejects(service.saveCoupon(actor(1), {}), { code: 'AUTOMATION_FORBIDDEN' });
});
test('Square multiple payment intervals share one notification policy with independent quotes, bindings, leases and coupon terms', { skip: !port, timeout: 90000 }, async t => {
    const db = await createTestDatabase(port); let clock = Date.parse('2026-10-13T00:00:00Z');
    const square = mockSquare(() => clock), commerce = () => createSquareCommerce(db, { env: ENV, fetch: square.fetch, clock: () => clock }), billing = () => createSquareBilling(db, { env: ENV, fetch: square.fetch, clock: () => clock });
    const bind = async (cadence, amount) => {
        const q = await commerce().createCatalogQuote(ADMIN, { planId: 'multi', name: 'Multiple ' + cadence, cadence, amount, currency: 'JPY' });
        return commerce().confirmCatalogCreation(ADMIN, { creationId: q.creationId, consent: true });
    };
    const quote = (i, variationId, couponCode) => billing().createQuote(actor(i), { planId: 'multi', variationId, email: 'buyer@example.com', name: 'Fixture Buyer', couponCode });
    const submit = (i, q) => billing().subscribe(actor(i), { checkoutId: q.checkoutId, sourceId: 'cnon:fixture-' + i, consent: true });
    let monthly, annual;
    try {
        await savePlanPolicy(db.queryDatabase, ADMIN, { planId: 'multi', label: 'Multiple', slotLimit: 10, minuteLimit: 10, dayLimit: 100, priority: 2 });
        await t.test('concurrent interval creation keeps distinct durable requests and retries the unknown annual response unchanged', async () => {
            const [monthQuote, yearQuote] = await Promise.all(['MONTHLY', 'ANNUAL'].map(cadence => commerce().createCatalogQuote(ADMIN, { planId: 'multi', name: 'Multiple ' + cadence, cadence, amount: cadence === 'MONTHLY' ? 1200 : 12000, currency: 'JPY' })));
            monthly = await commerce().confirmCatalogCreation(ADMIN, { creationId: monthQuote.creationId, consent: true });
            square.state.lost = '/v2/catalog/object';
            await assert.rejects(commerce().confirmCatalogCreation(ADMIN, { creationId: yearQuote.creationId, consent: true }), { code: 'SQUARE_RESULT_UNKNOWN' });
            await assert.rejects(commerce().createCatalogQuote(ADMIN, { planId: 'multi', name: 'Duplicate annual', cadence: 'ANNUAL', amount: 1, currency: 'JPY' }), { code: 'SQUARE_CATALOG_PENDING' });
            assert.equal((await commerce().getCreation(ADMIN, monthQuote.creationId)).state, 'COMPLETE');
            const count = square.catalog.size;
            annual = await commerce().confirmCatalogCreation(ADMIN, { creationId: yearQuote.creationId, consent: true });
            assert.equal(annual.state, 'COMPLETE'); assert.equal(square.catalog.size, count);
            const wires = square.requests.filter(item => item.path === '/v2/catalog/object' && item.body?.idempotency_key === yearQuote.creationId);
            assert.equal(wires.length, 2); assert.deepEqual(wires[0].body, wires[1].body);
            assert.equal((await billing().getOptions(actor(200))).plans.filter(item => item.planId === 'multi').length, 2);
            await assert.rejects(commerce().createCatalogQuote(ADMIN, { planId: 'multi', name: 'Duplicate monthly', cadence: 'MONTHLY', amount: 1, currency: 'JPY' }), { code: 'SQUARE_CATALOG_ALREADY_BOUND' });
        });
        await t.test('explicit variation selects its exact interval and ambiguous old clients fail before financial writes', async () => {
            const before = square.requests.filter(item => item.method === 'POST').length;
            await assert.rejects(quote(201), { code: 'SQUARE_PAYMENT_INTERVAL_REQUIRED' });
            await assert.rejects(quote(201, 'OTHER-PLAN-VARIATION'), { code: 'SQUARE_PLAN_UNAVAILABLE' });
            assert.equal(square.requests.filter(item => item.method === 'POST').length, before);
            const month = await quote(202, monthly.variationId), year = await quote(203, annual.variationId);
            assert.equal(month.plan.cadence, 'MONTHLY'); assert.equal(month.plan.amount, 1200);
            assert.equal(year.plan.cadence, 'ANNUAL'); assert.equal(year.plan.amount, 12000);
            assert.equal(month.plan.slotLimit, year.plan.slotLimit);
            for (const [i, q] of [[202, month], [203, year]]) {
                const result = await submit(i, q); assert.equal(result.subscription.active, true);
                assert.equal(result.subscription.cadence, q.plan.cadence); assert.equal(result.subscription.amount, q.plan.amount); assert.equal(result.subscription.currency, 'JPY');
                const wire = square.requests.find(item => item.path === '/v2/subscriptions' && item.body.source.name === 'cbte:' + q.checkoutId);
                assert.equal(wire.body.plan_variation_id, q.plan.variationId); assert.equal(wire.body.price_override_money.amount, q.plan.amount);
            }
        });
        await t.test('monthly CAS edits and disablement affect only monthly quotes; annual checkout retains its accepted price', async () => {
            const year = await quote(204, annual.variationId), month = await quote(205, monthly.variationId);
            const binding = (await billing().getAdmin(ADMIN)).bindings.find(item => item.cadence === 'MONTHLY');
            await assert.rejects(billing().saveBinding(ADMIN, 'multi', { cadence: 'ANNUAL', variationId: monthly.variationId, enabled: false, expectedVerifiedAtMs: binding.verifiedAtMs }), { code: 'SQUARE_PAYMENT_INTERVAL_MISMATCH' });
            const edit = { cadence: 'MONTHLY', variationId: monthly.variationId, enabled: false, expectedVerifiedAtMs: binding.verifiedAtMs };
            const outcomes = await Promise.allSettled([billing().saveBinding(ADMIN, 'multi', edit), billing().saveBinding(ADMIN, 'multi', edit)]);
            assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
            assert.equal(outcomes.find(item => item.status === 'rejected').reason.code, 'SQUARE_BINDING_CONFLICT');
            const before = square.requests.filter(item => item.path === '/v2/cards' && item.method === 'POST').length;
            await assert.rejects(submit(205, month), { code: 'SQUARE_QUOTE_CHANGED' });
            assert.equal(square.requests.filter(item => item.path === '/v2/cards' && item.method === 'POST').length, before);
            assert.equal((await submit(204, year)).subscription.active, true);
            assert.equal((await billing().getOptions(actor(206))).plans[0].cadence, 'ANNUAL');
            const original = square.catalog.get(annual.variationId); original.version++; original.subscription_plan_variation_data.phases[0].pricing.price_money.amount = 14000;
            const annualBinding = (await billing().getAdmin(ADMIN)).bindings.find(item => item.cadence === 'ANNUAL');
            await billing().saveBinding(ADMIN, 'multi', { cadence: 'ANNUAL', variationId: annual.variationId, enabled: true, expectedVerifiedAtMs: annualBinding.verifiedAtMs });
            clock += 31000;
            assert.equal((await billing().getStatus(actor(204))).subscription.amount, 12000, 'historical subscription uses immutable agreed price');
            const disabled = outcomes.find(item => item.status === 'fulfilled').value;
            await billing().saveBinding(ADMIN, 'multi', { cadence: 'MONTHLY', variationId: monthly.variationId, enabled: true, expectedVerifiedAtMs: disabled.verifiedAtMs });
        });
        await t.test('yearly coupon phases discount one full yearly invoice and keep subsequent yearly price and status exact', async () => {
            await commerce().saveCoupon(ADMIN, { code: 'YEAR20', label: 'Year 20%', type: 'percent', value: 20, currency: null, planIds: ['multi'], enabled: true, expiresAtMs: null, totalLimit: 1, userLimit: 1, expectedUpdatedAtMs: null });
            const q = await quote(207, annual.variationId, 'YEAR20'); assert.equal(q.plan.firstAmount, 11200); assert.equal(q.plan.regularAmount, 14000);
            const result = await submit(207, q); assert.equal(result.subscription.active, true); assert.equal(result.subscription.amount, 14000); assert.equal(result.subscription.cadence, 'ANNUAL');
            const wire = square.requests.find(item => item.path === '/v2/subscriptions' && item.body.source.name === 'cbte:' + q.checkoutId);
            assert.ok(!Object.hasOwn(wire.body, 'price_override_money'));
            const phases = square.catalog.get(wire.body.plan_variation_id).subscription_plan_variation_data.phases;
            assert.deepEqual(phases.map(item => [item.cadence, item.periods ?? null, item.pricing.price_money.amount]), [['ANNUAL', 1, 11200], ['ANNUAL', null, 14000]]);
            const usage = (await db.queryDatabase('SELECT * FROM automation_square_coupon_uses WHERE checkout_id=?', [q.checkoutId]))[0]; assert.equal(usage.state, 'COMMITTED');
            const sub = [...square.subscriptions.values()].find(item => item.source.name === 'cbte:' + q.checkoutId), regularId = 'YEAR-REGULAR-' + sub.id;
            sub.invoice_ids.push(regularId); sub.charged_through_date = '2027-10-31'; sub.version++;
            square.invoices.set(regularId, { id: regularId, subscription_id: sub.id, location_id: 'LOCATION', primary_recipient: { customer_id: sub.customer_id }, status: 'PAID', payment_requests: [{ computed_amount_money: { amount: 14000, currency: 'JPY' }, total_completed_amount_money: { amount: 14000, currency: 'JPY' } }] });
            const checkout = (await db.queryDatabase('SELECT * FROM automation_square_checkouts WHERE id=?', [q.checkoutId]))[0];
            assert.equal(await db.withDatabaseTransaction(query => commerce().confirmInvoice(query, checkout, sub, square.invoices.get(regularId))), 14000);
        });
        await t.test('concurrent additional interval confirmations each acquire their own lease and append rather than overwrite', async () => {
            const results = await Promise.all([bind('QUARTERLY', 3000), bind('EVERY_SIX_MONTHS', 5500)]);
            assert.ok(results.every(item => item.state === 'COMPLETE'));
            const rows = await db.queryDatabase("SELECT cadence FROM automation_square_bindings WHERE plan_id='multi' ORDER BY cadence");
            assert.deepEqual(rows.map(item => item.cadence), ['ANNUAL', 'EVERY_SIX_MONTHS', 'MONTHLY', 'QUARTERLY']);
        });
    } finally { await db.close(); }
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
            square.invoices.get(firstId).status = 'REFUNDED'; clock += 31000; assert.equal((await billing().getStatus(own)).subscription.active, false, 'second invoice at first price must not grant');
            square.invoices.get(secondId).payment_requests[0].computed_amount_money.amount = 1000; square.invoices.get(secondId).payment_requests[0].total_completed_amount_money.amount = 1000; clock += 31000; assert.equal((await billing().getStatus(own)).subscription.active, true);
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
            const sub = [...square.subscriptions.values()].find(item => item.source.name === 'cbte:' + q.checkoutId); square.invoices.get(sub.invoice_ids[0]).status = 'REFUNDED'; clock += 31000; assert.equal((await billing().getStatus(own)).subscription.active, false);
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
        const legacyRequest = body => {
            body.object.present_at_all_locations = false; body.object.present_at_location_ids = ['LOCATION'];
            for (const child of body.object.subscription_plan_data.subscription_plan_variations) { child.present_at_all_locations = false; child.present_at_location_ids = ['LOCATION']; }
            return body;
        };
        async function legacyQuote(id) {
            await plan(id); const q = await commerce().createCatalogQuote(ADMIN, { planId: id, name: id, amount: 1400, currency: 'JPY', cadence: 'MONTHLY' });
            const record = (await db.queryDatabase('SELECT request_json FROM automation_square_catalog_creations WHERE id=?', [q.creationId]))[0], original = legacyRequest(JSON.parse(record.request_json));
            await db.queryDatabase('UPDATE automation_square_catalog_creations SET request_json=? WHERE id=?', [JSON.stringify(original), q.creationId]);
            return { q, original };
        }
        async function legacyCouponCache(q) {
            const terms = q.plan.coupon, identity = createHash('sha256').update(JSON.stringify([['sandbox','MERCHANT'], q.plan.variationId, q.plan.catalogVersion, terms])).digest('hex'), name = q.plan.catalogName + ' [' + terms.code + ']';
            const phase = (ordinal, amount, periods) => ({ ordinal, cadence: terms.cadence, ...(periods ? { periods } : {}), pricing: { type: 'STATIC', price_money: { amount, currency: terms.currency } } });
            const original = legacyRequest({ idempotency_key: identity, object: { type: 'SUBSCRIPTION_PLAN', id: '#plan-' + identity, subscription_plan_data: { name,
                subscription_plan_variations: [{ type: 'SUBSCRIPTION_PLAN_VARIATION', id: '#variation-' + identity, subscription_plan_variation_data: { name, subscription_plan_id: '#plan-' + identity, can_prorate: false, phases: [phase(0, terms.firstAmount, 1), phase(1, terms.regularAmount)] } }] } } });
            const response = await (await square.fetch('https://connect.squareupsandbox.com/v2/catalog/object', { method: 'POST', body: JSON.stringify(original) })).json(), variationId = response.id_mappings.find(item => item.client_object_id === '#variation-' + identity).object_id;
            await db.queryDatabase("INSERT INTO automation_square_coupon_variations (identity_key,environment,merchant_id,request_json,variation_id,catalog_version,state) VALUES (?,'sandbox','MERCHANT',?,?,?,'READY')", [identity, JSON.stringify(original), variationId, String(clock)]);
            return { identity, original, variationId };
        }
        const repairWires = () => square.requests.filter(item => item.path === '/v2/catalog/object' && item.method === 'POST' && !item.body.object.id.startsWith('#'));
        await t.test('normal and coupon creations are globally active with pinned own parents and no per-location workaround', async () => {
            const base = (await db.queryDatabase("SELECT variation_id FROM automation_square_bindings WHERE plan_id='pro'"))[0], discounted = [...square.catalog.values()].find(item => item.subscription_plan_variation_data.name === 'Pro [SAVE]');
            for (const variation of [square.catalog.get(base.variation_id), discounted]) {
                assert.equal(variation.present_at_all_locations, true); assert.ok(!Object.hasOwn(variation, 'present_at_location_ids'));
                const parent = square.parents.get(variation.subscription_plan_variation_data.subscription_plan_id);
                assert.equal(parent.present_at_all_locations, true); assert.ok(!Object.hasOwn(parent, 'present_at_location_ids'));
                const owned = (await db.queryDatabase('SELECT * FROM automation_square_catalog_ownership WHERE variation_id=?', [variation.id]))[0];
                assert.equal(owned.parent_id, parent.id); assert.equal(owned.state, 'VERIFIED'); assert.equal(owned.repair_request_json, null);
            }
        });
        await t.test('new active requests refuse disabled parent or child even when per-location IDs include the merchant location', async () => {
            for (const parentDisabled of [false, true]) {
                const id = parentDisabled ? 'disabledparent' : 'disabledchild'; await plan(id);
                const q = await commerce().createCatalogQuote(ADMIN, { planId: id, name: id, amount: 1400, currency: 'JPY', cadence: 'MONTHLY' }), before = repairWires().length;
                if (parentDisabled) square.state.mutateParent = parent => { parent.present_at_all_locations = false; parent.present_at_location_ids = ['LOCATION']; };
                else square.state.mutate = child => { child.present_at_all_locations = false; child.present_at_location_ids = ['LOCATION']; };
                try { await assert.rejects(commerce().confirmCatalogCreation(ADMIN, { creationId: q.creationId, consent: true }), { code: 'SQUARE_CATALOG_DISABLED' }); }
                finally { square.state.mutate = null; square.state.mutateParent = null; }
                assert.equal(repairWires().length, before); assert.equal((await db.queryDatabase('SELECT * FROM automation_square_bindings WHERE plan_id=?', [id])).length, 0);
            }
            const base = (await db.queryDatabase("SELECT variation_id FROM automation_square_bindings WHERE plan_id='pro'"))[0], child = square.catalog.get(base.variation_id);
            child.present_at_all_locations = false; child.present_at_location_ids = ['LOCATION'];
            try { await assert.rejects(quote(actor(90)), { code: 'SQUARE_PLAN_UNSUPPORTED' }); }
            finally { child.present_at_all_locations = true; delete child.present_at_location_ids; }
        });
        await t.test('legacy admin repair freezes one CAS payload before the wire and survives two lost ACKs without duplicate objects or bindings', async () => {
            const { q, original } = await legacyQuote('legacyactivation'), before = square.catalog.size, firstRepair = repairWires().length;
            square.state.lostRepair = 2;
            for (let attempt = 0; attempt < 2; attempt++) {
                await assert.rejects(commerce().confirmCatalogCreation(ADMIN, { creationId: q.creationId, consent: true }), { code: 'SQUARE_RESULT_UNKNOWN' });
                const owned = (await db.queryDatabase('SELECT * FROM automation_square_catalog_ownership WHERE request_ref=?', [q.creationId]))[0];
                assert.equal(owned.state, 'REPAIRING'); assert.ok(owned.repair_request_json); assert.equal(square.catalog.size, before + 1);
                assert.equal((await db.queryDatabase('SELECT * FROM automation_square_bindings WHERE plan_id=?', ['legacyactivation'])).length, 0);
            }
            const done = await commerce().confirmCatalogCreation(ADMIN, { creationId: q.creationId, consent: true }); assert.equal(done.state, 'COMPLETE');
            const owned = (await db.queryDatabase('SELECT * FROM automation_square_catalog_ownership WHERE request_ref=?', [q.creationId]))[0], wires = repairWires().slice(firstRepair);
            assert.equal(owned.state, 'VERIFIED'); assert.equal(wires.length, 3); wires.forEach(wire => assert.deepEqual(wire.body, JSON.parse(owned.repair_request_json)));
            assert.equal((await db.queryDatabase('SELECT request_json FROM automation_square_catalog_creations WHERE id=?', [q.creationId]))[0].request_json, JSON.stringify(original));
            await commerce().confirmCatalogCreation(ADMIN, { creationId: q.creationId, consent: true });
            assert.equal(square.catalog.size, before + 1); assert.equal((await db.queryDatabase('SELECT * FROM automation_square_bindings WHERE plan_id=?', ['legacyactivation'])).length, 1);
        });
        await t.test('legacy repairs reject wrong child, parent, name, frozen price and active siblings before activation', async () => {
            const changes = [
                ['wrongchild', child => { child.id = 'UNRELATED-VARIATION'; }],
                ['wrongparent', child => { child.subscription_plan_variation_data.subscription_plan_id = 'UNRELATED-PLAN'; }],
                ['wrongname', child => { child.subscription_plan_variation_data.name = 'Different'; }],
                ['wrongprice', child => { child.subscription_plan_variation_data.phases[0].pricing.price_money.amount = 1; }],
                ['wrongcurrency', child => { child.subscription_plan_variation_data.phases[0].pricing.price_money.currency = 'USD'; }],
                ['wrongcadence', child => { child.subscription_plan_variation_data.phases[0].cadence = 'WEEKLY'; }],
                ['wrongphase', child => { child.subscription_plan_variation_data.phases[0].ordinal = 1; }],
            ];
            for (const [id, mutate] of changes) {
                const { q } = await legacyQuote(id), before = repairWires().length; square.state.mutate = mutate;
                try { await assert.rejects(commerce().confirmCatalogCreation(ADMIN, { creationId: q.creationId, consent: true }), { code: 'SQUARE_CATALOG_MISMATCH' }); }
                finally { square.state.mutate = null; }
                assert.equal(repairWires().length, before); assert.equal((await db.queryDatabase('SELECT * FROM automation_square_bindings WHERE plan_id=?', [id])).length, 0);
            }
            const { q } = await legacyQuote('activesibling'), before = repairWires().length;
            square.state.mutateParent = (parent, child) => { const sibling = structuredClone(child); sibling.id = 'ACTIVE-SIBLING'; sibling.present_at_all_locations = true; square.catalog.set(sibling.id, sibling); parent.subscription_plan_data.subscription_plan_variations.push(sibling); };
            try { await assert.rejects(commerce().confirmCatalogCreation(ADMIN, { creationId: q.creationId, consent: true }), { code: 'SQUARE_CATALOG_REPAIR_COLLATERAL' }); }
            finally { square.state.mutateParent = null; }
            assert.equal(repairWires().length, before); assert.equal(square.parents.get(square.catalog.get('ACTIVE-SIBLING').subscription_plan_variation_data.subscription_plan_id).present_at_all_locations, false);
        });
        await t.test('old READY coupon ownership is recovered by the original key, repairs once after consent, then respects operator stops and existing contracts', async () => {
            await coupon('OLD_CACHE'); const own = actor(91), q = await quote(own, 'OLD_CACHE'), { identity, original, variationId } = await legacyCouponCache(q);
            const count = square.catalog.size, before = repairWires().length; square.state.lostRepair = 2;
            for (let attempt = 0; attempt < 2; attempt++) { await assert.rejects(submit(own, q), { code: 'SQUARE_RESULT_UNKNOWN' }); assert.equal(square.catalog.size, count); }
            assert.equal((await submit(own, q)).subscription.active, true); assert.equal(square.catalog.size, count);
            const owned = (await db.queryDatabase('SELECT * FROM automation_square_catalog_ownership WHERE request_ref=?', [identity]))[0], wires = repairWires().slice(before);
            assert.equal(owned.state, 'VERIFIED'); assert.equal(wires.length, 3); wires.forEach(wire => assert.deepEqual(wire.body, JSON.parse(owned.repair_request_json)));
            const replayed = square.requests.filter(item => item.path === '/v2/catalog/object' && item.body.idempotency_key === identity); replayed.forEach(wire => assert.deepEqual(wire.body, original));
            const parent = square.parents.get(owned.parent_id), child = square.catalog.get(variationId); parent.present_at_all_locations = false; parent.version++; child.present_at_all_locations = false; child.version++;
            const stoppedPostCount = repairWires().length, subscriptions = square.subscriptions.size;
            const later = await quote(actor(92), 'OLD_CACHE'); await assert.rejects(submit(actor(92), later), { code: 'SQUARE_CATALOG_DISABLED' });
            assert.equal(repairWires().length, stoppedPostCount); assert.equal(square.subscriptions.size, subscriptions); assert.equal(parent.present_at_all_locations, false); assert.equal(child.present_at_all_locations, false);
            clock += 31000; assert.equal((await billing().getStatus(own)).subscription.active, true, 'disabling future catalog enrollment does not revoke an existing verified paid invoice');
        });
        await t.test('concurrent consented legacy coupon enrollments reuse one frozen repair and one shared variation', async () => {
            await coupon('CONCURRENT_CACHE'); const first = actor(93), second = actor(94), q1 = await quote(first, 'CONCURRENT_CACHE'), q2 = await quote(second, 'CONCURRENT_CACHE');
            const { identity } = await legacyCouponCache(q1), count = square.catalog.size, before = repairWires().length;
            let release, arrived = 0; const gate = new Promise(resolve => { release = resolve; });
            square.state.gate = async path => { if (path === '/v2/catalog/object' && !square.requests.at(-1).body.object.id.startsWith('#')) { if (++arrived === 2) release(); await gate; } };
            let results;
            try { results = await Promise.all([submit(first, q1), submit(second, q2)]); }
            finally { square.state.gate = null; release(); }
            assert.ok(results.every(result => result.subscription.active)); assert.equal(square.catalog.size, count);
            const wires = repairWires().slice(before), owned = (await db.queryDatabase('SELECT * FROM automation_square_catalog_ownership WHERE request_ref=?', [identity]))[0];
            assert.equal(wires.length, 2); assert.deepEqual(wires[0].body, wires[1].body); assert.equal(owned.state, 'VERIFIED');
            const subscriptions = [q1, q2].map(q => [...square.subscriptions.values()].find(sub => sub.source.name === 'cbte:' + q.checkoutId));
            assert.equal(subscriptions[0].plan_variation_id, subscriptions[1].plan_variation_id);
        });
        await t.test('operator stops after an unknown repair ACK remain stopped when its frozen key is replayed', async () => {
            const { q } = await legacyQuote('stoppedunknown'); square.state.lostRepair = 1;
            await assert.rejects(commerce().confirmCatalogCreation(ADMIN, { creationId: q.creationId, consent: true }), { code: 'SQUARE_RESULT_UNKNOWN' });
            const owned = (await db.queryDatabase('SELECT * FROM automation_square_catalog_ownership WHERE request_ref=?', [q.creationId]))[0], parent = square.parents.get(owned.parent_id), child = square.catalog.get(owned.variation_id);
            parent.present_at_all_locations = false; parent.version++; child.present_at_all_locations = false; child.version++;
            const count = square.catalog.size, before = repairWires().length;
            await assert.rejects(commerce().confirmCatalogCreation(ADMIN, { creationId: q.creationId, consent: true }), { code: 'SQUARE_CATALOG_DISABLED' });
            assert.equal(square.catalog.size, count); assert.equal(parent.present_at_all_locations, false); assert.equal(child.present_at_all_locations, false);
            assert.deepEqual(repairWires()[before].body, JSON.parse(owned.repair_request_json));
            assert.equal((await db.queryDatabase('SELECT * FROM automation_square_bindings WHERE plan_id=?', ['stoppedunknown'])).length, 0);
        });
        await t.test('legacy repair preserves inactive siblings and their monetary terms without creating replacements', async () => {
            const { q } = await legacyQuote('inactivesibling'); let frozenSibling;
            square.state.mutateParent = (parent, child) => {
                const sibling = structuredClone(child); sibling.id = 'INACTIVE-SIBLING'; sibling.present_at_all_locations = false;
                sibling.subscription_plan_variation_data.name = 'Existing inactive sibling'; sibling.subscription_plan_variation_data.phases[0].pricing.price_money.amount = 8765;
                frozenSibling = structuredClone(sibling); square.catalog.set(sibling.id, sibling); parent.subscription_plan_data.subscription_plan_variations.push(sibling);
            };
            const count = square.catalog.size;
            try { assert.equal((await commerce().confirmCatalogCreation(ADMIN, { creationId: q.creationId, consent: true })).state, 'COMPLETE'); }
            finally { square.state.mutateParent = null; }
            const sibling = structuredClone(square.catalog.get('INACTIVE-SIBLING')); delete sibling.version; delete frozenSibling.version;
            assert.deepEqual(sibling, frozenSibling); assert.equal(square.catalog.size, count + 2);
        });
        await t.test('version conflicts preserve the original frozen repair instead of refreshing a key that could overwrite operator changes', async () => {
            const { q } = await legacyQuote('repairconflict'); let changeVersion = true;
            const concurrent = createSquareCommerce({ ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
                const result = await query(sql, params);
                if (changeVersion && sql.startsWith("UPDATE automation_square_catalog_ownership SET state='REPAIRING'")) {
                    changeVersion = false; const owned = (await query('SELECT * FROM automation_square_catalog_ownership WHERE request_ref=?', [q.creationId]))[0]; square.parents.get(owned.parent_id).version++;
                }
                return result;
            })) }, { env: ENV, fetch: square.fetch, clock: () => clock });
            const before = repairWires().length;
            await assert.rejects(concurrent.confirmCatalogCreation(ADMIN, { creationId: q.creationId, consent: true }), { code: 'SQUARE_REQUEST_FAILED' });
            await assert.rejects(commerce().confirmCatalogCreation(ADMIN, { creationId: q.creationId, consent: true }), { code: 'SQUARE_REQUEST_FAILED' });
            const owned = (await db.queryDatabase('SELECT * FROM automation_square_catalog_ownership WHERE request_ref=?', [q.creationId]))[0], wires = repairWires().slice(before);
            assert.equal(owned.state, 'REPAIRING'); assert.equal(wires.length, 2); wires.forEach(wire => assert.deepEqual(wire.body, JSON.parse(owned.repair_request_json)));
            assert.equal(square.parents.get(owned.parent_id).present_at_all_locations, false); assert.equal((await db.queryDatabase('SELECT * FROM automation_square_bindings WHERE plan_id=?', ['repairconflict'])).length, 0);
        });
        await t.test('coupon first-invoice identity survives a truncated remote invoice list and an older usage row without its first ID', async () => {
            const checkout = (await db.queryDatabase("SELECT * FROM automation_square_checkouts WHERE owner_user_id=? AND state='COMPLETE'", [actor(91).userId]))[0], sub = square.subscriptions.get(checkout.subscription_id);
            const remembered = (await db.queryDatabase("SELECT first_invoice_id FROM automation_square_subscription_invoices WHERE environment='sandbox' AND merchant_id='MERCHANT' AND subscription_id=?", [sub.id]))[0].first_invoice_id;
            await db.queryDatabase('UPDATE automation_square_coupon_uses SET first_invoice_id=NULL WHERE checkout_id=?', [checkout.id]);
            const truncated = { ...sub, invoice_ids: ['ONLY-LATEST'] };
            const expected = await db.withDatabaseTransaction(query => commerce().confirmInvoice(query, checkout, truncated, square.invoices.get(remembered)));
            assert.equal(expected, 900); assert.equal((await row(checkout.id)).first_invoice_id, remembered);
        });
    } finally { await db.close(); }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createSquareBilling, getSquareScope, verifyWebhookSignature, dateEnd } = require('../../src/automation/square-billing');
const entitlements = require('../../src/automation/entitlements');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const ENV = { SQUARE_ENVIRONMENT: 'sandbox', SQUARE_ACCESS_TOKEN: 'fixture-token-private', SQUARE_APPLICATION_ID: 'sandbox-app', SQUARE_LOCATION_ID: 'LOCATION',
    SQUARE_MERCHANT_ID: 'MERCHANT', SQUARE_WEBHOOK_SIGNATURE_KEY: 'fixture-signature-private', SQUARE_WEBHOOK_NOTIFICATION_URL: 'https://service.example/api/automation/square/webhook' };
const ADMIN = { userId: '444444444444444444', isAdmin: true };
const actor = value => ({ userId: String(222222222222222000n + BigInt(value)) });
function json(data, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => data }; }
function squareMock() {
    const customers = new Map(), cards = new Map(), subscriptions = new Map(), invoices = new Map(), keys = new Map(), requests = [];
    const state = { lost: null, rejected: null, paid: false, locationMerchant: 'MERCHANT', variation: { id: 'VARIATION', type: 'SUBSCRIPTION_PLAN_VARIATION', version: 1,
        subscription_plan_variation_data: { name: 'Square Pro', phases: [{ cadence: 'MONTHLY', pricing: { type: 'STATIC', price_money: { amount: 1500, currency: 'JPY' } } }] } } };
    const fetch = async (url, options) => {
        assert.ok(url.startsWith('https://connect.squareupsandbox.com/v2/'));
        assert.equal(options.headers.Authorization, `Bearer ${ENV.SQUARE_ACCESS_TOKEN}`);
        const path = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : null;
        requests.push({ path, method: options.method, body });
        if (state.rejected === path) { state.rejected = null; return json({ errors: [{ detail: 'secret server response never forwarded' }] }, 422); }
        let result;
        if (path === '/v2/locations/LOCATION') result = { location: { id: 'LOCATION', merchant_id: state.locationMerchant, status: 'ACTIVE', timezone: 'Asia/Tokyo', currency: 'JPY' } };
        else if (path === '/v2/catalog/object/VARIATION') result = { object: state.variation };
        else if (path === '/v2/catalog/list') result = { objects: [state.variation] };
        else if (path === '/v2/customers' && options.method === 'POST') {
            let customer = keys.get(body.idempotency_key);
            if (!customer) { customer = { id: `CUSTOMER-${customers.size + 1}`, reference_id: body.reference_id, email_address: body.email_address }; keys.set(body.idempotency_key, customer); customers.set(customer.id, customer); }
            result = { customer };
        } else if (path === '/v2/customers/search') result = { customers: [...customers.values()].filter(customer => customer.reference_id === body.query.filter.reference_id.exact) };
        else if (path.startsWith('/v2/customers/')) result = { customer: customers.get(path.slice('/v2/customers/'.length)) };
        else if (path === '/v2/cards' && options.method === 'POST') {
            let card = keys.get(body.idempotency_key);
            if (!card) { card = { id: `ccof:card-${cards.size + 1}`, ...body.card, enabled: true }; keys.set(body.idempotency_key, card); cards.set(card.id, card); }
            result = { card };
        } else if (path === '/v2/cards') result = { cards: [...cards.values()].filter(card => card.customer_id === new URL(url).searchParams.get('customer_id')) };
        else if (path.startsWith('/v2/cards/')) result = { card: cards.get(decodeURIComponent(path.slice('/v2/cards/'.length))) };
        else if (path === '/v2/subscriptions/search') result = { subscriptions: [...subscriptions.values()].filter(sub => body.query.filter.customer_ids.includes(sub.customer_id)) };
        else if (path === '/v2/subscriptions' && options.method === 'POST') {
            let subscription = keys.get(body.idempotency_key);
            if (!subscription) {
                const subscriptionId = `SUBSCRIPTION-${subscriptions.size + 1}`, invoiceId = `inv:INVOICE-${subscriptions.size + 1}`;
                subscription = { id: subscriptionId, location_id: body.location_id, customer_id: body.customer_id, plan_variation_id: body.plan_variation_id,
                    card_id: body.card_id, source: body.source, price_override_money: body.price_override_money, status: 'ACTIVE', version: 1, timezone: 'Asia/Tokyo', charged_through_date: '2026-10-31', invoice_ids: [invoiceId] };
                keys.set(body.idempotency_key, subscription); subscriptions.set(subscription.id, subscription);
                invoices.set(invoiceId, { id: invoiceId, subscription_id: subscriptionId, location_id: body.location_id, primary_recipient: { customer_id: body.customer_id },
                    status: state.paid ? 'PAID' : 'UNPAID', payment_requests: [{ computed_amount_money: { amount: 1500, currency: 'JPY' }, total_completed_amount_money: { amount: state.paid ? 1500 : 0, currency: 'JPY' } }] });
            }
            result = { subscription };
        } else if (path.startsWith('/v2/subscriptions/') && path.endsWith('/cancel')) {
            const subscription = subscriptions.get(path.split('/')[3]); subscription.canceled_date = '2026-10-31'; subscription.version++; result = { subscription };
        } else if (path.startsWith('/v2/subscriptions/')) result = { subscription: subscriptions.get(path.slice('/v2/subscriptions/'.length)) };
        else if (path.startsWith('/v2/invoices/')) result = { invoice: invoices.get(decodeURIComponent(path.slice('/v2/invoices/'.length))) };
        else throw new Error(`Unexpected mock path ${path}`);
        if (state.lost === path && options.method === 'POST') { state.lost = null; throw new Error('response lost after Square side effect'); }
        return json(result);
    };
    return { fetch, state, requests, customers, cards, subscriptions, invoices };
}
function signed(event) { const body = JSON.stringify(event); return { body, signature: createHmac('sha256', ENV.SQUARE_WEBHOOK_SIGNATURE_KEY).update(ENV.SQUARE_WEBHOOK_NOTIFICATION_URL).update(body).digest('base64') }; }

test('Square: signature authenticates exact raw bytes and canonical configured URL with constant-time digest length', () => {
    const raw = '{ "value": 1 }', signature = createHmac('sha256', ENV.SQUARE_WEBHOOK_SIGNATURE_KEY).update(ENV.SQUARE_WEBHOOK_NOTIFICATION_URL).update(raw).digest('base64');
    assert.equal(verifyWebhookSignature(raw, signature, ENV.SQUARE_WEBHOOK_SIGNATURE_KEY, ENV.SQUARE_WEBHOOK_NOTIFICATION_URL), true);
    assert.equal(verifyWebhookSignature('{"value":1}', signature, ENV.SQUARE_WEBHOOK_SIGNATURE_KEY, ENV.SQUARE_WEBHOOK_NOTIFICATION_URL), false);
    assert.equal(verifyWebhookSignature(raw, signature, ENV.SQUARE_WEBHOOK_SIGNATURE_KEY, 'https://forged.example/path'), false);
    assert.equal(verifyWebhookSignature(raw, 'a', ENV.SQUARE_WEBHOOK_SIGNATURE_KEY, ENV.SQUARE_WEBHOOK_NOTIFICATION_URL), false);
});
test('Square: date-only paid period ends at next midnight in actual Square location timezone', () => {
    assert.equal(dateEnd('2026-10-31', 'Asia/Tokyo'), Date.parse('2026-10-31T15:00:00Z'));
    assert.equal(dateEnd('2026-03-08', 'America/Los_Angeles'), Date.parse('2026-03-09T07:00:00Z'));
    assert.equal(dateEnd('2026-02-30', 'Asia/Tokyo'), null);
    assert.equal(dateEnd('2026-10-31', 'unknown'), null);
});
test('Square: explicit fixture environment never imports local production configuration and no secrets enter DTO', async () => {
    assert.deepEqual(getSquareScope({}), { configured: false, environment: null, merchantId: null });
    assert.equal(getSquareScope(ENV).configured, true);
    const billing = createSquareBilling({}, { env: {} });
    const result = await billing.getAdmin(ADMIN);
    assert.equal(result.configured, false); assert.ok(result.missing.includes('SQUARE_WEBHOOK_SIGNATURE_KEY'));
    assert.equal((await billing.getOptions(actor(1))).configured, false);
    assert.equal((await billing.getStatus(actor(1))).subscription, null);
    await assert.rejects(billing.subscribe(actor(1), {}), { code: 'SQUARE_NOT_CONFIGURED' });
    await assert.rejects(billing.getAdmin(actor(1)), { code: 'AUTOMATION_FORBIDDEN' });
});

test('Square real SQL with mocked REST: paid subscription lifecycle, exact user binding, retries and webhook integrity', { skip: !port, timeout: 120000 }, async t => {
    const db = await createTestDatabase(port), square = squareMock();
    let clock = Date.parse('2026-10-13T00:00:00Z');
    const make = overrides => createSquareBilling(db, { env: ENV, fetch: square.fetch, clock: () => clock, ...overrides });
    const billing = make();
    const quote = owner => billing.createQuote(owner, { planId: 'pro', email: 'buyer@example.com', name: 'Fixture Buyer', userId: actor(99).userId });
    const submit = (owner, checkout) => billing.subscribe(owner, { checkoutId: checkout.checkoutId, sourceId: `cnon:fixture-${owner.userId}`, consent: true, userId: actor(99).userId, tier: 'forged' });
    const rowFor = owner => db.queryDatabase('SELECT * FROM automation_square_subscriptions WHERE owner_user_id=?', [owner.userId]).then(rows => rows[0]);
    const cancellationFor = async owner => { const row = await rowFor(owner); return { subscriptionId: row.subscription_id, checkoutId: row.checkout_id }; };
    const eventFor = (row, eventId, type = 'subscription.updated', overrides = {}) => signed({ event_id: eventId, merchant_id: 'MERCHANT', type, data: { id: row.subscription_id, object: { subscription: { id: row.subscription_id, status: 'ACTIVE' } } }, ...overrides });
    try {
        await entitlements.savePlanPolicy(db.queryDatabase, ADMIN, { planId: 'pro', label: 'Pro', slotLimit: 15, minuteLimit: 12, dayLimit: 500, priority: 3 });
        await t.test('only verified admin binds supported Square fixed indefinite variation; catalog choices and public price are safe', async () => {
            await assert.rejects(billing.saveBinding(actor(1), 'pro', { variationId: 'VARIATION', enabled: true }), { code: 'AUTOMATION_FORBIDDEN' });
            await assert.rejects(billing.saveBinding(ADMIN, 'free', { variationId: 'VARIATION', enabled: true }), { code: 'SQUARE_INVALID_INPUT' });
            const saved = await billing.saveBinding(ADMIN, 'pro', { variationId: 'VARIATION', enabled: true }); assert.equal(saved.amount, 1500); assert.equal(saved.cadence, 'MONTHLY');
            const admin = await billing.getAdmin(ADMIN); assert.equal(admin.availableVariations.length, 1); assert.equal(admin.bindings.length, 1);
            const options = await billing.getOptions(actor(1)); assert.equal(options.plans[0].slotLimit, 15); assert.equal(options.applicationId, 'sandbox-app');
            assert.ok(!JSON.stringify([admin, options]).includes(ENV.SQUARE_ACCESS_TOKEN)); assert.ok(!JSON.stringify([admin, options]).includes(ENV.SQUARE_WEBHOOK_SIGNATURE_KEY));
            square.state.variation.subscription_plan_variation_data.phases[0].periods = 1;
            await assert.rejects(billing.saveBinding(ADMIN, 'pro', { variationId: 'VARIATION', enabled: true }), { code: 'SQUARE_PLAN_UNSUPPORTED' });
            delete square.state.variation.subscription_plan_variation_data.phases[0].periods;
            const disabled = await billing.saveBinding(ADMIN, 'pro', { variationId: 'VARIATION', enabled: false, expectedVerifiedAtMs: saved.verifiedAtMs });
            assert.ok(disabled.verifiedAtMs > saved.verifiedAtMs);
            await assert.rejects(make().saveBinding(ADMIN, 'pro', { variationId: 'VARIATION', enabled: true, expectedVerifiedAtMs: saved.verifiedAtMs }), { code: 'SQUARE_BINDING_CONFLICT', status: 409 });
            assert.equal((await billing.getOptions(actor(1))).plans.length, 0);
            await billing.saveBinding(ADMIN, 'pro', { variationId: 'VARIATION', enabled: true, expectedVerifiedAtMs: disabled.verifiedAtMs });
            square.state.locationMerchant = 'OTHER'; await assert.rejects(quote(actor(1)), { code: 'SQUARE_ACCOUNT_MISMATCH' }); square.state.locationMerchant = 'MERCHANT';
        });
        await t.test('receipt email validation rejects oversized malformed input before Square I/O and accepts bounded subdomains', async () => {
            const invalid = ['', 'buyer@@example.com', 'buyer@.com', 'buyer@example', 'buyer@example.com.', 'buyer@exa mple.com', `buyer@${'a.'.repeat(10000)} bad`];
            for (const email of invalid) {
                const before = square.requests.length;
                await assert.rejects(billing.createQuote(actor(84), { planId: 'pro', email, name: 'Fixture Buyer' }), { code: 'SQUARE_EMAIL_REQUIRED' });
                assert.equal(square.requests.length, before);
            }
            for (const email of ['buyer+tag@deep.mail.example.co.jp', 'a'.repeat(240) + '@example.co.uk']) {
                const result = await billing.createQuote(actor(85), { planId: 'pro', email, name: 'Fixture Buyer' });
                assert.equal(result.email, email); assert.ok(result.checkoutId);
            }
        });
        await t.test('quote is owned by session; client user/tier/price ignored; consent and unexpired confirmed price required before card wire', async () => {
            const own = actor(1), checkout = await quote(own);
            await assert.rejects(submit(actor(2), checkout), { code: 'SQUARE_CHECKOUT_NOT_FOUND' });
            await assert.rejects(billing.subscribe(own, { checkoutId: checkout.checkoutId, sourceId: 'cnon:ok', consent: false }), { code: 'SQUARE_CONSENT_REQUIRED' });
            const count = square.cards.size; square.state.variation.version++;
            await assert.rejects(submit(own, checkout), { code: 'SQUARE_QUOTE_CHANGED' }); assert.equal(square.cards.size, count);
            const expired = await quote(actor(3)); clock += 16 * 60000;
            await assert.rejects(submit(actor(3), expired), { code: 'SQUARE_QUOTE_EXPIRED' }); clock -= 16 * 60000;
        });
        await t.test('concurrent admin bindings admit one paid plan for a variation and never rewrite the other plan on unique-key collision', async () => {
            await entitlements.savePlanPolicy(db.queryDatabase, ADMIN, { planId: 'alternate', label: 'Alternate', slotLimit: 15, minuteLimit: 12, dayLimit: 500, priority: 3 });
            await db.queryDatabase('DELETE FROM automation_square_bindings WHERE plan_id=?', ['pro']);
            const otherAdmin = { userId: actor(80).userId, isAdmin: true };
            const outcomes = await Promise.allSettled([billing.saveBinding(ADMIN, 'pro', { variationId: 'VARIATION', enabled: true }), make().saveBinding(otherAdmin, 'alternate', { variationId: 'VARIATION', enabled: true })]);
            assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
            assert.equal(outcomes.filter(item => item.status === 'rejected')[0].reason.code, 'SQUARE_VARIATION_IN_USE');
            const rows = await db.queryDatabase('SELECT plan_id FROM automation_square_bindings WHERE variation_id=?', ['VARIATION']); assert.equal(rows.length, 1);
            await db.queryDatabase('DELETE FROM automation_square_bindings WHERE plan_id=?', ['alternate']);
            const baseline = (await billing.getAdmin(ADMIN)).bindings.find(item => item.planId === 'pro');
            await billing.saveBinding(ADMIN, 'pro', { variationId: 'VARIATION', enabled: true, expectedVerifiedAtMs: baseline?.verifiedAtMs ?? null });
            await db.queryDatabase('DELETE FROM automation_notification_plans WHERE plan_id=?', ['alternate']);
        });
        await t.test('ACTIVE without paid current invoice never grants entitlement; PAID verifies customer/location/currency and exact paid period', async () => {
            const own = actor(4), checkout = await quote(own), initial = await submit(own, checkout);
            assert.equal(initial.subscription.state, 'ACTIVE'); assert.equal(initial.subscription.active, false); assert.equal(initial.pending, null);
            let row = await rowFor(own); assert.equal(row.owner_user_id, own.userId); assert.equal(row.valid_until_at_ms, null);
            const invoice = square.invoices.get(row.current_invoice_id); invoice.status = 'PAID'; invoice.payment_requests[0].total_completed_amount_money.amount = 1500;
            const notification = eventFor(row, 'event-paid'); await billing.handleWebhook(notification.body, notification.signature);
            const result = await billing.getStatus(own); assert.equal(result.subscription.active, true); assert.equal(result.subscription.validUntilAtMs, Date.parse('2026-10-31T15:00:00Z'));
            assert.equal((await rowFor(own)).owner_user_id, own.userId);
            const charges = square.requests.filter(request => request.path === '/v2/subscriptions' && request.method === 'POST'); assert.equal(charges[0].body.price_override_money.amount, checkout.plan.amount);
            assert.equal((await billing.getStatus(actor(99))).subscription, null);
        });
        await t.test('invalid signatures/merchant and mismatched customer cannot elevate plan; duplicates are durable across instances', async () => {
            const row = await rowFor(actor(4)), notification = eventFor(row, 'event-paid');
            await assert.rejects(billing.handleWebhook(notification.body, 'bad'), { code: 'SQUARE_WEBHOOK_SIGNATURE_INVALID' });
            const forged = eventFor(row, 'event-forged', 'subscription.updated', { merchant_id: 'OTHER' }); await assert.rejects(billing.handleWebhook(forged.body, forged.signature), { code: 'SQUARE_WEBHOOK_ACCOUNT_MISMATCH' });
            const before = square.requests.length; assert.deepEqual(await make().handleWebhook(notification.body, notification.signature), { accepted: true, duplicate: true }); assert.equal(square.requests.length, before);
            const changed = eventFor(row, 'event-paid', 'subscription.updated', { created_at: 'modified' }); await assert.rejects(billing.handleWebhook(changed.body, changed.signature), { code: 'SQUARE_WEBHOOK_CONFLICT' });
            const sub = square.subscriptions.get(row.subscription_id), original = sub.customer_id; sub.customer_id = 'OTHER';
            const mismatch = eventFor(row, 'event-mismatch'); await assert.rejects(billing.handleWebhook(mismatch.body, mismatch.signature), { code: 'SQUARE_ACCOUNT_MISMATCH' }); sub.customer_id = original;
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_square_webhook_events WHERE event_id=?', ['event-mismatch']))[0].n), 0);
        });
        await t.test('older signed paid/ACTIVE notification reconciles current unpaid/refunded/paused REST instead of resurrecting access', async () => {
            const own = actor(4), row = await rowFor(own), invoice = square.invoices.get(row.current_invoice_id), sub = square.subscriptions.get(row.subscription_id);
            invoice.status = 'PARTIALLY_REFUNDED';
            const old = eventFor(row, 'event-out-of-order'); await billing.handleWebhook(old.body, old.signature); assert.equal((await billing.getStatus(own)).subscription.active, false);
            invoice.status = 'PAID'; sub.status = 'PAUSED'; sub.version++;
            const paused = eventFor(row, 'event-paused'); await billing.handleWebhook(paused.body, paused.signature); assert.equal((await billing.getStatus(own)).subscription.active, false);
            sub.status = 'ACTIVE'; sub.version++; invoice.payment_requests[0].total_completed_amount_money.currency = 'USD';
            const badCurrency = eventFor(row, 'event-currency'); await billing.handleWebhook(badCurrency.body, badCurrency.signature); assert.equal((await billing.getStatus(own)).subscription.active, false);
            invoice.payment_requests[0].total_completed_amount_money.currency = 'JPY';
        });
        await t.test('lost subscription response preserves durable checkout; GET refresh recovers existing contract after restart without another charge', async () => {
            const own = actor(5), checkout = await quote(own); square.state.paid = true; square.state.lost = '/v2/subscriptions';
            const createdBefore = square.subscriptions.size;
            await assert.rejects(submit(own, checkout), { code: 'SQUARE_RESULT_UNKNOWN' }); assert.equal(square.subscriptions.size, createdBefore + 1);
            await assert.rejects(quote(own), { code: 'SQUARE_CHECKOUT_PENDING' });
            const posts = square.requests.filter(request => request.path === '/v2/subscriptions').length;
            const recovered = await make().getStatus(own); assert.equal(recovered.subscription.active, true); assert.equal(recovered.pending, null);
            assert.equal(square.requests.filter(request => request.path === '/v2/subscriptions').length, posts);
            await submit(own, checkout); assert.equal(square.subscriptions.size, createdBefore + 1);
            await assert.rejects(quote(own), { code: 'SQUARE_ALREADY_SUBSCRIBED' });
        });
        await t.test('lost card response recovers reference-bound stored card; stale nonce replaced only after GET confirms no duplicate charge', async () => {
            const own = actor(6), checkout = await quote(own); square.state.lost = '/v2/cards';
            const count = square.cards.size; await assert.rejects(submit(own, checkout), { code: 'SQUARE_RESULT_UNKNOWN' }); assert.equal(square.cards.size, count + 1);
            const status = await make().getStatus(own); assert.equal(status.pending.state, 'CARD_STORED'); assert.equal(status.pending.retryable, true);
            await make().subscribe(own, { checkoutId: checkout.checkoutId, sourceId: 'cnon:fresh-unused', consent: true }); assert.equal(square.cards.size, count + 1);
        });
        await t.test('unknown prior subscription never frees claim when lookup is eventually consistent and price changes before retry', async () => {
            const own = actor(15), checkout = await quote(own); square.state.lost = '/v2/subscriptions'; await assert.rejects(submit(own, checkout), { code: 'SQUARE_RESULT_UNKNOWN' });
            const hidden = make({ fetch: async (url, options) => new URL(url).pathname === '/v2/subscriptions/search' ? json({ subscriptions: [] }) : square.fetch(url, options) });
            square.state.variation.version++;
            await assert.rejects(hidden.subscribe(own, { checkoutId: checkout.checkoutId, sourceId: `cnon:fixture-${own.userId}`, consent: true }), { code: 'SQUARE_QUOTE_CHANGED' });
            await assert.rejects(quote(own), { code: 'SQUARE_CHECKOUT_PENDING' });
            const saved = await db.queryDatabase('SELECT state FROM automation_square_checkouts WHERE id=?', [checkout.checkoutId]); assert.equal(saved[0].state, 'SUBSCRIPTION_SUBMITTING');
            assert.equal((await make().getStatus(own)).pending, null);
        });
        await t.test('concurrent duplicate submissions are serialized across module instances; exactly one card and contract are created', async () => {
            const own = actor(7), checkout = await quote(own), before = square.subscriptions.size;
            const results = await Promise.allSettled([submit(own, checkout), make().subscribe(own, { checkoutId: checkout.checkoutId, sourceId: `cnon:fixture-${own.userId}`, consent: true })]);
            assert.ok(results.some(result => result.status === 'fulfilled')); assert.equal(square.subscriptions.size, before + 1);
            assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'SQUARE_CHECKOUT_BUSY'));
        });
        await t.test('database failure after subscription exists is unknown and never frees claim; refresh safely recovers same subscription', async () => {
            const own = actor(8), checkout = await quote(own); let failOnce = true;
            const brokenDb = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
                if (failOnce && sql.startsWith('INSERT INTO automation_square_subscriptions')) { failOnce = false; throw new Error('fixture persistence failure'); }
                return query(sql, params);
            })) };
            const broken = createSquareBilling(brokenDb, { env: ENV, fetch: square.fetch, clock: () => clock });
            const before = square.subscriptions.size;
            await assert.rejects(broken.subscribe(own, { checkoutId: checkout.checkoutId, sourceId: `cnon:fixture-${own.userId}`, consent: true }), { code: 'SQUARE_RESULT_UNKNOWN' });
            await assert.rejects(quote(own), { code: 'SQUARE_CHECKOUT_PENDING' });
            assert.equal((await make().getStatus(own)).subscription.active, true); assert.equal(square.subscriptions.size, before + 1);
        });
        await t.test('known rejected subscription never grants and safely permits a new reviewed quote', async () => {
            const own = actor(9), checkout = await quote(own); square.state.rejected = '/v2/subscriptions';
            await assert.rejects(submit(own, checkout), { code: 'SQUARE_REQUEST_FAILED' });
            assert.equal((await billing.getStatus(own)).subscription, null); assert.ok((await quote(own)).checkoutId);
        });
        await t.test('lost customer response recovers exact server reference without creating another customer or charging on refresh', async () => {
            const own = actor(10), checkout = await quote(own); square.state.lost = '/v2/customers';
            const before = square.customers.size; await assert.rejects(submit(own, checkout), { code: 'SQUARE_RESULT_UNKNOWN' }); assert.equal(square.customers.size, before + 1);
            const recovered = await make().getStatus(own); assert.equal(recovered.pending.state, 'CUSTOMER_READY'); assert.equal(recovered.pending.quote.name, 'Fixture Buyer');
            await make().subscribe(own, { checkoutId: checkout.checkoutId, sourceId: 'cnon:fresh-customer-recovery', consent: true }); assert.equal(square.customers.size, before + 1);
            const rows = await db.queryDatabase('SELECT source_digest FROM automation_square_checkouts WHERE id=?', [checkout.checkoutId]); assert.equal(rows[0].source_digest.length, 64); assert.ok(!JSON.stringify(rows).includes('cnon:'));
        });
        await t.test('a crash after the pre-wire lease commit is safely reclaimed after expiry with no remote enrollment', async () => {
            const own = actor(90), checkout = await quote(own), before = square.requests.length; let crash = true;
            const crashing = createSquareBilling({ ...db, withDatabaseTransaction: async work => {
                let leased = false;
                const result = await db.withDatabaseTransaction(query => work(async (sql, params) => {
                    if (sql.startsWith('UPDATE automation_square_checkouts SET source_digest=')) leased = true;
                    return query(sql, params);
                }));
                if (leased && crash) { crash = false; throw new Error('fixture crash after committed checkout claim'); }
                return result;
            } }, { env: ENV, fetch: square.fetch, clock: () => clock });
            await assert.rejects(crashing.subscribe(own, { checkoutId: checkout.checkoutId, sourceId: 'cnon:crash', consent: true }), /fixture crash/);
            assert.equal(square.requests.slice(before).filter(item => ['/v2/customers','/v2/cards','/v2/subscriptions'].includes(item.path) && item.method === 'POST').length, 0);
            await assert.rejects(billing.abort(own, { checkoutId: checkout.checkoutId }), { code: 'SQUARE_ABORT_UNAVAILABLE' });
            clock += 6 * 60000;
            const recovered = await make().getStatus(own); assert.equal(recovered.pending, null); assert.equal(recovered.subscription, null);
            assert.equal((await db.queryDatabase('SELECT state FROM automation_square_checkouts WHERE id=?', [checkout.checkoutId]))[0].state, 'FAILED');
            assert.ok((await quote(own)).checkoutId);
        });
        await t.test('explicit stored-card resume survives reload, checks owner and consent, and concurrently creates one contract without a nonce', async () => {
            const own = actor(91), checkout = await quote(own); square.state.lost = '/v2/cards';
            await assert.rejects(submit(own, checkout), { code: 'SQUARE_RESULT_UNKNOWN' });
            const pending = (await make().getStatus(own)).pending; assert.equal(pending.resumeAllowed, true); assert.equal(pending.abortAllowed, true);
            const beforeCards = square.cards.size, beforeSubscriptions = square.subscriptions.size;
            await assert.rejects(make().resume(actor(92), { checkoutId: checkout.checkoutId, consent: true }), { code: 'SQUARE_CHECKOUT_NOT_FOUND' });
            await assert.rejects(make().resume(own, { checkoutId: checkout.checkoutId, consent: false }), { code: 'SQUARE_CONSENT_REQUIRED' });
            const results = await Promise.allSettled([make().resume(own, { checkoutId: checkout.checkoutId, consent: true }), make().resume(own, { checkoutId: checkout.checkoutId, consent: true })]);
            assert.ok(results.some(item => item.status === 'fulfilled'));
            assert.ok(results.filter(item => item.status === 'rejected').every(item => item.reason.code === 'SQUARE_CHECKOUT_BUSY'));
            assert.equal(square.cards.size, beforeCards); assert.equal(square.subscriptions.size, beforeSubscriptions + 1);
            assert.equal((await rowFor(own)).checkout_id, checkout.checkoutId);
        });
        await t.test('unknown enrollment is searched first, never downgraded to an abortable stage, and is resumed without another charge', async () => {
            const own = actor(93), checkout = await quote(own); square.state.lost = '/v2/subscriptions';
            await assert.rejects(submit(own, checkout), { code: 'SQUARE_RESULT_UNKNOWN' });
            await assert.rejects(make().abort(own, { checkoutId: checkout.checkoutId }), { code: 'SQUARE_ABORT_UNAVAILABLE' });
            const hidden = make({ fetch: async (url, options) => new URL(url).pathname === '/v2/subscriptions/search' ? json({ subscriptions: [] }) : square.fetch(url, options) });
            square.state.variation.version++;
            await assert.rejects(hidden.resume(own, { checkoutId: checkout.checkoutId, consent: true }), { code: 'SQUARE_QUOTE_CHANGED' });
            assert.equal((await db.queryDatabase('SELECT state FROM automation_square_checkouts WHERE id=?', [checkout.checkoutId]))[0].state, 'SUBSCRIPTION_SUBMITTING');
            await assert.rejects(make().abort(own, { checkoutId: checkout.checkoutId }), { code: 'SQUARE_ABORT_UNAVAILABLE' });
            const before = square.requests.length, count = square.subscriptions.size;
            assert.equal((await make().resume(own, { checkoutId: checkout.checkoutId, consent: true })).subscription.active, true);
            assert.equal(square.requests[before + 1].path, '/v2/subscriptions/search');
            assert.equal(square.requests.slice(before).filter(item => item.path === '/v2/subscriptions' && item.method === 'POST').length, 0);
            assert.equal(square.subscriptions.size, count);
        });
        await t.test('aborting unknown card storage releases a coupon atomically and stops a delayed worker before enrollment', async () => {
            const commerce = require('../../src/automation/square-commerce').createSquareCommerce(db, { env: ENV, fetch: square.fetch, clock: () => clock });
            await commerce.saveCoupon(ADMIN, { code: 'ABORT', label: 'Abort', type: 'fixed', value: 100, currency: 'JPY', planIds: ['pro'], enabled: true, totalLimit: 1, userLimit: 1, expiresAtMs: null, expectedUpdatedAtMs: null });
            const own = actor(94), checkout = await billing.createQuote(own, { planId: 'pro', email: 'buyer@example.com', name: 'Fixture Buyer', couponCode: 'ABORT' });
            await db.queryDatabase('INSERT INTO automation_square_accounts (owner_user_id,environment,merchant_id,current_checkout_id,updated_at_ms) VALUES (?,?,?,?,?)', [own.userId, 'sandbox', 'MERCHANT', checkout.checkoutId, clock]);
            await db.queryDatabase("UPDATE automation_square_checkouts SET state='CARD_SUBMITTING',lease_token=?,lease_until_at_ms=? WHERE id=?", ['00000000-0000-0000-0000-000000000000', clock - 1, checkout.checkoutId]);
            await db.queryDatabase("UPDATE automation_square_coupon_uses SET state='SUBMITTING' WHERE checkout_id=?", [checkout.checkoutId]);
            const result = await billing.abort(own, { checkoutId: checkout.checkoutId }); assert.equal(result.pending, null);
            assert.equal((await db.queryDatabase('SELECT state FROM automation_square_coupon_uses WHERE checkout_id=?', [checkout.checkoutId]))[0].state, 'RELEASED');
            const late = await db.queryDatabase("UPDATE automation_square_checkouts SET state='SUBSCRIPTION_SUBMITTING' WHERE id=? AND lease_token=? AND state<>'COMPLETE'", [checkout.checkoutId, '00000000-0000-0000-0000-000000000000']); assert.equal(late.affectedRows, 0);
            await billing.createQuote(own, { planId: 'pro', email: 'buyer@example.com', name: 'Fixture Buyer', couponCode: 'ABORT' });
            const customerOnly = await quote(actor(95));
            await assert.rejects(make().resume(actor(95), { checkoutId: customerOnly.checkoutId, consent: true }), { code: 'SQUARE_RESUME_UNAVAILABLE' });
        });
        await t.test('fixed-price underpayment never grants and explicit initial proration uses a verified calendar interval only once', async () => {
            const own = actor(96), checkout = await quote(own); await submit(own, checkout);
            const row = await rowFor(own), invoice = square.invoices.get(row.current_invoice_id);
            invoice.payment_requests = [{ computed_amount_money: { amount: 1, currency: 'JPY' }, total_completed_amount_money: { amount: 1, currency: 'JPY' } }];
            const event = eventFor(row, 'event-underpayment'); await make().handleWebhook(event.body, event.signature);
            assert.equal((await make().getStatus(own)).subscription.active, false);
            const data = square.state.variation.subscription_plan_variation_data; data.can_prorate = true; data.monthly_billing_anchor_date = 15;
            const proratedOwner = actor(97), proratedQuote = await quote(proratedOwner);
            const prorated = make({ fetch: async (url, options) => {
                const response = await square.fetch(url, options);
                if (new URL(url).pathname === '/v2/subscriptions' && options.method === 'POST') {
                    const { subscription } = await response.json(); subscription.start_date = '2026-09-30'; subscription.monthly_billing_anchor_date = 15; subscription.charged_through_date = '2026-10-14';
                    const invoice = square.invoices.get(subscription.invoice_ids[0]); invoice.payment_requests = [{ computed_amount_money: { amount: 750, currency: 'JPY' }, total_completed_amount_money: { amount: 750, currency: 'JPY' } }];
                }
                return response;
            } });
            const paid = await prorated.subscribe(proratedOwner, { checkoutId: proratedQuote.checkoutId, sourceId: 'cnon:prorated', consent: true });
            assert.equal(paid.subscription.active, true); assert.equal(paid.subscription.validUntilAtMs, Date.parse('2026-10-14T15:00:00Z'));
            delete data.can_prorate; delete data.monthly_billing_anchor_date;
            const proratedRow = await rowFor(proratedOwner), sub = square.subscriptions.get(proratedRow.subscription_id), first = square.invoices.get(proratedRow.current_invoice_id);
            const renewal = { ...structuredClone(first), id: 'inv:PRORATION-RENEWAL' }; first.status = 'REFUNDED'; square.invoices.set(renewal.id, renewal); sub.invoice_ids = [renewal.id]; sub.charged_through_date = '2026-11-14'; sub.version++;
            const renewalEvent = eventFor(proratedRow, 'event-proration-renewal'); await make().handleWebhook(renewalEvent.body, renewalEvent.signature);
            assert.equal((await make().getStatus(proratedOwner)).subscription.active, false, 'renewal must not inherit first-invoice proration after the API invoice list changes');
            renewal.payment_requests[0].computed_amount_money.amount = 1500; renewal.payment_requests[0].total_completed_amount_money.amount = 1500;
            const corrected = eventFor(proratedRow, 'event-proration-renewal-paid'); await make().handleWebhook(corrected.body, corrected.signature);
            assert.equal((await make().getStatus(proratedOwner)).subscription.validUntilAtMs, Date.parse('2026-11-14T15:00:00Z'));
        });
        await t.test('durable polling cooldown and single-flight avoid REST fanout across factories; immediate webhook fences a late same-version paid snapshot', async () => {
            const own = actor(98), checkout = await quote(own); await submit(own, checkout);
            const before = square.requests.length;
            assert.equal((await make().getStatus(own)).refresh.state, 'cooldown'); assert.equal((await make().getStatus(own)).refresh.state, 'cooldown'); assert.equal(square.requests.length, before);
            clock += 31000; const row = await rowFor(own), invoice = square.invoices.get(row.current_invoice_id);
            let release, started, once = true; const ready = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
            const slow = make({ fetch: async (url, options) => { const response = await square.fetch(url, options), snapshot = structuredClone(await response.json());
                if (decodeURIComponent(new URL(url).pathname) === `/v2/invoices/${row.current_invoice_id}` && once) { once = false; started(); await gate; }
                return json(snapshot, response.status);
            } }).getStatus(own); await ready;
            const pendingReads = square.requests.length; assert.equal((await make().getStatus(own)).refresh.state, 'busy'); assert.equal(square.requests.length, pendingReads);
            await db.withDatabaseTransaction(query => entitlements.lockOwner(query, own.userId));
            invoice.status = 'REFUNDED'; const event = eventFor(row, 'event-refund-during-status'); await make().handleWebhook(event.body, event.signature);
            assert.equal((await rowFor(own)).valid_until_at_ms, null); release(); await slow;
            assert.equal((await rowFor(own)).valid_until_at_ms, null); assert.equal((await make().getStatus(own)).subscription.active, false);
        });
        await t.test('bounded refresh stops at sixteen REST calls during paginated recovery and keeps durable unknown claims', async () => {
            const own = actor(99), checkout = await quote(own); square.state.lost = '/v2/subscriptions';
            await assert.rejects(submit(own, checkout), { code: 'SQUARE_RESULT_UNKNOWN' });
            const sub = [...square.subscriptions.values()].find(item => item.source.name === 'cbte:' + checkout.checkoutId), first = square.invoices.get(sub.invoice_ids[0]);
            for (let i = 1; i <= 12; i++) {
                const invoice = { ...structuredClone(first), id: 'inv:BUDGET-' + i }; square.invoices.set(invoice.id, invoice);
                await db.queryDatabase('INSERT INTO automation_square_invoice_periods (environment,merchant_id,subscription_id,invoice_id,period_end_at_ms,observed_at_ms) VALUES (?,?,?,?,?,?)', ['sandbox', 'MERCHANT', sub.id, invoice.id, Date.parse('2026-11-30T15:00:00Z') + i * 86400000, clock]);
            }
            let reads = 0, searches = 0;
            const paginated = make({ fetch: async (url, options) => {
                reads++;
                if (new URL(url).pathname === '/v2/subscriptions/search' && ++searches < 10) return json({ subscriptions: [], cursor: 'next-page' });
                return square.fetch(url, options);
            } });
            const result = await paginated.getStatus(own); assert.equal(result.refresh.state, 'failed'); assert.equal(reads, 16); assert.equal(result.subscription.active, false);
            const before = reads; assert.equal((await paginated.getStatus(own)).refresh.state, 'cooldown'); assert.equal(reads, before);
            assert.equal((await db.queryDatabase('SELECT state FROM automation_square_checkouts WHERE id=?', [checkout.checkoutId]))[0].state, 'COMPLETE', 'recovered remote enrollment remains durably recorded even while invoice verification is budgeted');
        });
        await t.test('nonce-free resume rejects changed remote card ownership before any subscription charge', async () => {
            const own = actor(101), checkout = await quote(own); square.state.lost = '/v2/cards'; await assert.rejects(submit(own, checkout), { code: 'SQUARE_RESULT_UNKNOWN' });
            const pending = (await make().getStatus(own)).pending; assert.equal(pending.resumeAllowed, true);
            const saved = (await db.queryDatabase('SELECT card_id FROM automation_square_checkouts WHERE id=?', [checkout.checkoutId]))[0], card = square.cards.get(saved.card_id); card.customer_id = 'FOREIGN-CUSTOMER';
            const before = square.requests.length;
            await assert.rejects(make().resume(own, { checkoutId: checkout.checkoutId, consent: true }), { code: 'SQUARE_ACCOUNT_MISMATCH' });
            assert.equal(square.requests.slice(before).filter(item => item.path === '/v2/subscriptions' && item.method === 'POST').length, 0);
            assert.equal((await db.queryDatabase('SELECT state FROM automation_square_checkouts WHERE id=?', [checkout.checkoutId]))[0].state, 'CARD_STORED');
        });
        await t.test('unverifiable paid first proration retains an actionable warning and cancellation access after reload without granting', async () => {
            const data = square.state.variation.subscription_plan_variation_data; data.can_prorate = true; data.monthly_billing_anchor_date = 15;
            try {
                const own = actor(102), checkout = await quote(own);
                const submitted = await submit(own, checkout); assert.equal(submitted.refresh.state, 'failed'); assert.equal(submitted.verificationWarning.code, 'SQUARE_PRORATION_UNVERIFIED'); assert.match(submitted.verificationWarning.message, /管理者にお問い合わせ/);
                const row = await rowFor(own); assert.equal(Number(row.verified), 0); assert.equal(row.valid_until_at_ms, null);
                const restored = await make().getStatus(own); assert.equal(restored.subscription.active, false); assert.equal(restored.verificationWarning.code, 'SQUARE_PRORATION_UNVERIFIED');
                const canceled = await make().cancel(own, await cancellationFor(own)); assert.equal(canceled.subscription.cancelScheduled, true); assert.equal(canceled.subscription.active, false); assert.equal(canceled.verificationWarning.code, 'SQUARE_PRORATION_UNVERIFIED');
                const before = square.requests.length; await make().cancel(own, await cancellationFor(own)); assert.equal(square.requests.length, before);
                const invoice = square.invoices.get(square.subscriptions.get(row.subscription_id).invoice_ids[0]); invoice.status = 'REFUNDED';
                const event = eventFor(row, 'event-unverifiable-proration-refund'); await make().handleWebhook(event.body, event.signature);
                assert.equal((await rowFor(own)).valid_until_at_ms, null);
            } finally { delete data.can_prorate; delete data.monthly_billing_anchor_date; }
        });
        await t.test('future unpaid invoice preserves independently recorded paid remainder and never extends it; refund revokes that remainder', async () => {
            const own = actor(12), checkout = await quote(own); square.state.paid = true; await submit(own, checkout);
            const row = await rowFor(own), sub = square.subscriptions.get(row.subscription_id), oldInvoice = square.invoices.get(row.current_invoice_id);
            const futureId = 'inv:FUTURE', future = { ...structuredClone(oldInvoice), id: futureId, status: 'UNPAID' }; future.payment_requests[0].total_completed_amount_money.amount = 0;
            square.invoices.set(futureId, future); sub.invoice_ids.unshift(futureId); sub.charged_through_date = '2026-11-30'; sub.version++;
            clock += 31000; const result = await billing.getStatus(own); assert.equal(result.subscription.active, true); assert.equal(result.subscription.validUntilAtMs, Date.parse('2026-10-31T15:00:00Z'));
            oldInvoice.status = 'REFUNDED'; clock += 31000; const refunded = await billing.getStatus(own); assert.equal(refunded.subscription.active, false); assert.equal(refunded.subscription.validUntilAtMs, null);
            future.status = 'PAID'; future.payment_requests[0].total_completed_amount_money.amount = 1500;
            clock += 31000; const renewal = await billing.getStatus(own); assert.equal(renewal.subscription.validUntilAtMs, Date.parse('2026-11-30T15:00:00Z'));
        });
        await t.test('observed refund persists even if cancel result is unknown; a stale PAID read cannot overwrite later refund with same subscription version', async () => {
            const own = actor(13), checkout = await quote(own); await submit(own, checkout);
            const row = await rowFor(own), invoice = square.invoices.get(row.current_invoice_id);
            let held = false, release, started;
            const ready = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
            const fetch = async (url, options) => {
                if (new URL(url).pathname.endsWith('/cancel')) return json({ errors: [{ code: 'INTERNAL_SERVER_ERROR' }] }, 503);
                const response = await square.fetch(url, options), snapshot = structuredClone(await response.json());
                if (decodeURIComponent(new URL(url).pathname) === `/v2/invoices/${row.current_invoice_id}` && !held) { held = true; started(); await gate; }
                return json(snapshot, response.status);
            };
            const slow = make({ fetch }).cancel(own, await cancellationFor(own)).catch(error => error); await ready;
            invoice.status = 'REFUNDED';
            const busy = await make().getStatus(own); assert.equal(busy.refresh.state, 'busy');
            const refundEvent = eventFor(row, 'event-refund-during-cancel');
            await make().handleWebhook(refundEvent.body, refundEvent.signature); release();
            assert.equal((await slow).code, 'SQUARE_RESULT_UNKNOWN');
            assert.equal((await rowFor(own)).valid_until_at_ms, null);
            // No parallel refresh is required to preserve a refund already
            // observed by the failing cancel itself.
            clock += 31000; // A new cancel attempt is admitted after its dedicated cooldown.
            const alone = make({ fetch: async (url, options) => new URL(url).pathname.endsWith('/cancel') ? json({ errors: [{}] }, 503) : square.fetch(url, options) });
            await assert.rejects(alone.cancel(own, await cancellationFor(own)), { code: 'SQUARE_RESULT_UNKNOWN' }); assert.equal((await rowFor(own)).valid_until_at_ms, null);
        });
        await t.test('slow old checkout recovery cannot replace a newly completed subscription for the same owner', async () => {
            const own = actor(14), checkout = await quote(own); square.state.lost = '/v2/subscriptions'; await assert.rejects(submit(own, checkout), { code: 'SQUARE_RESULT_UNKNOWN' });
            let release, started, once = true;
            const ready = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
            const slowFetch = async (url, options) => {
                const response = await square.fetch(url, options), snapshot = structuredClone(await response.json());
                if (new URL(url).pathname === '/v2/subscriptions/search' && once) { once = false; started(); await gate; }
                return json(snapshot, response.status);
            };
            const slow = make({ fetch: slowFetch }).getStatus(own); await ready;
            assert.equal((await make().getStatus(own)).refresh.state, 'busy'); clock += 6 * 60000; await make().getStatus(own);
            const old = await rowFor(own), oldSub = square.subscriptions.get(old.subscription_id); oldSub.status = 'CANCELED'; oldSub.version++; square.invoices.get(old.current_invoice_id).status = 'REFUNDED';
            clock += 31000; await billing.getStatus(own); const replacement = await quote(own); await submit(own, replacement); const expected = await rowFor(own);
            release(); const finished = await slow, final = await rowFor(own);
            assert.notEqual(expected.subscription_id, old.subscription_id); assert.equal(final.subscription_id, expected.subscription_id); assert.equal(final.checkout_id, replacement.checkoutId); assert.equal(finished.subscription.active, true);
        });
        await t.test('webhook database failure rolls event admission back so Square retry can reconcile; unknown remote subscriptions never grant', async () => {
            const own = actor(12), row = await rowFor(own), notification = eventFor(row, 'event-db-retry'); let once = true;
            const broken = createSquareBilling({ ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
                if (once && sql.startsWith('UPDATE automation_square_subscriptions')) { once = false; throw new Error('fixture database write failure'); }
                return query(sql, params);
            })) }, { env: ENV, fetch: square.fetch, clock: () => clock });
            await assert.rejects(broken.handleWebhook(notification.body, notification.signature));
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_square_webhook_events WHERE event_id=?', ['event-db-retry']))[0].n), 0);
            assert.equal((await billing.handleWebhook(notification.body, notification.signature)).duplicate, false);
            const unknown = eventFor({ subscription_id: 'UNBOUND-REMOTE' }, 'event-unbound'); const count = Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_square_subscriptions'))[0].n);
            assert.equal((await billing.handleWebhook(unknown.body, unknown.signature)).accepted, true); assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_square_subscriptions'))[0].n), count);
        });
        await t.test('cancel schedules end of paid cycle, preserves paid remainder and is safe to repeat; actual expiry removes access', async () => {
            const own = actor(5), before = square.requests.filter(request => request.path.endsWith('/cancel')).length;
            const result = await billing.cancel(own, await cancellationFor(own)); assert.equal(result.subscription.cancelScheduled, true); assert.equal(result.subscription.active, true);
            await billing.cancel(own, await cancellationFor(own)); assert.equal(square.requests.filter(request => request.path.endsWith('/cancel')).length, before + 1);
            clock = Date.parse('2026-10-31T15:00:00Z'); assert.equal((await billing.getStatus(own)).subscription.active, false);
            const row = await rowFor(own), sub = square.subscriptions.get(row.subscription_id); sub.status = 'CANCELED'; sub.version++;
            clock += 31000; await billing.getStatus(own);
            assert.ok((await quote(own)).checkoutId);
        });
        await t.test('dedicated cancel admission survives factories, coalesces concurrent requests and preserves cancellation during ordinary GET cooldown', async () => {
            const own = actor(120), checkout = await quote(own); await submit(own, checkout); const row = await rowFor(own);
            assert.equal((await make().getStatus(own)).refresh.state, 'cooldown');
            let release, started, once = true; const ready = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
            const beforeWire = square.requests.filter(item => item.path.endsWith('/cancel')).length;
            const slow = make({ fetch: async (url, options) => { const response = await square.fetch(url, options); if (new URL(url).pathname === `/v2/subscriptions/${row.subscription_id}` && once) { once = false; started(); await gate; } return response; } }).cancel(own, await cancellationFor(own));
            await ready;
            try {
                const before = square.requests.length;
                const other = await make().cancel(own, await cancellationFor(own)); assert.equal(other.refresh.state, 'busy'); assert.equal(square.requests.length, before); assert.equal(other.subscription.cancelScheduled, false);
            } finally { release(); }
            const canceled = await slow; assert.equal(canceled.subscription.cancelScheduled, true); assert.equal(square.requests.filter(item => item.path.endsWith('/cancel')).length, beforeWire + 1);
            const after = square.requests.length;
            for (let i = 0; i < 3; i++) { const result = await make().cancel(own, await cancellationFor(own)); assert.equal(result.subscription.cancelScheduled, true); assert.equal(result.refresh.state, 'cooldown'); }
            assert.equal(square.requests.length, after, 'already observed cancellation must not force two fresh REST scans on every POST');
        });
        await t.test('an unknown cancel result keeps its actual error and a durable same-contract retry cooldown prevents repeated forced scans', async () => {
            const own = actor(121), checkout = await quote(own); await submit(own, checkout); let calls = 0;
            const failing = () => make({ fetch: async (url, options) => { calls++; return new URL(url).pathname.endsWith('/cancel') ? json({ errors: [{}] }, 503) : square.fetch(url, options); } });
            await assert.rejects(failing().cancel(own, await cancellationFor(own)), { code: 'SQUARE_RESULT_UNKNOWN' }); const before = calls;
            for (let i = 0; i < 3; i++) { const result = await failing().cancel(own, await cancellationFor(own)); assert.equal(result.refresh.state, 'cooldown'); assert.equal(result.subscription.cancelScheduled, false); }
            assert.equal(calls, before);
            clock += 31000; assert.equal((await make().cancel(own, await cancellationFor(own))).subscription.cancelScheduled, true);
        });
        await t.test('a replacement contract is never bound by the previous contract cancel retry cooldown', async () => {
            const own = actor(122), first = await quote(own); await submit(own, first);
            await assert.rejects(make({ fetch: async (url, options) => new URL(url).pathname.endsWith('/cancel') ? json({ errors: [{}] }, 503) : square.fetch(url, options) }).cancel(own, await cancellationFor(own)), { code: 'SQUARE_RESULT_UNKNOWN' });
            const previous = await rowFor(own), old = square.subscriptions.get(previous.subscription_id); old.status = 'COMPLETED'; old.version++;
            const event = eventFor(previous, 'event-cancel-replaced-terminal'); await make().handleWebhook(event.body, event.signature);
            const replacement = await quote(own); await submit(own, replacement); const next = await rowFor(own); assert.notEqual(next.subscription_id, previous.subscription_id);
            const beforeStale = square.requests.length;
            await assert.rejects(make().cancel(own, { subscriptionId: previous.subscription_id, checkoutId: previous.checkout_id }), { code: 'SQUARE_CANCEL_CONTRACT_CHANGED' });
            await assert.rejects(make().cancel(own, {}), { code: 'SQUARE_CANCEL_CONFIRMATION_REQUIRED' });
            assert.equal(square.requests.length, beforeStale, 'An obsolete or absent UI confirmation makes no remote request');
            assert.equal(square.subscriptions.get(next.subscription_id).status, 'ACTIVE');
            const result = await make().cancel(own, await cancellationFor(own)); assert.equal(result.subscription.cancelScheduled, true);
            const cancel = square.requests.filter(item => item.path.endsWith('/cancel')).at(-1); assert.equal(cancel.path, `/v2/subscriptions/${next.subscription_id}/cancel`);
        });
        await t.test('a delayed expired cancellation cannot select or cancel a newly enrolled replacement contract', async () => {
            const own = actor(123), first = await quote(own); await submit(own, first); const previous = await rowFor(own);
            let release, started, once = true; const ready = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
            const slow = make({ fetch: async (url, options) => { const response = await square.fetch(url, options), snapshot = structuredClone(await response.json()); if (new URL(url).pathname === `/v2/subscriptions/${previous.subscription_id}` && once) { once = false; started(); await gate; } return json(snapshot, response.status); } }).cancel(own, await cancellationFor(own)).catch(error => error);
            await ready;
            let replacement;
            try {
                clock += 6 * 60000; const old = square.subscriptions.get(previous.subscription_id); old.status = 'COMPLETED'; old.version++;
                const event = eventFor(previous, 'event-cancel-old-terminal'); await make().handleWebhook(event.body, event.signature);
                const next = await quote(own); await submit(own, next); replacement = await rowFor(own);
            } finally { release(); }
            assert.equal((await slow).code, 'SQUARE_CANCEL_BUSY');
            assert(!square.requests.some(item => item.path === `/v2/subscriptions/${replacement.subscription_id}/cancel`));
            assert.equal((await make().getStatus(own)).subscription.cancelScheduled, false);
        });
        await t.test('a fenced old poll reports the newer durable busy observation while cancellation is still reading Square', async () => {
            const own = actor(124), checkout = await quote(own);
            await make({ fetch: async (url, options) => { const response = await square.fetch(url, options); if (new URL(url).pathname === '/v2/subscriptions' && options.method === 'POST') (await response.json()).subscription.charged_through_date = '2026-11-30'; return response; } }).subscribe(own, { checkoutId: checkout.checkoutId, sourceId: 'cnon:future-invoice', consent: true });
            const row = await rowFor(own); clock += 31000;
            let releasePoll, pollStarted, releaseCancel, cancelStarted;
            const pollReady = new Promise(resolve => { pollStarted = resolve; }), pollGate = new Promise(resolve => { releasePoll = resolve; });
            const cancelReady = new Promise(resolve => { cancelStarted = resolve; }), cancelGate = new Promise(resolve => { releaseCancel = resolve; });
            const original = await rowFor(own);
            const oldPoll = make({ fetch: async (url, options) => { const response = await square.fetch(url, options), snapshot = structuredClone(await response.json()); if (decodeURIComponent(new URL(url).pathname) === `/v2/invoices/${row.current_invoice_id}`) { pollStarted(); await pollGate; } return json(snapshot, response.status); } }).getStatus(own);
            await pollReady;
            let once = true;
            const cancellation = make({ fetch: async (url, options) => { const response = await square.fetch(url, options); if (new URL(url).pathname === `/v2/subscriptions/${row.subscription_id}` && once) { once = false; cancelStarted(); await cancelGate; } return response; } }).cancel(own, await cancellationFor(own));
            await cancelReady;
            try {
                releasePoll(); const result = await oldPoll; assert.equal(result.refresh.state, 'busy');
                assert.equal(Number(result.refresh.retryAtMs), clock + 5 * 60000); assert.equal((await rowFor(own)).valid_until_at_ms, original.valid_until_at_ms);
            } finally { releaseCancel(); }
            assert.equal((await cancellation).subscription.cancelScheduled, true);
        });
        await t.test('missing first-proration dates or a changed anchor revoke an earlier same-version grant before preserving owned cancellation', async () => {
            const data = square.state.variation.subscription_plan_variation_data; data.can_prorate = true; data.monthly_billing_anchor_date = 15;
            try {
                for (const [index, defect] of ['missing-start', 'changed-anchor'].entries()) {
                    const own = actor(125 + index), checkout = await quote(own);
                    const enrolled = await make({ fetch: async (url, options) => { const response = await square.fetch(url, options); if (new URL(url).pathname === '/v2/subscriptions' && options.method === 'POST') {
                        const { subscription } = await response.json(); subscription.start_date = '2026-10-31'; subscription.monthly_billing_anchor_date = 15; subscription.charged_through_date = '2026-11-14';
                        square.invoices.get(subscription.invoice_ids[0]).payment_requests = [{ computed_amount_money: { amount: 725, currency: 'JPY' }, total_completed_amount_money: { amount: 725, currency: 'JPY' } }];
                    } return response; } }).subscribe(own, { checkoutId: checkout.checkoutId, sourceId: 'cnon:verified-proration', consent: true });
                    assert.equal(enrolled.subscription.active, true); const row = await rowFor(own), subscription = square.subscriptions.get(row.subscription_id);
                    if (defect === 'missing-start') delete subscription.start_date; else subscription.monthly_billing_anchor_date = 16;
                    const event = eventFor(row, 'event-proration-invalid-' + defect); await make().handleWebhook(event.body, event.signature);
                    const revoked = await rowFor(own); assert.equal(Number(revoked.verified), 0); assert.equal(revoked.valid_until_at_ms, null);
                    assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_square_webhook_events WHERE event_id=? AND processed_at_ms IS NOT NULL', ['event-proration-invalid-' + defect]))[0].n), 1);
                    clock += 31000; const failed = await make().getStatus(own); assert.equal(failed.refresh.state, 'failed'); assert.equal(failed.subscription.active, false); assert.equal(failed.subscription.validUntilAtMs, null); assert.equal(failed.verificationWarning.code, 'SQUARE_PRORATION_UNVERIFIED');
                    const stored = await rowFor(own); assert.equal(Number(stored.verified), 0); assert.equal(stored.valid_until_at_ms, null);
                    const canceled = await make().cancel(own, await cancellationFor(own)); assert.equal(canceled.subscription.cancelScheduled, true); assert.equal(canceled.subscription.active, false);
                    const before = square.requests.length; await make().cancel(own, await cancellationFor(own)); assert.equal(square.requests.length, before);
                    const invoice = square.invoices.get(subscription.invoice_ids[0]); invoice.status = 'REFUNDED';
                    const refunded = eventFor(row, 'event-proration-refund-' + defect); await make().handleWebhook(refunded.body, refunded.signature);
                    const warning = (await db.queryDatabase('SELECT warning_code FROM automation_square_billing_reconciliation WHERE owner_user_id=? AND environment=? AND merchant_id=?', [own.userId, 'sandbox', 'MERCHANT']))[0]; assert.equal(warning.warning_code, null); assert.equal((await rowFor(own)).valid_until_at_ms, null);
                }
            } finally { delete data.can_prorate; delete data.monthly_billing_anchor_date; }
        });
    } finally { await db.close(); }
});

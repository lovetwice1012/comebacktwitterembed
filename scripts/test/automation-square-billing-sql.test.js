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
        if (path === '/v2/locations/LOCATION') result = { location: { id: 'LOCATION', merchant_id: state.locationMerchant, status: 'ACTIVE', timezone: 'Asia/Tokyo' } };
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
            await billing.saveBinding(ADMIN, 'pro', { variationId: 'VARIATION', enabled: true });
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
        await t.test('future unpaid invoice preserves independently recorded paid remainder and never extends it; refund revokes that remainder', async () => {
            const own = actor(12), checkout = await quote(own); square.state.paid = true; await submit(own, checkout);
            const row = await rowFor(own), sub = square.subscriptions.get(row.subscription_id), oldInvoice = square.invoices.get(row.current_invoice_id);
            const futureId = 'inv:FUTURE', future = { ...structuredClone(oldInvoice), id: futureId, status: 'UNPAID' }; future.payment_requests[0].total_completed_amount_money.amount = 0;
            square.invoices.set(futureId, future); sub.invoice_ids.unshift(futureId); sub.charged_through_date = '2026-11-30'; sub.version++;
            const result = await billing.getStatus(own); assert.equal(result.subscription.active, true); assert.equal(result.subscription.validUntilAtMs, Date.parse('2026-10-31T15:00:00Z'));
            oldInvoice.status = 'REFUNDED'; const refunded = await billing.getStatus(own); assert.equal(refunded.subscription.active, false); assert.equal(refunded.subscription.validUntilAtMs, null);
            future.status = 'PAID'; future.payment_requests[0].total_completed_amount_money.amount = 1500;
            const renewal = await billing.getStatus(own); assert.equal(renewal.subscription.validUntilAtMs, Date.parse('2026-11-30T15:00:00Z'));
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
            const slow = make({ fetch }).cancel(own).catch(error => error); await ready;
            invoice.status = 'REFUNDED';
            const refresh = make().getStatus(own); release();
            assert.equal((await slow).code, 'SQUARE_RESULT_UNKNOWN'); await refresh;
            assert.equal((await rowFor(own)).valid_until_at_ms, null);
            // No parallel refresh is required to preserve a refund already
            // observed by the failing cancel itself.
            const alone = make({ fetch: async (url, options) => new URL(url).pathname.endsWith('/cancel') ? json({ errors: [{}] }, 503) : square.fetch(url, options) });
            await assert.rejects(alone.cancel(own), { code: 'SQUARE_RESULT_UNKNOWN' }); assert.equal((await rowFor(own)).valid_until_at_ms, null);
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
            const slow = make({ fetch: slowFetch }).getStatus(own); await ready; await make().getStatus(own);
            const old = await rowFor(own), oldSub = square.subscriptions.get(old.subscription_id); oldSub.status = 'CANCELED'; oldSub.version++; square.invoices.get(old.current_invoice_id).status = 'REFUNDED';
            await billing.getStatus(own); const replacement = await quote(own); await submit(own, replacement); const expected = await rowFor(own);
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
            const result = await billing.cancel(own); assert.equal(result.subscription.cancelScheduled, true); assert.equal(result.subscription.active, true);
            await billing.cancel(own); assert.equal(square.requests.filter(request => request.path.endsWith('/cancel')).length, before + 1);
            clock = Date.parse('2026-10-31T15:00:00Z'); assert.equal((await billing.getStatus(own)).subscription.active, false);
            const row = await rowFor(own), sub = square.subscriptions.get(row.subscription_id); sub.status = 'CANCELED'; sub.version++;
            await billing.getStatus(own);
            assert.ok((await quote(own)).checkoutId);
        });
    } finally { await db.close(); }
});

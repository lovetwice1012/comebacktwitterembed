'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, createHash, randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createSquareDonations, isSquareDonationSupporter, getSquareDonationGrant } = require('../../src/automation/square-donations');
const { createSquareBilling } = require('../../src/automation/square-billing');
const entitlements = require('../../src/automation/entitlements');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const ENV = { SQUARE_ENVIRONMENT: 'sandbox', SQUARE_ACCESS_TOKEN: 'donation-fixture-private-token', SQUARE_APPLICATION_ID: 'sandbox-app', SQUARE_LOCATION_ID: 'LOCATION',
    SQUARE_MERCHANT_ID: 'MERCHANT', SQUARE_WEBHOOK_SIGNATURE_KEY: 'donation-fixture-private-signature', SQUARE_WEBHOOK_NOTIFICATION_URL: 'https://service.example/api/automation/square/webhook' };
const ADMIN = { userId: '444444444444444444', isAdmin: true }, actor = i => ({ userId: String(222222222222222000n + BigInt(i)) });
function json(value, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(value) }; }
function mockSquare(clock) {
    const payments = new Map(), orders = new Map(), refunds = new Map(), keys = new Map(), requests = [];
    const state = { lost: false, reject: false, getReject: false, status: 'COMPLETED', wrongMerchant: false, beforeReply: null, beforeRead: null, endlessList: false };
    async function fetch(url, options) {
        assert.ok(url.startsWith('https://connect.squareupsandbox.com/v2/')); assert.equal(options.headers.Authorization, `Bearer ${ENV.SQUARE_ACCESS_TOKEN}`);
        const path = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : null;
        requests.push({ path, method: options.method, body });
        if (options.method === 'GET' && state.beforeRead) await state.beforeRead(path);
        if (path === '/v2/locations/LOCATION') return json({ location: { id: 'LOCATION', merchant_id: state.wrongMerchant ? 'OTHER' : 'MERCHANT', status: 'ACTIVE', timezone: 'Asia/Tokyo', currency: 'JPY' } });
        if (path === '/v2/payments' && options.method === 'POST') {
            if (state.reject) { state.reject = false; return json({ errors: [{ detail: 'secret raw failure' }] }, 422); }
            let payment = keys.get(body.idempotency_key);
            if (!payment) {
                const id = `PAYMENT-${payments.size + 1}`, orderId = `ORDER-${orders.size + 1}`, timestamp = new Date(clock()).toISOString();
                payment = { id, order_id: orderId, reference_id: body.reference_id, location_id: body.location_id, amount_money: body.amount_money, total_money: body.amount_money,
                    source_type: 'CARD', status: state.status, application_details: { application_id: ENV.SQUARE_APPLICATION_ID }, buyer_email_address: body.buyer_email_address,
                    updated_at: timestamp, created_at: timestamp, card_details: { status: 'CAPTURED', card_payment_timeline: { captured_at: timestamp } } };
                keys.set(body.idempotency_key, payment); payments.set(id, payment);
                orders.set(orderId, { id: orderId, location_id: body.location_id, total_money: body.amount_money, tenders: [{ payment_id: id }] });
            }
            if (state.beforeReply) await state.beforeReply();
            if (state.lost) { state.lost = false; throw new Error('ACK lost after payment wire side effect'); }
            return json({ payment });
        }
        if (path === '/v2/payments') return json(state.endlessList ? { payments: [], cursor: 'next-page' } : { payments: [...payments.values()] });
        if (path.startsWith('/v2/payments/')) { if (state.getReject) { state.getReject = false; return json({ errors: [{ detail: 'raw GET failure' }] }, 422); } return json({ payment: payments.get(path.slice('/v2/payments/'.length)) }); }
        if (path.startsWith('/v2/orders/')) return json({ order: orders.get(path.slice('/v2/orders/'.length)) });
        if (path.startsWith('/v2/refunds/')) return json({ refund: refunds.get(path.slice('/v2/refunds/'.length)) });
        throw new Error(`Unexpected fixture path ${path}`);
    }
    return { state, payments, orders, refunds, keys, requests, fetch };
}
function signed(event) { const raw = JSON.stringify(event); return { raw, signature: createHmac('sha256', ENV.SQUARE_WEBHOOK_SIGNATURE_KEY).update(ENV.SQUARE_WEBHOOK_NOTIFICATION_URL).update(raw).digest('base64') }; }

test('Square donations: no local secrets or invented monetary defaults; login and admin contracts fail closed', async () => {
    const service = createSquareDonations({}, { env: {} });
    const options = await service.getOptions(actor(1)); assert.equal(options.configured, false); assert.equal(options.enabled, false); assert.equal(options.minimumAmount, null); assert.equal(options.maximumAmount, null); assert.equal(options.supporterThreshold, null);
    assert.equal((await service.getStatus(actor(1))).supporter.active, false);
    await assert.rejects(service.getAdmin(actor(1)), { code: 'AUTOMATION_FORBIDDEN' });
    await assert.rejects(service.createQuote(actor(1), {}), { code: 'SQUARE_NOT_CONFIGURED' });
    await assert.rejects(service.getStatus({ userId: 'client-not-discord' }), { code: 'AUTOMATION_AUTH_REQUIRED' });
});

test('Square donations real SQL with mocked REST: trusted payment, durable ownership, refunds, rolling eligibility', { skip: !port, timeout: 120000 }, async t => {
    const db = await createTestDatabase(port), initial = Date.parse('2026-10-13T00:00:00Z'); let clock = initial;
    const square = mockSquare(() => clock), make = () => createSquareDonations(db, { env: ENV, fetch: square.fetch, clock: () => clock });
    const donations = make(), billing = createSquareBilling(db, { env: ENV, fetch: square.fetch, clock: () => clock });
    const previousEnv = Object.fromEntries(Object.keys(ENV).map(key => [key, process.env[key]])); Object.assign(process.env, ENV);
    const quote = (owner, chosen = 600) => donations.createQuote(owner, { amount: chosen, email: 'buyer@example.com', name: 'Fixture Buyer', userId: actor(99).userId, currency: 'USD' });
    const submit = (owner, q, overrides = {}) => donations.donate(owner, { attemptId: q.attemptId, sourceId: `cnon:fixture-${owner.userId}`, consent: true, amount: 1, userId: actor(99).userId, ...overrides });
    const paymentFor = async id => square.payments.get((await db.queryDatabase('SELECT payment_id FROM automation_square_donation_attempts WHERE id=?', [id]))[0].payment_id);
    const save = async changes => { const p = (await donations.getAdmin(ADMIN)).policy; return donations.savePolicy(ADMIN, { ...p, enabled: true, currency: 'JPY', minimumAmount: 100, maximumAmount: 10000, expectedUpdatedAtMs: p.updatedAtMs, ...changes }); };
    const fire = async (payment, eventId, type = 'payment.updated', refundId) => { const event = signed({ event_id: eventId, merchant_id: 'MERCHANT', type, data: { id: refundId || payment.id, object: type.startsWith('refund.') ? { refund: { id: refundId } } : { payment: { id: payment.id, status: 'COMPLETED' } } } }); return billing.handleWebhook(event.raw, event.signature); };
    const scope = { configured: true, environment: 'sandbox', merchantId: 'MERCHANT' };
    try {
        await t.test('administrator sets blank disabled policy, CAS protects concurrent editing, enabled bounds and location currency are verified', async () => {
            await assert.rejects(donations.savePolicy(actor(1), {}), { code: 'AUTOMATION_FORBIDDEN' });
            const empty = await donations.savePolicy(ADMIN, { enabled: false, currency: null, minimumAmount: null, maximumAmount: null, supporterThreshold: null, validityDays: null, expectedUpdatedAtMs: null });
            assert.equal(empty.enabled, false); assert.equal(empty.minimumAmount, null);
            await assert.rejects(donations.savePolicy(ADMIN, { ...empty, enabled: true, expectedUpdatedAtMs: empty.updatedAtMs }), { code: 'SQUARE_DONATION_POLICY_INVALID' });
            await assert.rejects(save({ currency: 'USD' }), { code: 'SQUARE_DONATION_CURRENCY_MISMATCH' });
            const p = await save({ supporterThreshold: null });
            await assert.rejects(donations.savePolicy(ADMIN, { ...p, expectedUpdatedAtMs: empty.updatedAtMs }), { code: 'SQUARE_DONATION_POLICY_CONFLICT' });
            const publicOptions = await donations.getOptions(actor(1)); assert.equal(publicOptions.currency, 'JPY'); assert.equal(publicOptions.minorUnitDigits, 0);
            assert.ok(!JSON.stringify([publicOptions, p]).includes(ENV.SQUARE_ACCESS_TOKEN)); assert.ok(!JSON.stringify(publicOptions).includes(ENV.SQUARE_WEBHOOK_SIGNATURE_KEY));
            await assert.rejects(quote(actor(1), 99), { code: 'SQUARE_DONATION_AMOUNT_INVALID' });
            square.state.wrongMerchant = true; await assert.rejects(quote(actor(1)), { code: 'SQUARE_ACCOUNT_MISMATCH' }); square.state.wrongMerchant = false;
        });
        await t.test('receipt email validation rejects oversized malformed input before Square I/O and accepts bounded subdomains', async () => {
            const invalid = ['', 'buyer@@example.com', 'buyer@.com', 'buyer@example', 'buyer@example.com.', 'buyer@exa mple.com', `buyer@${'a.'.repeat(10000)} bad`];
            for (const email of invalid) {
                const before = square.requests.length;
                await assert.rejects(donations.createQuote(actor(84), { amount: 600, email, name: 'Fixture Buyer' }), { code: 'SQUARE_EMAIL_REQUIRED' });
                assert.equal(square.requests.length, before);
            }
            for (const email of ['buyer+tag@deep.mail.example.co.jp', 'a'.repeat(240) + '@example.co.uk']) {
                const result = await donations.createQuote(actor(85), { amount: 600, email, name: 'Fixture Buyer' });
                assert.equal(result.email, email); assert.ok(result.attemptId);
            }
        });
        await t.test('one-off payment uses exact server amount, app/location/reference/order ownership and no stored card; no threshold grants no supporter', async () => {
            const own = actor(1), q = await quote(own); assert.equal(q.currency, 'JPY'); assert.equal(q.email, 'buyer@example.com');
            await assert.rejects(submit(actor(2), q), { code: 'SQUARE_DONATION_NOT_FOUND' });
            await assert.rejects(submit(own, q, { consent: false }), { code: 'SQUARE_CONSENT_REQUIRED' });
            await assert.rejects(submit(own, q, { sourceId: 'CASH' }), { code: 'SQUARE_DONATION_SOURCE_INVALID' });
            const result = await submit(own, q); assert.equal(result.history[0].netAmount, 600); assert.equal(result.supporter.active, false); assert.equal(result.pending, null);
            const wire = square.requests.find(item => item.method === 'POST' && item.body.reference_id === q.attemptId); assert.equal(wire.body.amount_money.amount, 600); assert.equal(wire.body.amount_money.currency, 'JPY'); assert.equal(wire.body.autocomplete, true); assert.equal(wire.body.idempotency_key, q.attemptId);
            assert.ok(!square.requests.some(item => item.path === '/v2/cards' || item.path === '/v2/subscriptions'));
            const rawRow = (await db.queryDatabase('SELECT * FROM automation_square_donation_attempts WHERE id=?', [q.attemptId]))[0]; assert.ok(!JSON.stringify(rawRow).includes('cnon:')); assert.equal(Number(rawRow.verified), 1);
            assert.deepEqual((await donations.getStatus(actor(2))).history, []); await assert.rejects(donations.getAttempt(actor(2), q.attemptId), { code: 'SQUARE_DONATION_NOT_FOUND' });
        });
        await t.test('policy enables automatic donation supporter without changing manual donor flags; cumulative payments apply current supporter quota', async () => {
            await save({ supporterThreshold: 1000, validityDays: 30 }); const own = actor(3);
            await submit(own, await quote(own)); assert.equal((await donations.getStatus(own)).supporter.active, false);
            await submit(own, await quote(own)); const result = await donations.getStatus(own); assert.equal(result.supporter.active, true); assert.equal(result.supporter.netAmount, 1200); assert.equal(result.supporter.validUntilAtMs, clock + 30 * 86400000);
            assert.equal(Number((await db.queryDatabase('SELECT is_donor FROM users WHERE user_id=?', [own.userId]))[0].is_donor), 0);
            await entitlements.savePlanPolicy(db.queryDatabase, ADMIN, { planId: 'supporter', label: 'Supporter', slotLimit: 8, minuteLimit: 10, dayLimit: 90, priority: 2, expectedUpdatedAtMs: 0 });
            const plan = await entitlements.inspectPlan(db.queryDatabase, own.userId, clock); assert.equal(plan.tier, 'supporter'); assert.equal(plan.baseSlotLimit, 8); assert.equal(plan.slotLimit, 10, 'two verified 600-yen purchases retain one permanent slot each'); assert.equal(plan.priority, 2);
        });
        await t.test('lost payment ACK is recovered after service restart without another wire charge; durable unresolved attempt blocks new quote and retry', async () => {
            const own = actor(4), q = await quote(own); square.state.lost = true;
            await assert.rejects(submit(own, q), { code: 'SQUARE_RESULT_UNKNOWN' });
            assert.equal((await db.queryDatabase('SELECT state FROM automation_square_donation_attempts WHERE id=?', [q.attemptId]))[0].state, 'UNKNOWN');
            await assert.rejects(quote(own), { code: 'SQUARE_DONATION_PENDING' }); await assert.rejects(submit(own, q), { code: 'SQUARE_DONATION_PENDING' });
            const restored = await make().getStatus(own); assert.equal(restored.history[0].state, 'COMPLETED'); assert.equal(restored.pending, null);
            await submit(own, q); assert.equal(square.requests.filter(item => item.method === 'POST' && item.body.reference_id === q.attemptId).length, 1);
        });
        await t.test('a read error after successful CreatePayment remains UNKNOWN and cannot create a second charge', async () => {
            const own = actor(5), q = await quote(own); square.state.getReject = true;
            await assert.rejects(submit(own, q), { code: 'SQUARE_REQUEST_FAILED' });
            assert.equal((await db.queryDatabase('SELECT state FROM automation_square_donation_attempts WHERE id=?', [q.attemptId]))[0].state, 'UNKNOWN');
            await assert.rejects(quote(own), { code: 'SQUARE_DONATION_PENDING' }); assert.equal((await donations.getStatus(own)).history[0].state, 'COMPLETED');
        });
        await t.test('concurrent same-attempt and competing quoted attempts never issue more than one payment for the owner', async () => {
            const own = actor(6), a = await quote(own), b = await quote(own); let release, entered;
            const arrival = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
            square.state.beforeReply = async () => { entered(); await gate; };
            const first = submit(own, a); await arrival;
            await assert.rejects(submit(own, a), { code: 'SQUARE_DONATION_BUSY' }); await assert.rejects(submit(own, b), { code: 'SQUARE_DONATION_PENDING' });
            release(); await first; square.state.beforeReply = null;
            assert.equal(square.requests.filter(item => item.method === 'POST' && item.body.reference_id === a.attemptId).length, 1); assert.equal(square.requests.filter(item => item.method === 'POST' && item.body.reference_id === b.attemptId).length, 0);
        });
        await t.test('expired and changed quotes require renewed confirmation before any wire; known declined writes remain historical FAILED', async () => {
            const own = actor(7), expired = await quote(own); clock += 16 * 60000; await assert.rejects(submit(own, expired), { code: 'SQUARE_DONATION_QUOTE_EXPIRED' }); clock -= 16 * 60000;
            const changed = await quote(own); await save({ maximumAmount: 9000 }); await assert.rejects(submit(own, changed), { code: 'SQUARE_DONATION_QUOTE_CHANGED' });
            const rejected = await quote(own); square.state.reject = true; await assert.rejects(submit(own, rejected), { code: 'SQUARE_REQUEST_FAILED' });
            assert.equal((await donations.getAttempt(own, rejected.attemptId)).state, 'FAILED'); await quote(own);
        });
        await t.test('pending payment is not a grant; current REST completion via signed webhook grants once; duplicate and altered event replay denied', async () => {
            const own = actor(8), q = await quote(own, 1200); square.state.status = 'PENDING'; const result = await submit(own, q); square.state.status = 'COMPLETED';
            assert.equal(result.supporter.active, false); assert.equal(result.history[0].netAmount, 0); assert.equal(result.pending.state, 'PENDING');
            const payment = await paymentFor(q.attemptId); payment.status = 'COMPLETED'; payment.updated_at = new Date(clock + 1000).toISOString();
            const fresh = await fire(payment, 'event-pending-completed'); assert.equal(fresh.duplicate, false); assert.equal((await fire(payment, 'event-pending-completed')).duplicate, true);
            assert.equal((await donations.getStatus(own)).supporter.active, true);
            const changed = signed({ event_id: 'event-pending-completed', merchant_id: 'MERCHANT', type: 'payment.updated', data: { id: payment.id } });
            await assert.rejects(billing.handleWebhook(changed.raw, changed.signature), { code: 'SQUARE_WEBHOOK_CONFLICT' });
            await assert.rejects(billing.handleWebhook(changed.raw, 'bad'), { code: 'SQUARE_WEBHOOK_SIGNATURE_INVALID' });
        });
        await t.test('refund lifecycle uses current REST; pending/failed do not reduce net, completed partial/full refunds revoke correctly and never extend capture time', async () => {
            const own = actor(9), q = await quote(own, 1600); await submit(own, q); const payment = await paymentFor(q.attemptId), captured = (await donations.getStatus(own)).history[0].completedAtMs;
            const refund = { id: 'REFUND-partial', payment_id: payment.id, location_id: 'LOCATION', amount_money: { amount: 700, currency: 'JPY' }, status: 'PENDING' };
            square.refunds.set(refund.id, refund); payment.refund_ids = [refund.id];
            await fire(payment, 'refund-pending', 'refund.created', refund.id); assert.equal((await donations.getStatus(own)).supporter.netAmount, 1600);
            refund.status = 'FAILED'; await fire(payment, 'refund-failed', 'refund.updated', refund.id); assert.equal((await donations.getStatus(own)).supporter.active, true);
            clock += 5 * 86400000; refund.status = 'COMPLETED'; payment.refunded_money = { amount: 700, currency: 'JPY' }; payment.updated_at = new Date(clock).toISOString();
            await fire(payment, 'refund-partial', 'refund.updated', refund.id); let result = await donations.getStatus(own); assert.equal(result.supporter.netAmount, 900); assert.equal(result.supporter.active, false); assert.equal(result.history[0].completedAtMs, captured);
            const rest = { id: 'REFUND-rest', payment_id: payment.id, location_id: 'LOCATION', amount_money: { amount: 900, currency: 'JPY' }, status: 'COMPLETED' }; square.refunds.set(rest.id, rest); payment.refund_ids.push(rest.id); payment.refunded_money.amount = 1600;
            await fire(payment, 'refund-full', 'refund.updated', rest.id); result = await donations.getStatus(own); assert.equal(result.history[0].netAmount, 0); assert.equal(result.history[0].refundedAmount, 1600);
        });
        await t.test('rolling grant expires when cumulative unexpired donations fall below threshold, not at the most recent donation plus duration', async () => {
            clock = initial; const own = actor(10); await save({ validityDays: 30 }); await submit(own, await quote(own, 600));
            clock += 10 * 86400000; await submit(own, await quote(own, 600)); const result = await donations.getStatus(own);
            assert.equal(result.supporter.validUntilAtMs, initial + 30 * 86400000); assert.equal(await isSquareDonationSupporter(db.queryDatabase, own.userId, initial + 30 * 86400000 - 1, scope), true);
            assert.equal(await isSquareDonationSupporter(db.queryDatabase, own.userId, initial + 30 * 86400000, scope), false);
            clock = initial + 30 * 86400000; const expired = await donations.getStatus(own); assert.equal(expired.supporter.netAmount, 600); assert.equal(expired.supporter.active, false); assert.equal((await entitlements.inspectPlan(db.queryDatabase, own.userId, clock)).tier, 'free');
        });
        await t.test('policy threshold changes recompute existing grants immediately; lifetime includes older verified donations; unset threshold disables only Square grants', async () => {
            clock = initial + 100 * 86400000; const own = actor(10); await save({ validityDays: null }); assert.equal((await donations.getStatus(own)).supporter.active, true);
            await save({ supporterThreshold: 2000 }); assert.equal(await isSquareDonationSupporter(db.queryDatabase, own.userId, clock, scope), false);
            await db.queryDatabase('UPDATE users SET is_donor=1 WHERE user_id=?', [own.userId]); await save({ supporterThreshold: null });
            const result = await donations.getStatus(own); assert.equal(result.supporter.active, false); assert.equal(result.supporter.manualActive, true); assert.equal((await entitlements.inspectPlan(db.queryDatabase, own.userId, clock)).tier, 'supporter');
            assert.equal(await isSquareDonationSupporter(db.queryDatabase, own.userId, clock, { ...scope, merchantId: 'OTHER' }), false); assert.equal(await isSquareDonationSupporter(db.queryDatabase, own.userId, clock, { ...scope, environment: 'production' }), false);
        });
        await t.test('other app, wrong money, wrong source and foreign order never establish verified donation grants', async () => {
            await save({ supporterThreshold: 1000 });
            const mutations = [payment => { payment.application_details.application_id = 'tts'; }, payment => { payment.amount_money = { amount: 1, currency: 'JPY' }; }, payment => { payment.source_type = 'CASH'; }, payment => { square.orders.get(payment.order_id).tenders[0].payment_id = 'OTHER'; }];
            for (let i = 0; i < mutations.length; i++) {
                const own = actor(20 + i), q = await quote(own, 1200); square.state.beforeReply = async () => { mutations[i](square.keys.get(q.attemptId)); };
                await assert.rejects(submit(own, q), { code: 'SQUARE_DONATION_PAYMENT_MISMATCH' }); square.state.beforeReply = null;
                assert.equal(Number((await db.queryDatabase('SELECT verified FROM automation_square_donation_attempts WHERE id=?', [q.attemptId]))[0].verified), 0);
                assert.equal(await isSquareDonationSupporter(db.queryDatabase, own.userId, clock, scope), false); await assert.rejects(quote(own), { code: 'SQUARE_DONATION_PENDING' });
            }
        });
        await t.test('unbound subscription or other-project payment is acknowledged without donation import; malformed merchant and wrong canonical signature rejected', async () => {
            const payment = { id: 'EXTERNAL-PAYMENT', reference_id: 'unrelated-project', location_id: 'LOCATION' }; square.payments.set(payment.id, payment);
            assert.equal((await fire(payment, 'unbound-payment')).accepted, true);
            const foreign = signed({ event_id: 'foreign-merchant', merchant_id: 'OTHER', type: 'payment.updated', data: { id: payment.id } }); await assert.rejects(billing.handleWebhook(foreign.raw, foreign.signature), { code: 'SQUARE_WEBHOOK_ACCOUNT_MISMATCH' });
            const wrongURL = signed({ event_id: 'wrong-url', merchant_id: 'MERCHANT', type: 'payment.updated', data: { id: payment.id } }); const signature = createHmac('sha256', ENV.SQUARE_WEBHOOK_SIGNATURE_KEY).update('https://wrong.example/webhook').update(wrongURL.raw).digest('base64');
            await assert.rejects(billing.handleWebhook(wrongURL.raw, signature), { code: 'SQUARE_WEBHOOK_SIGNATURE_INVALID' });
        });
        await t.test('FAILED and CANCELED terminal REST payments without an order do not grant or keep new donations blocked', async () => {
            for (const [i, state] of ['FAILED', 'CANCELED'].entries()) {
                const own = actor(30 + i), q = await quote(own, 1200); square.state.status = state;
                square.state.beforeReply = async () => { delete square.keys.get(q.attemptId).order_id; };
                const result = await submit(own, q); square.state.status = 'COMPLETED'; square.state.beforeReply = null;
                assert.equal(result.history[0].state, state); assert.equal(result.history[0].netAmount, 0); assert.equal(result.supporter.active, false); assert.equal(result.pending, null);
                await quote(own);
            }
        });
        await t.test('verified donation supporter enters durable queue priority, and every fourth claim remains oldest-first for free users', async () => {
            clock = initial + 100 * 86400000; await save({ supporterThreshold: 1000, validityDays: null });
            const donor = actor(3), free = actor(50); await db.queryDatabase('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,0)', [free.userId]);
            assert.equal((await donations.getStatus(donor)).supporter.active, true); assert.equal(Number((await db.queryDatabase('SELECT is_donor FROM users WHERE user_id=?', [donor.userId]))[0].is_donor), 0);
            for (const owner of [free.userId, donor.userId]) for (let i = 0; i < 5; i++) {
                const runId = randomUUID(), jobId = randomUUID();
                await db.queryDatabase('INSERT INTO automation_runs (id,dedupe_key,owner_user_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)', [runId, createHash('sha256').update(jobId).digest('hex'), owner, 'private', 'price', 1, '{}', '[]', 'queued', clock]);
                await db.queryDatabase('INSERT INTO automation_jobs (id,run_id,plan_json,due_at_ms,state,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?)', [jobId, runId, JSON.stringify({ context: {}, schedules: [] }), clock, 'pending', clock + (owner === free.userId ? 0 : 1), clock]);
            }
            const queue = require('../../src/automation/queue').createQueue(db, {}), owners = [];
            for (let i = 0; i < 4; i++) { const job = await queue.claim(clock); owners.push(job.owner_user_id); await queue.transition(job, 'sent'); }
            assert.deepEqual(owners, [donor.userId, donor.userId, donor.userId, free.userId]);
        });
        await t.test('webhook SQL failure rolls back both event admission and donation grant so retry safely applies once', async () => {
            const own = actor(40), q = await quote(own, 1200); square.state.status = 'PENDING'; await submit(own, q); square.state.status = 'COMPLETED';
            const payment = await paymentFor(q.attemptId); payment.status = 'COMPLETED'; payment.updated_at = new Date(clock + 1000).toISOString();
            const event = signed({ event_id: 'event-db-retry', merchant_id: 'MERCHANT', type: 'payment.updated', data: { id: payment.id } }); let failUpdate = true;
            const broken = createSquareBilling({ ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
                if (failUpdate && sql.startsWith('UPDATE automation_square_donation_attempts SET state=')) { failUpdate = false; throw new Error('fixture SQL failure'); }
                return query(sql, params);
            })) }, { env: ENV, fetch: square.fetch, clock: () => clock });
            await assert.rejects(broken.handleWebhook(event.raw, event.signature), /fixture SQL failure/);
            assert.equal((await db.queryDatabase('SELECT * FROM automation_square_webhook_events WHERE event_id=?', ['event-db-retry'])).length, 0);
            assert.equal(await isSquareDonationSupporter(db.queryDatabase, own.userId, clock, scope), false);
            assert.equal((await billing.handleWebhook(event.raw, event.signature)).duplicate, false); assert.equal((await billing.handleWebhook(event.raw, event.signature)).duplicate, true);
            assert.equal((await donations.getStatus(own)).supporter.active, true);
        });
        await t.test('turning off donation checkout leaves previously earned supporter allowance intact', async () => {
            const own = actor(40); await save({ enabled: false });
            assert.equal((await donations.getStatus(own)).supporter.active, true); assert.equal((await entitlements.inspectPlan(db.queryDatabase, own.userId, clock)).tier, 'supporter');
            await assert.rejects(quote(own), { code: 'SQUARE_DONATION_UNAVAILABLE' });
        });
        async function seed(owner, count, state = 'COMPLETED', created = clock) {
            await db.queryDatabase('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,0)', [owner.userId]);
            const p = (await donations.getAdmin(ADMIN)).policy, seeded = [];
            for (let i = 0; i < count; i++) {
                const id = randomUUID(), paymentId = `large-${owner.userId}-${i}`, orderId = `order-${paymentId}`, timestamp = new Date(created + i).toISOString();
                if (state === 'COMPLETED') {
                    square.payments.set(paymentId, { id: paymentId, order_id: orderId, location_id: 'LOCATION', reference_id: id, amount_money: { amount: 100, currency: 'JPY' }, total_money: { amount: 100, currency: 'JPY' },
                        source_type: 'CARD', status: 'COMPLETED', application_details: { application_id: 'sandbox-app' }, created_at: timestamp, updated_at: timestamp, card_details: { status: 'CAPTURED', card_payment_timeline: { captured_at: timestamp } } });
                    square.orders.set(orderId, { id: orderId, location_id: 'LOCATION', total_money: { amount: 100, currency: 'JPY' }, tenders: [{ payment_id: paymentId }] });
                }
                await db.queryDatabase(`INSERT INTO automation_square_donation_attempts (id,owner_user_id,environment,merchant_id,location_id,application_id,amount,currency,email,name,policy_updated_at_ms,state,payment_id,order_id,verified,completed_at_ms,square_updated_at_ms,expires_at_ms,created_at_ms,updated_at_ms)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, owner.userId, 'sandbox', 'MERCHANT', 'LOCATION', 'sandbox-app', 100, 'JPY', 'buyer@example.com', 'Fixture Buyer', p.updatedAtMs, state,
                    state === 'COMPLETED' ? paymentId : null, state === 'COMPLETED' ? orderId : null, state === 'COMPLETED' ? 1 : 0, state === 'COMPLETED' ? created + i : null, state === 'COMPLETED' ? created + i : null, created + 900000, created + i, created + i]);
                seeded.push({ id, paymentId });
            }
            return seeded;
        }
        await t.test('large completed histories use bounded durable cursor refresh; repeated and restarted factories share cooldown and local expiry', async () => {
            await save({ enabled: true, supporterThreshold: 10050, validityDays: null }); const own = actor(60); const rows = await seed(own, 101);
            const transaction = new AsyncLocalStorage(), wrapped = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => transaction.run(true, () => work(query))) };
            const service = createSquareDonations(wrapped, { env: ENV, clock: () => clock, fetch: async (...args) => { assert.notEqual(transaction.getStore(), true, 'status HTTP must never hold the owner transaction'); return square.fetch(...args); } });
            let start = square.requests.length; const first = await service.getStatus(own); assert.equal(first.history.length, 100); assert.equal(first.refresh.state, 'checked'); assert.equal(first.supporter.active, true);
            assert.equal(square.requests.slice(start).length, 8, 'four completed records, payment and order reads only');
            start = square.requests.length; const repeated = await make().getStatus(own); assert.equal(repeated.refresh.state, 'cooldown'); assert.equal(square.requests.length, start, 'cooldown is shared after module restart');
            // A refund whose webhook was missed is eventually reached by the
            // persisted cursor rather than requiring unbounded list reads.
            const last = square.payments.get(rows[100].paymentId), refund = { id: 'large-last-refund', payment_id: last.id, location_id: 'LOCATION', amount_money: { amount: 100, currency: 'JPY' }, status: 'COMPLETED' };
            square.refunds.set(refund.id, refund); last.refund_ids = [refund.id]; last.refunded_money = { amount: 100, currency: 'JPY' }; last.updated_at = new Date(clock + 1000).toISOString();
            let recovered;
            for (let i = 0; i < 25; i++) { clock += 30000; start = square.requests.length; recovered = await make().getStatus(own); assert.ok(square.requests.length - start <= 9, 'bounded batch even during fallback refund refresh'); }
            assert.equal(recovered.supporter.active, false); assert.equal(recovered.supporter.netAmount, 10000);
            assert.equal(Number((await db.queryDatabase('SELECT refunded_amount FROM automation_square_donation_attempts WHERE id=?', [rows[100].id]))[0].refunded_amount), 100);
            const cursor = (await db.queryDatabase('SELECT completed_cursor_id FROM automation_square_donation_reconciliation WHERE owner_user_id=?', [own.userId]))[0]; assert.equal(cursor.completed_cursor_id, rows[100].id);
            clock += 30000; await make().getStatus(own); const wrappedCursor = (await db.queryDatabase('SELECT completed_cursor_id FROM automation_square_donation_reconciliation WHERE owner_user_id=?', [own.userId]))[0]; assert.equal(wrappedCursor.completed_cursor_id, rows[3].id, 'end of history wraps cursor to start');
        });
        await t.test('parallel workers use one durable single flight while cached status stays responsive without owner locks across network', async () => {
            const own = actor(61); await seed(own, 4); let entered, release;
            const arrival = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
            square.state.beforeRead = async path => { if (path.startsWith(`/v2/payments/large-${own.userId}`)) { entered(); await gate; } };
            const start = square.requests.length, running = make().getStatus(own); await arrival;
            const others = await Promise.all(Array.from({ length: 4 }, () => make().getStatus(own))); assert.ok(others.every(result => result.refresh.state === 'busy')); assert.ok(others.every(result => result.history.length === 4));
            assert.equal(square.requests.length - start, 1, 'only the lease owner starts Square read'); release(); const first = await running; square.state.beforeRead = null;
            assert.equal(first.refresh.state, 'checked'); assert.equal(square.requests.length - start, 8);
        });
        await t.test('old unresolved payment remains visible independently of a hundred newer unsubmitted quote rows and is refreshed first', async () => {
            const own = actor(62), pending = (await seed(own, 1, 'UNKNOWN', clock - 1000))[0]; await seed(own, 100, 'QUOTED', clock);
            const start = square.requests.length, result = await make().getStatus(own); assert.equal(result.history.length, 100); assert.ok(!result.history.some(row => row.attemptId === pending.id));
            assert.equal(result.pending.attemptId, pending.id); assert.equal(result.pending.state, 'UNKNOWN'); assert.equal(square.requests[start].path, '/v2/payments');
            await assert.rejects(quote(own), { code: 'SQUARE_DONATION_PENDING' });
        });
        await t.test('refresh failures release their durable lease, respect cooldown, then recover without charging or regranting refunded support', async () => {
            const own = actor(63), rows = await seed(own, 1); square.state.getReject = true;
            const failed = await make().getStatus(own); assert.equal(failed.refresh.state, 'failed'); assert.equal(failed.history[0].netAmount, 100);
            assert.equal((await make().getStatus(own)).refresh.state, 'cooldown'); clock += 30000; assert.equal((await make().getStatus(own)).refresh.state, 'checked');
            const payment = square.payments.get(rows[0].paymentId), refund = { id: 'refresh-recovered-refund', payment_id: payment.id, location_id: 'LOCATION', amount_money: { amount: 100, currency: 'JPY' }, status: 'COMPLETED' };
            square.refunds.set(refund.id, refund); payment.refund_ids = [refund.id]; payment.refunded_money = { amount: 100, currency: 'JPY' }; payment.updated_at = new Date(clock).toISOString();
            await fire(payment, 'immediate-refund-during-cooldown', 'refund.updated', refund.id); const immediate = await make().getStatus(own); assert.equal(immediate.refresh.state, 'cooldown'); assert.equal(immediate.history[0].netAmount, 0);
            // Same-timestamp stale Square reads cannot roll back a confirmed
            // refund, including its durable refund ledger state.
            refund.status = 'PENDING'; delete payment.refunded_money; clock += 30000; const stale = await make().getStatus(own); assert.equal(stale.history[0].netAmount, 0);
            assert.equal((await db.queryDatabase('SELECT state FROM automation_square_donation_refunds WHERE refund_id=?', [refund.id]))[0].state, 'COMPLETED');
            assert.equal(square.requests.filter(item => item.method === 'POST' && item.body?.reference_id === rows[0].id).length, 0);
            await db.queryDatabase('UPDATE automation_square_donation_reconciliation SET lease_token=?,lease_until_at_ms=?,next_allowed_at_ms=0 WHERE owner_user_id=?', [randomUUID(), clock - 1, own.userId]);
            assert.equal((await make().getStatus(own)).refresh.state, 'checked', 'a crashed worker lease is reclaimed after expiry');
        });
        await t.test('unknown recovery retains its twenty-page ceiling and total refresh budget even with multiple unresolved legacy rows', async () => {
            const own = actor(64), pending = await seed(own, 2, 'UNKNOWN'); await seed(own, 4); square.state.endlessList = true;
            const start = square.requests.length, result = await make().getStatus(own); square.state.endlessList = false;
            assert.equal(square.requests.length - start, 32); assert.equal(result.refresh.state, 'failed'); assert.equal(result.pending.attemptId, pending[0].id);
            assert.ok(result.history.filter(row => row.attemptId === pending[0].id || row.attemptId === pending[1].id).every(row => row.state === 'UNKNOWN' && row.netAmount === 0));
            const after = square.requests.length; await make().getStatus(own); assert.equal(square.requests.length, after, 'budget failure also activates durable cooldown');
        });
        await t.test('supporter expiry is recomputed locally during remote refresh cooldown', async () => {
            await save({ supporterThreshold: 100, validityDays: 1 }); const own = actor(65); await seed(own, 1, 'COMPLETED', clock - 86400000 + 10);
            const first = await make().getStatus(own); assert.equal(first.supporter.active, true); const start = square.requests.length; clock += 11;
            const expired = await make().getStatus(own); assert.equal(expired.refresh.state, 'cooldown'); assert.equal(expired.supporter.active, false); assert.equal(expired.supporter.netAmount, 0); assert.equal(square.requests.length, start);
        });
        await t.test('configured supporter units and successful payment count are distinct, cumulative, and never change the manual donor flag', async () => {
            await save({ supporterThreshold: null, validityDays: 30, unitAmount: 500, slotsPerUnit: 3 });
            const own = actor(90); await submit(own, await quote(own, 1200));
            let status = await donations.getStatus(own);
            assert.equal(status.supporter.purchaseUnits, 2); assert.equal(status.supporter.extraSlots, 6); assert.equal(status.supporter.paymentCount, 1);
            await submit(own, await quote(own, 300)); status = await donations.getStatus(own);
            assert.equal(status.supporter.purchaseUnits, 3); assert.equal(status.supporter.extraSlots, 9); assert.equal(status.supporter.paymentCount, 2);
            const start = square.requests.length, plan = await entitlements.inspectPlan(db.queryDatabase, own.userId, clock);
            assert.equal(square.requests.length, start, 'entitlement reads use only the verified local ledger');
            assert.equal(plan.tier, 'supporter'); assert.equal(plan.addonGrantUnits, 3); assert.equal(plan.addonExtraSlots, 2, 'new grants are per-payment 500-yen units; 300-yen payments are not combined'); assert.equal(plan.donationPaymentCount, 2);
            assert.equal(plan.slotLimit, plan.baseSlotLimit + 2); assert.equal(plan.minuteLimit, 10); assert.equal(plan.dayLimit, 90);
            assert.equal(Number((await db.queryDatabase('SELECT is_donor FROM users WHERE user_id=?', [own.userId]))[0].is_donor), 0);
        });
        await t.test('partial and full financial refunds reduce units immediately while successful net-positive payment count stays separate', async () => {
            const own = actor(91), first = await quote(own, 600), second = await quote(own, 600); await submit(own, first); await submit(own, second);
            const payment = await paymentFor(first.attemptId), refund = { id: 'unit-partial-refund', payment_id: payment.id, location_id: 'LOCATION', amount_money: { amount: 300, currency: 'JPY' }, status: 'COMPLETED' };
            square.refunds.set(refund.id, refund); payment.refund_ids = [refund.id]; payment.refunded_money = { amount: 300, currency: 'JPY' }; payment.updated_at = new Date(clock).toISOString();
            await fire(payment, 'unit-refund-partial', 'refund.updated', refund.id);
            let grant = await getSquareDonationGrant(db.queryDatabase, own.userId, clock, scope);
            assert.equal(grant.netAmount, 900); assert.equal(grant.purchaseUnits, 1); assert.equal(grant.paymentCount, 2);
            const rest = { ...refund, id: 'unit-rest-refund', amount_money: { amount: 300, currency: 'JPY' } }; square.refunds.set(rest.id, rest); payment.refund_ids.push(rest.id); payment.refunded_money.amount = 600;
            await fire(payment, 'unit-refund-full', 'refund.updated', rest.id); grant = await getSquareDonationGrant(db.queryDatabase, own.userId, clock, scope);
            assert.equal(grant.netAmount, 600); assert.equal(grant.purchaseUnits, 1); assert.equal(grant.paymentCount, 1);
            const other = await paymentFor(second.attemptId), full = { ...refund, id: 'unit-last-refund', payment_id: other.id, amount_money: { amount: 600, currency: 'JPY' } }; square.refunds.set(full.id, full); other.refund_ids = [full.id]; other.refunded_money = { amount: 600, currency: 'JPY' };
            await fire(other, 'unit-last-payment-refunded', 'refund.updated', full.id); grant = await getSquareDonationGrant(db.queryDatabase, own.userId, clock, scope);
            assert.equal(grant.purchaseUnits, 0); assert.equal(grant.extraSlots, 0); assert.equal(grant.paymentCount, 0); assert.equal(grant.active, false);
        });
        await t.test('unit expiry retains remaining eligible units automatically without status refresh or provider I/O', async () => {
            const own = actor(92), started = clock; await save({ supporterThreshold: 2000, validityDays: 30 });
            await submit(own, await quote(own, 1600)); clock += 10 * 86400000; await submit(own, await quote(own, 900));
            const initialGrant = await getSquareDonationGrant(db.queryDatabase, own.userId, clock, scope);
            assert.equal(initialGrant.purchaseUnits, 5); assert.equal(initialGrant.unitsValidUntilAtMs, started + 30 * 86400000);
            assert.equal(initialGrant.validUntilAtMs, started + 40 * 86400000, 'remaining units retain supporter priority after threshold eligibility ends');
            const start = square.requests.length; clock = started + 30 * 86400000;
            const reduced = await entitlements.inspectPlan(db.queryDatabase, own.userId, clock);
            assert.equal(reduced.addonGrantUnits, 1); assert.equal(reduced.addonExtraSlots, 4, '1600-yen and 900-yen purchases retain 3+1 permanent slots'); assert.equal(reduced.donationPaymentCount, 1); assert.equal(reduced.tier, 'supporter');
            assert.equal(reduced.addonValidUntilAtMs, started + 40 * 86400000);
            assert.equal(await isSquareDonationSupporter(db.queryDatabase, own.userId, clock, scope), true);
            clock = started + 40 * 86400000;
            const expired = await entitlements.inspectPlan(db.queryDatabase, own.userId, clock);
            assert.equal(expired.addonGrantUnits, 0); assert.equal(expired.addonExtraSlots, 4, 'legacy financial expiry does not erase purchased permanent slots'); assert.equal(expired.donationPaymentCount, 0); assert.equal(expired.tier, 'free');
            assert.equal(square.requests.length, start);
        });
        await t.test('manual and Square paid tiers add manual and purchased units while retaining their own send limits', async () => {
            await save({ supporterThreshold: null, validityDays: null });
            await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, ADMIN, { planId: 'unit-paid-proof', label: 'Unit proof', slotLimit: 4, minuteLimit: 77, dayLimit: 500, priority: 7 }));
            for (const [i, manual] of [true, false].entries()) {
                const own = actor(93 + i); await submit(own, await quote(own, 1500));
                await db.queryDatabase('UPDATE users SET is_donor=1,additional_auto_extract_slots=2 WHERE user_id=?', [own.userId]);
                if (manual) await db.withDatabaseTransaction(query => entitlements.setUserPlan(query, ADMIN, own.userId, 'unit-paid-proof'));
                else await db.queryDatabase(`INSERT INTO automation_square_subscriptions (owner_user_id,environment,merchant_id,plan_id,variation_id,customer_id,subscription_id,checkout_id,state,valid_until_at_ms,verified,updated_at_ms)
                    VALUES (?,'sandbox','MERCHANT','unit-paid-proof','UNITVAR','UNITCUSTOMER',?,?,'ACTIVE',?,1,?)`, [own.userId, `UNIT-SUB-${i}`, randomUUID(), clock + 86400000, clock]);
                const plan = await entitlements.inspectPlan(db.queryDatabase, own.userId, clock);
                assert.equal(plan.tier, 'paid'); assert.equal(plan.baseSlotLimit, 4); assert.equal(plan.manualExtraSlots, 2); assert.equal(plan.addonGrantUnits, 3); assert.equal(plan.addonExtraSlots, 3); assert.equal(plan.slotLimit, 9);
                assert.equal(plan.minuteLimit, 77); assert.equal(plan.dayLimit, 500); assert.equal(plan.priority, 7);
            }
        });
        await t.test('unit policy supports partial updates, explicit disable, safe caps and revision conflicts without erasing trusted manual privileges', async () => {
            const previous = (await donations.getAdmin(ADMIN)).policy, { slotsPerUnit: _omitted, ...partial } = previous;
            let policy = await donations.savePolicy(ADMIN, { ...partial, unitAmount: 600, expectedUpdatedAtMs: previous.updatedAtMs }); assert.equal(policy.unitAmount, 600); assert.equal(policy.slotsPerUnit, 3);
            const { unitAmount: _oldAmount, slotsPerUnit: _oldSlots, ...oldClient } = policy;
            policy = await donations.savePolicy(ADMIN, { ...oldClient, expectedUpdatedAtMs: policy.updatedAtMs }); assert.equal(policy.unitAmount, 600); assert.equal(policy.slotsPerUnit, 3);
            const own = actor(95); await submit(own, await quote(own, 10000));
            await db.queryDatabase('UPDATE users SET is_donor=1,additional_auto_extract_slots=10000 WHERE user_id=?', [own.userId]);
            policy = await save({ unitAmount: 1, slotsPerUnit: 10000 });
            const grant = await getSquareDonationGrant(db.queryDatabase, own.userId, clock, scope); assert.equal(grant.purchaseUnits, 10000); assert.equal(grant.extraSlots, 10000); assert.equal(grant.paymentCount, 1);
            await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, ADMIN, { planId: 'unit-cap-proof', label: 'Cap proof', slotLimit: 10000, minuteLimit: 5, dayLimit: 24, priority: 0 }));
            await db.withDatabaseTransaction(query => entitlements.setUserPlan(query, ADMIN, own.userId, 'unit-cap-proof'));
            assert.equal((await entitlements.inspectPlan(db.queryDatabase, own.userId, clock)).slotLimit, 20020, 'base and legacy manual grants remain; new payment credits exactly 10000/500 slots regardless of rolling multiplier');
            await assert.rejects(save({ slotsPerUnit: 10001 }), { code: 'SQUARE_DONATION_POLICY_INVALID' });
            await assert.rejects(donations.savePolicy(ADMIN, { ...policy, expectedUpdatedAtMs: policy.updatedAtMs - 1 }), { code: 'SQUARE_DONATION_POLICY_CONFLICT' });
            await save({ unitAmount: null, slotsPerUnit: null });
            const after = await entitlements.inspectPlan(db.queryDatabase, own.userId, clock); assert.equal(after.addonExtraSlots, 20, 'disabling legacy rolling units retains the 10000/500 permanent purchase'); assert.equal(after.slotLimit, 20020);
            assert.equal(Number((await db.queryDatabase('SELECT is_donor FROM users WHERE user_id=?', [own.userId]))[0].is_donor), 1);
        });
        await t.test('unit-only supporter grants use durable queue priority and retain the fourth oldest-first turn', async () => {
            await save({ supporterThreshold: null, validityDays: null, unitAmount: 500, slotsPerUnit: 3 });
            const donor = actor(90), free = actor(97); await db.queryDatabase('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,0)', [free.userId]);
            assert.equal(await isSquareDonationSupporter(db.queryDatabase, donor.userId, clock, scope), true);
            assert.equal(Number((await db.queryDatabase('SELECT is_donor FROM users WHERE user_id=?', [donor.userId]))[0].is_donor), 0);
            await db.queryDatabase("UPDATE automation_jobs SET state='sent' WHERE state='pending'");
            await db.queryDatabase('UPDATE automation_counters SET used_count=0 WHERE counter_key=?', [require('../../src/automation/service').hash('automation:discord:priority-turn')]);
            for (const owner of [free.userId, donor.userId]) for (let i = 0; i < 4; i++) {
                const runId = randomUUID(), jobId = randomUUID();
                await db.queryDatabase('INSERT INTO automation_runs (id,dedupe_key,owner_user_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)', [runId, createHash('sha256').update(jobId).digest('hex'), owner, 'private', 'price', 1, '{}', '[]', 'queued', clock]);
                await db.queryDatabase('INSERT INTO automation_jobs (id,run_id,plan_json,due_at_ms,state,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?)', [jobId, runId, JSON.stringify({ context: {}, schedules: [] }), clock, 'pending', clock + (owner === free.userId ? 0 : 1), clock]);
            }
            const queue = require('../../src/automation/queue').createQueue(db, {}), owners = [];
            for (let i = 0; i < 4; i++) { const job = await queue.claim(clock); owners.push(job.owner_user_id); await queue.transition(job, 'sent'); }
            assert.deepEqual(owners, [donor.userId, donor.userId, donor.userId, free.userId]);
        });
    } finally { for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await db.close(); }
});

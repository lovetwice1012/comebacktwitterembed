'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRunner } = require('../../src/automation/runtime');
const { createTransport, publicAddress, splitText, filterMedia } = require('../../src/automation/transport');
const { runBoundedFetches, applyBudget } = require('../../src/automation/fetch-budget');
const G = '111111111111111111', U = '222222222222222222', C = '333333333333333333', M = '444444444444444444';

function fixture(transport, overrides = {}) {
    const states = [], acks = [];
    const job = { id: 'job', run_id: 'run', target_kind: 'price', target_id: '1', owner_user_id: U, attempts: 0, created_at_ms: 1000,
        plan: { context: { userId: U }, schedules: [], event: { title: 'sale' } }, ...overrides };
    const queue = { claim: async () => job, check: async () => ({ state: 'ready', destination: {} }), beginSend: async () => ({ state: 'sending' }),
        transition: async (_job, state, code, due) => { states.push({ state, code, due }); return true; }, acknowledgeStep: async (_job, id) => { acks.push(id); } };
    const query = async sql => sql.startsWith('SELECT expires') ? [{ expires_at_ms: 0 }] : { affectedRows: 1 };
    const db = { queryDatabase: query, withDatabaseTransaction: work => work(query) };
    return { states, acks, job, queue, db, run: options => createRunner(db, queue, transport, { clock: () => 2000, assertAllowed: () => {}, notificationAllowed: () => true, ...options }).tick() };
}
test('runner persists each confirmed step then completes; recovery quarantine performs no transport I/O', async () => {
    let prepares = 0, sends = 0;
    const transport = { prepare: async () => { prepares++; return { payloads: [{}, {}] }; }, sendStep: async () => { sends++; return M; } };
    const f = fixture(transport);
    assert.equal((await f.run()).state, 'sent'); assert.equal(f.acks.length, 2); assert.equal(sends, 2);
    await f.run({ notificationAllowed: () => false }); assert.equal(prepares, 1); assert.equal(sends, 2);
    assert.equal(f.states.at(-1).code, 'RECOVERY_QUARANTINED');
});
test('timeout, HTTP 5xx and unpersistable ACK become unknown with no automatic resend', async () => {
    for (const failure of [Object.assign(new Error('secret'), { code: 'ETIMEDOUT' }), Object.assign(new Error('secret'), { status: 502 })]) {
        let calls = 0;
        const f = fixture({ prepare: async () => ({ payloads: [{}] }), sendStep: async () => { calls++; throw failure; } });
        assert.equal((await f.run()).state, 'unknown'); assert.equal(calls, 1);
        assert(!JSON.stringify(f.states).includes('secret'));
    }
    const f = fixture({ prepare: async () => ({ payloads: [{}] }), sendStep: async () => M });
    f.queue.acknowledgeStep = async () => { throw new Error('DB disconnected'); };
    assert.equal((await f.run()).state, 'unknown');
});
test('429 is deferred; known failure after a confirmed step becomes partial and is never replayed wholesale', async () => {
    const rate = Object.assign(new Error('rate limited'), { name: 'RateLimitError', retryAfter: 120000 });
    let calls = 0;
    const f = fixture({ prepare: async () => ({ payloads: [{}, {}] }), sendStep: async () => { calls++; if (calls > 1) throw rate; return M; } });
    assert.equal((await f.run()).state, 'partial'); assert.equal(f.acks.length, 1);
    const fresh = fixture({ prepare: async () => ({ payloads: [{}] }), sendStep: async () => { throw rate; } });
    assert.equal((await fresh.run()).state, 'pending'); assert.equal(fresh.states.at(-1).due, 122000);
});
test('revocation after prepare prevents send, and waiting for provider headroom does not exhaust transport retries', async () => {
    let sent = false;
    const f = fixture({ prepare: async () => ({ payloads: [{}] }), sendStep: async () => { sent = true; } });
    f.queue.beginSend = async () => ({ state: 'cancelled', code: 'MONITOR_CHANGED' });
    assert.equal((await f.run()).state, 'cancelled'); assert.equal(sent, false);
    const paced = fixture({ prepare: async () => { throw Object.assign(new Error('paced'), { code: 'AUTOMATION_PROVIDER_PACED', retryAfterMs: 40000 }); } });
    assert.equal((await paced.run()).code, 'PROVIDER_HEADROOM'); assert.equal(paced.states.at(-1).due, 42000);
});
test('transport disables mentions, uses nonce for DM and only confirmed same-channel IDs are accepted', async () => {
    const requests = [];
    const rest = { post: async (route, body) => { requests.push({ route, body }); return route === '/users/@me/channels' ? { id: C } : { id: M, channel_id: C }; } };
    const client = { options: { jsonTransformer: value => value, allowedMentions: { parse: ['everyone'] } } };
    const transport = createTransport({}, {}, client, { rest, safety: { assertNotification: async () => {} } });
    const job = { id: 'job', owner_user_id: U, plan: { context: {}, event: {}, display: { format: 'text', media: 'inherit' }, text: '@everyone sale' } };
    const prepared = await transport.prepare(job, { kind: 'dm', dm_user_id: U });
    assert.deepEqual(prepared.payloads[0].body.allowed_mentions.parse, []);
    assert.equal(prepared.payloads[0].body.flags, 4);
    assert.equal(await transport.sendStep(prepared, job, 0), M);
    assert.equal(requests.at(-1).body.body.enforce_nonce, true);
    assert.equal(requests.at(-1).body.body.nonce.length, 24);
    await assert.rejects(transport.prepare(job, { kind: 'dm', dm_user_id: M }), { code: 'DM_OWNER_MISMATCH' });
});
test('expanded scheduled price alerts use the stored price and delta rather than refetching another market', async () => {
    let calls = 0;
    const rest = { post: async route => { calls++; assert.equal(route, '/users/@me/channels'); return { id: C }; } };
    const client = { options: { jsonTransformer: value => value } }, transport = createTransport({}, {}, client, { rest });
    const job = { id: 'price', owner_user_id: U, target_kind: 'price', guild_id: G, plan: { context: { locale: 'ja' }, event: { title: '観測した商品', priceAmount: 950, priceDelta: -150, currency: 'JPY', discountPercent: 20, observedAtMs: 1000, url: 'https://store.steampowered.com/app/730' }, display: { format: 'expanded', media: 'inherit' }, text: '予定された価格通知' } };
    const prepared = await transport.prepare(job, { kind: 'dm', dm_user_id: U });
    assert.equal(calls, 1); assert(prepared.payloads[0].body.embeds[0].fields.some(f => f.name === '増減' && f.value === '-150 JPY'));
    assert.equal(prepared.payloads[0].body.embeds[0].timestamp, '1970-01-01T00:00:01.000Z');
});
test('legacy webhook resolves real destination channel but rejects cross-guild movement', async () => {
    let verifiedChannel;
    const webhook = { id: M, guild_id: G, channel_id: C, type: 1 };
    const rest = { get: async () => webhook };
    const db = { queryDatabase: async () => [{ webhook_url: `https://discord.com/api/webhooks/${M}/${'a'.repeat(60)}` }] };
    const destinations = { verifyChannel: async (_actor, _guild, channelId) => { verifiedChannel = channelId; return { channel: { id: channelId }, member: { roles: [] } }; } };
    const client = { options: { jsonTransformer: v => v } };
    const transport = createTransport(db, destinations, client, { rest });
    const job = { id: 'job', owner_user_id: U, plan: { context: {}, event: {}, display: { format: 'text', media: 'inherit' }, text: 'test' } };
    await transport.prepare(job, { kind: 'webhook', guild_id: G, channel_id: 'legacy-origin', webhook_endpoint_id: '1' });
    assert.equal(verifiedChannel, C);
    webhook.guild_id = U;
    await assert.rejects(transport.prepare(job, { kind: 'webhook', guild_id: G, channel_id: C, webhook_endpoint_id: '1' }), { code: 'WEBHOOK_MOVED' });
});
test('media suppression removes attachment/image URLs, text chunking preserves surrogate pairs, private IPs are denied', () => {
    const step = filterMedia({ content: 'caption', embeds: [{ image: { url: 'https://example.org/image.png' }, description: 'description' }], files: ['https://example.org/file.png'] }, 'hide');
    assert.equal(step.embeds[0].image, undefined); assert.equal(step.files.length, 0);
    const text = 'x'.repeat(1899) + '🎉'.repeat(3); assert.equal(splitText(text).join(''), text);
    for (const ip of ['127.0.0.1', '169.254.169.254', '10.1.1.1', '172.16.0.1', '192.168.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1']) assert.equal(publicAddress(ip), false, ip);
    assert.equal(publicAddress('8.8.8.8'), true);
});
test('opt-in fetch budgets bound fallback attempts even when a provider catches errors', async () => {
    const options = { follow: 20 };
    assert.equal(applyBudget(options), options);
    await assert.rejects(runBoundedFetches(1, async () => { assert.equal(applyBudget(options).follow, 1); try { applyBudget(options); } catch {} return []; }), { code: 'AUTOMATION_FETCH_BUDGET' });
    assert.equal(applyBudget(options), options);
    await runBoundedFetches(1, async () => {
        const sanitized = applyBudget({ headers: { Authorization: 'Bearer operator-secret', Cookie: 'session=operator-secret', Accept: 'application/json' } });
        assert.equal(sanitized.headers.has('authorization'), false);
        assert.equal(sanitized.headers.has('cookie'), false);
        assert.equal(sanitized.headers.get('accept'), 'application/json');
        assert.throws(() => applyBudget({}, 'https://id.twitch.tv/oauth2/token?client_secret=operator-secret'), { code: 'AUTOMATION_GUEST_ONLY' });
    });
});
test('guest Twitch expansion does not mint or reuse an operator credential', async () => {
    const previousId = process.env.TWITCH_CLIENT_ID, previousSecret = process.env.TWITCH_CLIENT_SECRET;
    process.env.TWITCH_CLIENT_ID = 'fixture-client'; process.env.TWITCH_CLIENT_SECRET = 'must-not-be-sent';
    try {
        const provider = require('../../src/providers/twitch');
        const token = await runBoundedFetches(0, () => provider._internal.fetchTwitchAppToken());
        assert.equal(token, null);
    } finally {
        if (previousId === undefined) delete process.env.TWITCH_CLIENT_ID; else process.env.TWITCH_CLIENT_ID = previousId;
        if (previousSecret === undefined) delete process.env.TWITCH_CLIENT_SECRET; else process.env.TWITCH_CLIENT_SECRET = previousSecret;
    }
});
test('shutdown during preparation prevents new submission; a stop between confirmed parts is recorded as partial', async () => {
    let stopping = false, sends = 0;
    const f = fixture({ prepare: async () => { stopping = true; return { payloads: [{}] }; }, sendStep: async () => { sends++; return M; } });
    assert.equal((await f.run({ isStopping: () => stopping })).state, 'stopped'); assert.equal(sends, 0);
    stopping = false;
    const partial = fixture({ prepare: async () => ({ payloads: [{}, {}] }), sendStep: async () => { stopping = true; sends++; return M; } });
    assert.equal((await partial.run({ isStopping: () => stopping })).state, 'partial'); assert.equal(sends, 1);
});

test('mechanical failures and denials terminate without holds, including after a confirmed part', async () => {
    const { SafetyError } = require('../../src/automation/safety');
    for (const [decision, state] of [['deny', 'excluded'], ['error', 'failed']]) {
        const f = fixture({ prepare: async () => ({ payloads: [{}] }), sendStep: async () => { throw new SafetyError('SAFETY_FIXTURE', decision); } });
        assert.equal((await f.run()).state, state);
        assert.deepEqual(f.states, [{ state, code: 'SAFETY_FIXTURE', due: undefined }]);
        let sends = 0;
        const partial = fixture({ prepare: async () => ({ payloads: [{}, {}] }), sendStep: async () => {
            if (sends++) throw new SafetyError('SAFETY_FIXTURE', decision);
            return M;
        } });
        assert.equal((await partial.run()).state, 'partial'); assert.equal(partial.acks.length, 1);
    }
    let prepares = 0;
    const unavailable = fixture({ readiness: () => false, prepare: async () => { prepares++; } });
    assert.equal((await unavailable.run()).state, 'failed'); assert.equal(prepares, 0);
});

test('a delivery window closing after preparation keeps quiet hours and expires exhausted deadlines', async () => {
    const clock = Date.UTC(2026, 0, 5, 22, 0), opens = Date.UTC(2026, 0, 6, 9, 0);
    const schedule = { zone: 'UTC', days: [1, 2, 3, 4, 5, 6, 7], windows: [{ start: '00:00', end: '00:00' }], quiet: [{ start: '21:00', end: '09:00' }], datesExcluded: [], maxWaitDays: 7 };
    let sent = 0;
    const transport = { prepare: async () => ({ payloads: [{}] }), sendStep: async () => { sent++; return M; } };
    const queued = fixture(transport);
    queued.job.plan.schedules = [schedule];
    assert.equal((await queued.run({ clock: () => clock })).state, 'pending');
    assert.equal(queued.states.at(-1).due, opens); assert.equal(sent, 0);
    const expired = fixture(transport, { deadline_ms: clock - 1 });
    assert.equal((await expired.run({ clock: () => clock })).state, 'expired'); assert.equal(sent, 0);
});

test('corrupt legacy dependency metadata fails the mechanical check instead of creating a hold', async () => {
    const { assertPackageSafety } = require('../../src/automation/package-safety');
    const query = async sql => sql.includes('automation_revisions') ? [{ bindings_json: '{broken' }] : [];
    await assert.rejects(assertPackageSafety(query, { workflow_id: 'fixture', revision: 1, plan: {} }), { code: 'SAFETY_DEPENDENCIES_UNAVAILABLE', decision: 'error' });
    for (const refs of [[], { words: null }, { words: { id: 'dictionary', revision: 0 } }]) {
        await assert.rejects(assertPackageSafety(query, { plan: { dictionaryRefs: refs } }), { code: 'SAFETY_DEPENDENCIES_UNAVAILABLE', decision: 'error' });
    }
});

function pacedFixture(count, initialTime = 1000) {
    let now = initialTime;
    const sentAt = [], renewAt = [], counters = new Map();
    const f = fixture({ prepare: async () => ({ payloads: Array.from({ length: count }, () => ({})) }), sendStep: async () => { sentAt.push(now); return M; } });
    const query = async (sql, params) => {
        if (sql.startsWith('SELECT expires_at_ms')) return [{ expires_at_ms: counters.get(params[0]) || 0 }];
        if (sql.startsWith('UPDATE automation_counters SET expires_at_ms')) counters.set(params[1], params[0]);
        return { affectedRows: 1 };
    };
    f.db.withDatabaseTransaction = work => work(query);
    f.queue.renewLease = async (_job, at) => { renewAt.push(at); return true; };
    return { ...f, sentAt, renewAt, options: { clock: () => now, sleep: async ms => { assert(ms > 0 && ms <= 1000); now += ms; } } };
}

test('every send step reserves durable headroom and renews the lease throughout long batches', async () => {
    const f = pacedFixture(70);
    assert.equal((await f.run(f.options)).state, 'sent');
    assert.equal(f.sentAt.length, 70); assert.equal(f.acks.length, 70);
    for (let i = 1; i < f.sentAt.length; i++) assert(f.sentAt[i] - f.sentAt[i - 1] >= 2000);
    assert(f.sentAt.at(-1) - f.sentAt[0] > 120000, 'the batch exceeds a single lease lifetime');
    assert(f.renewAt.length >= 70); assert.equal(f.renewAt.at(-1), f.sentAt.at(-1));
    assert.deepEqual(f.states.map(row => row.state), ['sent']);
});

test('paced batches stop at quiet hours, shutdown or lost ownership without replaying confirmed parts', async () => {
    const quiet = pacedFixture(5, Date.UTC(2026, 0, 5, 20, 59, 55));
    quiet.job.plan.schedules = [{ zone: 'UTC', days: [1, 2, 3, 4, 5, 6, 7], windows: [{ start: '00:00', end: '00:00' }], quiet: [{ start: '21:00', end: '09:00' }], datesExcluded: [], maxWaitDays: 7 }];
    assert.equal((await quiet.run(quiet.options)).state, 'partial');
    assert.equal(quiet.sentAt.length, 2); assert(quiet.sentAt.every(at => at < Date.UTC(2026, 0, 5, 21, 0)));
    const stopping = pacedFixture(5);
    assert.equal((await stopping.run({ ...stopping.options, isStopping: () => stopping.sentAt.length > 0 })).state, 'partial');
    assert.equal(stopping.sentAt.length, 1);
    const lost = pacedFixture(5);
    lost.queue.renewLease = async () => lost.sentAt.length === 0;
    assert.equal((await lost.run(lost.options)).state, 'lease_lost');
    assert.equal(lost.sentAt.length, 1); assert.equal(lost.states.length, 0, 'the expired send lease owns recovery, never a new pending batch');
    const delayed = pacedFixture(1);
    delayed.job.deadline_ms = 3500;
    const transaction = delayed.db.withDatabaseTransaction;
    let calls = 0;
    delayed.db.withDatabaseTransaction = async work => {
        const result = await transaction(work);
        if (++calls === 4) await delayed.options.sleep(1000);
        return result;
    };
    assert.equal((await delayed.run(delayed.options)).state, 'expired');
    assert.equal(delayed.sentAt.length, 0, 'slow reservation I/O cannot cross the deadline and still send');
});

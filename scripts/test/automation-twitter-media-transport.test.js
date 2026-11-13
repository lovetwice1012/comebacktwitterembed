'use strict';

// Exercise the real Twitter extractor and transport preparation with a closed
// network fixture. No Discord, X, DNS or database service is contacted.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');

function isolated(filename, mocks) {
    const actualRequire = createRequire(filename), mod = { exports: {} };
    compileFunction(readFileSync(filename, 'utf8'), ['require', 'module', 'exports', 'console'], { filename: `${filename}.fixture.cjs` })(
        id => Object.hasOwn(mocks, id) ? mocks[id] : actualRequire(id), mod, mod.exports,
        { log() {}, warn() {}, error() {} });
    return mod.exports;
}

const OWNER = '222222222222222222', CHANNEL = '333333333333333333';
const GUILD = '444444444444444444', WEBHOOK = '555555555555555555';
const POST_URL = 'https://x.com/fixture/status/1234567890123456789';
const images = Array.from({ length: 20 }, (_, i) => `https://pbs.twimg.com/media/photo-${i + 1}.jpg`);

async function prepare(destinationKind, legacyMode, options = {}) {
    const seenImages = [], posts = [], rateEvents = [];
    const fakeFetch = async value => {
        const url = new URL(String(value));
        if (url.hostname === 'pbs.twimg.com') {
            seenImages.push(url.href);
            const index = Number(url.pathname.match(/photo-(\d+)/)?.[1]) - 1;
            return { ok: true, status: 200, buffer: async () => options.sizes
                ? Buffer.alloc(options.sizes[index], index + 1) : Buffer.from(`fixture-${url.pathname.split('/').pop()}`) };
        }
        if (url.hostname === 'altterx.sprink.cloud') return { text: async () => 'ok' };
        assert.equal(url.hostname, 'api.vxtwitter.com', 'unexpected network destination');
        return { text: async () => JSON.stringify({ tweetURL: POST_URL, text: 'fixture post', user_name: 'fixture',
            user_screen_name: 'fixture', date: '2026-01-01T00:00:00Z', mediaURLs: images }) };
    };
    const provider = isolated(require.resolve('../../src/providers/twitter'), {
        '../../providerFetch': { withDeadline: () => fakeFetch },
        '../../adminSupport/providerSources': { resolvePlan: async () => ({ sources: [{ origin: 'https://api.vxtwitter.com' }] }) },
    });
    const { createTransport } = isolated(require.resolve('../../src/automation/transport'), {
        'node:dns': { promises: { lookup: async () => [{ address: '8.8.8.8', family: 4 }] } },
        'node:https': { Agent: class { destroy() {} } },
        '../providerFetch': { withDeadline: () => fakeFetch },
        '../providers/_loader': { loadProviders: () => [{ ...provider, id: options.providerId || 'twitter', ...(options.steps ? { extract: async () => options.steps } : {}) }] },
        '../providers/_provider_settings': {
            PROVIDER_DEFAULTS: { legacy_mode: undefined },
            getProviderSettings: async () => ({ enabled: true, legacy_mode: legacyMode }),
        },
    });
    const db = options.db || { queryDatabase: async () => [{ webhook_url: `https://discord.com/api/webhooks/${WEBHOOK}/${'a'.repeat(60)}` }] };
    const rest = {
        post: async (route, payload) => {
            if (route === '/users/@me/channels') return { id: CHANNEL, recipients: [{ id: OWNER, username: 'fixture' }] };
            posts.push({ route, payload });
            if (options.failPost === posts.length) throw Object.assign(new Error('synthetic failure'), options.failStatus ? { status: options.failStatus } : { code: 'ETIMEDOUT' });
            return { id: String(666666666666666660n + BigInt(posts.length)), channel_id: CHANNEL };
        },
        get: async () => ({ id: WEBHOOK, channel_id: CHANNEL, guild_id: GUILD, type: 1 }),
    };
    const destinations = { verifyChannel: async () => ({ member: { user: { username: 'fixture' }, roles: [] }, channel: { nsfw: false } }) };
    const rateLimiter = options.rateLimiter || {
        reserveNotifications: async (_principal, count) => { rateEvents.push(['reserve', count]); if (options.failReserve) throw Error('synthetic DB failure'); return { count, expiresAtMs: Number.MAX_SAFE_INTEGER }; },
        beginNotification: async (_reservation, index) => { rateEvents.push(['begin', index]); },
        commitNotification: async (_reservation, index) => { rateEvents.push(['commit', index]); },
        releaseNotifications: async (_reservation, index) => { rateEvents.push(['release', index]); },
        retainUnknownNotification: async (_reservation, index) => { rateEvents.push(['unknown', index]); },
    };
    let entitlementCalls = 0;
    const transport = createTransport(db, destinations, { options: { jsonTransformer: value => value } }, {
        rest, rateLimiter, safety: { assertNotification: async () => {} }, skipProviderBudget: true,
        entitlementResolver: async () => { if (options.failEntitlementAfter && ++entitlementCalls > options.failEntitlementAfter) throw Error('synthetic DB failure'); return { slotId: `${OWNER}:1`, slotIndex: 1, minuteLimit: 5, dayLimit: 24 }; },
        membershipResolver: async (_db, job) => [{ targetKind: job.target_kind, targetId: String(job.target_id) }],
    });
    const job = { id: 'fixture', owner_user_id: OWNER, target_kind: 'x', target_id: '1', plan: {
        context: { locale: 'ja' }, event: { providerId: options.providerId || 'twitter', url: POST_URL }, schedules: [],
        display: { format: 'expanded', media: 'inherit' }, text: 'notification fixture',
    } };
    const destination = destinationKind === 'dm' ? { kind: 'dm', dm_user_id: OWNER }
        : { kind: 'webhook', guild_id: GUILD, webhook_endpoint_id: '1' };
    return { prepared: await transport.prepare(job, destination), seenImages, transport, job, destination, db, posts, rateEvents };
}

test('expanded X automatic notifications prepare all 20 images in order for DM and webhook contexts', async () => {
    for (const [kind, mode] of [['dm', undefined], ['webhook', undefined], ['webhook', true]]) {
        const { prepared, seenImages } = await prepare(kind, mode);
        assert.equal(prepared.payloads.length, 2, `${kind}: message count`);
        assert.deepEqual(prepared.payloads.map(part => part.files.length), [10, 10]);
        assert.deepEqual(seenImages, images);
        assert.deepEqual(prepared.payloads.flatMap(part => part.files.map(file => file.data.toString())),
            images.map(url => `fixture-${new URL(url).pathname.split('/').pop()}`));
        assert.match(prepared.payloads[0].body.content, /notification fixture/);
        assert.ok(!prepared.payloads[1].body.content);
        assert.equal(prepared.payloads[0].body.embeds.length, 1);
        assert.ok(!prepared.payloads[1].body.embeds?.length);
    }
});

test('large expanded X images split by request bytes in order for DM and webhook without duplicating post details', async () => {
    const sizes = Array(20).fill(3 * 1024 * 1024);
    for (const kind of ['dm', 'webhook']) {
        const { prepared, seenImages, transport, job, rateEvents } = await prepare(kind, undefined, { sizes });
        assert.deepEqual(prepared.payloads.map(part => part.files.length), [8, 2, 8, 2]);
        assert.deepEqual(seenImages, images);
        assert.deepEqual(prepared.payloads.flatMap(part => part.files.map(file => file.data[0])), Array.from({ length: 20 }, (_, i) => i + 1));
        assert(prepared.payloads.every(part => part.files.reduce((n, file) => n + file.data.length, 0) <= 24 * 1024 * 1024));
        assert(prepared.payloads.every(part => part.files.reduce((n, file) => n + file.data.length, 0) + Buffer.byteLength(JSON.stringify(part.body)) + 64 * 1024 <= 25 * 1024 * 1024));
        assert.match(prepared.payloads[0].body.content, /notification fixture/);
        assert.equal(prepared.payloads[0].body.embeds.length, 1);
        assert(prepared.payloads.slice(1).every(part => !part.body.content && !part.body.embeds?.length && !part.body.components?.length));
        await transport.reserve(prepared, job);
        assert.deepEqual(rateEvents, [['reserve', 4]], 'reserve actual Discord message count before sending');
    }
});

test('single images too large for the safe multipart budget and non-X totals fail before posting', async () => {
    await assert.rejects(prepare('dm', undefined, { sizes: [24 * 1024 * 1024 + 1, ...Array(19).fill(1)] }), { code: 'ATTACHMENT_LIMIT' });
    // This new X-specific splitting must not change unrelated providers.
    await assert.rejects(prepare('dm', undefined, { providerId: 'other', sizes: Array(20).fill(3 * 1024 * 1024) }), { code: 'ATTACHMENT_LIMIT' });
});

test('size continuations preserve inline quote embeds on the first message only', async () => {
    const parts = [{ content: '元投稿', embeds: [{ title: '投稿', description: '本文' }, { title: '引用', description: '引用本文' }],
        files: Array.from({ length: 10 }, (_, i) => ({ attachment: Buffer.alloc(3 * 1024 * 1024, i + 1), name: `photo-${i}.jpg` })) }];
    const { prepared } = await prepare('dm', undefined, { steps: parts });
    assert.deepEqual(prepared.payloads.map(part => part.files.length), [8, 2]);
    assert.deepEqual(prepared.payloads[0].body.embeds.map(embed => embed.title), ['投稿', '引用']);
    assert.match(prepared.payloads[0].body.content, /元投稿/);
    assert.equal(prepared.payloads[1].body.embeds?.length || 0, 0); assert(!prepared.payloads[1].body.content);
});

test('reservation/entitlement DB failures leave every split part unsent', async () => {
    for (const options of [{ failReserve: true }, { failEntitlementAfter: 1 }]) {
        const { prepared, transport, job, posts } = await prepare('dm', undefined, { ...options, sizes: Array(20).fill(3 * 1024 * 1024) });
        await assert.rejects(transport.reserve(prepared, job)); assert.equal(posts.length, 0);
    }
});

test('an unknown Discord result in the second split part cannot be resent or continue the batch', async () => {
    const { prepared, transport, job, posts, rateEvents } = await prepare('dm', undefined, { failPost: 2, sizes: Array(20).fill(3 * 1024 * 1024) });
    await transport.reserve(prepared, job);
    await transport.sendStep(prepared, job, 0);
    await assert.rejects(transport.sendStep(prepared, job, 1), { code: 'ETIMEDOUT' });
    assert(rateEvents.some(event => event[0] === 'commit' && event[1] === 0));
    assert(rateEvents.some(event => event[0] === 'unknown' && event[1] === 1));
    await assert.rejects(transport.sendStep(prepared, job, 1), { name: 'SafetyError' });
    await assert.rejects(transport.sendStep(prepared, job, 2), { name: 'SafetyError' });
    assert.equal(posts.length, 2);
});

test('runner stops size-split delivery at known or unknown Discord failures without replaying confirmed parts', async () => {
    const { createRunner } = require('../../src/automation/runtime');
    for (const [failure, expected] of [[{ failPost: 1, failStatus: 400 }, 'failed'], [{ failPost: 2, failStatus: 400 }, 'partial'], [{ failPost: 2 }, 'unknown']]) {
        const f = await prepare('dm', undefined, { ...failure, sizes: Array(20).fill(3 * 1024 * 1024) });
        const acks = [], transitions = [];
        const queue = {
            claim: async () => f.job, check: async () => ({ state: 'ready', destination: f.destination }),
            beginSend: async () => ({ state: 'sending', attempts: 1 }),
            acknowledgeStep: async (_job, id) => { acks.push(id); },
            transition: async (_job, state, code) => { transitions.push({ state, code }); return true; },
        };
        const db = { queryDatabase: async () => ({ affectedRows: 1 }), withDatabaseTransaction: async work => work(async sql =>
            sql.startsWith('SELECT expires') ? [{ expires_at_ms: 0 }] : { affectedRows: 1 }) };
        const runnerTransport = { prepare: async () => f.prepared, reserve: f.transport.reserve, sendStep: f.transport.sendStep, release: f.transport.release };
        const runner = createRunner(db, queue, runnerTransport, { clock: () => 2000, assertAllowed: () => {}, notificationAllowed: () => true });
        const result = await runner.tick();
        assert.equal(result.state, expected); assert.equal(f.posts.length, failure.failPost);
        assert.equal(acks.length, failure.failPost - 1); assert.equal(transitions.at(-1).state, expected);
    }
});

const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
test('real SQL reserves every byte-split message, retains an unknown and releases only unsent parts', { skip: !port, timeout: 60000 }, async () => {
    assert([33621, 33622].includes(port), 'only an explicit isolated database port is permitted');
    const db = await require('../lib/automation-test-db').createTestDatabase(port);
    try {
        const limiter = require('../../src/automation/rate-limits').createRateLimiter(db);
        const { prepared, transport, job, posts } = await prepare('dm', undefined, { db, rateLimiter: limiter, failPost: 2, sizes: Array(20).fill(3 * 1024 * 1024) });
        await transport.reserve(prepared, job);
        let usage = await limiter.getSlotUsage(`${OWNER}:1`);
        assert.equal(usage.todayUsed, 0); assert.equal(usage.todayReserved, 4);
        await transport.sendStep(prepared, job, 0);
        await assert.rejects(transport.sendStep(prepared, job, 1), { code: 'ETIMEDOUT' });
        usage = await limiter.getSlotUsage(`${OWNER}:1`);
        assert.equal(usage.todayUsed, 1); assert.equal(usage.todayReserved, 1);
        const rows = await db.queryDatabase('SELECT parts_json FROM automation_rate_reservations WHERE owner_user_id=?', [OWNER]);
        assert.equal(rows.length, 1); assert.deepEqual(JSON.parse(rows[0].parts_json), ['committed', 'unknown', 'released', 'released']);
        await assert.rejects(transport.sendStep(prepared, job, 2), { name: 'SafetyError' });
        assert.equal(posts.length, 2);

        // An actual SQL transaction failure after reservation writes must roll
        // back every counter and must never admit any Discord post.
        await db.queryDatabase('DELETE FROM automation_rate_reservations');
        await db.queryDatabase('DELETE FROM automation_counters');
        let failTransaction = false, injected = 0;
        const failedDb = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(async query => {
            let wroteCounters = false;
            const wrapped = async (sql, params, options) => {
                if (/^INSERT INTO automation_counters/i.test(sql)) wroteCounters = true;
                return query(sql, params, options);
            };
            const result = await work(wrapped);
            if (failTransaction && wroteCounters) { injected++; throw Error('synthetic transaction failure after counter writes'); }
            return result;
        }) };
        const failedLimiter = require('../../src/automation/rate-limits').createRateLimiter(failedDb);
        const failed = await prepare('dm', undefined, { db: failedDb, rateLimiter: failedLimiter, sizes: Array(20).fill(3 * 1024 * 1024) });
        failTransaction = true;
        await assert.rejects(failed.transport.reserve(failed.prepared, failed.job));
        assert.equal(injected, 1);
        assert.equal(failed.posts.length, 0);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_counters'))[0].n), 0);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_rate_reservations'))[0].n), 0);

        // The existing plan limit applies to physical messages, including the
        // new continuations; exceeding it must not reserve or send a prefix.
        const tooMany = await prepare('dm', undefined, { db, rateLimiter: limiter, sizes: Array(20).fill(5 * 1024 * 1024) });
        assert.equal(tooMany.prepared.payloads.length, 6);
        await assert.rejects(tooMany.transport.reserve(tooMany.prepared, tooMany.job), { code: 'AUTOMATION_DELIVERY_SIZE_LIMIT' });
        assert.equal(tooMany.posts.length, 0);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_counters'))[0].n), 0);
    } finally { await db.close(); }
});

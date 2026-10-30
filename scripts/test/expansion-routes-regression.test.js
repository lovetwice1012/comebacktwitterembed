'use strict';

// Real recognition, cleaning, queue, telemetry and dispatch. Provider outputs
// and Discord/storage boundaries are fixtures; provider acquisition is covered
// separately by each *.extract.test.js and autoWatch.providers.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');
const loader = require('../../src/providers/_loader');
const utils = require('../../src/utils');
const { WorkQueue } = require('../../src/workQueue');

const samples = {
    amazon: 'https://www.amazon.com/dp/B08N5WRWNW',
    booth: 'https://sample.booth.pm/items/123',
    github: 'https://github.com/octocat/Hello-World',
    instagram: 'https://www.instagram.com/p/CODE123/',
    niconico: 'https://www.nicovideo.jp/watch/sm12345',
    pixiv: 'https://www.pixiv.net/artworks/12345',
    spotify: 'https://open.spotify.com/track/2up3OPMp9Tb4dAKM2erWXQ',
    steam: 'https://store.steampowered.com/app/730/',
    tiktok: 'https://www.tiktok.com/@sample/video/1234567890123456789',
    twitch: 'https://clips.twitch.tv/SampleClip-abc_123',
    twitter: 'https://x.com/u/status/123',
    youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
};

function isolated(filename, mocks) {
    const actualRequire = createRequire(filename), mod = { exports: {} };
    compileFunction(readFileSync(filename, 'utf8'), ['require', 'module', 'exports', 'console'], { filename: `${filename}.fixture.cjs` })(
        id => Object.hasOwn(mocks, id) ? mocks[id] : actualRequire(id), mod, mod.exports,
        { log() {}, warn() {}, error() {} });
    return mod.exports;
}

function harness(options = {}) {
    const events = { extracted: [], payloads: [], traces: [], errors: [], metrics: [], cleanup: [], settings: [], sends: [] };
    const settings = options.settings || (() => ({ enabled: true, button_invisible: { all: true } }));
    const tracking = {
        recordMetric: key => events.metrics.push(key),
        recordError: (error, context) => events.errors.push({ error, context }),
    };
    const dispatch = isolated(require.resolve('../../src/providers/_dispatcher'), {
        '../errorTracking': tracking,
        '../settings': { checkComponentIncludesDisabledButtonAndIfFindDeleteIt: async rows => rows },
        '../state': { incrementProcessedCounters() {} },
        '../sharedPostHistory': { run: (_message, steps, _context, send) => send(steps) },
        '../mediaGallery': { prepare: async step => ({ step }) },
        '../personalLinks/cards': { prepare: async step => ({ step }) },
    });
    const source = () => {
        const message = {
            id: 'source', guildId: 'guild', channelId: 'channel',
            guild: { id: 'guild' }, author: { id: 'user', bot: false },
            member: { roles: { cache: new Map() } }, content: samples.twitter,
            suppressEmbeds: async () => events.cleanup.push('suppress'),
            delete: async () => events.cleanup.push('delete'),
        };
        const send = mode => async payload => {
            events.payloads.push(structuredClone(payload)); events.sends.push(mode);
            if (options.send) await options.send(payload, events.payloads.length);
            const response = { id: `sent-${events.payloads.length}`, channelId: 'channel' };
            response.reply = send(`reply-${response.id}`);
            return response;
        };
        message.channel = { id: 'channel', send: send('channel') };
        message.reply = send('reply-source');
        return message;
    };
    const queue = options.queue || new WorkQueue({ concurrency: 1, maxPending: 8, maxWaitMs: 1000 });
    const handler = isolated(require.resolve('../../src/handlers/messageCreate'), {
        '../utils': utils,
        '../providers/_loader': { extractAllUrls: content => loader.extractAllUrls(content).map(match => ({
            ...match, provider: { ...match.provider, extract: async (message, url, current) => {
                events.extracted.push({ id: match.provider.id, url, message, settings: current });
                return options.extract ? options.extract(match.provider.id, message, url, current)
                    : [{ content: `expanded ${match.provider.id}`, suppressSourceEmbeds: true }];
            } },
        })) },
        '../providers/_provider_settings': { getProviderSettings: async (provider, guild) => {
            events.settings.push({ id: provider.id, guild }); return settings(provider.id);
        } },
        '../providers/_dispatcher': options.dispatch || dispatch,
        '../errorTracking': tracking,
        '../workQueue': { messageWorkQueue: queue },
        '../automation/outbound-guard': { shouldIgnore: options.outboundGuard || (async () => false) },
        '../expansionTraceStore': {
            beginExpansionTrace: async input => events.traces.push({ ...input, state: 'queued' }),
            updateExpansionTrace: async (traceId, value) => events.traces.push({ traceId, ...value }),
            reserveExpansionRetries: options.reserveRetries || (async () => []),
        },
    });
    const listeners = [];
    const client = { user: { id: 'bot' }, on: (_event, callback) => listeners.push(callback) };
    handler.register(client);
    return { events, source, receive: listeners[1], retry: message => handler.retryMessage(client, message), queue };
}

test('every registered provider has a route fixture, including future provider additions', () => {
    assert.deepEqual(loader.loadProviders().map(provider => provider.id).sort(), Object.keys(samples).sort());
});

for (const [id, url] of Object.entries(samples)) {
    test(`${id}: real message recognition to dispatch, suppression and Gateway deduplication`, async () => {
        const h = harness(), message = h.source(); message.content = url;
        await h.receive(message); await h.receive(message);
        assert.deepEqual(h.events.extracted.map(value => value.id), [id]);
        assert.deepEqual(h.events.payloads.map(value => value.content), [`expanded ${id}`]);
        assert.deepEqual(h.events.cleanup, ['suppress']);
        assert.deepEqual(h.events.traces.map(value => value.state), ['queued', 'processing', 'sending', 'completed']);
        assert.equal(h.events.traces.at(-1).outcome, 'F');
        assert.deepEqual(h.events.errors, []);
    });
    test(`${id}: angle bracket and spoiler opt-outs never extract or send`, async () => {
        const h = harness(), message = h.source(); message.content = `<${url}> ||${url}||`;
        await h.receive(message);
        assert.deepEqual(h.events.extracted, []); assert.deepEqual(h.events.payloads, []);
        assert.deepEqual(h.events.traces, []);
    });
}

const gates = [
    ['disabled provider', { enabled: false }, {}, 'provider_disabled'],
    ['disabled user', { disable: { user: ['user'] } }, {}, 'target_disabled'],
    ['disabled channel', { disable: { channel: ['channel'] } }, {}, 'target_disabled'],
    ['disabled role', { disable: { role: ['blocked'] } }, { member: { roles: { cache: new Map([['blocked', {}]]) } } }, 'target_disabled'],
    ['missing restricted member', { disable: { role: ['blocked'] } }, { member: null }, 'member_unavailable'],
    ['bot default', {}, { author: { id: 'other-bot', bot: true } }, 'bot_message_disabled'],
];
for (const [name, setting, overrides, reason] of gates) test(`eligibility: ${name}`, async () => {
    const h = harness({ settings: () => ({ enabled: true, ...setting }) });
    await h.receive(Object.assign(h.source(), overrides));
    assert.deepEqual(h.events.extracted, []); assert.deepEqual(h.events.payloads, []);
    assert.equal(h.events.traces.at(-1).state, 'skipped');
    assert.equal(h.events.traces.at(-1).reasonCode, reason);
});

test('enabled bot and webhook messages expand; rendered automation messages never expand again', async () => {
    for (const [webhookId, extract_bot_message, ignored, expected] of [
        [null, true, false, 1], ['hook', false, false, 1], ['hook', true, true, 0],
    ]) {
        const h = harness({ settings: () => ({ enabled: true, extract_bot_message }), outboundGuard: async () => ignored });
        await h.receive(Object.assign(h.source(), { webhookId, author: { id: 'other-bot', bot: true } }));
        assert.equal(h.events.extracted.length, expected); assert.equal(h.events.payloads.length, expected);
    }
});

async function automationHandoff(format, { early = true, enabled = true, unknown = false, members = null } = {}) {
    const guard = require('../../src/automation/outbound-guard').createOutboundGuard();
    const h = harness({ settings: () => ({ enabled, silent_expansion: true }), outboundGuard: message => guard.shouldIgnore(message) });
    const owner = '222222222222222222', channel = '333333333333333333', webhook = '444444444444444444';
    const gatewayEvents = [], gatewayWork = [], submitted = [];
    let directFetches = 0;
    const rest = {
        get: async () => ({ id: webhook, channel_id: channel, guild_id: 'guild', type: 1 }),
        post: async (_route, payload) => {
            const id = String(555555555555555550n + BigInt(submitted.length));
            submitted.push(payload.body);
            const message = Object.assign(h.source(), {
                id, channelId: channel, webhookId: webhook, author: { id: webhook, bot: true },
                content: payload.body.content, embeds: payload.body.embeds || [],
            });
            message.channel.id = channel;
            gatewayEvents.push(message);
            if (early) gatewayWork.push(h.receive(message));
            if (unknown) throw Object.assign(new Error('HTTP receipt lost'), { code: 'ETIMEDOUT' });
            return { id, channel_id: channel };
        },
    };
    const db = { queryDatabase: async () => [{ webhook_url: `https://discord.com/api/webhooks/${webhook}/${'a'.repeat(60)}` }] };
    const rateLimiter = {
        reserveNotifications: async (_principal, count) => ({ count, expiresAtMs: Number.MAX_SAFE_INTEGER }),
        beginNotification: async () => {}, commitNotification: async () => {}, releaseNotifications: async () => {}, retainUnknownNotification: async () => {},
    };
    const { createTransport } = isolated(require.resolve('../../src/automation/transport'), {
        './outbound-guard': guard,
        '../providers/_loader': { loadProviders: () => [{ id: 'youtube', extract: async () => {
            directFetches++;
            return [{ content: samples.youtube, embeds: [{ title: 'direct media', url: samples.youtube }] }];
        } }] },
        '../providers/_provider_settings': { getProviderSettings: async () => ({ enabled: true }), PROVIDER_DEFAULTS: {} },
    });
    const transport = createTransport(db, { verifyChannel: async () => ({ member: { roles: [] }, channel: {} }) },
        { options: { jsonTransformer: value => value } }, {
            rest, rateLimiter, skipProviderBudget: true,
            entitlementResolver: async () => ({ slotId: `${owner}:1`, minuteLimit: 5, dayLimit: 24 }),
            membershipResolver: async (_db, job) => [{ targetKind: job.target_kind, targetId: String(job.target_id) }],
        });
    const job = { id: 'handoff', target_kind: 'auto', target_id: '1', owner_user_id: owner, plan: {
        context: { locale: 'ja' }, event: { title: 'new video', providerId: 'youtube', url: samples.youtube },
        display: { format, media: 'inherit' }, text: `new video\n${samples.youtube}`, ...(members ? { members } : {}),
    } };
    const prepared = await transport.prepare(job, { kind: 'webhook', guild_id: 'guild', webhook_endpoint_id: '1' });
    for (const [index] of prepared.payloads.entries()) {
        if (unknown) await assert.rejects(transport.sendStep(prepared, job, index), { code: 'ETIMEDOUT' });
        else await transport.sendStep(prepared, job, index);
    }
    if (!early) for (const message of gatewayEvents) gatewayWork.push(h.receive(message));
    await Promise.all(gatewayWork);
    // A duplicate Gateway delivery must never expand the same raw notification twice.
    for (const message of gatewayEvents) await h.receive(message);
    return { ...h, submitted, directFetches, prepared, job };
}

test('normal automation hands off early and late Gateway events to ordinary settings, dispatch and deduplication', async () => {
    for (const early of [true, false]) {
        const h = await automationHandoff('normal', { early });
        assert.equal(h.directFetches, 0);
        assert.equal(h.submitted[0].content, `new video\n${samples.youtube}`);
        assert.equal(h.submitted[0].embeds, undefined);
        assert.equal(h.events.extracted.length, 1);
        assert.equal(h.events.extracted[0].settings.silent_expansion, true);
        assert.equal(h.events.payloads[0].flags, 4096);
        assert.equal(h.events.traces.at(-1).state, 'completed');
    }
});

test('normal automation obeys disabled providers and a visible unknown submission still expands once', async () => {
    const disabled = await automationHandoff('normal', { enabled: false });
    assert.equal(disabled.submitted.length, 1);
    assert.equal(disabled.events.extracted.length, 0);
    assert.equal(disabled.events.traces.at(-1).reasonCode, 'provider_disabled');
    for (const early of [true, false]) {
        const visible = await automationHandoff('normal', { unknown: true, early });
        assert.equal(visible.submitted.length, 1);
        assert.equal(visible.events.extracted.length, 1);
    }
});

test('direct automation and URL-only notifications do not enter ordinary expansion', async () => {
    for (const early of [true, false]) for (const format of ['expanded', 'url']) {
        const h = await automationHandoff(format, { early });
        assert.equal(h.directFetches, format === 'expanded' ? 1 : 0);
        assert.equal(h.events.extracted.length, 0);
        assert.equal(h.events.payloads.length, 0);
    }
});

test('mixed normal and text aggregate members stay in separate messages with their own expansion decisions', async () => {
    const members = ['normal', 'text'].map(format => ({
        event: { title: format, url: samples.youtube }, text: `${format}\n${samples.youtube}`,
        display: { format, media: 'inherit' },
    }));
    const h = await automationHandoff('normal', { members });
    assert.equal(h.submitted.length, 2);
    assert.equal(h.events.extracted.length, 1);
    assert.equal(h.events.extracted[0].message.content, members[0].text);
});

test('a failing provider or settings lookup cannot prevent later links from expanding in text order', async () => {
    for (const failure of ['extract', 'settings', 'dispatch']) {
        const h = harness({
            settings: id => { if (failure === 'settings' && id === 'twitter') throw new Error('settings unavailable'); return { enabled: true }; },
            extract: id => { if (failure === 'extract' && id === 'twitter') throw new Error('upstream unavailable'); return [{ content: id }]; },
            ...(failure === 'dispatch' ? { dispatch: { runSendSteps: async (_message, _steps, id) => {
                if (id === 'twitter') throw new Error('dispatch unavailable');
                return { outcome: 'F', sent: [{ messageId: 'confirmed' }] };
            } } } : {}),
        });
        const message = h.source(); message.content = `${samples.twitter} ${samples.youtube} ${samples.twitter}`;
        await h.receive(message);
        const final = h.events.traces.filter(row => ['failed', 'completed'].includes(row.state));
        assert.deepEqual(final.map(row => row.state), ['failed', 'completed'], failure);
        assert.equal(final.at(-1).outcome, 'F');
    }
});

test('failure notices remain failed even when sent successfully and never suppress the original', async () => {
    const h = harness({ extract: () => [{ content: 'temporarily unavailable', outputRole: 'failure_notice' }] });
    await h.receive(h.source());
    assert.equal(h.events.payloads.length, 1); assert.deepEqual(h.events.cleanup, []);
    assert.equal(h.events.traces.at(-1).state, 'failed'); assert.equal(h.events.traces.at(-1).outcome, 'failure_notice');
});

test('multi-step output retains reply destinations and silent flags, including attachment fallback', async () => {
    const h = harness({ settings: () => ({ enabled: true, silent_expansion: true }),
        extract: () => [
            { content: 'one', send: 'channel', deleteSource: true },
            { content: 'two', send: 'reply-source' },
            { files: ['https://media.example/video.mp4'], send: 'reply-previous' },
        ], send: async (_payload, attempt) => { if (attempt === 3) throw { status: 413 }; },
    });
    await h.receive(h.source());
    assert.deepEqual(h.events.sends, ['channel', 'reply-source', 'reply-sent-2', 'reply-sent-2']);
    assert(h.events.payloads.every(payload => payload.flags === 4096));
    assert.equal(h.events.payloads.at(-1).content, 'https://media.example/video.mp4');
    assert.deepEqual(h.events.cleanup, ['delete']); assert.equal(h.events.traces.at(-1).outcome, 'D');
});

test('concurrent Gateway delivery is processed once; different messages share the bounded queue', async () => {
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const h = harness({ extract: async () => { entered(); await blocked; return [{ content: 'expanded' }]; } });
    const first = h.source(), second = { ...h.source(), id: 'second' };
    const firstRun = h.receive(first); await ready;
    assert.deepEqual(await h.receive(first), { status: 'busy' });
    const secondRun = h.receive(second);
    // Admission precedes enqueueing, so yield without a wall-clock timer.
    for (let i = 0; i < 20 && h.queue.pending.size === 0; i++) await Promise.resolve();
    assert.equal(h.queue.pending.size, 1);
    release(); await Promise.all([firstRun, secondRun]);
    assert.equal(h.events.extracted.length, 2); assert.equal(h.events.payloads.length, 2);
});

for (const code of ['WORK_QUEUE_FULL', 'WORK_QUEUE_EXPIRED']) test(`queue rejection ${code} remains retryable without extraction or dispatch`, async () => {
    let reject = true;
    const h = harness({ queue: { snapshot: () => ({}), run: work => reject ? Promise.reject(Object.assign(new Error('queue unavailable'), { code })) : Promise.resolve().then(work) } });
    const message = h.source(); await h.receive(message);
    assert.equal(h.events.traces.at(-1).outcome, 'queue_rejected');
    assert.equal(h.events.extracted.length, 0); assert.equal(h.events.payloads.length, 0);
    reject = false; await h.receive(message);
    assert.equal(h.events.payloads.length, 1); assert.equal(h.events.traces.at(-1).outcome, 'F');
});

test('Gateway admission errors are recorded and release the active-message guard for a later event', async () => {
    let fail = true;
    const h = harness({ outboundGuard: async () => { if (fail) throw new Error('guard database unavailable'); return false; } });
    const message = { ...h.source(), webhookId: 'hook' };
    await assert.doesNotReject(h.receive(message));
    assert.equal(h.events.errors.length, 1); assert.equal(h.events.payloads.length, 0);
    fail = false; await h.receive(message); assert.equal(h.events.payloads.length, 1);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Events } = require('discord.js');

const messageCreateModulePath = require.resolve('../../src/handlers/messageCreate');
const utilsModulePath = require.resolve('../../src/utils');
const loaderModulePath = require.resolve('../../src/providers/_loader');
const providerSettingsModulePath = require.resolve('../../src/providers/_provider_settings');
const dispatcherModulePath = require.resolve('../../src/providers/_dispatcher');
const errorTrackingModulePath = require.resolve('../../src/errorTracking');
const expansionTraceStoreModulePath = require.resolve('../../src/expansionTraceStore');
const telemetryModulePath = require.resolve('../../src/adminSupport/telemetry');
const realUtils = require('../../src/utils');

async function withMessageCreateMocks(mocks, callback) {
    const modulePaths = [
        messageCreateModulePath,
        utilsModulePath,
        loaderModulePath,
        providerSettingsModulePath,
        dispatcherModulePath,
        errorTrackingModulePath,
        expansionTraceStoreModulePath,
        telemetryModulePath,
    ];
    const originals = new Map(modulePaths.map(modulePath => [modulePath, require.cache[modulePath]]));

    if (mocks.telemetry) require.cache[telemetryModulePath] = {
        id: telemetryModulePath, filename: telemetryModulePath, loaded: true, exports: mocks.telemetry,
    };
    require.cache[utilsModulePath] = {
        id: utilsModulePath,
        filename: utilsModulePath,
        loaded: true,
        exports: mocks.utils,
    };
    require.cache[loaderModulePath] = {
        id: loaderModulePath,
        filename: loaderModulePath,
        loaded: true,
        exports: mocks.loader,
    };
    require.cache[providerSettingsModulePath] = {
        id: providerSettingsModulePath,
        filename: providerSettingsModulePath,
        loaded: true,
        exports: mocks.providerSettings,
    };
    require.cache[dispatcherModulePath] = {
        id: dispatcherModulePath,
        filename: dispatcherModulePath,
        loaded: true,
        exports: mocks.dispatcher,
    };
    require.cache[errorTrackingModulePath] = {
        id: errorTrackingModulePath,
        filename: errorTrackingModulePath,
        loaded: true,
        exports: mocks.errorTracking,
    };
    require.cache[expansionTraceStoreModulePath] = {
        id: expansionTraceStoreModulePath,
        filename: expansionTraceStoreModulePath,
        loaded: true,
        exports: mocks.expansionTraceStore || {
            beginExpansionTrace: async ({ traceId }) => ({ traceId, persisted: true }),
            updateExpansionTrace: async () => true,
        },
    };
    delete require.cache[messageCreateModulePath];

    try {
        return await callback(require(messageCreateModulePath));
    } finally {
        delete require.cache[messageCreateModulePath];
        for (const [modulePath, original] of originals) {
            if (original) require.cache[modulePath] = original;
            else delete require.cache[modulePath];
        }
    }
}

function createClient() {
    const listeners = [];
    return {
        client: {
            user: { id: 'bot-user' },
            on: (event, listener) => {
                if (event === Events.MessageCreate) listeners.push(listener);
            },
        },
        listeners,
    };
}

test('silent fetch failures are persisted as failures; intentional empty arrays produce no send', async () => {
    const telemetry = require(telemetryModulePath);
    for (const fail of [true, false]) {
        const updates = [], metrics = [], analytics = [];
        const provider = { id: 'twitter', extract: async () => {
            if (fail) telemetry.markOutcome('failed', 'provider_fetch_or_parse_failed');
            return fail ? null : [];
        } };
        await withMessageCreateMocks({
            utils: { cleanMessageContent: value => value },
            loader: { extractAllUrls: () => [{ provider, url: 'https://x.com/u/status/1' }] },
            providerSettings: { getProviderSettings: async () => ({ enabled: true }) },
            dispatcher: { runSendSteps: () => assert.fail('No output should be sent') },
            errorTracking: { recordMetric: key => metrics.push(key), recordAnalyticsEvent: (_key, value) => analytics.push(value), recordError: () => assert.fail('unexpected error') },
            expansionTraceStore: { beginExpansionTrace: async () => {}, updateExpansionTrace: async (_id, value) => { updates.push(value); } },
        }, async ({ register }) => {
            const { client, listeners } = createClient(); register(client);
            await listeners[1]({ id: 'silent', guild: { id: 'guild' }, channel: { id: 'channel' }, author: { id: 'user' }, member: { roles: { cache: new Map() } }, content: 'https://x.com/u/status/1' });
        });
        assert.equal(updates.at(-1).state, fail ? 'failed' : 'completed');
        assert.equal(updates.at(-1).outcome, fail ? 'extract_failed' : 'empty');
        assert.ok(metrics.includes(fail ? 'provider_extract_error' : 'provider_extract_empty'));
        assert.equal(analytics.at(-1).success, fail ? false : null);
    }
});

test('missing member data fails closed when disabled-role restrictions exist', async () => {
    const updates = [], errors = [];
    const provider = { id: 'twitter', extract: () => assert.fail('role authorization bypassed') };
    await withMessageCreateMocks({
        utils: { cleanMessageContent: value => value, ifUserHasRole: realUtils.ifUserHasRole },
        loader: { extractAllUrls: () => [{ provider, url: 'https://x.com/u/status/1' }] },
        providerSettings: { getProviderSettings: async () => ({ enabled: true, disable: { role: ['restricted'] } }) },
        dispatcher: {}, errorTracking: { recordError: error => errors.push(error) },
        expansionTraceStore: { beginExpansionTrace: async () => {}, updateExpansionTrace: async (_id, value) => { updates.push(value); } },
    }, async ({ register }) => {
        const { client, listeners } = createClient(); register(client);
        await listeners[1]({ id: 'roles', guild: { id: 'guild', members: { fetch: async () => { throw new Error('lookup unavailable'); } } },
            channel: { id: 'channel' }, author: { id: 'user' }, member: null, content: 'https://x.com/u/status/1' });
    });
    assert.equal(errors.length, 1);
    assert.equal(updates.at(-1).state, 'skipped');
    assert.equal(updates.at(-1).reasonCode, 'member_unavailable');
});

test('silent source errors retain a safe reason and intentional skips remain distinguishable', async () => {
    const telemetry = require(telemetryModulePath);
    for (const outcome of ['failed', 'skipped', 'target_constraint']) {
        const updates = [];
        const provider = { id: 'test', extract: async () => {
            if (outcome === 'failed') return require('../../src/providers/_output_controls').buildFailureResponse('test', 'https://example.test', {}, { status: 429, message: 'private-secret' });
            telemetry.markOutcome(outcome, outcome === 'skipped' ? 'banned_word' : 'upstream_non_expandable');
            return null;
        } };
        await withMessageCreateMocks({
            utils: { cleanMessageContent: value => value }, loader: { extractAllUrls: () => [{ provider, url: 'https://example.test' }] },
            providerSettings: { getProviderSettings: async () => ({ enabled: true }) }, dispatcher: {},
            errorTracking: { recordMetric() {}, recordError: () => assert.fail('unexpected error') },
            expansionTraceStore: { beginExpansionTrace: async () => {}, updateExpansionTrace: async (_id, value) => { updates.push(value); } },
        }, async ({ register }) => {
            const { client, listeners } = createClient(); register(client);
            await listeners[1]({ id: 'reason', guild: { id: 'guild' }, channel: { id: 'channel' }, author: { id: 'user' }, member: { roles: { cache: new Map() } }, content: 'https://example.test' });
        });
        assert.equal(updates.at(-1).state, outcome === 'failed' ? 'failed' : 'skipped');
        if (outcome === 'failed') {
            assert.equal(updates.at(-1).error.status, 429);
            assert.doesNotMatch(JSON.stringify(updates.at(-1)), /private-secret/);
        } else assert.equal(updates.at(-1).reasonCode, outcome === 'skipped' ? 'banned_word' : 'upstream_non_expandable');
    }
});

test('manual retry reuses current settings, only reserved URLs, and excludes simultaneous processing', async () => {
    let extracts = 0, reservations = 0, starts = 0, enabled = true;
    const errors = [], updates = [];
    let release, extractionStarted;
    const started = new Promise(resolve => { extractionStarted = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const provider = { id: 'twitter', extract: async () => { extracts++; extractionStarted(); await blocked; return null; } };
    await withMessageCreateMocks({
        utils: { cleanMessageContent: value => value },
        loader: { extractAllUrls: () => [{ provider, url: 'https://x.com/u/status/1' }, { provider, url: 'https://x.com/u/status/2' }] },
        providerSettings: { getProviderSettings: async () => ({ enabled }) },
        dispatcher: {}, errorTracking: { recordMetric() {}, recordError: error => errors.push(error) },
        expansionTraceStore: {
            beginExpansionTrace: async () => { starts++; },
            updateExpansionTrace: async (id, value) => { updates.push({ id, ...value }); },
            reserveExpansionRetries: async (_message, matches) => { reservations++; return [{ ...matches[0], requestId: 'reserved', receivedStart: performance.now() }]; },
        },
    }, async ({ register, retryMessage }) => {
        const { client, listeners } = createClient(); register(client);
        const message = { id: 'retry', guild: { id: 'guild' }, channel: { id: 'channel' }, author: { id: 'user' }, member: { roles: { cache: new Map() } }, content: 'https://x.com/u/status/1 https://x.com/u/status/2' };
        const retry = retryMessage(client, message);
        await started;
        assert.deepEqual(await retryMessage(client, message), { status: 'busy' });
        assert.deepEqual(await listeners[1](message), { status: 'busy' });
        release();
        assert.deepEqual(await retry, { status: 'processed', count: 1 });
        assert.equal(extracts, 1);
        assert.equal(reservations, 1);
        assert.equal(starts, 0);
        enabled = false;
        await retryMessage(client, message);
        assert.equal(extracts, 1, 'Retry must re-evaluate disabled provider settings');
        assert.equal(updates.at(-1).reasonCode, 'provider_disabled');
    });
    assert.deepEqual(errors, []);
});

test('retry admission failures release the in-flight guard and never start extraction', async () => {
    let reserveCalls = 0;
    const provider = { id: 'twitter', extract: () => assert.fail('Cannot extract without a durable reservation') };
    await withMessageCreateMocks({
        utils: { cleanMessageContent: value => value }, loader: { extractAllUrls: () => [{ provider, url: 'https://x.com/u/status/1' }] },
        providerSettings: { getProviderSettings: () => assert.fail('Cannot load settings without reservation') },
        dispatcher: {}, errorTracking: {},
        expansionTraceStore: { reserveExpansionRetries: async () => {
            reserveCalls++;
            if (reserveCalls === 1) throw new Error('storage unavailable');
            return [];
        } },
    }, async ({ register, retryMessage }) => {
        const { client } = createClient(); register(client);
        const message = { id: 'failed-admission', guild: { id: 'guild' }, channel: { id: 'channel' }, author: { id: 'user' }, content: 'https://x.com/u/status/1' };
        await assert.rejects(retryMessage(client, message), /storage unavailable/);
        assert.deepEqual(await retryMessage(client, message), { status: 'not_retryable' });
        assert.equal(reserveCalls, 2);
    });
});

test('already-rendered automation webhook messages bypass re-expansion, including Gateway-before-HTTP delivery', async () => {
    const outbound = require('../../src/automation/outbound-guard');
    let scans = 0;
    await withMessageCreateMocks({
        utils: { ...realUtils, cleanMessageContent: value => value },
        loader: { extractAllUrls: () => { scans++; return []; } },
        providerSettings: { getProviderSettings: () => assert.fail('No re-expansion settings lookup') },
        dispatcher: {}, errorTracking: {},
    }, async ({ register }) => {
        const { client, listeners } = createClient(); register(client);
        const body = { content: 'https://example.test/notification', embeds: [{ title: 'rendered' }] };
        const message = { ...body, id: 'outbound-fixture', webhookId: 'owned-webhook', author: { id: 'owned-webhook', bot: true }, guild: { id: 'guild' }, channel: { id: 'channel', type: 0 }, channelId: 'channel' };
        const ticket = outbound.begin(message.webhookId, message.channelId, body);
        const handlers = listeners.map(listener => listener(message));
        ticket.sent(message.id);
        await Promise.all(handlers);
        assert.equal(scans, 0);
        await Promise.all(listeners.map(listener => listener({ ...message, id: 'external-fixture' })));
        assert.equal(scans, 1, 'a different message from a shared webhook keeps the normal expansion path');
    });
});

test('ordinary chat, DMs and self messages skip telemetry and asynchronous work', async () => {
    await withMessageCreateMocks({
        utils: { cleanMessageContent: () => assert.fail('ordinary message was cleaned') },
        loader: { extractAllUrls: () => assert.fail('ordinary message was scanned') },
        providerSettings: { getProviderSettings: () => assert.fail('DB accessed') },
        dispatcher: {},
        errorTracking: { runWithErrorContext: () => assert.fail('async context created') },
        telemetry: {
            contextFromMessage: () => assert.fail('telemetry context created'),
            run: () => assert.fail('telemetry run created'),
        },
    }, ({ register }) => {
        const { client, listeners } = createClient();
        register(client);
        const message = { guild: { id: 'guild' }, author: { id: 'user' }, content: 'こんにちは！今日もよろしくお願いします。' };
        assert.equal(listeners[1](message), undefined);
        assert.equal(listeners[1]({ ...message, content: '' }), undefined);
        assert.equal(listeners[1]({ ...message, content: undefined }), undefined);
        assert.equal(listeners[1]({ ...message, guild: null, content: 'https://x.com/u/status/1' }), undefined);
        assert.equal(listeners[1]({ ...message, author: { id: client.user.id }, content: 'https://x.com/u/status/1' }), undefined);
    });
});

test('messages excluded without role checks do not fetch an evicted member', async () => {
    for (const settings of [
        { enabled: false },
        { enabled: true, disable: { user: ['user'] } },
        { enabled: true, disable: { channel: ['channel'] } },
        { enabled: true, extract_bot_message: false },
    ]) {
        const errors = [], fetches = [];
        const provider = { id: 'twitter', extract: () => assert.fail('excluded message extracted') };
        await withMessageCreateMocks({
            utils: { cleanMessageContent: content => content },
            loader: { extractAllUrls: () => [{ provider, url: 'https://x.com/u/status/1' }] },
            providerSettings: { getProviderSettings: async () => settings },
            dispatcher: {},
            errorTracking: { recordError: error => errors.push(error) },
        }, async ({ register }) => {
            const { client, listeners } = createClient();
            register(client);
            await listeners[1]({
                id: 'excluded', guild: { id: 'guild', members: { fetch: async userId => {
                    fetches.push(userId);
                    return { roles: { cache: new Map() } };
                } } },
                channel: { id: 'channel' }, author: { id: 'user', bot: settings.extract_bot_message === false },
                member: null, content: 'https://x.com/u/status/1',
            });
        });
        assert.deepEqual(errors, []);
        assert.deepEqual(fetches, [], JSON.stringify(settings));
    }
});

test('a member fetched for role rules is shared across providers and retained for extraction', async () => {
    let fetched = 0;
    const member = { roles: { cache: new Map([['allowed', {}]]) } };
    const extracted = [], errors = [];
    const providers = ['twitter', 'instagram'].map(id => ({ id, extract: async message => {
        assert.equal(message.member, member);
        extracted.push(id);
        return null;
    } }));
    await withMessageCreateMocks({
        utils: { cleanMessageContent: content => content, ifUserHasRole: realUtils.ifUserHasRole },
        loader: { extractAllUrls: () => providers.map(provider => ({ provider, url: `https://${provider.id}.example/post` })) },
        providerSettings: { getProviderSettings: async () => ({ enabled: true, disable: { role: ['disabled'] } }) },
        dispatcher: {},
        errorTracking: { recordMetric() {}, recordError: error => errors.push(error) },
    }, async ({ register }) => {
        const { client, listeners } = createClient();
        register(client);
        await listeners[1]({
            id: 'two-providers', guild: { id: 'guild', members: { fetch: async () => { fetched++; return member; } } },
            channel: { id: 'channel' }, author: { id: 'user' }, member: null, content: 'https://example.test',
        });
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(extracted, ['twitter', 'instagram']);
    assert.equal(fetched, 1);
});

test('eligible messages preserve telemetry context across queue and provider work', async () => {
    const telemetry = require(telemetryModulePath);
    const events = [], errors = [];
    let traceId, providerContext;
    const provider = { id: 'twitter', extract: async () => {
        await new Promise(resolve => setImmediate(resolve));
        providerContext = telemetry.current();
        return null;
    } };
    await withMessageCreateMocks({
        utils: { cleanMessageContent: content => content },
        loader: { extractAllUrls: () => [{ provider, url: 'https://x.com/u/status/1' }] },
        providerSettings: { getProviderSettings: async () => ({ enabled: true }) },
        dispatcher: {},
        errorTracking: { recordMetric() {}, recordError: error => errors.push(error) },
        expansionTraceStore: {
            beginExpansionTrace: async input => { traceId = input.traceId; },
            updateExpansionTrace: async () => true,
        },
    }, async ({ register }) => {
        const { client, listeners } = createClient();
        register(client);
        await telemetry.run({ preview: true, events }, () => listeners[1]({
            id: 'traced-message', guild: { id: 'guild', shardId: 3 }, channel: { id: 'channel' },
            author: { id: 'user' }, member: { roles: { cache: new Map() } }, content: 'https://x.com/u/status/1',
        }));
    });
    assert.deepEqual(errors, []);
    assert.equal(providerContext.trace_id, traceId);
    assert.equal(providerContext.request_id, traceId);
    assert.equal(providerContext.provider_id, 'twitter');
    assert.equal(providerContext.guild_id, 'guild');
    assert.equal(providerContext.shard_id, 3);
    assert.ok(events.some(row => row.kind === 'request.completed' && row.request_id === traceId));
});

test('active messages retain role restrictions across cache eviction and duplicate Gateway delivery', async () => {
    let member = { roles: { cache: new Map([['disabled', {}]]) } };
    let checks = 0;
    const provider = { id: 'twitter', extract: () => assert.fail('role restriction lost') };
    await withMessageCreateMocks({
        utils: { cleanMessageContent: content => content, ifUserHasRole: realUtils.ifUserHasRole },
        loader: { extractAllUrls: () => [{ provider, url: 'https://x.com/u/status/1' }] },
        providerSettings: { getProviderSettings: async () => {
            checks++;
            member = null;
            return { enabled: true, disable: { role: ['disabled'] } };
        } },
        dispatcher: { runSendSteps: () => assert.fail() },
        errorTracking: { recordError: () => assert.fail('unexpected handler error') },
    }, async ({ register }) => {
        const { client, listeners } = createClient();
        register(client);
        const message = {
            id: 'message', guild: { id: 'guild' }, channel: { id: 'channel' },
            author: { id: 'user' }, content: 'https://x.com/u/status/1',
            get member() { return member; },
        };
        await listeners[1](message);
        await listeners[1](message);
        assert.equal(checks, 1);
    });
});

test('sender roles are retained synchronously before another Gateway event can evict the member', async () => {
    let member = { roles: { cache: new Map([['disabled', {}]]) } };
    let fetches = 0, extracts = 0;
    const errors = [];
    const provider = { id: 'twitter', extract: async () => { extracts++; return null; } };
    await withMessageCreateMocks({
        utils: { cleanMessageContent: content => content, ifUserHasRole: realUtils.ifUserHasRole },
        loader: { extractAllUrls: () => [{ provider, url: 'https://x.com/u/status/1' }] },
        providerSettings: { getProviderSettings: async () => ({ enabled: true, disable: { role: ['disabled'] } }) },
        dispatcher: {},
        errorTracking: { recordMetric() {}, recordError: error => errors.push(error) },
    }, async ({ register }) => {
        const { client, listeners } = createClient();
        register(client);
        const message = {
            id: 'evicted-immediately', guild: { id: 'guild', members: { fetch: async () => {
                fetches++;
                throw new Error('member lookup unavailable');
            } } }, channel: { id: 'channel' }, author: { id: 'user' },
            get member() { return member; }, content: 'https://x.com/u/status/1',
        };
        const pending = listeners[1](message);
        member = null;
        await pending;
    });
    assert.deepEqual(errors, []);
    assert.equal(fetches, 0);
    assert.equal(extracts, 0);
});

test('member evicted while constructing a reply is restored before provider role checks', async () => {
    const member = { id: 'user', roles: { cache: new Map([['restricted', {}]]) } };
    let fetched = 0;
    let extracted = 0;
    const provider = { id: 'twitter', extract: async message => {
        assert.equal(message.member, member);
        extracted++;
        return null;
    } };
    await withMessageCreateMocks({
        utils: { cleanMessageContent: content => content },
        loader: { extractAllUrls: () => [{ provider, url: 'https://x.com/u/status/1' }] },
        providerSettings: { getProviderSettings: async () => ({ enabled: true }) },
        dispatcher: {},
        errorTracking: { recordMetric() {}, recordError: () => assert.fail() },
    }, async ({ register }) => {
        const { client, listeners } = createClient();
        register(client);
        await listeners[1]({
            id: 'reply', guild: { id: 'guild', members: { fetch: async () => { fetched++; return member; } } },
            channel: { id: 'channel' }, author: { id: 'user' }, member: null,
            content: 'https://x.com/u/status/1',
        });
        assert.equal(fetched, 1);
        assert.equal(extracted, 1);
    });
});

test('messageCreate writes durable expansion states before and after dispatch', async () => {
    const traceCalls = [];
    const provider = {
        id: 'instagram',
        extract: async () => [{
            embeds: [{ title: 'Instagram', url: 'https://www.instagram.com/p/POST/' }],
            files: [],
            send: 'channel',
        }],
    };
    await withMessageCreateMocks({
        utils: { cleanMessageContent: value => value },
        loader: { extractAllUrls: () => [{ provider, url: 'https://www.instagram.com/p/POST/?stkn=private' }] },
        providerSettings: { getProviderSettings: async () => ({ enabled: true }) },
        dispatcher: {
            runSendSteps: async () => ({
                outcome: 'F', plannedSteps: 1, fallback: false,
                sent: [{ stepIndex: 0, messageId: 'result-1', channelId: 'channel-1' }],
                attempts: [{ stepIndex: 0, outcome: 'confirmed', messageId: 'result-1', channelId: 'channel-1' }],
                postprocess: [],
            }),
        },
        errorTracking: {
            recordAnalyticsEvent: () => {},
            recordError: () => {},
            recordMetric: () => {},
            recordProviderContentEvent: () => {},
        },
        expansionTraceStore: {
            beginExpansionTrace: async input => {
                traceCalls.push({ type: 'begin', input });
                return { traceId: input.traceId, persisted: true };
            },
            updateExpansionTrace: async (traceId, update) => {
                traceCalls.push({ type: 'update', traceId, update });
                return true;
            },
        },
    }, async ({ register }) => {
        const { client, listeners } = createClient();
        register(client);
        await listeners[1]({
            id: 'message-1',
            guild: { id: 'guild-1' },
            guildId: 'guild-1',
            channel: { id: 'channel-1' },
            channelId: 'channel-1',
            author: { id: 'user-1', bot: false },
            member: { roles: { cache: new Map() } },
            content: 'https://www.instagram.com/p/POST/?stkn=private',
        });
    });

    assert.equal(traceCalls[0].type, 'begin');
    assert.equal(traceCalls[0].input.providerId, 'instagram');
    assert.equal(traceCalls[0].input.message.id, 'message-1');
    assert.deepEqual(traceCalls.filter(call => call.type === 'update').map(call => call.update.state), [
        'processing', 'sending', 'completed',
    ]);
    const completed = traceCalls.at(-1).update;
    assert.equal(completed.outcome, 'F');
    assert.deepEqual(completed.delivery.sent, [{ step_index: 0, message_id: 'result-1', channel_id: 'channel-1' }]);
});

test('messageCreate fetches uncached guild member before role disable check', async () => {
    const disabledRoleId = 'role-disabled';
    const provider = {
        id: 'twitter',
        extract: async () => {
            assert.fail('provider.extract should not run for a role-disabled member');
        },
    };
    const fetchCalls = [];
    const sendCalls = [];

    await withMessageCreateMocks({
        utils: {
            ifUserHasRole: realUtils.ifUserHasRole,
            cleanMessageContent: content => content,
        },
        loader: {
            extractAllUrls: () => [{ provider, url: 'https://x.com/u/status/1' }],
        },
        providerSettings: {
            getProviderSettings: async () => ({
                enabled: true,
                disable: { user: [], channel: [], role: [disabledRoleId] },
            }),
        },
        dispatcher: {
            runSendSteps: async (...args) => {
                sendCalls.push(args);
            },
        },
        errorTracking: {
            recordAnalyticsEvent: () => {},
            recordError: () => {},
            recordMetric: () => {},
            recordProviderContentEvent: () => {},
        },
    }, async ({ register }) => {
        const { client, listeners } = createClient();
        register(client);

        const message = {
            guild: {
                id: 'guild-1',
                members: {
                    fetch: async (userId) => {
                        fetchCalls.push(userId);
                        return { roles: { cache: new Map([[disabledRoleId, { id: disabledRoleId }]]) } };
                    },
                },
            },
            guildId: 'guild-1',
            channel: { id: 'channel-1' },
            channelId: 'channel-1',
            author: { id: 'user-1', bot: false },
            member: null,
            content: 'https://x.com/u/status/1',
        };

        for (const listener of listeners) {
            await listener(message);
        }
    });

    assert.deepEqual(fetchCalls, ['user-1']);
    assert.equal(sendCalls.length, 0);
});

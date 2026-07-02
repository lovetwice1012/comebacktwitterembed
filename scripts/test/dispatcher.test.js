'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runSendSteps } = require('../../src/providers/_dispatcher');
const { counters, loadCounters, _internal } = require('../../src/state');

const dispatcherModulePath = require.resolve('../../src/providers/_dispatcher');
const errorTrackingModulePath = require.resolve('../../src/errorTracking');

function loadDispatcherWithErrorTracking(errorTrackingExports) {
    const originalDispatcherModule = require.cache[dispatcherModulePath];
    const originalErrorTrackingModule = require.cache[errorTrackingModulePath];

    require.cache[errorTrackingModulePath] = {
        id: errorTrackingModulePath,
        filename: errorTrackingModulePath,
        loaded: true,
        exports: errorTrackingExports,
    };
    delete require.cache[dispatcherModulePath];

    try {
        return require(dispatcherModulePath);
    } finally {
        delete require.cache[dispatcherModulePath];
        if (originalDispatcherModule) require.cache[dispatcherModulePath] = originalDispatcherModule;
        if (originalErrorTrackingModule) require.cache[errorTrackingModulePath] = originalErrorTrackingModule;
        else delete require.cache[errorTrackingModulePath];
    }
}

test('dispatcher: increments processed counters for sent steps', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cte-dispatcher-'));
    const statsFile = path.join(tmpDir, 'stats.json');

    _internal.configureStatsPersistenceForTest(statsFile);
    loadCounters(new Date(), statsFile);

    const sentMessages = [];
    const message = {
        guildId: 'guild-1',
        channel: {
            send: async (payload) => {
                sentMessages.push(payload);
                return {
                    id: `sent-${sentMessages.length}`,
                    reply: async (replyPayload) => {
                        sentMessages.push(replyPayload);
                        return { id: `reply-${sentMessages.length}` };
                    },
                };
            },
        },
        reply: async (payload) => {
            sentMessages.push(payload);
            return {
                id: `reply-${sentMessages.length}`,
                reply: async (replyPayload) => {
                    sentMessages.push(replyPayload);
                    return { id: `reply-${sentMessages.length}` };
                },
            };
        },
        suppressEmbeds: async () => {},
        delete: async () => {},
    };

    try {
        await runSendSteps(message, [
            { embeds: [{ description: 'one' }] },
            { embeds: [{ description: 'two' }] },
        ], 'twitter');

        const saved = JSON.parse(fs.readFileSync(statsFile, 'utf8'));

        assert.equal(sentMessages.length, 2);
        assert.equal(counters.processed, 2);
        assert.equal(counters.processed_hour, 2);
        assert.equal(counters.processed_day, 2);
        assert.equal(saved.processed, 2);
        assert.equal(saved.processed_hour, 2);
        assert.equal(saved.processed_day, 2);
    } finally {
        _internal.configureStatsPersistenceForTest(_internal.DEFAULT_STATS_FILE);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('dispatcher: missing send permissions are non-fatal', async () => {
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (message) => {
        warnings.push(message);
    };

    const message = {
        guildId: 'guild-1',
        channelId: 'channel-1',
        channel: {
            send: async () => {
                throw { code: 50013, rawError: { message: 'Missing Permissions' } };
            },
        },
        reply: async () => {
            throw { code: 50013, rawError: { message: 'Missing Permissions' } };
        },
        suppressEmbeds: async () => {},
        delete: async () => {},
    };

    try {
        await assert.doesNotReject(runSendSteps(message, [{ content: 'hello' }], 'twitter'));
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /Missing Permissions/);
    } finally {
        console.warn = originalWarn;
    }
});

test('dispatcher: source embed suppression is skipped for interaction commands', async () => {
    const sentPayloads = [];
    const interaction = {
        guildId: 'guild-1',
        channelId: 'channel-1',
        channel: {
            send: async (payload) => {
                sentPayloads.push(payload);
                return { id: 'sent-message' };
            },
        },
    };

    await assert.doesNotReject(runSendSteps(interaction, [{
        content: 'expanded from command',
        suppressSourceEmbeds: true,
    }], 'twitter'));

    assert.deepEqual(sentPayloads, [{ content: 'expanded from command' }]);
});

test('dispatcher: empty suppression steps do not send a message', async () => {
    let sendCount = 0;
    let suppressCount = 0;
    const message = {
        guildId: 'guild-1',
        channelId: 'channel-1',
        channel: {
            send: async () => {
                sendCount += 1;
                return { id: 'sent-message' };
            },
        },
        suppressEmbeds: async () => {
            suppressCount += 1;
        },
    };

    await runSendSteps(message, [{ suppressSourceEmbeds: true }], 'pixiv');

    assert.equal(sendCount, 0);
    assert.equal(suppressCount, 1);
});

test('dispatcher: missing permissions are excluded from global send error metric', async () => {
    const metrics = [];
    const errors = [];
    const dispatcher = loadDispatcherWithErrorTracking({
        recordError: (_err, context) => errors.push(context),
        recordMetric: (metricName) => metrics.push(metricName),
    });
    const originalWarn = console.warn;
    console.warn = () => {};

    const message = {
        guildId: 'guild-1',
        channelId: 'channel-1',
        channel: {
            send: async () => {
                throw { code: 50013, rawError: { message: 'Missing Permissions' } };
            },
        },
        suppressEmbeds: async () => {},
        delete: async () => {},
    };

    try {
        await dispatcher.runSendSteps(message, [{ content: 'hello' }], 'twitter');

        assert.deepEqual(metrics, ['discord_send_attempt', 'discord_send_permission_denied']);
        assert.equal(errors.length, 1);
        assert.equal(errors[0].errorType, 'discord_missing_permissions');
        assert.ok(!metrics.includes('discord_send_error'));
    } finally {
        console.warn = originalWarn;
    }
});

test('dispatcher: attachment fallback preserves reply-source mode and preview embeds', async () => {
    const replyPayloads = [];
    const channelPayloads = [];
    let replyAttempts = 0;
    const message = {
        guildId: 'guild-1',
        channelId: 'channel-1',
        channel: {
            send: async (payload) => {
                channelPayloads.push(JSON.parse(JSON.stringify(payload)));
                return { id: 'channel-message' };
            },
        },
        reply: async (payload) => {
            replyPayloads.push(JSON.parse(JSON.stringify(payload)));
            replyAttempts += 1;
            if (replyAttempts === 1) {
                throw { code: 400, rawError: { message: 'Cannot upload attachment' } };
            }
            return {
                id: 'reply-message',
                reply: async (replyPayload) => {
                    replyPayloads.push(JSON.parse(JSON.stringify(replyPayload)));
                    return { id: 'nested-reply' };
                },
            };
        },
        suppressEmbeds: async () => {},
        delete: async () => {},
    };

    await runSendSteps(message, [{
        send: 'reply-source',
        embeds: [{ title: 'pixiv metadata', description: 'preview info' }],
        files: ['https://img.example/artwork-1.jpg'],
        allowedMentions: { repliedUser: false },
    }], 'pixiv');

    assert.equal(channelPayloads.length, 0);
    assert.equal(replyPayloads.length, 2);
    assert.deepEqual(replyPayloads[0].files, ['https://img.example/artwork-1.jpg']);
    assert.equal(replyPayloads[1].files, undefined);
    assert.deepEqual(replyPayloads[1].embeds, [{ title: 'pixiv metadata', description: 'preview info' }]);
    assert.match(replyPayloads[1].content, /https:\/\/img\.example\/artwork-1\.jpg/);
    assert.deepEqual(replyPayloads[1].allowedMentions, { repliedUser: false });
});

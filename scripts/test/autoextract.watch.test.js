'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const watchPath = require.resolve('../../src/commands/handlers/autoextract/watch');
const unwatchPath = require.resolve('../../src/commands/handlers/autoextract/unwatch');
const registryPath = require.resolve('../../src/providers/autoWatch');
const storePath = require.resolve('../../src/providers/autoWatch/store');
const webhookDestinationPath = require.resolve('../../src/components/_webhookDestination');

function replaceModule(path, exports) {
    const original = require.cache[path];
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
    return () => {
        if (original) require.cache[path] = original;
        else delete require.cache[path];
    };
}

test('autoextract watch validates and registers a non-Twitter source without exposing the webhook token', async () => {
    const calls = [];
    const restoreRegistry = replaceModule(registryPath, { provider: () => ({ label: 'YouTube' }) });
    const restoreStore = replaceModule(storePath, {
        validateWebhook: async value => {
            calls.push({ type: 'validate', value });
            return { guildId: 'guild-1', channelId: 'channel-1' };
        },
        registerTarget: async input => {
            calls.push({ type: 'register', input });
            return { id: '11', providerId: 'youtube', sourceKey: 'channel:UC_x5XG1OV2P6uZZ5FSM9Ttw', sourceUrl: 'https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw', premium: false, initialCheckNotBeforeMs: 1000000 };
        },
    });
    delete require.cache[watchPath];
    try {
        const watch = require(watchPath);
        const replies = [];
        const webhook = 'https://discord.com/api/webhooks/123456789012345678/token-is-not-disclosed';
        await watch({
            user: { id: '123456789012345678' }, guildId: 'guild-1', locale: 'en',
            options: { getBoolean: () => true, getString: key => ({ provider: 'youtube', source: 'UC_x5XG1OV2P6uZZ5FSM9Ttw', destination: 'webhook', webhook })[key] || null },
            editReply: async payload => replies.push(payload),
        });
        assert.equal(calls[0].type, 'validate');
        assert.equal(calls[1].input.providerId, 'youtube');
        assert.equal(replies.length, 1);
        assert.doesNotMatch(JSON.stringify(replies[0]), /token-is-not-disclosed/);
        assert.match(replies[0].embeds[0].description, /YouTube/);
    } finally {
        delete require.cache[watchPath];
        restoreStore();
        restoreRegistry();
    }
});

test('autoextract watch can register direct-message delivery without a webhook URL', async () => {
    const calls = [];
    const restoreRegistry = replaceModule(registryPath, { provider: () => ({ label: 'YouTube' }) });
    const restoreStore = replaceModule(storePath, {
        validateWebhook: async () => { throw new Error('DM must not validate a webhook'); },
        registerTarget: async input => { calls.push(input); return { id: '12', providerId: 'youtube', sourceUrl: 'https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw', premium: false, destinationType: 'dm', initialCheckNotBeforeMs: null }; },
    });
    delete require.cache[watchPath];
    try {
        const watch = require(watchPath);
        const replies = [];
        await watch({
            user: { id: '123456789012345678' }, guildId: 'guild-1', channelId: 'channel-1', channel: { nsfw: false }, locale: 'en',
            options: { getBoolean: () => true, getString: key => ({ provider: 'youtube', source: 'UC_x5XG1OV2P6uZZ5FSM9Ttw', destination: 'dm' })[key] || null },
            editReply: async payload => replies.push(payload),
        });
        assert.equal(calls[0].destinationType, 'dm');
        assert.equal(calls[0].webhookUrl, null);
        assert.match(replies[0].embeds[0].description, /directly in DM/i);
    } finally {
        delete require.cache[watchPath];
        restoreStore();
        restoreRegistry();
    }
});

test('autoextract watch rejects a webhook whose verified guild is missing or differs before registration', async () => {
    for (const guildId of [null, 'other-guild']) {
        const calls = [];
        const restoreRegistry = replaceModule(registryPath, { provider: () => ({ label: 'YouTube' }) });
        const restoreStore = replaceModule(storePath, {
            validateWebhook: async () => ({ guildId, channelId: 'channel' }),
            registerTarget: async () => { calls.push('register'); },
        });
        delete require.cache[watchPath];
        try {
            const replies = [];
            await require(watchPath)({
                user: { id: '123456789012345678' }, guildId: 'guild-1', locale: 'en',
                options: { getBoolean: () => true, getString: key => ({ provider: 'youtube', source: 'source', destination: 'webhook', webhook: 'https://discord.com/api/webhooks/123456789012345678/token' })[key] || null },
                editReply: async payload => replies.push(payload),
            });
            assert.deepEqual(calls, []);
            assert.match(replies[0].embeds[0].description, /another server/i);
        } finally {
            delete require.cache[watchPath];
            restoreStore(); restoreRegistry();
        }
    }
});

test('webhook validation accepts only a verified incoming webhook in a guild channel', async () => {
    const { validateWebhook } = require('../../src/providers/autoWatch/store');
    const url = 'https://discord.com/api/webhooks/123456789012345678/token';
    const valid = { id: '123456789012345678', type: 1, guild_id: '223456789012345678', channel_id: '323456789012345678' };
    const response = body => ({ ok: true, status: 200, json: async () => body });
    assert.deepEqual(await validateWebhook(url, { fetch: async () => response(valid) }), {
        id: valid.id, guildId: valid.guild_id, channelId: valid.channel_id,
    });
    for (const body of [{ ...valid, type: 2 }, { ...valid, guild_id: null }, { ...valid, channel_id: 'bad' }, { ...valid, id: 'bad' }]) {
        await assert.rejects(validateWebhook(url, { fetch: async () => response(body) }), error => error?.code === 'AUTO_WATCH_INVALID_WEBHOOK');
    }
});

test('autoextract watch creates a webhook in a selected channel when requested', async () => {
    const calls = [];
    const restoreRegistry = replaceModule(registryPath, { provider: () => ({ label: 'YouTube' }) });
    const restoreStore = replaceModule(storePath, {
        validateWebhook: async () => ({ guildId: 'guild-1' }),
        registerTarget: async input => { calls.push(input); return { id: '13', providerId: 'youtube', sourceUrl: 'https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw', premium: false, destinationType: 'webhook', initialCheckNotBeforeMs: null }; },
    });
    const restoreWebhook = replaceModule(webhookDestinationPath, {
        createWebhookForChannel: async (_interaction, channelId) => ({ webhookUrl: 'https://discord.com/api/webhooks/123456789012345678/created-token', channel: { id: channelId, name: 'alerts' } }),
    });
    delete require.cache[watchPath];
    try {
        const watch = require(watchPath);
        await watch({
            user: { id: '123456789012345678' }, guildId: 'guild-1', channelId: 'channel-1', channel: { nsfw: false }, locale: 'en',
            options: {
                getBoolean: () => true,
                getString: key => ({ provider: 'youtube', source: 'UC_x5XG1OV2P6uZZ5FSM9Ttw', destination: 'channel' })[key] || null,
                getChannel: () => ({ id: 'channel-2' }),
            },
            editReply: async () => {},
        });
        assert.match(calls[0].webhookUrl, /created-token/);
        assert.equal(calls[0].destinationType, 'webhook');
    } finally {
        delete require.cache[watchPath];
        restoreWebhook();
        restoreStore();
        restoreRegistry();
    }
});

test('autoextract unwatch deletes only the caller target', async () => {
    const calls = [];
    const restoreStore = replaceModule(storePath, { deleteTarget: async (...input) => calls.push(input) });
    delete require.cache[unwatchPath];
    try {
        const unwatch = require(unwatchPath);
        const replies = [];
        await unwatch({
            user: { id: '123456789012345678' },
            options: { getInteger: () => 42 },
            editReply: async payload => replies.push(payload),
        });
        assert.deepEqual(calls, [['123456789012345678', 42]]);
        assert.match(replies[0].embeds[0].description, /deleted/i);
    } finally {
        delete require.cache[unwatchPath];
        restoreStore();
    }
});

test('autoextract command offers unified non-Twitter watch choices', () => {
    const command = require('../../src/commands/handlers/autoextract');
    const watch = command.definition.options.find(option => option.name === 'watch');
    assert.ok(watch);
    assert.deepEqual(watch.options.find(option => option.name === 'provider').choices.map(choice => choice.value), [
        'youtube', 'github', 'twitch', 'spotify', 'pixiv', 'booth',
    ]);
    assert.deepEqual(watch.options.find(option => option.name === 'destination').choices.map(choice => choice.value), ['dm', 'webhook', 'channel']);
    assert.equal(watch.options.find(option => option.name === 'responsibility').required, true);
});

test('unconfirmed responsibility is rejected before any webhook or subscription side effects', async () => {
    delete require.cache[watchPath];
    const replies = [];
    await require(watchPath)({ guildId: 'fixture', locale: 'ja', options: { getString: key => ({ provider: 'youtube', source: 'sample', destination: 'channel' })[key], getBoolean: () => false, getChannel: () => assert.fail('No channel side effect before confirmation') }, editReply: async payload => replies.push(payload) });
    assert.match(replies[0].embeds[0].description, /responsibility/);
});

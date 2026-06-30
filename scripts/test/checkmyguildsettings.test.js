'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const handlerPath = require.resolve('../../src/commands/handlers/checkmyguildsettings');
const loaderPath = require.resolve('../../src/providers/_loader');
const providerSettingsPath = require.resolve('../../src/providers/_provider_settings');

function loadHandlerWithProviders(providers, enabledIds) {
    const originalHandler = require.cache[handlerPath];
    const originalLoader = require.cache[loaderPath];
    const originalProviderSettings = require.cache[providerSettingsPath];

    require.cache[loaderPath] = {
        id: loaderPath,
        filename: loaderPath,
        loaded: true,
        exports: {
            loadProviders: () => providers,
        },
    };
    require.cache[providerSettingsPath] = {
        id: providerSettingsPath,
        filename: providerSettingsPath,
        loaded: true,
        exports: {
            getProviderSettings: async () => ({ enabled: true }),
            isProviderEnabled: async (provider) => enabledIds.has(provider.id),
        },
    };
    delete require.cache[handlerPath];

    const handler = require(handlerPath);

    return {
        handler,
        restore: () => {
            delete require.cache[handlerPath];
            if (originalHandler) require.cache[handlerPath] = originalHandler;
            if (originalLoader) require.cache[loaderPath] = originalLoader;
            else delete require.cache[loaderPath];
            if (originalProviderSettings) require.cache[providerSettingsPath] = originalProviderSettings;
            else delete require.cache[providerSettingsPath];
        },
    };
}

test('checkmyguildsettings shows enabled providers for the guild', async () => {
    const providers = [
        { id: 'twitter', enabledByDefault: true },
        { id: 'pixiv', enabledByDefault: false },
        { id: 'youtube', enabledByDefault: false },
    ];
    const { handler, restore } = loadHandlerWithProviders(providers, new Set(['twitter', 'pixiv']));

    try {
        let reply = null;
        const interaction = {
            guildId: 'guild-enabled-providers',
            locale: 'en',
            user: { id: 'user-1' },
            options: {
                getString: () => null,
            },
            editReply: async (payload) => {
                reply = payload;
            },
        };

        await handler.execute(interaction);

        const field = reply.embeds[0].fields.find(item => item.name === 'Enabled providers');
        assert.ok(field, 'enabled providers field should be present');
        assert.match(field.value, /\*\*twitter\*\*/);
        assert.match(field.value, /\*\*pixiv\*\*/);
        assert.doesNotMatch(field.value, /youtube/);
    } finally {
        restore();
    }
});

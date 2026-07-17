'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadProviders } = require('../../src/providers/_loader');

const handlerPath = require.resolve('../../src/commands/handlers/provider');
const providerSettingsPath = require.resolve('../../src/providers/_provider_settings');

function loadProviderHandlerWithProviderSettings(providerSettings) {
    const originalHandler = require.cache[handlerPath];
    const originalProviderSettings = require.cache[providerSettingsPath];

    require.cache[providerSettingsPath] = {
        id: providerSettingsPath,
        filename: providerSettingsPath,
        loaded: true,
        exports: {
            PROVIDER_DEFAULTS: { enabled: undefined },
            getSetting: async () => undefined,
            isProviderEnabled: async () => true,
            setProviderEnabled: async () => {},
            ...providerSettings,
        },
    };
    delete require.cache[handlerPath];

    const handler = require(handlerPath);

    return {
        handler,
        restore: () => {
            delete require.cache[handlerPath];
            if (originalHandler) require.cache[handlerPath] = originalHandler;
            if (originalProviderSettings) require.cache[providerSettingsPath] = originalProviderSettings;
            else delete require.cache[providerSettingsPath];
        },
    };
}

function optionChoices(command, subcommandName) {
    const subcommand = command.options.find(option => option.name === subcommandName);
    const idOption = subcommand.options.find(option => option.name === 'id');
    return new Set(idOption.choices.map(choice => choice.value));
}

test('provider enable and disable commands accept all as an id choice', () => {
    const { handler, restore } = loadProviderHandlerWithProviderSettings();

    try {
        assert.ok(optionChoices(handler.definition, 'enable').has('all'));
        assert.ok(optionChoices(handler.definition, 'disable').has('all'));
        assert.equal(optionChoices(handler.definition, 'show').has('all'), false);
    } finally {
        restore();
    }
});

test('provider command has no static Discord permission gate and still checks permissions at runtime', async () => {
    const { handler, restore } = loadProviderHandlerWithProviderSettings();

    try {
        assert.equal(handler.definition.default_member_permissions, null);

        let reply = null;
        await handler.execute({
            guild: { id: 'guild-provider-list' },
            guildId: 'guild-provider-list',
            memberPermissions: { has: () => false },
            options: {
                getSubcommand: () => 'list',
                getString: () => null,
            },
            editReply: async (payload) => {
                reply = payload;
            },
        });

        assert.match(reply.content, /Manage Server permission is required/);
    } finally {
        restore();
    }
});

for (const [subcommand, enabled] of [['enable', true], ['disable', false]]) {
    test(`provider ${subcommand} all updates every loaded provider`, async () => {
        const calls = [];
        const { handler, restore } = loadProviderHandlerWithProviderSettings({
            setProviderEnabled: async (provider, guildId, value) => {
                calls.push({ providerId: provider.id, guildId, value });
            },
        });

        try {
            let reply = null;
            const interaction = {
                guild: { id: 'guild-provider-all' },
                guildId: 'guild-provider-all',
                memberPermissions: { has: () => true },
                options: {
                    getSubcommand: () => subcommand,
                    getString: (name) => (name === 'id' ? 'all' : null),
                },
                editReply: async (payload) => {
                    reply = payload;
                },
            };

            await handler.execute(interaction);

            const expectedIds = loadProviders().map(provider => provider.id).sort();
            assert.deepEqual(calls.map(call => call.providerId).sort(), expectedIds);
            assert.ok(calls.every(call => call.guildId === 'guild-provider-all'));
            assert.ok(calls.every(call => call.value === enabled));
            assert.match(reply.content, new RegExp(`All providers are now \\*\\*${enabled ? 'enabled' : 'disabled'}\\*\\*`));
        } finally {
            restore();
        }
    });
}

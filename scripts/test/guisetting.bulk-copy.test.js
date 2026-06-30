'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const providerSettingsPath = require.resolve('../../src/providers/_provider_settings');
const guisettingPath = require.resolve('../../src/commands/handlers/guisetting');
const settingsPath = require.resolve('../../src/commands/handlers/settings');
const settingsImportPath = require.resolve('../../src/commands/handlers/settings/import');
const settingsHandlerPaths = [
    require.resolve('../../src/commands/handlers/settings/disable'),
    require.resolve('../../src/commands/handlers/settings/button_disabled'),
    require.resolve('../../src/commands/handlers/settings/button_invisible'),
    require.resolve('../../src/commands/handlers/settings/defaultlanguage'),
    require.resolve('../../src/commands/handlers/settings/editoriginaliftranslate'),
    require.resolve('../../src/commands/handlers/settings/extractbotmessage'),
];

function settingKey(providerId, guildId, key) {
    return `${providerId}\0${guildId}\0${key}`;
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function loadGuisettingWithFakeProviderSettings() {
    const originalGuisetting = require.cache[guisettingPath];
    const originalSettings = require.cache[settingsPath];
    const originalSettingsImport = require.cache[settingsImportPath];
    const originalSettingsHandlers = new Map(settingsHandlerPaths.map(handlerPath => [handlerPath, require.cache[handlerPath]]));
    const originalProviderSettings = require.cache[providerSettingsPath];
    const values = new Map();

    require.cache[providerSettingsPath] = {
        id: providerSettingsPath,
        filename: providerSettingsPath,
        loaded: true,
        exports: {
            getSetting: async (provider, key, guildId) => clone(values.get(settingKey(provider.id, guildId, key))),
            setSetting: async (provider, key, guildId, value) => {
                values.set(settingKey(provider.id, guildId, key), clone(value));
            },
            isProviderEnabled: async (provider, guildId) => {
                const value = values.get(settingKey(provider.id, guildId, 'enabled'));
                return value === undefined ? provider.enabledByDefault === true : value === true;
            },
            setProviderEnabled: async (provider, guildId, value) => {
                values.set(settingKey(provider.id, guildId, 'enabled'), value === true);
            },
        },
    };
    delete require.cache[guisettingPath];
    delete require.cache[settingsPath];
    delete require.cache[settingsImportPath];
    for (const handlerPath of settingsHandlerPaths) delete require.cache[handlerPath];

    return {
        guisetting: require(guisettingPath),
        values,
        loadSettings: () => require(settingsPath),
        restore: () => {
            delete require.cache[guisettingPath];
            delete require.cache[settingsPath];
            delete require.cache[settingsImportPath];
            for (const handlerPath of settingsHandlerPaths) delete require.cache[handlerPath];
            if (originalGuisetting) require.cache[guisettingPath] = originalGuisetting;
            if (originalSettings) require.cache[settingsPath] = originalSettings;
            if (originalSettingsImport) require.cache[settingsImportPath] = originalSettingsImport;
            for (const [handlerPath, originalHandler] of originalSettingsHandlers) {
                if (originalHandler) require.cache[handlerPath] = originalHandler;
            }
            if (originalProviderSettings) require.cache[providerSettingsPath] = originalProviderSettings;
            else delete require.cache[providerSettingsPath];
        },
    };
}

test('guisetting all provider choice updates shared settings for every provider', async () => {
    const { guisetting, values, restore } = loadGuisettingWithFakeProviderSettings();

    try {
        await guisetting._internal.applySettingValue('all', 'defaultLanguage', 'guild-bulk', 'ja');

        const providers = require('../../src/providers/_loader').loadProviders();
        for (const provider of providers) {
            assert.equal(values.get(settingKey(provider.id, 'guild-bulk', 'defaultLanguage')), 'ja');
        }
    } finally {
        restore();
    }
});

test('settings command exposes import and offers provider all for same-guild bulk subcommands', async () => {
    const { loadSettings, restore } = loadGuisettingWithFakeProviderSettings();

    try {
        const settings = loadSettings();
        const definition = settings.definition;
        assert.ok(definition.options.some(option => option.name === 'import'));

        const defaultLanguage = definition.options.find(option => option.name === 'defaultlanguage');
        const disable = definition.options.find(option => option.name === 'disable');
        const buttonDisabled = definition.options.find(option => option.name === 'button_disabled');
        const bannedWords = definition.options.find(option => option.name === 'bannedwords');
        const defaultProviderOption = defaultLanguage.options.find(option => option.name === 'provider');
        const disableProviderOption = disable.options.find(option => option.name === 'provider');
        const buttonDisabledProviderOption = buttonDisabled.options.find(option => option.name === 'provider');
        const bannedWordsProviderOption = bannedWords.options.find(option => option.name === 'provider');

        assert.match(defaultProviderOption.description, /all/);
        assert.match(disableProviderOption.description, /all/);
        assert.match(buttonDisabledProviderOption.description, /all/);
        assert.doesNotMatch(bannedWordsProviderOption.description, /all/);
    } finally {
        restore();
    }
});

test('settings import command copies settings into the current guild', async () => {
    const { loadSettings, values, restore } = loadGuisettingWithFakeProviderSettings();

    try {
        values.set(settingKey('twitter', 'guild-source', 'defaultLanguage'), 'ja');

        const settings = loadSettings();
        let reply = null;
        const interaction = {
            guildId: 'guild-target',
            locale: 'en-US',
            memberPermissions: { has: () => true },
            options: {
                getSubcommandGroup: () => null,
                getSubcommand: () => 'import',
                getString: (name) => (name === 'source_guild' ? 'guild-source' : null),
            },
            editReply: async (payload) => {
                reply = payload;
            },
        };

        await settings.execute(interaction);

        assert.match(reply.content, /Imported \d+ setting\(s\) from guild-source/);
        assert.equal(values.get(settingKey('twitter', 'guild-target', 'defaultLanguage')), 'ja');
    } finally {
        restore();
    }
});

test('settings disable provider all applies channel target to every provider in the current guild', async () => {
    const { loadSettings, values, restore } = loadGuisettingWithFakeProviderSettings();

    try {
        values.set(settingKey('twitter', 'guild-target', 'disable'), { user: [], channel: ['channel-1'], role: [] });

        const settings = loadSettings();
        let reply = null;
        const interaction = {
            guildId: 'guild-target',
            locale: 'en-US',
            member: { permissions: { has: () => true } },
            options: {
                getSubcommandGroup: () => null,
                getSubcommand: () => 'disable',
                getString: (name) => (name === 'provider' ? 'all' : null),
                getUser: () => null,
                getChannel: (name) => (name === 'channel' ? { id: 'channel-1' } : null),
                getRole: () => null,
            },
            editReply: async (payload) => {
                reply = payload;
            },
        };

        await settings.execute(interaction);

        assert.match(reply, /All providers:/);
        const providers = require('../../src/providers/_loader').loadProviders();
        for (const provider of providers) {
            assert.deepEqual(values.get(settingKey(provider.id, 'guild-target', 'disable')), {
                user: [],
                channel: ['channel-1'],
                role: [],
            });
        }
    } finally {
        restore();
    }
});

test('settings button_disabled provider all removes role target when every provider already has it', async () => {
    const { loadSettings, values, restore } = loadGuisettingWithFakeProviderSettings();

    try {
        const providers = require('../../src/providers/_loader').loadProviders();
        for (const provider of providers) {
            values.set(settingKey(provider.id, 'guild-target', 'button_disabled'), { user: [], channel: [], role: ['role-1'] });
        }

        const settings = loadSettings();
        const interaction = {
            guildId: 'guild-target',
            locale: 'en-US',
            member: { permissions: { has: () => true } },
            options: {
                getSubcommandGroup: () => null,
                getSubcommand: () => 'button_disabled',
                getString: (name) => (name === 'provider' ? 'all' : null),
                getUser: () => null,
                getChannel: () => null,
                getRole: (name) => (name === 'role' ? { id: 'role-1' } : null),
            },
            editReply: async () => {},
        };

        await settings.execute(interaction);

        for (const provider of providers) {
            assert.deepEqual(values.get(settingKey(provider.id, 'guild-target', 'button_disabled')), {
                user: [],
                channel: [],
                role: [],
            });
        }
    } finally {
        restore();
    }
});

test('guisetting import checks target permission only and skips channel/role targets', async () => {
    const { guisetting, values, restore } = loadGuisettingWithFakeProviderSettings();

    try {
        values.set(settingKey('twitter', 'guild-source', 'enabled'), true);
        values.set(settingKey('twitter', 'guild-source', 'defaultLanguage'), 'ja');
        values.set(settingKey('twitter', 'guild-source', 'disable'), {
            user: ['user-1'],
            channel: ['channel-1'],
            role: ['role-1'],
        });
        values.set(settingKey('twitter', 'guild-source', 'button_disabled'), {
            user: ['user-2'],
            channel: ['channel-2'],
            role: ['role-2'],
        });
        values.set(settingKey('twitter', 'guild-source', 'button_invisible'), { translate: true });
        values.set(settingKey('twitter', 'guild-source', 'bannedWords'), ['blocked']);
        values.set(settingKey('twitter', 'guild-source', 'passive_mode'), true);
        values.set(settingKey('twitter', 'guild-source', 'twitter_text_mode'), 'link_only');
        values.set(settingKey('pixiv', 'guild-source', 'pixiv_images_per_step'), 10);
        values.set(settingKey('pixiv', 'guild-source', 'hidden_output_items'), ['tags']);
        values.set(settingKey('youtube', 'guild-source', 'youtube_description_max_length'), 500);
        values.set(settingKey('tiktok', 'guild-source', 'tiktok_hq'), true);
        values.set(settingKey('github', 'guild-source', 'github_card_style'), 'github');
        values.set(settingKey('steam', 'guild-source', 'hidden_output_items'), ['price']);

        const interaction = {
            guildId: 'guild-target',
            locale: 'en-US',
            client: null,
            user: { id: 'user-running-copy' },
            memberPermissions: { has: () => true },
        };

        const notice = await guisetting._internal.importSettingsFromGuild(interaction, 'guild-source', 'guild-target');

        assert.match(notice, /Imported \d+ setting\(s\) from guild-source/);
        assert.match(notice, /Skipped 4 channel\/role target\(s\)/);
        assert.equal(values.get(settingKey('twitter', 'guild-target', 'enabled')), true);
        assert.equal(values.get(settingKey('twitter', 'guild-target', 'defaultLanguage')), 'ja');
        assert.deepEqual(values.get(settingKey('twitter', 'guild-target', 'disable')), {
            user: ['user-1'],
            channel: [],
            role: [],
        });
        assert.deepEqual(values.get(settingKey('twitter', 'guild-target', 'button_disabled')), {
            user: ['user-2'],
            channel: [],
            role: [],
        });
        assert.deepEqual(values.get(settingKey('twitter', 'guild-target', 'bannedWords')), ['blocked']);
        assert.equal(values.get(settingKey('twitter', 'guild-target', 'passive_mode')), true);
        assert.equal(values.get(settingKey('twitter', 'guild-target', 'twitter_text_mode')), 'link_only');
        assert.equal(values.get(settingKey('pixiv', 'guild-target', 'pixiv_images_per_step')), 10);
        assert.deepEqual(values.get(settingKey('pixiv', 'guild-target', 'hidden_output_items')), ['tags']);
        assert.equal(values.get(settingKey('youtube', 'guild-target', 'youtube_description_max_length')), 500);
        assert.equal(values.get(settingKey('tiktok', 'guild-target', 'tiktok_hq')), true);
        assert.equal(values.get(settingKey('github', 'guild-target', 'github_card_style')), 'github');
        assert.deepEqual(values.get(settingKey('steam', 'guild-target', 'hidden_output_items')), ['price']);
    } finally {
        restore();
    }
});

test('guisetting import refuses users without target guild settings permission', async () => {
    const { guisetting, values, restore } = loadGuisettingWithFakeProviderSettings();

    try {
        values.set(settingKey('twitter', 'guild-source', 'defaultLanguage'), 'ja');

        const interaction = {
            guildId: 'guild-target',
            locale: 'en-US',
            memberPermissions: { has: () => false },
        };

        const notice = await guisetting._internal.importSettingsFromGuild(interaction, 'guild-source', 'guild-target');

        assert.match(notice, /need Manage Channels/);
        assert.equal(values.get(settingKey('twitter', 'guild-target', 'defaultLanguage')), undefined);
    } finally {
        restore();
    }
});

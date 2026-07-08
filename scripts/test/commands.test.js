'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const quotastats = require('../../src/commands/handlers/quotastats');
const checkmyguildsettings = require('../../src/commands/handlers/checkmyguildsettings');
const help = require('../../src/commands/handlers/help');
const buttonInvisible = require('../../src/commands/handlers/settings/button_invisible');
const expandTweet = require('../../src/providers/twitter/commands/expandtweet');
const showSaveTweet = require('../../src/providers/twitter/commands/showsavetweet');
const { buildSlashCommands } = require('../../src/commands');
const { settings } = require('../../src/settings');

const DISCORD_COMMAND_NAME_RE = /^[-_\p{L}\p{N}]{1,32}$/u;
const MAX_DISCORD_COMMAND_JSON_LENGTH = 8000;

function assertValidDiscordCommandName(value, pathLabel) {
    assert.equal(typeof value, 'string', `${pathLabel} must be a string`);
    assert.match(value, DISCORD_COMMAND_NAME_RE, `${pathLabel} is not a valid Discord command name`);
    assert.equal(value, value.toLocaleLowerCase(), `${pathLabel} must be lowercase`);
}

function assertValidDefinitionNames(definition, pathLabel) {
    assertValidDiscordCommandName(definition.name, `${pathLabel}.name`);

    for (const [locale, value] of Object.entries(definition.name_localizations ?? {})) {
        assertValidDiscordCommandName(value, `${pathLabel}.name_localizations.${locale}`);
    }

    for (const [index, option] of (definition.options ?? []).entries()) {
        assertValidDefinitionNames(option, `${pathLabel}.options[${index}]`);
    }
}

test('slash command names and name localizations are valid for Discord registration', () => {
    for (const [index, command] of buildSlashCommands().entries()) {
        assertValidDefinitionNames(command, `commands[${index}]`);
    }
});

test('slash command payloads stay under Discord registration size limit', () => {
    for (const command of buildSlashCommands()) {
        const jsonLength = JSON.stringify(command).length;
        assert.ok(
            jsonLength < MAX_DISCORD_COMMAND_JSON_LENGTH,
            `${command.name} command payload is ${jsonLength} bytes`
        );
    }
});

test('settings command keeps quick common and provider-specific subcommands', () => {
    const settingsCommand = buildSlashCommands().find(command => command.name === 'settings');
    assert.ok(settingsCommand, 'settings command should be registered');

    const disableCommand = settingsCommand.options?.find(option => option.name === 'disable');
    assert.ok(disableCommand, 'settings command should include common disable subcommand');
    assert.equal(disableCommand.type, 1);

    const providerOption = disableCommand.options?.find(option => option.name === 'provider');
    assert.ok(providerOption, 'common settings should include provider option');
    assert.equal(providerOption.type, 3);

    const twitterGroup = settingsCommand.options?.find(option => option.name === 'twitter');
    assert.ok(twitterGroup, 'settings command should include twitter group');
    assert.equal(twitterGroup.type, 2);
    const twitterSettingNames = new Set((twitterGroup.options || []).map(option => option.name));
    assert.ok(twitterSettingNames.has('passivemode'));
    assert.ok(twitterSettingNames.has('secondaryextractmode'));
    assert.ok(twitterSettingNames.has('secondarysourcepreview'));

    const pixivGroup = settingsCommand.options?.find(option => option.name === 'pixiv');
    assert.ok(pixivGroup, 'settings command should include pixiv group');
    assert.equal(pixivGroup.type, 2);
    assert.ok((pixivGroup.options || []).some(option => option.name === 'images_per_step'));
});

test('provider command no longer exposes set subcommand', () => {
    const providerCommand = buildSlashCommands().find(command => command.name === 'provider');
    assert.ok(providerCommand, 'provider command should be registered');

    const subcommandNames = new Set((providerCommand.options || []).map(option => option.name));
    assert.ok(!subcommandNames.has('set'), 'provider set should not be registered');
});

test('help command output includes webui dashboard guidance', async () => {
    let reply = null;
    const interaction = {
        guildId: 'guild-help',
        locale: 'ja',
        editReply: async (payload) => {
            reply = payload;
        },
    };

    await help.execute(interaction, {});

    const fields = reply.embeds[0].fields;
    const webui = fields.find(field => field.name === 'Web UI');
    assert.ok(webui, 'help output should include a Web UI field');
    assert.match(webui.value, /dashboard\/guild-help\/settings/);
    assert.match(webui.value, /高度なカスタマイズ/);
    assert.match(webui.value, /サポートされなくなる予定/);
});

test('quotastats returns zero usage when user has no saves directory', async () => {
    let reply = null;
    const interaction = {
        user: { id: '__missing_saved_tweet_user__' },
        options: {
            getUser: () => null,
        },
        editReply: async (payload) => {
            reply = payload;
        },
    };

    await quotastats.execute(interaction, {});

    assert.equal(reply.embeds[0].fields[0].name, 'Used');
    assert.equal(reply.embeds[0].fields[0].value, '0.00MB');
});

test('checkmyguildsettings accepts the declared guild option and shows disabled channels', async () => {
    const originalDisable = JSON.parse(JSON.stringify(settings.disable));
    const targetGuild = 'guild-settings-target';
    settings.disable.channel = ['channel-1'];
    settings.disable.role[targetGuild] = ['role-1'];

    try {
        let reply = null;
        const interaction = {
            guildId: 'guild-current',
            locale: 'en',
            user: { id: '796972193287503913' },
            guild: {
                members: { me: { permissions: { has: () => true } } },
            },
            options: {
                getString: (name) => (name === 'guild' ? targetGuild : null),
            },
            editReply: async (payload) => {
                reply = payload;
            },
        };

        await checkmyguildsettings.execute(interaction, {});

        const allValues = reply.embeds[0].fields.map(f => f.value).join('\n');
        assert.match(allValues, /<#channel-1>/);
        assert.match(allValues, /<@&role-1>/);
    } finally {
        settings.disable = originalDisable;
    }
});

test('button_invisible replies once when multiple button options are changed', async () => {
    const originalButtonInvisible = JSON.parse(JSON.stringify(settings.button_invisible));
    const originalByProvider = JSON.parse(JSON.stringify(settings.byProvider));

    try {
        const replies = [];
        const interaction = {
            guildId: 'guild-button-invisible',
            locale: 'en',
            member: {
                permissions: { has: () => true },
            },
            options: {
                getSubcommandGroup: () => 'twitter',
                getString: () => null,
                getBoolean: (name) => {
                    if (name === 'showmediaasattachments') return true;
                    if (name === 'translate') return true;
                    return null;
                },
            },
            editReply: async (payload) => {
                replies.push(payload);
            },
        };

        await buttonInvisible(interaction, {});

        assert.equal(replies.length, 1);
        assert.match(replies[0], /showMediaAsAttachments/);
        assert.match(replies[0], /Translate|translate/);
    } finally {
        settings.button_invisible = originalButtonInvisible;
        settings.byProvider = originalByProvider;
    }
});

test('showsavetweet edits the deferred reply when requested saved tweet is missing', async () => {
    const originalCwd = process.cwd();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cte-showsavetweet-'));

    try {
        process.chdir(tmpDir);
        fs.mkdirSync(path.join('saves', 'user-1', 'existing'), { recursive: true });
        fs.writeFileSync(path.join('saves', 'user-1', 'existing', 'data.json'), JSON.stringify({
            text: 'existing saved tweet',
            user_name: 'SavedUser',
        }));

        const calls = [];
        const interaction = {
            user: { id: 'user-1' },
            locale: 'en',
            options: {
                getString: (name) => (name === 'id' ? 'missing' : null),
            },
            editReply: async () => {
                calls.push('edit');
            },
        };

        await showSaveTweet.execute(interaction, {});

        assert.deepEqual(calls, ['edit']);
    } finally {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('showsavetweet forces channel send mode for deferred saved-tweet display', async () => {
    const originalCwd = process.cwd();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cte-showsavetweet-'));
    const twitterProviderPath = require.resolve('../../src/providers/twitter');
    const originalProvider = require.cache[twitterProviderPath];

    try {
        process.chdir(tmpDir);
        fs.mkdirSync(path.join('saves', 'user-1', 'tweet-1'), { recursive: true });
        fs.writeFileSync(path.join('saves', 'user-1', 'tweet-1', 'data.json'), JSON.stringify({
            text: 'saved tweet',
            user_name: 'SavedUser',
        }));

        let sendOptions = null;
        require.cache[twitterProviderPath] = {
            id: twitterProviderPath,
            filename: twitterProviderPath,
            loaded: true,
            exports: {
                sendTweetEmbed: async (_interaction, _url, options) => {
                    sendOptions = options;
                },
            },
        };

        const interaction = {
            user: { id: 'user-1' },
            locale: 'en',
            options: {
                getString: (name) => (name === 'id' ? 'tweet-1' : null),
            },
            editReply: async () => {},
        };

        await showSaveTweet.execute(interaction, {});

        assert.deepEqual(sendOptions, { forceSendMode: 'channel' });
    } finally {
        process.chdir(originalCwd);
        if (originalProvider) require.cache[twitterProviderPath] = originalProvider;
        else delete require.cache[twitterProviderPath];
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('et command sends tweet with per-command quote depth override', async () => {
    const twitterProviderPath = require.resolve('../../src/providers/twitter');
    const originalProvider = require.cache[twitterProviderPath];

    try {
        let sendCall = null;
        require.cache[twitterProviderPath] = {
            id: twitterProviderPath,
            filename: twitterProviderPath,
            loaded: true,
            exports: {
                sendTweetEmbed: async (_interaction, url, options) => {
                    sendCall = { url, options };
                },
            },
        };

        const replies = [];
        const interaction = {
            user: { id: 'user-1' },
            options: {
                getString: (name) => {
                    if (name === 'url') return 'https://x.com/example/status/12345';
                    return null;
                },
                getInteger: (name) => (name === 'depth' ? 2 : null),
                getBoolean: () => false,
            },
            editReply: async (payload) => {
                replies.push(payload);
            },
        };

        await expandTweet.execute(interaction, {});

        assert.equal(sendCall.url, 'https://x.com/example/status/12345');
        assert.deepEqual(sendCall.options, {
            forceSendMode: 'channel',
            settingsOverride: {
                secondary_extract_mode: false,
                quote_repost_max_depth: 2,
                quote_repost_do_not_extract: false,
            },
        });
        assert.match(replies.at(-1).content, /Quote repost depth: 2/);
    } finally {
        if (originalProvider) require.cache[twitterProviderPath] = originalProvider;
        else delete require.cache[twitterProviderPath];
    }
});

test('et command requires url and depth options in the slash command definition', () => {
    const etCommand = buildSlashCommands().find(command => command.name === 'et');
    assert.ok(etCommand, 'et command should be registered');

    const requiredOptions = new Set((etCommand.options || [])
        .filter(option => option.required)
        .map(option => option.name));

    assert.ok(requiredOptions.has('url'));
    assert.ok(requiredOptions.has('depth'));
});

test('et command rejects missing depth before sending', async () => {
    const twitterProviderPath = require.resolve('../../src/providers/twitter');
    const originalProvider = require.cache[twitterProviderPath];

    try {
        let sent = false;
        require.cache[twitterProviderPath] = {
            id: twitterProviderPath,
            filename: twitterProviderPath,
            loaded: true,
            exports: {
                sendTweetEmbed: async () => {
                    sent = true;
                },
            },
        };

        let reply = null;
        const interaction = {
            user: { id: 'user-1' },
            options: {
                getString: (name) => (name === 'url' ? 'https://x.com/example/status/12345' : null),
                getInteger: () => null,
                getBoolean: () => false,
            },
            editReply: async (payload) => {
                reply = payload;
            },
        };

        await expandTweet.execute(interaction, {});

        assert.equal(sent, false);
        assert.equal(reply.content, 'depth is required.');
    } finally {
        if (originalProvider) require.cache[twitterProviderPath] = originalProvider;
        else delete require.cache[twitterProviderPath];
    }
});

test('et command builds a tweet URL from account and id, then saves account depth automatically', async () => {
    const twitterProviderPath = require.resolve('../../src/providers/twitter');
    const providerSettingsPath = require.resolve('../../src/providers/_provider_settings');
    const originalProvider = require.cache[twitterProviderPath];
    const originalProviderSettings = require.cache[providerSettingsPath];

    try {
        let sendUrl = null;
        const setCalls = [];
        require.cache[twitterProviderPath] = {
            id: twitterProviderPath,
            filename: twitterProviderPath,
            loaded: true,
            exports: {
                sendTweetEmbed: async (_interaction, url) => {
                    sendUrl = url;
                },
            },
        };
        require.cache[providerSettingsPath] = {
            id: providerSettingsPath,
            filename: providerSettingsPath,
            loaded: true,
            exports: {
                getSetting: async () => ({ other: 3 }),
                setSetting: async (provider, key, guildId, value) => {
                    setCalls.push({ providerId: provider.id, key, guildId, value });
                },
            },
        };

        let reply = null;
        const interaction = {
            guildId: 'guild-et',
            user: { id: 'user-1' },
            options: {
                getString: (name) => {
                    if (name === 'url') return '12345';
                    if (name === 'account') return '@example';
                    return null;
                },
                getInteger: (name) => (name === 'depth' ? 1 : null),
                getBoolean: () => false,
            },
            editReply: async (payload) => {
                reply = payload;
            },
        };

        await expandTweet.execute(interaction, {});

        assert.equal(sendUrl, 'https://twitter.com/example/status/12345');
        assert.deepEqual(setCalls, [{
            providerId: 'twitter',
            key: 'quote_repost_depth_by_account',
            guildId: 'guild-et',
            value: { other: 3, example: 1 },
        }]);
        assert.match(reply.content, /Saved future depth for @example/);
    } finally {
        if (originalProvider) require.cache[twitterProviderPath] = originalProvider;
        else delete require.cache[twitterProviderPath];
        if (originalProviderSettings) require.cache[providerSettingsPath] = originalProviderSettings;
        else delete require.cache[providerSettingsPath];
    }
});

test('et command save option stores the future guild default depth', async () => {
    const twitterProviderPath = require.resolve('../../src/providers/twitter');
    const providerSettingsPath = require.resolve('../../src/providers/_provider_settings');
    const originalProvider = require.cache[twitterProviderPath];
    const originalProviderSettings = require.cache[providerSettingsPath];

    try {
        const setCalls = [];
        require.cache[twitterProviderPath] = {
            id: twitterProviderPath,
            filename: twitterProviderPath,
            loaded: true,
            exports: {
                sendTweetEmbed: async () => {},
            },
        };
        require.cache[providerSettingsPath] = {
            id: providerSettingsPath,
            filename: providerSettingsPath,
            loaded: true,
            exports: {
                setSetting: async (provider, key, guildId, value) => {
                    setCalls.push({ providerId: provider.id, key, guildId, value });
                },
            },
        };

        let reply = null;
        const interaction = {
            guildId: 'guild-et',
            user: { id: 'user-1' },
            options: {
                getString: (name) => (name === 'url' ? 'https://x.com/example/status/12345' : null),
                getInteger: (name) => (name === 'depth' ? 2 : null),
                getBoolean: (name) => name === 'save',
            },
            editReply: async (payload) => {
                reply = payload;
            },
        };

        await expandTweet.execute(interaction, {});

        assert.deepEqual(setCalls, [
            {
                providerId: 'twitter',
                key: 'quote_repost_max_depth',
                guildId: 'guild-et',
                value: 2,
            },
            {
                providerId: 'twitter',
                key: 'quote_repost_do_not_extract',
                guildId: 'guild-et',
                value: false,
            },
        ]);
        assert.match(reply.content, /Saved future default quote repost depth/);
    } finally {
        if (originalProvider) require.cache[twitterProviderPath] = originalProvider;
        else delete require.cache[twitterProviderPath];
        if (originalProviderSettings) require.cache[providerSettingsPath] = originalProviderSettings;
        else delete require.cache[providerSettingsPath];
    }
});

test('et command rejects invalid tweet URLs before sending', async () => {
    const twitterProviderPath = require.resolve('../../src/providers/twitter');
    const originalProvider = require.cache[twitterProviderPath];

    try {
        let sent = false;
        require.cache[twitterProviderPath] = {
            id: twitterProviderPath,
            filename: twitterProviderPath,
            loaded: true,
            exports: {
                sendTweetEmbed: async () => {
                    sent = true;
                },
            },
        };

        let reply = null;
        const interaction = {
            user: { id: 'user-1' },
            options: {
                getString: (name) => (name === 'url' ? 'https://example.com/not-a-tweet' : null),
                getInteger: (name) => (name === 'depth' ? 1 : null),
                getBoolean: () => false,
            },
            editReply: async (payload) => {
                reply = payload;
            },
        };

        await expandTweet.execute(interaction, {});

        assert.equal(sent, false);
        assert.match(reply.content, /Twitter\/X status URL/);
    } finally {
        if (originalProvider) require.cache[twitterProviderPath] = originalProvider;
        else delete require.cache[twitterProviderPath];
    }
});

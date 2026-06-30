'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const quotastats = require('../../src/commands/handlers/quotastats');
const checkmyguildsettings = require('../../src/commands/handlers/checkmyguildsettings');
const buttonInvisible = require('../../src/commands/handlers/settings/button_invisible');
const showSaveTweet = require('../../src/providers/twitter/commands/showsavetweet');
const { buildSlashCommands } = require('../../src/commands');
const { settings } = require('../../src/settings');

const DISCORD_COMMAND_NAME_RE = /^[-_\p{L}\p{N}]{1,32}$/u;

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

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const quotastats = require('../../src/commands/handlers/quotastats');
const checkmyguildsettings = require('../../src/commands/handlers/checkmyguildsettings');
const buttonInvisible = require('../../src/commands/handlers/settings/button_invisible');
const { settings } = require('../../src/settings');

test('quotastats returns zero usage when user has no saves directory', async () => {
    let reply = null;
    const interaction = {
        user: { id: '__missing_saved_tweet_user__' },
        options: {
            getUser: () => null,
        },
        reply: async (payload) => {
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
            reply: async (payload) => {
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
            reply: async (payload) => {
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

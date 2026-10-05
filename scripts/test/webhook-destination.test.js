'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionsBitField } = require('discord.js');
const { createWebhookForChannel } = require('../../src/components/_webhookDestination');

function channel(permissions = true) {
    return {
        id: 'channel-1',
        type: ChannelType.GuildText,
        permissionsFor: () => ({ has: permission => permissions && permission === PermissionsBitField.Flags.ManageWebhooks }),
        createWebhook: async ({ name }) => ({ name, url: 'https://discord.com/api/webhooks/123456789012345678/created-token' }),
    };
}

test('channel destination creates a webhook only with both user and bot permissions', async () => {
    const selected = channel(true);
    const interaction = {
        member: { id: 'user-1' },
        client: { user: { id: 'bot-1' } },
        guild: { members: { me: { id: 'bot-1' } }, channels: { cache: new Map([[selected.id, selected]]) } },
    };
    const created = await createWebhookForChannel(interaction, selected.id, 'Price alert');
    assert.equal(created.channel, selected);
    assert.match(created.webhookUrl, /created-token/);
});

test('channel destination rejects a user without Manage Webhooks', async () => {
    const selected = channel(false);
    const interaction = {
        member: { id: 'user-1' },
        client: { user: { id: 'bot-1' } },
        guild: { members: { me: { id: 'bot-1' } }, channels: { cache: new Map([[selected.id, selected]]) } },
    };
    await assert.rejects(createWebhookForChannel(interaction, selected.id), error => error?.code === 'WEBHOOK_DESTINATION_USER_PERMISSION');
});

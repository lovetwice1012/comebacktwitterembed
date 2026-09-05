'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client, MessageComponentInteraction } = require('discord.js');
const { createDiscordCacheOptions, retainMessageMember } = require('../../src/discordCache');

test('real Discord managers discard history, bound users and retain active role checks and bot permissions', async () => {
    const client = new Client({ intents: [], ...createDiscordCacheOptions() });
    try {
        client.user = client.users._add({ id: '100', username: 'bot', discriminator: '0', bot: true });
        const guild = client.guilds._add({ id: '200', name: 'guild', roles: [
            { id: '200', name: '@everyone', permissions: '0' },
            { id: '201', name: 'disabled', permissions: '0' },
        ] });
        guild.members._add({ user: client.user, roles: [] });
        const channel = client.channels._add({ id: '300', guild_id: guild.id, name: 'test', type: 0 });
        const payload = {
            id: '400', channel_id: channel.id, guild_id: guild.id,
            author: { id: '500', username: 'sender', discriminator: '0' },
            member: { roles: ['201'], joined_at: '2026-01-01T00:00:00Z' },
            content: 'https://x.com/u/status/1', timestamp: '2026-09-05T00:00:00Z',
            type: 0, attachments: [], embeds: [], mentions: [], mention_roles: [], components: [],
        };
        const message = channel.messages._add(payload);
        retainMessageMember(message);
        for (let i = 0; i < 3000; i++) {
            channel.messages._add({ ...payload, id: String(1000 + i), author: { ...payload.author, id: String(10000 + i) }, member: { roles: [] } });
        }
        assert.equal(channel.messages.cache.size, 0);
        assert.equal(guild.members.cache.size, 2);
        assert.ok(client.users.cache.size <= 1000);
        assert.equal(guild.members.me.id, client.user.id);
        assert.ok(client.users.cache.has(client.user.id));
        assert.equal(message.member.id, '500');
        assert.ok(message.member.roles.cache.has('201'));
        // Button events carry the old message even when it was never cached.
        const interaction = new MessageComponentInteraction(client, {
            id: '900', application_id: client.user.id, type: 3, token: 'test', version: 1,
            guild_id: guild.id, channel: { id: channel.id, type: 0 },
            member: { user: payload.author, roles: ['201'] },
            message: payload, data: { custom_id: 'delete', component_type: 2 },
            locale: 'ja', guild_locale: 'ja', entitlements: [],
        });
        assert.equal(interaction.message.id, payload.id);
        assert.ok(interaction.member.roles.cache.has('201'));
        assert.equal(channel.messages.cache.size, 0);
    } finally { await client.destroy(); }
});

'use strict';

const { ChannelType, PermissionsBitField } = require('discord.js');

const WEBHOOK_NAME = 'ComebackTwitterEmbed notifications';
const WEBHOOK_CHANNEL_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const pendingCreations = new Map();

function isWebhookChannel(channel) {
    return Boolean(channel && WEBHOOK_CHANNEL_TYPES.has(channel.type) && typeof channel.createWebhook === 'function');
}

function hasManageWebhooks(channel, subject) {
    try {
        return Boolean(channel?.permissionsFor?.(subject)?.has(PermissionsBitField.Flags.ManageWebhooks));
    } catch {
        return false;
    }
}

async function resolveGuildChannel(interaction, channelId) {
    if (!interaction.guild) throw Object.assign(new Error('A server channel is required.'), { code: 'WEBHOOK_DESTINATION_GUILD_REQUIRED' });
    const channel = interaction.guild.channels?.cache?.get(channelId)
        || await interaction.guild.channels?.fetch?.(channelId);
    if (!isWebhookChannel(channel)) throw Object.assign(new Error('Select a normal text or announcement channel.'), { code: 'WEBHOOK_DESTINATION_CHANNEL_INVALID' });
    return channel;
}

async function verifyChannelForNotification(interaction, channelId, manageWebhooks = false) {
    const channel = await resolveGuildChannel(interaction, channelId);
    const required = PermissionsBitField.Flags.ViewChannel | PermissionsBitField.Flags.SendMessages
        | (manageWebhooks ? PermissionsBitField.Flags.ManageWebhooks : 0n);
    const has = subject => { try { return Boolean(subject && channel.permissionsFor(subject)?.has(required)); } catch { return false; } };
    if (!has(interaction.member)) {
        throw Object.assign(new Error('You need View Channel, Send Messages and the required webhook permissions in the selected channel.'), { code: 'WEBHOOK_DESTINATION_USER_PERMISSION' });
    }
    const botMember = interaction.guild?.members?.me || interaction.client?.user;
    if (!has(botMember)) {
        throw Object.assign(new Error('The bot needs View Channel, Send Messages and the required webhook permissions in the selected channel.'), { code: 'WEBHOOK_DESTINATION_BOT_PERMISSION' });
    }
    return channel;
}

async function createWebhookForChannel(interaction, channelId, name = WEBHOOK_NAME) {
    const channel = await verifyChannelForNotification(interaction, channelId, true);
    const botId = interaction.client?.user?.id || interaction.guild?.members?.me?.id;
    const webhookName = String(name).slice(0, 80), key = `${interaction.guildId || interaction.guild.id}:${channelId}:${botId}:${webhookName}`;
    // Serialize the remote lookup/create for concurrent local retries. Native
    // stores also use a stable selected-channel identity under their owner lock.
    const previous = pendingCreations.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
        const hooks = await channel.fetchWebhooks();
        const existing = [...hooks.values()].find(hook => hook.type === 1 && hook.owner?.id === botId && hook.name === webhookName && hook.url && hook.token);
        const webhook = existing || await channel.createWebhook({ name: webhookName });
        if (!webhook?.url) throw Object.assign(new Error('Discord did not return a usable webhook URL.'), { code: 'WEBHOOK_DESTINATION_CREATE_FAILED' });
        return { webhookUrl: webhook.url, channel, webhook, created: !existing };
    });
    pendingCreations.set(key, operation);
    try { return await operation; }
    finally { if (pendingCreations.get(key) === operation) pendingCreations.delete(key); }
}

module.exports = {
    WEBHOOK_NAME,
    createWebhookForChannel,
    hasManageWebhooks,
    isWebhookChannel,
    resolveGuildChannel,
    verifyChannelForNotification,
};

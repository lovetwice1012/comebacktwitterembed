'use strict';

const { ChannelType, PermissionsBitField } = require('discord.js');

const WEBHOOK_NAME = 'ComebackTwitterEmbed notifications';
const WEBHOOK_CHANNEL_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

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

async function createWebhookForChannel(interaction, channelId, name = WEBHOOK_NAME) {
    const channel = await resolveGuildChannel(interaction, channelId);
    if (!hasManageWebhooks(channel, interaction.member)) {
        throw Object.assign(new Error('You need Manage Webhooks in the selected channel.'), { code: 'WEBHOOK_DESTINATION_USER_PERMISSION' });
    }
    const botMember = interaction.guild?.members?.me || interaction.client?.user;
    if (!hasManageWebhooks(channel, botMember)) {
        throw Object.assign(new Error('The bot needs Manage Webhooks in the selected channel.'), { code: 'WEBHOOK_DESTINATION_BOT_PERMISSION' });
    }
    const webhook = await channel.createWebhook({ name: String(name).slice(0, 80) });
    if (!webhook?.url) throw Object.assign(new Error('Discord did not return a usable webhook URL.'), { code: 'WEBHOOK_DESTINATION_CREATE_FAILED' });
    return { webhookUrl: webhook.url, channel, webhook };
}

module.exports = {
    WEBHOOK_NAME,
    createWebhookForChannel,
    hasManageWebhooks,
    isWebhookChannel,
    resolveGuildChannel,
};

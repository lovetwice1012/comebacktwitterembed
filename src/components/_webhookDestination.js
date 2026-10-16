'use strict';

const { ChannelType, PermissionsBitField } = require('discord.js');
const { createHash } = require('node:crypto');
const { withChannelWebhookOperation } = require('../automation/webhook-registration');

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

async function webhookIsReferenced(query, url) {
    const rows = await query('SELECT id FROM webhook_endpoints WHERE webhook_url_hash=? FOR UPDATE', [createHash('sha256').update(url).digest('hex')]);
    if (!rows.length) return false;
    // Locking reads see committed users of the endpoint, including a direct-URL
    // registration which did not use this channel-creation operation.
    for (const table of ['auto_watch_targets', 'price_watch_targets', 'automation_destinations', 'auto_extract_targets']) {
        if ((await query(`SELECT id FROM ${table} WHERE webhook_endpoint_id=? LIMIT 1 FOR UPDATE`, [rows[0].id])).length) return true;
    }
    return false;
}

async function withWebhookForChannel(interaction, channelId, name, register, options = {}) {
    const db = options.db || require('../db');
    // Creation, reuse, registration and failure cleanup share one cross-process
    // lock. A second request cannot adopt an uncommitted hook and then lose it
    // to its creator's cleanup. Acquire this lock before native owner/source
    // admission locks. Returning from withDatabaseTransaction confirms COMMIT.
    return withChannelWebhookOperation(db, interaction.guildId || interaction.guild?.id, channelId, async query => {
        const created = await createWebhookForChannel(interaction, channelId, name);
        await query('SAVEPOINT native_webhook_registration');
        try { return await register(created); }
        catch (error) {
            // A failed nested native registration may have made partial SQL
            // changes. Undo those before checking other committed references.
            // On rollback/check/COMMIT uncertainty retain the remote hook.
            try {
                await query('ROLLBACK TO SAVEPOINT native_webhook_registration');
                if (created.created && !await webhookIsReferenced(query, created.webhookUrl)) await created.webhook.delete();
            } catch { /* preserve the original failure and keep uncertain hooks */ }
            throw error;
        }
    });
}

module.exports = {
    WEBHOOK_NAME,
    createWebhookForChannel,
    withWebhookForChannel,
    hasManageWebhooks,
    isWebhookChannel,
    resolveGuildChannel,
    verifyChannelForNotification,
};

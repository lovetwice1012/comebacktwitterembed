'use strict';

const { t } = require('../locales');
const { Routes } = require('discord.js');
const { detectProviderIdFromMessage } = require('../settings');
const providerSettings = require('../providers/_provider_settings');

function authoritativeRoleIds(member) {
    if (!member || member.partial === true) return null;
    const ids = Array.isArray(member._roles) ? member._roles : Array.isArray(member.roles) ? member.roles : null;
    return ids && ids.every(id => typeof id === 'string' && /^\d{16,22}$/.test(id)) && new Set(ids).size === ids.length ? ids : null;
}

function checkAborted(signal) { if (signal.aborted) throw new Error('POLICY_DEADLINE'); }

async function resolvePolicy(interaction, options, signal) {
    checkAborted(signal);
    let providerId = options.providerId || detectProviderIdFromMessage(interaction.message);
    const action = String(interaction.customId || '').split(':')[0];
    const guarded = ['delete', 'translate', 'showMediaAsAttachments', 'showAttachmentsAsEmbedsImage'].includes(action);
    if (!providerId && guarded && interaction.message?.id && interaction.channel?.messages?.fetch) {
        try {
            const current = await interaction.channel.messages.fetch({ message: interaction.message.id, force: true, cache: false });
            checkAborted(signal);
            if (current?.author?.id === interaction.client?.user?.id && interaction.client?.user?.id)
                providerId = detectProviderIdFromMessage(current);
        } catch { /* A missing source cannot establish a provider policy. */ }
    }
    if (!providerId && guarded) return false;
    providerId ||= 'twitter';
    const provider = { id: providerId };
    const guildSetting = await providerSettings.getSetting(provider, 'button_disabled', interaction.guildId);
    checkAborted(signal);
    if (guildSetting === undefined || guildSetting === null) return true;

    const users = Array.isArray(guildSetting.user) ? guildSetting.user : [];
    const channels = Array.isArray(guildSetting.channel) ? guildSetting.channel : [];
    const roles = Array.isArray(guildSetting.role) ? guildSetting.role : [];
    const validRolePolicy = (guildSetting.role == null || Array.isArray(guildSetting.role)) && roles.every(id => typeof id === 'string' && /^\d{16,22}$/.test(id));

    let memberRoles = roles.length ? null : [];
    // Both raw interaction roles and GuildMember caches can be stale. A
    // GuildMember also initializes _roles to [] when the REST response omits
    // the field, so a forced SDK fetch alone cannot prove completeness.
    if (roles.length && validRolePolicy && interaction.client?.rest?.get) {
        try {
            const raw = await interaction.client.rest.get(Routes.guildMember(interaction.guildId, interaction.user.id), { signal });
            checkAborted(signal);
            if (String(raw?.user?.id || '') === String(interaction.user.id) && Array.isArray(raw.roles)
                && (raw.guild_id == null || String(raw.guild_id) === String(interaction.guildId))
                && (raw.guild?.id == null || String(raw.guild.id) === String(interaction.guildId)))
                memberRoles = authoritativeRoleIds({ roles: raw.roles });
        } catch { /* Unknown role membership must not bypass restrictions. */ }
    }
    const denied = (
        users.includes(interaction.user.id)
        || channels.includes(interaction.channelId || interaction.channel?.id)
        || !validRolePolicy || roles.length > 0 && (roles.includes(String(interaction.guildId)) || !memberRoles || roles.some(id => memberRoles.includes(id)))
    );
    return !denied;
}

// Modal-opening interactions cannot defer and then call showModal. Bound all
// read-only policy work so denial can be acknowledged before Discord's limit.
async function isAllowed(interaction, options = {}) {
    if (!interaction.guildId) return true;
    const controller = new AbortController(), now = Date.now(), created = Number(interaction.createdTimestamp);
    const acknowledged = interaction.deferred || interaction.replied;
    const remaining = !acknowledged && Number.isFinite(created) && created > 0 ? Math.max(0, created + 2400 - now) : Infinity;
    const timeoutMs = Math.max(1, Math.min(acknowledged ? 10000 : 1200, remaining));
    let timer, timedOut = false, allowed = false;
    try {
        if (!acknowledged && remaining <= 0) timedOut = true;
        else allowed = await Promise.race([resolvePolicy(interaction, options, controller.signal), new Promise(resolve => {
            timer = setTimeout(() => { timedOut = true; controller.abort(); resolve(false); }, timeoutMs);
        })]);
    } catch { allowed = false; }
    finally { clearTimeout(timer); controller.abort(); }
    if (allowed) return true;
    const reply = interaction.deferred || interaction.replied || typeof interaction.reply !== 'function' ? 'editReply' : 'reply';
    const content = timedOut ? (String(interaction.locale || '').startsWith('ja') ? '権限を確認できませんでした。もう一度お試しください。' : 'Could not verify permissions. Please try again.')
        : t('userDonthavePermissionLocales', interaction.locale);
    await interaction[reply]({ content, ephemeral: true });
    if (typeof interaction.deleteReply === 'function') setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 3000).unref?.();
    return false;
}

module.exports = { isAllowed, _internal: { authoritativeRoleIds, resolvePolicy } };

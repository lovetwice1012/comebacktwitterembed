'use strict';

const { t } = require('../locales');
const { detectProviderIdFromMessage } = require('../settings');
const providerSettings = require('../providers/_provider_settings');

// Returns true if the interaction is allowed to proceed; otherwise replies with
// a private denial. Modal-opening actions cannot defer before this check.
async function isAllowed(interaction, options = {}) {
    if (!interaction.guildId) return true;
    const providerId = options.providerId || detectProviderIdFromMessage(interaction.message) || 'twitter';
    const provider = { id: providerId };
    const guildSetting = await providerSettings.getSetting(provider, 'button_disabled', interaction.guildId);
    if (guildSetting === undefined || guildSetting === null) return true;

    const users = Array.isArray(guildSetting.user) ? guildSetting.user : [];
    const channels = Array.isArray(guildSetting.channel) ? guildSetting.channel : [];
    const roles = Array.isArray(guildSetting.role) ? guildSetting.role : [];

    const memberRoles = interaction.member?.roles;
    const hasRole = id => Array.isArray(memberRoles) ? memberRoles.includes(id) : !!memberRoles?.cache?.has?.(id);
    const denied = (
        users.includes(interaction.user.id)
        || channels.includes(interaction.channelId || interaction.channel?.id)
        || roles.length > 0 && (!memberRoles || roles.some(hasRole))
    );
    if (!denied) return true;

    const reply = interaction.deferred || interaction.replied || typeof interaction.reply !== 'function' ? 'editReply' : 'reply';
    await interaction[reply]({ content: t('userDonthavePermissionLocales', interaction.locale), ephemeral: true });
    if (typeof interaction.deleteReply === 'function') setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 3000).unref?.();
    return false;
}

module.exports = { isAllowed };

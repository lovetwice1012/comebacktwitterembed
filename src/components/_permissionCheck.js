'use strict';

const { t } = require('../locales');
const { detectProviderIdFromMessage } = require('../settings');
const { getSetting } = require('../providers/_provider_settings');
const { ifUserHasRole } = require('../utils');

// Returns true if the interaction is allowed to proceed; otherwise replies with
// a "no permission" message and returns false. The caller already deferred the reply.
async function isAllowed(interaction) {
    const providerId = detectProviderIdFromMessage(interaction.message) || 'twitter';
    const provider = { id: providerId };
    const guildSetting = await getSetting(provider, 'button_disabled', interaction.guildId);
    if (guildSetting === undefined || guildSetting === null) return true;

    const users = Array.isArray(guildSetting.user) ? guildSetting.user : [];
    const channels = Array.isArray(guildSetting.channel) ? guildSetting.channel : [];
    const roles = Array.isArray(guildSetting.role) ? guildSetting.role : [];

    const denied = (
        users.includes(interaction.user.id)
        || channels.includes(interaction.channel.id)
        || roles.some(roleId => ifUserHasRole(interaction.member, roleId))
    );
    if (!denied) return true;

    await interaction.editReply({ content: t('userDonthavePermissionLocales', interaction.locale), ephemeral: true });
    setTimeout(() => { interaction.deleteReply(); }, 3000);
    return false;
}

module.exports = { isAllowed };

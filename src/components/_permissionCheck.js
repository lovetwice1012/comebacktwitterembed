'use strict';

const { t } = require('../locales');
const { settings } = require('../settings');
const { ifUserHasRole } = require('../utils');

// Returns true if the interaction is allowed to proceed; otherwise replies with
// a "no permission" message and returns false. The caller already deferred the reply.
async function isAllowed(interaction) {
    const guildSetting = settings.button_disabled[interaction.guildId];
    if (guildSetting === undefined) return true;

    const denied = (
        guildSetting.user.includes(interaction.user.id)
        || guildSetting.channel.includes(interaction.channel.id)
        || guildSetting.role.some(roleId => ifUserHasRole(interaction.member, roleId))
    );
    if (!denied) return true;

    await interaction.editReply({ content: t('userDonthavePermissionLocales', interaction.locale), ephemeral: true });
    setTimeout(() => { interaction.deleteReply(); }, 3000);
    return false;
}

module.exports = { isAllowed };

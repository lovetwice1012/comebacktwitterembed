'use strict';

const { PermissionsBitField } = require('discord.js');
const { t } = require('../../../locales');
const { setSetting } = require('../../../providers/_provider_settings');
const { convertBoolToEnableDisable } = require('../../../utils');
function hasAdminPerm(member) {
    return (
        member.permissions.has(PermissionsBitField.Flags.ManageChannels)
        || member.permissions.has(PermissionsBitField.Flags.ManageGuild)
        || member.permissions.has(PermissionsBitField.Flags.Administrator)
    );
}

module.exports = async function (interaction, client) {
    if (!hasAdminPerm(interaction.member)) {
        return await interaction.editReply(t('userDonthavePermissionLocales', interaction.locale));
    }

    if (interaction.options.getBoolean('boolean') === null) return await interaction.editReply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    const providerId = interaction.options.getSubcommandGroup(false) || interaction.options.getString('provider') || 'twitter';
    const provider = { id: providerId };
    const boolean = interaction.options.getBoolean('boolean');
    await setSetting(provider, 'editOriginalIfTranslate', interaction.guildId, boolean);
    await interaction.editReply((t('seteditoriginaliftranslatetolocales', interaction.locale)) + convertBoolToEnableDisable(boolean, interaction.locale));

};

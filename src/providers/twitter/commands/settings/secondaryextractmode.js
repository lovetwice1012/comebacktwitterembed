'use strict';

const { PermissionsBitField } = require('discord.js');
const { t } = require('../../../../locales');
const { settings } = require('../../../../settings');
const { setSetting } = require('../../../../providers/_provider_settings');
const { convertBoolToEnableDisable } = require('../../../../utils');
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

    if (settings.legacy_mode[interaction.guildId] === true) settings.legacy_mode[interaction.guildId] = false; 
    if (interaction.options.getBoolean('boolean') === null) return await interaction.editReply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    const boolean = interaction.options.getBoolean('boolean');
    setSetting({ id: 'twitter' }, 'secondary_extract_mode', interaction.guildId, boolean);
    if (boolean === true) setSetting({ id: 'twitter' }, 'legacy_mode', interaction.guildId, false);
    settings.secondary_extract_mode[interaction.guildId] = boolean;
    await interaction.editReply((t('setsecondaryextractmodetolocales', interaction.locale)) + convertBoolToEnableDisable(boolean, interaction.locale));

};

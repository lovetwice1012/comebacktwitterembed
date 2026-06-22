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
        return await interaction.reply(t('userDonthavePermissionLocales', interaction.locale));
    }

    if (interaction.options.getBoolean('boolean') === null) return await interaction.reply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    const boolean = interaction.options.getBoolean('boolean');
    setSetting({ id: 'twitter' }, 'alwaysreplyifpostedtweetlink', interaction.guildId, boolean);
    settings.alwaysreplyifpostedtweetlink[interaction.guildId] = boolean;
    await interaction.reply((t('setalwaysreplyifpostedtweetlinktolocales', interaction.locale)) + convertBoolToEnableDisable(boolean, interaction.locale));

};

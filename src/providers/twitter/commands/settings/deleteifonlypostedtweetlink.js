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

    if (interaction.options.getBoolean('boolean') === null) return await interaction.editReply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    const boolean = interaction.options.getBoolean('boolean');
    setSetting({ id: 'twitter' }, 'deletemessageifonlypostedtweetlink', interaction.guildId, boolean);
    settings.deletemessageifonlypostedtweetlink[interaction.guildId] = boolean;
    await interaction.editReply((t('setdeleteifonlypostedtweetlinktolocales', interaction.locale)) + convertBoolToEnableDisable(boolean, interaction.locale));
    if (interaction.options.getBoolean('secoundaryextractmode') !== null) {
        const sec = interaction.options.getBoolean('secoundaryextractmode');
        setSetting({ id: 'twitter' }, 'deletemessageifonlypostedtweetlink_secoundaryextractmode', interaction.guild.id, sec);
        settings.deletemessageifonlypostedtweetlink_secoundaryextractmode[interaction.guild.id] = sec;
        await interaction.followUp((t('setdoitwhensecoundaryextractmodeisenabledtolocales', interaction.locale)) + convertBoolToEnableDisable(sec, interaction.locale));
    }

};

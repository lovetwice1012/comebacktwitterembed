'use strict';

const { PermissionsBitField } = require('discord.js');
const { t } = require('../../../../locales');
const { setSetting } = require('../../../../providers/_provider_settings');
const { convertBoolToEnableDisable } = require('../../../../utils');
function hasAdminPerm(member) {
    return (
        member.permissions.has(PermissionsBitField.Flags.ManageChannels)
        || member.permissions.has(PermissionsBitField.Flags.ManageGuild)
        || member.permissions.has(PermissionsBitField.Flags.Administrator)
    );
}

function providerFromInteraction(interaction) {
    return { id: interaction.options.getSubcommandGroup(false) || interaction.options.getString('provider') || 'twitter' };
}

module.exports = async function (interaction, client) {
    if (!hasAdminPerm(interaction.member)) {
        return await interaction.editReply(t('userDonthavePermissionLocales', interaction.locale));
    }

    if (interaction.options.getBoolean('boolean') === null) return await interaction.editReply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    const boolean = interaction.options.getBoolean('boolean');
    await setSetting(providerFromInteraction(interaction), 'anonymous_expand', interaction.guildId, boolean);
    await interaction.editReply((t('setanonymousexpandtolocales', interaction.locale)) + convertBoolToEnableDisable(boolean, interaction.locale));

};

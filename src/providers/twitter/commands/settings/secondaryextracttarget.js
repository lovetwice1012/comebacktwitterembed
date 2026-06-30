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

module.exports = async function (interaction, client) {
    if (!hasAdminPerm(interaction.member)) {
        return await interaction.editReply(t('userDonthavePermissionLocales', interaction.locale));
    }

    if (interaction.options.getBoolean('multipleimages') === null && interaction.options.getBoolean('video') === null) {
        return await interaction.editReply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    }
    const provider = { id: 'twitter' };

    const response = [];
    if (interaction.options.getBoolean('multipleimages') !== null) {
        const multipleImages = interaction.options.getBoolean('multipleimages');
        await setSetting(provider, 'secondary_extract_mode_multiple_images', interaction.guildId, multipleImages);
        response.push((t('setsecondaryextracttargetmultipleimagestolocales', interaction.locale)) + convertBoolToEnableDisable(multipleImages, interaction.locale));
    }
    if (interaction.options.getBoolean('video') !== null) {
        const video = interaction.options.getBoolean('video');
        await setSetting(provider, 'secondary_extract_mode_video', interaction.guildId, video);
        response.push((t('setsecondaryextracttargetvideotolocales', interaction.locale)) + convertBoolToEnableDisable(video, interaction.locale));
    }
    await interaction.editReply(response.join('\n'));

};

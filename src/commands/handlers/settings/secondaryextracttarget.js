'use strict';

const fs = require('fs');
const path = require('path');
const { ButtonBuilder, ButtonStyle, ComponentType, ApplicationCommandOptionType, PermissionsBitField, EmbedBuilder, ActionRowBuilder } = require('discord.js');
const { t, getStringFromObject, messageLocales, descriptionLocales, commandNameLocales } = require('../../../locales');
const { settings, saveSettings, checkComponentIncludesDisabledButtonAndIfFindDeleteIt } = require('../../../settings');
const { connection, queryDatabase, ensureUserExistsInDatabase } = require('../../../db');
const {
    button_disabled_template,
    button_invisible_template,
    antiDirectoryTraversalAttack,
    ifUserHasRole,
    convertBoolToEnableDisable,
    conv_en_to_en_US,
} = require('../../../utils');

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


    if (interaction.options.getBoolean('multipleimages') === null && interaction.options.getBoolean('video') === null) {
        return await interaction.reply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    }
    if (settings.secondary_extract_mode_multiple_images[interaction.guildId] === undefined) settings.secondary_extract_mode_multiple_images[interaction.guildId] = true;
    if (settings.secondary_extract_mode_video[interaction.guildId] === undefined) settings.secondary_extract_mode_video[interaction.guildId] = true;

    const response = [];
    if (interaction.options.getBoolean('multipleimages') !== null) {
        const multipleImages = interaction.options.getBoolean('multipleimages');
        settings.secondary_extract_mode_multiple_images[interaction.guildId] = multipleImages;
        response.push((t('setsecondaryextracttargetmultipleimagestolocales', interaction.locale)) + convertBoolToEnableDisable(multipleImages, interaction.locale));
    }
    if (interaction.options.getBoolean('video') !== null) {
        const video = interaction.options.getBoolean('video');
        settings.secondary_extract_mode_video[interaction.guildId] = video;
        response.push((t('setsecondaryextracttargetvideotolocales', interaction.locale)) + convertBoolToEnableDisable(video, interaction.locale));
    }
    await interaction.reply(response.join('\n'));

};

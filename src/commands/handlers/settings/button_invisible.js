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


    if (settings.button_invisible[interaction.guildId] === undefined) settings.button_invisible[interaction.guildId] = button_invisible_template;
    if (settings.button_invisible[interaction.guildId].savetweet === undefined) settings.button_invisible[interaction.guildId].savetweet = false;
    //options: showMediaAsAttachments, showAttachmentsAsEmbedsImage, translate, delete, all;  all boolean
    if (interaction.options.getBoolean('showmediaasattachments') === null && interaction.options.getBoolean('showattachmentsasembedsimage') === null && interaction.options.getBoolean('translate') === null && interaction.options.getBoolean('delete') === null && interaction.options.getBoolean('savetweet') === null && interaction.options.getBoolean('all') === null) {
        return await interaction.reply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    }
    if (interaction.options.getBoolean('all') !== null) {
        if (interaction.options.getBoolean('all') === true) {
            settings.button_invisible[interaction.guildId].showMediaAsAttachments = true;
            settings.button_invisible[interaction.guildId].showAttachmentsAsEmbedsImage = true;
            settings.button_invisible[interaction.guildId].translate = true;
            settings.button_invisible[interaction.guildId].delete = true;
            settings.button_invisible[interaction.guildId].savetweet = true;
            await interaction.reply(t('addedAllButtonLocales', interaction.locale));
        } else {
            settings.button_invisible[interaction.guildId].showMediaAsAttachments = false;
            settings.button_invisible[interaction.guildId].showAttachmentsAsEmbedsImage = false;
            settings.button_invisible[interaction.guildId].translate = false;
            settings.button_invisible[interaction.guildId].delete = false;
            settings.button_invisible[interaction.guildId].savetweet = false;
            await interaction.reply(t('removedAllButtonLocales', interaction.locale));
        }
    } else {
        if (interaction.options.getBoolean('showmediaasattachments') !== null) {
            settings.button_invisible[interaction.guildId].showMediaAsAttachments = interaction.options.getBoolean('showmediaasattachments');
            await interaction.reply((t('setshowmediaasattachmentsbuttonLocales', interaction.locale)) + convertBoolToEnableDisable(!interaction.options.getBoolean('showmediaasattachments'), interaction.locale));
        }
        if (interaction.options.getBoolean('showattachmentsasembedsimage') !== null) {
            settings.button_invisible[interaction.guildId].showAttachmentsAsEmbedsImage = interaction.options.getBoolean('showattachmentsasembedsimage');
            await interaction.reply((t('setshowattachmentsasembedsimagebuttonLocales', interaction.locale)) + convertBoolToEnableDisable(!interaction.options.getBoolean('showattachmentsasembedsimage'), interaction.locale));
        }
        if (interaction.options.getBoolean('translate') !== null) {
            settings.button_invisible[interaction.guildId].translate = interaction.options.getBoolean('translate');
            await interaction.reply((t('settranslatebuttonLocales', interaction.locale)) + convertBoolToEnableDisable(!interaction.options.getBoolean('translate'), interaction.locale));
        }
        if (interaction.options.getBoolean('delete') !== null) {
            settings.button_invisible[interaction.guildId].delete = interaction.options.getBoolean('delete');
            await interaction.reply((t('setdeletebuttonLocales', interaction.locale)) + convertBoolToEnableDisable(!interaction.options.getBoolean('delete'), interaction.locale));
        }
        if (interaction.options.getBoolean('savetweet') !== null) {
            settings.button_invisible[interaction.guildId].savetweet = interaction.options.getBoolean('savetweet');
            await interaction.reply((t('setsavetweetbuttonLocales', interaction.locale)) + convertBoolToEnableDisable(!interaction.options.getBoolean('savetweet'), interaction.locale));
        }
    }

};

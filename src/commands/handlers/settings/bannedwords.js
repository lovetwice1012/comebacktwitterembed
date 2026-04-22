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


    if (interaction.options.getString('word') === null) return await interaction.reply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        return await interaction.reply(t('iDonthavePermissionToManageMessagesLocales', interaction.locale));
    }
    const word = interaction.options.getString('word');
    if (settings.bannedWords[interaction.guildId] === undefined) {
        settings.bannedWords[interaction.guildId] = [];
    }
    if (settings.bannedWords[interaction.guildId].includes(word)) {
        settings.bannedWords[interaction.guildId].splice(settings.bannedWords[interaction.guildId].indexOf(word), 1);
        await interaction.reply(t('removedWordFromBannedWordsLocales', interaction.locale));
    } else {
        settings.bannedWords[interaction.guildId].push(word);
        await interaction.reply(t('addedWordToBannedWordsLocales', interaction.locale));
    }

};

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


    if (interaction.options.getUser('user') === null && interaction.options.getChannel('channel') === null && interaction.options.getRole('role') === null) {
        return await interaction.reply(t('userMustSpecifyAUserOrChannelLocales', interaction.locale));
    }

    if ((interaction.options.getUser('user') !== null && interaction.options.getChannel('channel') !== null && interaction.options.getRole('role') !== null) || (interaction.options.getUser('user') !== null && interaction.options.getChannel('channel') !== null) || (interaction.options.getUser('user') !== null && interaction.options.getRole('role') !== null) || (interaction.options.getChannel('channel') !== null && interaction.options.getRole('role') !== null)) {
        return await interaction.reply(t('userCantSpecifyBothAUserAndAChannelLocales', interaction.locale));
    }
    if (settings.button_disabled[interaction.guildId] === undefined) settings.button_disabled[interaction.guildId] = button_disabled_template;
    if (interaction.options.getUser('user') !== null) {
        const user = interaction.options.getUser('user');
        if (settings.button_disabled[interaction.guildId].user.includes(user.id)) {
            settings.button_disabled[interaction.guildId].user.splice(settings.button_disabled[interaction.guildId].user.indexOf(user.id), 1);
            await interaction.reply(t('removedUserFromDisableUserLocales', interaction.locale));
        } else {
            settings.button_disabled[interaction.guildId].user.push(user.id);
            await interaction.reply(t('addedUserToDisableUserLocales', interaction.locale));
        }
    } else if (interaction.options.getChannel('channel') !== null) {
        const channel = interaction.options.getChannel('channel');
        if (settings.button_disabled[interaction.guildId].channel.includes(channel.id)) {
            settings.button_disabled[interaction.guildId].channel.splice(settings.button_disabled[interaction.guildId].channel.indexOf(channel.id), 1);
            await interaction.reply(t('removedChannelFromDisableChannelLocales', interaction.locale));
        } else {
            settings.button_disabled[interaction.guildId].channel.push(channel.id);
            await interaction.reply(t('addedChannelToDisableChannelLocales', interaction.locale));
        }
    } else if (interaction.options.getRole('role') !== null) {
        const role = interaction.options.getRole('role');
        if (settings.button_disabled[interaction.guildId].role.includes(role.id)) {
            settings.button_disabled[interaction.guildId].role.splice(settings.button_disabled[interaction.guildId].role.indexOf(role.id), 1);
            await interaction.reply(t('removedRoleFromDisableRoleLocales', interaction.locale));
        } else {
            settings.button_disabled[interaction.guildId].role.push(role.id);
            await interaction.reply(t('addedRoleToDisableRoleLocales', interaction.locale));
        }
    }

};

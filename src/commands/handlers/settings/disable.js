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
        if (interaction.options.getUser('user') === null && interaction.options.getChannel('channel') === null && interaction.options.getRole('role') === null) {
                            return await interaction.reply(t('userMustSpecifyAUserOrChannelLocales', interaction.locale));
                        }
                        if ((interaction.options.getUser('user') !== null && interaction.options.getChannel('channel') !== null && interaction.options.getRole('role') !== null) || (interaction.options.getUser('user') !== null && interaction.options.getChannel('channel') !== null) || (interaction.options.getUser('user') !== null && interaction.options.getRole('role') !== null) || (interaction.options.getChannel('channel') !== null && interaction.options.getRole('role') !== null)) {
                            return await interaction.reply(t('userCantSpecifyBothAUserAndAChannelLocales', interaction.locale));
                        }
                        if (interaction.options.getUser('user') !== null) {
                            const user = interaction.options.getUser('user');
                            if (user.id !== interaction.user.id) return await interaction.reply(t('userCantUseThisCommandForOtherUsersLocales', interaction.locale));
                            if (settings.disable.user.includes(user.id)) {
                                settings.disable.user.splice(settings.disable.user.indexOf(user.id), 1);
                                await interaction.reply(t('removedUserFromDisableUserLocales', interaction.locale));
                            } else {
                                settings.disable.user.push(user.id);
                                await interaction.reply(t('addedUserToDisableUserLocales', interaction.locale));
                            }
                        } else if (interaction.options.getChannel('channel') !== null || interaction.options.getRole('role') !== null) {
                            return await interaction.reply(t('userDonthavePermissionLocales', interaction.locale));
                        }

        return;
    }


    if (interaction.options.getUser('user') === null && interaction.options.getChannel('channel') === null && interaction.options.getRole('role') === null) {
        return await interaction.reply(t('userMustSpecifyAUserOrChannelLocales', interaction.locale));
    }

    if ((interaction.options.getUser('user') !== null && interaction.options.getChannel('channel') !== null && interaction.options.getRole('role') !== null) || (interaction.options.getUser('user') !== null && interaction.options.getChannel('channel') !== null) || (interaction.options.getUser('user') !== null && interaction.options.getRole('role') !== null) || (interaction.options.getChannel('channel') !== null && interaction.options.getRole('role') !== null)) {
        return await interaction.reply(t('userCantSpecifyBothAUserAndAChannelLocales', interaction.locale));
    }

    if (interaction.options.getUser('user') !== null) {
        const user = interaction.options.getUser('user');
        if (settings.disable.user.includes(user.id)) {
            settings.disable.user.splice(settings.disable.user.indexOf(user.id), 1);
            await interaction.reply(t('removedUserFromDisableUserLocales', interaction.locale));
        } else {
            settings.disable.user.push(user.id);
            await interaction.reply(t('addedUserToDisableUserLocales', interaction.locale));
        }
    } else if (interaction.options.getChannel('channel') !== null) {
        const channel = interaction.options.getChannel('channel');
        if (settings.disable.channel.includes(channel.id)) {
            settings.disable.channel.splice(settings.disable.channel.indexOf(channel.id), 1);
            await interaction.reply(t('removedChannelFromDisableChannelLocales', interaction.locale));
        } else {
            settings.disable.channel.push(channel.id);
            await interaction.reply(t('addedChannelToDisableChannelLocales', interaction.locale));
        }
    } else if (interaction.options.getRole('role') !== null) {
        const role = interaction.options.getRole('role');
        if (settings.disable.role[interaction.guildId] === undefined) {
            settings.disable.role[interaction.guildId] = [];
        }
        if (settings.disable.role[interaction.guildId].includes(role.id)) {
            settings.disable.role[interaction.guildId].splice(settings.disable.role[interaction.guildId].indexOf(role.id), 1);
            await interaction.reply(t('removedRoleFromDisableRoleLocales', interaction.locale));
        } else {
            settings.disable.role[interaction.guildId].push(role.id);
            await interaction.reply(t('addedRoleToDisableRoleLocales', interaction.locale));
        }
    }

};

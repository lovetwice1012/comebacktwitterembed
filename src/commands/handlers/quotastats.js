'use strict';

const fs = require('fs');
const path = require('path');
const { ButtonBuilder, ButtonStyle, ComponentType, ApplicationCommandOptionType, PermissionsBitField, EmbedBuilder, ActionRowBuilder } = require('discord.js');
const { t, getStringFromObject, messageLocales, descriptionLocales, commandNameLocales } = require('../../locales');
const { settings, saveSettings, checkComponentIncludesDisabledButtonAndIfFindDeleteIt } = require('../../settings');
const { connection, queryDatabase, ensureUserExistsInDatabase } = require('../../db');
const {
    button_disabled_template,
    button_invisible_template,
    antiDirectoryTraversalAttack,
    ifUserHasRole,
    convertBoolToEnableDisable,
    conv_en_to_en_US,
} = require('../../utils');

module.exports.execute = async function (interaction, client) {

    let user = interaction.options.getUser('user');
    if (user === null) user = interaction.user;
    const userid = user.id;
    let quota = 100 * 1024 * 1024;
    if (settings.save_tweet_quota_override[userid] !== undefined) quota = settings.save_tweet_quota_override[userid];
    const dirs = fs.readdirSync('./saves/' + userid);
    let used = 0;
    for (let i = 0; i < dirs.length; i++) {
        const element = dirs[i];
        const dir2 = fs.readdirSync('./saves/' + userid + '/' + element);
        for (let j = 0; j < dir2.length; j++) {
            const element2 = dir2[j];
            const stats = fs.statSync('./saves/' + userid + '/' + element + '/' + element2);
            used += stats.size;
        }
    }
    used = used / 1024 / 1024;
    quota = quota / 1024 / 1024;
    if (used >= 1024) used = (used / 1024).toFixed(2) + 'GB';
    else used = used.toFixed(2) + 'MB';
    if (quota >= 1024) quota = (quota / 1024).toFixed(2) + 'GB';
    else quota = quota.toFixed(2) + 'MB';
    await interaction.reply({
        embeds: [
            {
                title: 'Quota stats',
                color: 0x1DA1F2,
                fields: [
                    {
                        name: 'Used',
                        value: used.toString()
                    },
                    {
                        name: 'Quota',
                        value: quota.toString()
                    }
                ]
            }
        ]
    });

};


module.exports.definition = {
        name: 'quotastats',
        name_localizations: conv_en_to_en_US(messageLocales.quotastatsCommandNameLocales),
        description: 'quota stats',
        description_localizations: conv_en_to_en_US(descriptionLocales.settingsSaveTweetQuotaOverride),
        options: [
            {
                name: 'user',
                name_localizations: conv_en_to_en_US(commandNameLocales.user),
                description: 'user',
                description_localizations: conv_en_to_en_US(descriptionLocales.settingsDisableUser),
                type: ApplicationCommandOptionType.User,
                required: false
            }
        ]
    };

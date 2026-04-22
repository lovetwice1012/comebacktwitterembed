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

    if (interaction.user.id === '796972193287503913') {
        if (interaction.options.getInteger('newquota') === null) return await interaction.reply(t('userMustSpecifyAnyWordLocales', interaction.locale));
        const quota = interaction.options.getInteger('newquota');
        let user = interaction.options.getUser('user');
        if (user === null) user = interaction.user;
        const userid = user.id;
        settings.save_tweet_quota_override[userid] = quota;
        await interaction.reply((t('setsavetweetquotaoverridetolocales', interaction.locale)) + quota.toString());
    } else {
        await interaction.reply(t('userDonthavePermissionLocales', interaction.locale));
    }
    fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));

};


module.exports.definition = {
        name: 'savetweetquotaoverride',
        name_localizations: conv_en_to_en_US(commandNameLocales.save_tweet_quota_override),
        description: 'save tweet quota override',
        description_localizations: conv_en_to_en_US(descriptionLocales.settingsSaveTweetQuotaOverride),
        options: [
            {
                name: 'newquota',
                name_localizations: conv_en_to_en_US(commandNameLocales.quota),
                description: 'new quota',
                type: ApplicationCommandOptionType.Integer,
                required: true
            },
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

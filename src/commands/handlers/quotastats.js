'use strict';

const fs = require('fs');
const path = require('path');
const { ApplicationCommandOptionType } = require('discord.js');
const { messageLocales, descriptionLocales, commandNameLocales } = require('../../locales');
const { settings } = require('../../settings');
const { conv_en_to_en_US } = require('../../utils');

function getSavedTweetUsageBytes(userId) {
    const userDir = path.join('.', 'saves', userId);
    if (!fs.existsSync(userDir)) return 0;

    let used = 0;
    const dirs = fs.readdirSync(userDir, { withFileTypes: true });
    for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const tweetDir = path.join(userDir, dir.name);
        const files = fs.readdirSync(tweetDir, { withFileTypes: true });
        for (const file of files) {
            if (!file.isFile()) continue;
            used += fs.statSync(path.join(tweetDir, file.name)).size;
        }
    }
    return used;
}

module.exports.execute = async function (interaction, client) {

    let user = interaction.options.getUser('user');
    if (user === null) user = interaction.user;
    const userid = user.id;
    let quota = 100 * 1024 * 1024;
    if (settings.save_tweet_quota_override[userid] !== undefined) quota = settings.save_tweet_quota_override[userid];
    let used = getSavedTweetUsageBytes(userid);
    used = used / 1024 / 1024;
    quota = quota / 1024 / 1024;
    const usedDisplay = used >= 1024 ? (used / 1024).toFixed(2) + 'GB' : used.toFixed(2) + 'MB';
    const quotaDisplay = quota >= 1024 ? (quota / 1024).toFixed(2) + 'GB' : quota.toFixed(2) + 'MB';
    await interaction.reply({
        embeds: [
            {
                title: 'Quota stats',
                color: 0x1DA1F2,
                fields: [
                    {
                        name: 'Used',
                        value: usedDisplay
                    },
                    {
                        name: 'Quota',
                        value: quotaDisplay
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

module.exports._internal = { getSavedTweetUsageBytes };

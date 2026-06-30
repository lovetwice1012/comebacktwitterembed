'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { ApplicationCommandOptionType } = require('discord.js');
const { messageLocales, descriptionLocales, commandNameLocales } = require('../../locales');
const { conv_en_to_en_US } = require('../../utils');
const { getSaveTweetQuotaOverride } = require('../../providers/_provider_settings');

async function getSavedTweetUsageBytes(userId) {
    const userDir = path.join('.', 'saves', userId);
    if (!fs.existsSync(userDir)) return 0;

    let used = 0;
    const dirs = await fsp.readdir(userDir, { withFileTypes: true });
    for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const tweetDir = path.join(userDir, dir.name);
        const files = await fsp.readdir(tweetDir, { withFileTypes: true });
        for (const file of files) {
            if (!file.isFile()) continue;
            used += (await fsp.stat(path.join(tweetDir, file.name))).size;
        }
    }
    return used;
}

module.exports.execute = async function (interaction, client) {

    let user = interaction.options.getUser('user');
    if (user === null) user = interaction.user;
    const userid = user.id;
    let quota = 100 * 1024 * 1024;
    quota = await getSaveTweetQuotaOverride(userid) ?? quota;
    let used = await getSavedTweetUsageBytes(userid);
    used = used / 1024 / 1024;
    quota = quota / 1024 / 1024;
    const usedDisplay = used >= 1024 ? (used / 1024).toFixed(2) + 'GB' : used.toFixed(2) + 'MB';
    const quotaDisplay = quota >= 1024 ? (quota / 1024).toFixed(2) + 'GB' : quota.toFixed(2) + 'MB';
    await interaction.editReply({
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

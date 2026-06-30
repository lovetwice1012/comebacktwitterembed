'use strict';

const { ApplicationCommandOptionType } = require('discord.js');
const { t, descriptionLocales, commandNameLocales } = require('../../../locales');
const { conv_en_to_en_US } = require('../../../utils');
const { setSaveTweetQuotaOverride } = require('../../_provider_settings');
module.exports.execute = async function (interaction, client) {

    if (interaction.user.id === '796972193287503913') {
        if (interaction.options.getInteger('newquota') === null) return await interaction.editReply(t('userMustSpecifyAnyWordLocales', interaction.locale));
        const quota = interaction.options.getInteger('newquota');
        let user = interaction.options.getUser('user');
        if (user === null) user = interaction.user;
        const userid = user.id;
        await setSaveTweetQuotaOverride(userid, quota);
        await interaction.editReply((t('setsavetweetquotaoverridetolocales', interaction.locale)) + quota.toString());
    } else {
        await interaction.editReply(t('userDonthavePermissionLocales', interaction.locale));
    }

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

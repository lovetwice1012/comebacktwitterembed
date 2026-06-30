'use strict';

const { PermissionsBitField } = require('discord.js');
const { t } = require('../../../locales');
const { loadProviders } = require('../../../providers/_loader');
const { setSetting } = require('../../../providers/_provider_settings');

const ALL_PROVIDERS_ID = 'all';

function hasAdminPerm(member) {
    return (
        member.permissions.has(PermissionsBitField.Flags.ManageChannels)
        || member.permissions.has(PermissionsBitField.Flags.ManageGuild)
        || member.permissions.has(PermissionsBitField.Flags.Administrator)
    );
}

module.exports = async function (interaction, client) {
    if (!hasAdminPerm(interaction.member)) {
        return await interaction.editReply(t('userDonthavePermissionLocales', interaction.locale));
    }

    if (interaction.options.getString('language') === null) return await interaction.editReply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    const providerId = interaction.options.getSubcommandGroup(false) || interaction.options.getString('provider') || 'twitter';
    const language = interaction.options.getString('language');
    if (language === 'en' || language === 'ja') {
        const providers = providerId === ALL_PROVIDERS_ID ? loadProviders() : [{ id: providerId }];
        for (const provider of providers) {
            await setSetting(provider, 'defaultLanguage', interaction.guildId, language);
        }
        const prefix = providerId === ALL_PROVIDERS_ID ? 'All providers: ' : '';
        await interaction.editReply(prefix + (t('setdefaultlanguagetolocales', interaction.locale)) + language.toString());
    } else {
        await interaction.editReply('You must specify either en or ja.');
    }

};

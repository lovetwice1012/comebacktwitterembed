'use strict';

const { PermissionsBitField } = require('discord.js');
const { t } = require('../../../locales');
const { settings } = require('../../../settings');
const { setSetting } = require('../../../providers/_provider_settings');

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
    const provider = { id: providerId };
    const language = interaction.options.getString('language');
    if (language === 'en' || language === 'ja') {
        setSetting(provider, 'defaultLanguage', interaction.guildId, language);
        if (providerId === 'twitter') settings.defaultLanguage[interaction.guildId] = language;
        await interaction.editReply((t('setdefaultlanguagetolocales', interaction.locale)) + language.toString());
    } else {
        await interaction.editReply('You must specify either en or ja.');
    }

};

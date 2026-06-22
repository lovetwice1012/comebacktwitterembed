'use strict';

const { PermissionsBitField } = require('discord.js');
const { t } = require('../../../../locales');
const { settings } = require('../../../../settings');
const { getSetting, setSetting } = require('../../../../providers/_provider_settings');

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
    const provider = { id: 'twitter' };
    const list = getSetting(provider, 'bannedWords', interaction.guildId);
    const bannedWords = Array.isArray(list) ? list : [];

    if (bannedWords.includes(word)) {
        bannedWords.splice(bannedWords.indexOf(word), 1);
        await interaction.reply(t('removedWordFromBannedWordsLocales', interaction.locale));
    } else {
        bannedWords.push(word);
        await interaction.reply(t('addedWordToBannedWordsLocales', interaction.locale));
    }

    setSetting(provider, 'bannedWords', interaction.guildId, bannedWords);
    settings.bannedWords[interaction.guildId] = bannedWords;

};

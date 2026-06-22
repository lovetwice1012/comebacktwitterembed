'use strict';

const { PermissionsBitField } = require('discord.js');
const { t } = require('../../../../locales');
const { settings } = require('../../../../settings');
const { setSetting } = require('../../../../providers/_provider_settings');

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

    const depth = interaction.options.getInteger('depth');
    if (depth === null) return await interaction.reply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    setSetting({ id: 'twitter' }, 'quote_repost_max_depth', interaction.guildId, depth);
    settings.quote_repost_max_depth[interaction.guildId] = depth;
    const depthText = depth === 0 ? (interaction.locale === 'ja' ? '無制限' : 'unlimited') : depth.toString();
    await interaction.reply((t('setquoterepostmaxdepthtolocales', interaction.locale)) + depthText);

};

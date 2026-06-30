'use strict';

const { PermissionsBitField } = require('discord.js');
const { t } = require('../../../locales');
const { setSetting, getSetting } = require('../../../providers/_provider_settings');
const { button_disabled_template } = require('../../../utils');
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

    if (interaction.options.getUser('user') === null && interaction.options.getChannel('channel') === null && interaction.options.getRole('role') === null) {
        return await interaction.editReply(t('userMustSpecifyAUserOrChannelLocales', interaction.locale));
    }

    if ((interaction.options.getUser('user') !== null && interaction.options.getChannel('channel') !== null && interaction.options.getRole('role') !== null) || (interaction.options.getUser('user') !== null && interaction.options.getChannel('channel') !== null) || (interaction.options.getUser('user') !== null && interaction.options.getRole('role') !== null) || (interaction.options.getChannel('channel') !== null && interaction.options.getRole('role') !== null)) {
        return await interaction.editReply(t('userCantSpecifyBothAUserAndAChannelLocales', interaction.locale));
    }
    const providerId = interaction.options.getSubcommandGroup(false) || interaction.options.getString('provider') || 'twitter';
    const provider = { id: providerId };
    let guildSetting = await getSetting(provider, 'button_disabled', interaction.guildId);
    if (!guildSetting || typeof guildSetting !== 'object') guildSetting = { ...button_disabled_template, user: [], channel: [], role: [] };
    if (!Array.isArray(guildSetting.user)) guildSetting.user = [];
    if (!Array.isArray(guildSetting.channel)) guildSetting.channel = [];
    if (!Array.isArray(guildSetting.role)) guildSetting.role = [];

    if (interaction.options.getUser('user') !== null) {
        const user = interaction.options.getUser('user');
        if (guildSetting.user.includes(user.id)) {
            guildSetting.user.splice(guildSetting.user.indexOf(user.id), 1);
            await interaction.editReply(t('removedUserFromDisableUserLocales', interaction.locale));
        } else {
            guildSetting.user.push(user.id);
            await interaction.editReply(t('addedUserToDisableUserLocales', interaction.locale));
        }
    } else if (interaction.options.getChannel('channel') !== null) {
        const channel = interaction.options.getChannel('channel');
        if (guildSetting.channel.includes(channel.id)) {
            guildSetting.channel.splice(guildSetting.channel.indexOf(channel.id), 1);
            await interaction.editReply(t('removedChannelFromDisableChannelLocales', interaction.locale));
        } else {
            guildSetting.channel.push(channel.id);
            await interaction.editReply(t('addedChannelToDisableChannelLocales', interaction.locale));
        }
    } else if (interaction.options.getRole('role') !== null) {
        const role = interaction.options.getRole('role');
        if (guildSetting.role.includes(role.id)) {
            guildSetting.role.splice(guildSetting.role.indexOf(role.id), 1);
            await interaction.editReply(t('removedRoleFromDisableRoleLocales', interaction.locale));
        } else {
            guildSetting.role.push(role.id);
            await interaction.editReply(t('addedRoleToDisableRoleLocales', interaction.locale));
        }
    }

    await setSetting(provider, 'button_disabled', interaction.guildId, guildSetting);

};

'use strict';

const { PermissionsBitField } = require('discord.js');
const { t } = require('../../../locales');
const { settings } = require('../../../settings');
const { getSetting, setSetting } = require('../../../providers/_provider_settings');

function hasAdminPerm(member) {
    return (
        member.permissions.has(PermissionsBitField.Flags.ManageChannels)
        || member.permissions.has(PermissionsBitField.Flags.ManageGuild)
        || member.permissions.has(PermissionsBitField.Flags.Administrator)
    );
}

function normalizeDisableSetting(raw, guildId, providerId) {
    let out = raw;
    if (!out || typeof out !== 'object') {
        if (providerId === 'twitter') {
            out = {
                user: Array.isArray(settings.disable.user) ? [...settings.disable.user] : [],
                channel: Array.isArray(settings.disable.channel) ? [...settings.disable.channel] : [],
                role: Array.isArray(settings.disable.role[guildId]) ? [...settings.disable.role[guildId]] : [],
            };
        } else {
            out = { user: [], channel: [], role: [] };
        }
    }
    if (!Array.isArray(out.user)) out.user = [];
    if (!Array.isArray(out.channel)) out.channel = [];
    if (!Array.isArray(out.role)) out.role = [];
    return out;
}

function syncTwitterLegacyDisable(guildId, providerId, guildSetting) {
    if (providerId !== 'twitter') return;
    settings.disable.user = [...guildSetting.user];
    settings.disable.channel = [...guildSetting.channel];
    settings.disable.role[guildId] = [...guildSetting.role];
}

function hasAnyTarget(interaction) {
    return interaction.options.getUser('user') !== null
        || interaction.options.getChannel('channel') !== null
        || interaction.options.getRole('role') !== null;
}

function hasMultipleTargets(interaction) {
    const count = [
        interaction.options.getUser('user'),
        interaction.options.getChannel('channel'),
        interaction.options.getRole('role'),
    ].filter(v => v !== null).length;
    return count > 1;
}

module.exports = async function (interaction, client) {
    const providerId = interaction.options.getSubcommandGroup(false) || interaction.options.getString('provider') || 'twitter';
    const provider = { id: providerId };
    let guildSetting = normalizeDisableSetting(getSetting(provider, 'disable', interaction.guildId), interaction.guildId, providerId);

    if (!hasAdminPerm(interaction.member)) {
        if (!hasAnyTarget(interaction)) return await interaction.reply(t('userMustSpecifyAUserOrChannelLocales', interaction.locale));
        if (hasMultipleTargets(interaction)) return await interaction.reply(t('userCantSpecifyBothAUserAndAChannelLocales', interaction.locale));

        if (interaction.options.getUser('user') !== null) {
            const user = interaction.options.getUser('user');
            if (user.id !== interaction.user.id) return await interaction.reply(t('userCantUseThisCommandForOtherUsersLocales', interaction.locale));
            if (guildSetting.user.includes(user.id)) {
                guildSetting.user.splice(guildSetting.user.indexOf(user.id), 1);
                await interaction.reply(t('removedUserFromDisableUserLocales', interaction.locale));
            } else {
                guildSetting.user.push(user.id);
                await interaction.reply(t('addedUserToDisableUserLocales', interaction.locale));
            }
            setSetting(provider, 'disable', interaction.guildId, guildSetting);
            syncTwitterLegacyDisable(interaction.guildId, providerId, guildSetting);
        } else if (interaction.options.getChannel('channel') !== null || interaction.options.getRole('role') !== null) {
            return await interaction.reply(t('userDonthavePermissionLocales', interaction.locale));
        }
        return;
    }

    if (!hasAnyTarget(interaction)) return await interaction.reply(t('userMustSpecifyAUserOrChannelLocales', interaction.locale));
    if (hasMultipleTargets(interaction)) return await interaction.reply(t('userCantSpecifyBothAUserAndAChannelLocales', interaction.locale));

    if (interaction.options.getUser('user') !== null) {
        const user = interaction.options.getUser('user');
        if (guildSetting.user.includes(user.id)) {
            guildSetting.user.splice(guildSetting.user.indexOf(user.id), 1);
            await interaction.reply(t('removedUserFromDisableUserLocales', interaction.locale));
        } else {
            guildSetting.user.push(user.id);
            await interaction.reply(t('addedUserToDisableUserLocales', interaction.locale));
        }
    } else if (interaction.options.getChannel('channel') !== null) {
        const channel = interaction.options.getChannel('channel');
        if (guildSetting.channel.includes(channel.id)) {
            guildSetting.channel.splice(guildSetting.channel.indexOf(channel.id), 1);
            await interaction.reply(t('removedChannelFromDisableChannelLocales', interaction.locale));
        } else {
            guildSetting.channel.push(channel.id);
            await interaction.reply(t('addedChannelToDisableChannelLocales', interaction.locale));
        }
    } else if (interaction.options.getRole('role') !== null) {
        const role = interaction.options.getRole('role');
        if (guildSetting.role.includes(role.id)) {
            guildSetting.role.splice(guildSetting.role.indexOf(role.id), 1);
            await interaction.reply(t('removedRoleFromDisableRoleLocales', interaction.locale));
        } else {
            guildSetting.role.push(role.id);
            await interaction.reply(t('addedRoleToDisableRoleLocales', interaction.locale));
        }
    }

    setSetting(provider, 'disable', interaction.guildId, guildSetting);
    syncTwitterLegacyDisable(interaction.guildId, providerId, guildSetting);

};

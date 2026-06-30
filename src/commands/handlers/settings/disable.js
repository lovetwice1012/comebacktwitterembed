'use strict';

const { PermissionsBitField } = require('discord.js');
const { t } = require('../../../locales');
const { loadProviders } = require('../../../providers/_loader');
const { getSetting, setSetting } = require('../../../providers/_provider_settings');

const ALL_PROVIDERS_ID = 'all';

function hasAdminPerm(member) {
    return (
        member.permissions.has(PermissionsBitField.Flags.ManageChannels)
        || member.permissions.has(PermissionsBitField.Flags.ManageGuild)
        || member.permissions.has(PermissionsBitField.Flags.Administrator)
    );
}

function normalizeDisableSetting(raw) {
    let out = raw;
    if (!out || typeof out !== 'object') {
        out = { user: [], channel: [], role: [] };
    }
    if (!Array.isArray(out.user)) out.user = [];
    if (!Array.isArray(out.channel)) out.channel = [];
    if (!Array.isArray(out.role)) out.role = [];
    return out;
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

function getProvidersForOption(providerId) {
    if (providerId === ALL_PROVIDERS_ID) return loadProviders().map(provider => ({ id: provider.id }));
    return [{ id: providerId }];
}

function selectedTarget(interaction) {
    if (interaction.options.getUser('user') !== null) return { type: 'user', id: interaction.options.getUser('user').id };
    if (interaction.options.getChannel('channel') !== null) return { type: 'channel', id: interaction.options.getChannel('channel').id };
    if (interaction.options.getRole('role') !== null) return { type: 'role', id: interaction.options.getRole('role').id };
    return null;
}

function responseKey(targetType, removed) {
    if (targetType === 'user') return removed ? 'removedUserFromDisableUserLocales' : 'addedUserToDisableUserLocales';
    if (targetType === 'channel') return removed ? 'removedChannelFromDisableChannelLocales' : 'addedChannelToDisableChannelLocales';
    return removed ? 'removedRoleFromDisableRoleLocales' : 'addedRoleToDisableRoleLocales';
}

async function toggleTargetForProviders(providers, interaction, targetType, targetId) {
    const entries = [];
    for (const provider of providers) {
        entries.push({
            provider,
            setting: normalizeDisableSetting(await getSetting(provider, 'disable', interaction.guildId)),
        });
    }

    const shouldRemove = entries.every(entry => entry.setting[targetType].includes(targetId));
    for (const entry of entries) {
        if (shouldRemove) {
            entry.setting[targetType] = entry.setting[targetType].filter(id => id !== targetId);
        } else if (!entry.setting[targetType].includes(targetId)) {
            entry.setting[targetType].push(targetId);
        }
        await setSetting(entry.provider, 'disable', interaction.guildId, entry.setting);
    }
    return shouldRemove;
}

module.exports = async function (interaction, client) {
    const providerId = interaction.options.getSubcommandGroup(false) || interaction.options.getString('provider') || 'twitter';
    const providers = getProvidersForOption(providerId);

    if (!hasAdminPerm(interaction.member)) {
        if (!hasAnyTarget(interaction)) return await interaction.editReply(t('userMustSpecifyAUserOrChannelLocales', interaction.locale));
        if (hasMultipleTargets(interaction)) return await interaction.editReply(t('userCantSpecifyBothAUserAndAChannelLocales', interaction.locale));

        if (interaction.options.getUser('user') !== null) {
            const user = interaction.options.getUser('user');
            if (user.id !== interaction.user.id) return await interaction.editReply(t('userCantUseThisCommandForOtherUsersLocales', interaction.locale));
            const removed = await toggleTargetForProviders(providers, interaction, 'user', user.id);
            await interaction.editReply(`${providerId === ALL_PROVIDERS_ID ? 'All providers: ' : ''}${t(responseKey('user', removed), interaction.locale)}`);
        } else if (interaction.options.getChannel('channel') !== null || interaction.options.getRole('role') !== null) {
            return await interaction.editReply(t('userDonthavePermissionLocales', interaction.locale));
        }
        return;
    }

    if (!hasAnyTarget(interaction)) return await interaction.editReply(t('userMustSpecifyAUserOrChannelLocales', interaction.locale));
    if (hasMultipleTargets(interaction)) return await interaction.editReply(t('userCantSpecifyBothAUserAndAChannelLocales', interaction.locale));

    const target = selectedTarget(interaction);
    const removed = await toggleTargetForProviders(providers, interaction, target.type, target.id);
    await interaction.editReply(`${providerId === ALL_PROVIDERS_ID ? 'All providers: ' : ''}${t(responseKey(target.type, removed), interaction.locale)}`);

};

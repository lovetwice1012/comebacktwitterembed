'use strict';

const { PermissionsBitField } = require('discord.js');
const { t } = require('../../../locales');
const { loadProviders } = require('../../../providers/_loader');
const { setSetting, getSetting } = require('../../../providers/_provider_settings');
const { button_disabled_template } = require('../../../utils');

const ALL_PROVIDERS_ID = 'all';

function hasAdminPerm(member) {
    return (
        member.permissions.has(PermissionsBitField.Flags.ManageChannels)
        || member.permissions.has(PermissionsBitField.Flags.ManageGuild)
        || member.permissions.has(PermissionsBitField.Flags.Administrator)
    );
}

function normalizeButtonDisabledSetting(raw) {
    let guildSetting = raw;
    if (!guildSetting || typeof guildSetting !== 'object') guildSetting = { ...button_disabled_template, user: [], channel: [], role: [] };
    if (!Array.isArray(guildSetting.user)) guildSetting.user = [];
    if (!Array.isArray(guildSetting.channel)) guildSetting.channel = [];
    if (!Array.isArray(guildSetting.role)) guildSetting.role = [];
    return guildSetting;
}

function hasAnyTarget(interaction) {
    return interaction.options.getUser('user') !== null
        || interaction.options.getChannel('channel') !== null
        || interaction.options.getRole('role') !== null;
}

function hasMultipleTargets(interaction) {
    return [
        interaction.options.getUser('user'),
        interaction.options.getChannel('channel'),
        interaction.options.getRole('role'),
    ].filter(value => value !== null).length > 1;
}

function selectedTarget(interaction) {
    if (interaction.options.getUser('user') !== null) return { type: 'user', id: interaction.options.getUser('user').id };
    if (interaction.options.getChannel('channel') !== null) return { type: 'channel', id: interaction.options.getChannel('channel').id };
    if (interaction.options.getRole('role') !== null) return { type: 'role', id: interaction.options.getRole('role').id };
    return null;
}

function getProvidersForOption(providerId) {
    if (providerId === ALL_PROVIDERS_ID) return loadProviders().map(provider => ({ id: provider.id }));
    return [{ id: providerId }];
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
            setting: normalizeButtonDisabledSetting(await getSetting(provider, 'button_disabled', interaction.guildId)),
        });
    }

    const shouldRemove = entries.every(entry => entry.setting[targetType].includes(targetId));
    for (const entry of entries) {
        if (shouldRemove) {
            entry.setting[targetType] = entry.setting[targetType].filter(id => id !== targetId);
        } else if (!entry.setting[targetType].includes(targetId)) {
            entry.setting[targetType].push(targetId);
        }
        await setSetting(entry.provider, 'button_disabled', interaction.guildId, entry.setting);
    }
    return shouldRemove;
}

module.exports = async function (interaction, client) {
    if (!hasAdminPerm(interaction.member)) {
        return await interaction.editReply(t('userDonthavePermissionLocales', interaction.locale));
    }

    if (!hasAnyTarget(interaction)) {
        return await interaction.editReply(t('userMustSpecifyAUserOrChannelLocales', interaction.locale));
    }

    if (hasMultipleTargets(interaction)) {
        return await interaction.editReply(t('userCantSpecifyBothAUserAndAChannelLocales', interaction.locale));
    }

    const providerId = interaction.options.getSubcommandGroup(false) || interaction.options.getString('provider') || 'twitter';
    const target = selectedTarget(interaction);
    const removed = await toggleTargetForProviders(getProvidersForOption(providerId), interaction, target.type, target.id);
    await interaction.editReply(`${providerId === ALL_PROVIDERS_ID ? 'All providers: ' : ''}${t(responseKey(target.type, removed), interaction.locale)}`);

};

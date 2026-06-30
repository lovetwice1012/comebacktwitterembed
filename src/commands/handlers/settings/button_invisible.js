'use strict';

const { PermissionsBitField } = require('discord.js');
const { t } = require('../../../locales');
const { loadProviders } = require('../../../providers/_loader');
const { button_invisible_template, convertBoolToEnableDisable } = require('../../../utils');
const { getSetting, setSetting } = require('../../../providers/_provider_settings');

const ALL_PROVIDERS_ID = 'all';
const COMMON_BUTTON_OPTIONS = [
    'showMediaAsAttachments',
    'showAttachmentsAsEmbedsImage',
    'translate',
    'delete',
];

async function getProviderButtonInvisible(providerId, guildId) {
    const raw = await getSetting({ id: providerId }, 'button_invisible', guildId);
    return { ...button_invisible_template, savetweet: false, ...(raw || {}) };
}

function hasAdminPerm(member) {
    return (
        member.permissions.has(PermissionsBitField.Flags.ManageChannels)
        || member.permissions.has(PermissionsBitField.Flags.ManageGuild)
        || member.permissions.has(PermissionsBitField.Flags.Administrator)
    );
}

function providerIdsForOption(providerId) {
    if (providerId === ALL_PROVIDERS_ID) return loadProviders().map(provider => provider.id);
    return [providerId];
}

function optionNamesForProvider(providerId) {
    return providerId === ALL_PROVIDERS_ID ? COMMON_BUTTON_OPTIONS : [...COMMON_BUTTON_OPTIONS, 'savetweet'];
}

async function saveProviderSetting(providerId, guildId, providerSetting) {
    const next = { ...providerSetting };
    if (providerId !== 'twitter') delete next.savetweet;
    await setSetting({ id: providerId }, 'button_invisible', guildId, next);
}

module.exports = async function (interaction, client) {
    if (!hasAdminPerm(interaction.member)) {
        return await interaction.editReply(t('userDonthavePermissionLocales', interaction.locale));
    }

    const providerId = interaction.options.getSubcommandGroup(false) || interaction.options.getString('provider') || 'twitter';
    const targetProviderIds = providerIdsForOption(providerId);

    //options: showMediaAsAttachments, showAttachmentsAsEmbedsImage, translate, delete, all;  all boolean
    if (interaction.options.getBoolean('showmediaasattachments') === null && interaction.options.getBoolean('showattachmentsasembedsimage') === null && interaction.options.getBoolean('translate') === null && interaction.options.getBoolean('delete') === null && interaction.options.getBoolean('savetweet') === null && interaction.options.getBoolean('all') === null) {
        return await interaction.editReply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    }
    if (interaction.options.getBoolean('all') !== null) {
        const hidden = interaction.options.getBoolean('all') === true;
        for (const targetProviderId of targetProviderIds) {
            const providerSetting = await getProviderButtonInvisible(targetProviderId, interaction.guildId);
            for (const optionName of optionNamesForProvider(providerId)) {
                providerSetting[optionName] = hidden;
            }
            await saveProviderSetting(targetProviderId, interaction.guildId, providerSetting);
        }
        await interaction.editReply(`${providerId === ALL_PROVIDERS_ID ? 'All providers: ' : ''}${t(hidden ? 'addedAllButtonLocales' : 'removedAllButtonLocales', interaction.locale)}`);
    } else {
        const response = [];
        const updates = [
            ['showmediaasattachments', 'showMediaAsAttachments', 'setshowmediaasattachmentsbuttonLocales'],
            ['showattachmentsasembedsimage', 'showAttachmentsAsEmbedsImage', 'setshowattachmentsasembedsimagebuttonLocales'],
            ['translate', 'translate', 'settranslatebuttonLocales'],
            ['delete', 'delete', 'setdeletebuttonLocales'],
            ...(providerId === ALL_PROVIDERS_ID ? [] : [['savetweet', 'savetweet', 'setsavetweetbuttonLocales']]),
        ];
        for (const targetProviderId of targetProviderIds) {
            const providerSetting = await getProviderButtonInvisible(targetProviderId, interaction.guildId);
            for (const [optionName, settingKey] of updates) {
                const value = interaction.options.getBoolean(optionName);
                if (value === null) continue;
                providerSetting[settingKey] = value;
            }
            await saveProviderSetting(targetProviderId, interaction.guildId, providerSetting);
        }
        for (const [optionName, , localeKey] of updates) {
            const value = interaction.options.getBoolean(optionName);
            if (value === null) continue;
            response.push((t(localeKey, interaction.locale)) + convertBoolToEnableDisable(!value, interaction.locale));
        }
        await interaction.editReply(`${providerId === ALL_PROVIDERS_ID ? 'All providers: ' : ''}${response.join('\n')}`);
    }

};

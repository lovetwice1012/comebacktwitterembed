'use strict';

const { ApplicationCommandOptionType } = require('discord.js');
const { t, messageLocales } = require('../../locales');
const { conv_en_to_en_US } = require('../../utils');
const { sendFieldEmbeds } = require('../../interactionResponse');
const { loadProviders } = require('../../providers/_loader');
const { getProviderSettings, isProviderEnabled } = require('../../providers/_provider_settings');
const { catalogText } = require('../../i18n');

const COMMAND_DESCRIPTION_LOCALES = { ja: 'ギルド設定を確認します', en: 'Check guild settings' };
const GUILD_OPTION_NAME_LOCALES = { ja: 'ギルド', en: 'guild' };
const GUILD_OPTION_DESCRIPTION_LOCALES = { ja: '確認するギルドID', en: 'Guild ID to check' };

const CHECK_TEXT = {
    enabledProviders: { ja: '有効なプロバイダー', en: 'Enabled providers' },
    guildSettings: { ja: 'ギルド設定', en: 'Guild settings' },
    mode: { ja: '動作モード', en: 'Mode' },
    normalMode: { ja: '通常モード', en: 'Normal' },
    secondaryTargets: { ja: 'セカンダリー展開対象', en: 'Secondary targets' },
    allButtons: { ja: 'すべてのボタン', en: 'All buttons' },
};

function getStringOption(interaction, name) {
    try {
        return interaction.options.getString(name);
    } catch {
        return null;
    }
}

function getTargetGuildId(interaction) {
    const optionGuildId = getStringOption(interaction, 'guildid') || getStringOption(interaction, 'guild');
    return optionGuildId || interaction.guildId;
}

function localText(key, locale) {
    const localized = CHECK_TEXT[key];
    if (!localized) return key;
    return localized[String(locale || '').toLowerCase().startsWith('ja') ? 'ja' : 'en'];
}

function uiText(key, locale, replacements = {}, fallback = key) {
    return catalogText(`gui.${key}`, locale, replacements) || fallback;
}

function settingLabel(key, locale, fallback = key) {
    return catalogText(`gui.settings.${key}.label`, locale) || fallback;
}

function buttonLabel(key, locale) {
    if (key === 'all') return localText('allButtons', locale);
    return catalogText(`gui.buttons.${key}`, locale) || key;
}

function boolText(value, locale) {
    return value === true
        ? uiText('enabled', locale, {}, 'Enabled')
        : uiText('disabled', locale, {}, 'Disabled');
}

function noneText(locale) {
    return uiText('none', locale, {}, 'None');
}

function moreItemsText(count, locale) {
    return uiText('moreItems', locale, { count }, `...and ${count} more`);
}

function uniqueIds(value) {
    return Array.isArray(value) ? [...new Set(value.filter(Boolean).map(String))] : [];
}

function formatTargetList(ids, formatter, locale) {
    const unique = uniqueIds(ids);
    if (unique.length === 0) return noneText(locale);
    const shown = unique.slice(0, 10).map(formatter);
    const hiddenCount = unique.length - shown.length;
    if (hiddenCount > 0) shown.push(moreItemsText(hiddenCount, locale));
    return shown.join(', ');
}

function targetSummary(setting, locale) {
    return [
        `${uiText('users', locale, {}, 'Users')}: ${formatTargetList(setting.user, id => `<@${id}>`, locale)}`,
        `${uiText('channels', locale, {}, 'Channels')}: ${formatTargetList(setting.channel, id => `<#${id}>`, locale)}`,
        `${uiText('roles', locale, {}, 'Roles')}: ${formatTargetList(setting.role, id => `<@&${id}>`, locale)}`,
    ].join('\n');
}

function hiddenButtons(setting, locale) {
    const hidden = Object.entries(setting || {})
        .filter(([, value]) => value === true)
        .map(([key]) => buttonLabel(key, locale));
    return hidden.length > 0 ? hidden.join('\n') : noneText(locale);
}

function modeText(settings, locale) {
    if (settings.secondary_extract_mode === true) {
        return settingLabel('secondary_extract_mode', locale, 'Secondary extract mode');
    }
    if (settings.legacy_mode === true) {
        return settingLabel('legacy_mode', locale, 'Legacy mode');
    }
    return localText('normalMode', locale);
}

async function enabledProvidersSummary(guildId, locale) {
    const enabled = [];
    for (const provider of loadProviders()) {
        if (await isProviderEnabled(provider, guildId)) enabled.push(`**${provider.id}**`);
    }
    return enabled.length > 0 ? enabled.join(', ') : noneText(locale);
}

module.exports.execute = async function (interaction) {
    const guildId = getTargetGuildId(interaction);
    if (guildId !== interaction.guildId && interaction.user.id !== '796972193287503913') {
        return await interaction.editReply(t('userDonthavePermissionLocales', interaction.locale));
    }

    const s = await getProviderSettings({ id: 'twitter', enabledByDefault: true }, guildId);
    const locale = interaction.locale;
    const fields = [
        { name: localText('enabledProviders', locale), value: await enabledProvidersSummary(guildId, locale), inline: false },
        { name: `${uiText('provider', locale, {}, 'Provider')}: ${uiText('enabled', locale, {}, 'Enabled')}`, value: boolText(s.enabled, locale), inline: true },
        { name: localText('mode', locale), value: modeText(s, locale), inline: true },
        {
            name: localText('secondaryTargets', locale),
            value: [
                `${settingLabel('secondary_extract_mode_multiple_images', locale, 'Multiple images')}: ${boolText(s.secondary_extract_mode_multiple_images, locale)}`,
                `${settingLabel('secondary_extract_mode_video', locale, 'Video')}: ${boolText(s.secondary_extract_mode_video, locale)}`,
            ].join('\n'),
            inline: true,
        },
        { name: settingLabel('disable', locale, 'Disable extraction'), value: targetSummary(s.disable || {}, locale), inline: false },
        { name: settingLabel('extract_bot_message', locale, 'Extract bot messages'), value: boolText(s.extract_bot_message, locale), inline: true },
        { name: settingLabel('quote_repost_do_not_extract', locale, 'Do not extract quote reposts'), value: boolText(s.quote_repost_do_not_extract, locale), inline: true },
        { name: settingLabel('anonymous_expand', locale, 'Anonymous expand'), value: boolText(s.anonymous_expand, locale), inline: true },
        { name: settingLabel('button_invisible', locale, uiText('hiddenButtons', locale, {}, 'Hidden buttons')), value: hiddenButtons(s.button_invisible, locale), inline: false },
        { name: settingLabel('button_disabled', locale, 'Disable buttons for targets'), value: targetSummary(s.button_disabled || {}, locale), inline: false },
    ];

    await sendFieldEmbeds(interaction, {
        title: localText('guildSettings', locale),
        fields,
        color: 0x1DA1F2,
    });
};

module.exports.definition = {
    name: 'checkmyguildsettings',
    name_localizations: conv_en_to_en_US(messageLocales.myGuildSettingsCommandNameLocales),
    description: COMMAND_DESCRIPTION_LOCALES.en,
    description_localizations: conv_en_to_en_US(COMMAND_DESCRIPTION_LOCALES),
    options: [
        {
            name: 'guild',
            name_localizations: conv_en_to_en_US(GUILD_OPTION_NAME_LOCALES),
            description: GUILD_OPTION_DESCRIPTION_LOCALES.en,
            description_localizations: conv_en_to_en_US(GUILD_OPTION_DESCRIPTION_LOCALES),
            type: ApplicationCommandOptionType.String,
            required: false,
        },
    ],
};

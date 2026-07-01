'use strict';

const {
    ActionRowBuilder,
    ApplicationCommandOptionType,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ModalBuilder,
    PermissionsBitField,
    RoleSelectMenuBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
    UserSelectMenuBuilder,
} = require('discord.js');
const { loadProviders } = require('../../providers/_loader');
const {
    getSetting,
    isProviderEnabled,
    setProviderEnabled,
    setSetting,
} = require('../../providers/_provider_settings');
const {
    BULK_SETTING_KEYS,
    DEFAULT_SETTING_KEY,
    getBulkSettingSpecs,
    getProviderSettingSpecs,
    overviewSpec,
} = require('../../providers/_setting_specs');
const { normalizeHiddenOutputItems } = require('../../providers/_output_visibility');
const { button_invisible_template } = require('../../utils');
const {
    catalogText,
    localize,
    toDiscordLocalizationsForKey,
} = require('../../i18n');
const {
    DISCORD_LOCALE_OPTIONS,
    formatDiscordLocaleName,
    normalizeDiscordLocale,
} = require('../../discordLocales');

const CUSTOM_ID_PREFIX = 'guisetting';
const DEFAULT_PROVIDER_ID = 'twitter';
const BULK_PROVIDER_ID = 'all';
const BANNED_WORD_INPUT_ID = 'guisetting-banned-word';
const COPY_SOURCE_GUILD_INPUT_ID = 'guisetting-copy-source-guild';
const DEFAULT_LANGUAGE_INPUT_ID = 'guisetting-default-language';

const LOCAL_TEXT = {
    allProviders: { en: 'All providers', ja: 'すべてのプロバイダー' },
    allProviderSettings: { en: 'Settings shared by all providers.', ja: 'すべてのプロバイダーに共通する設定です。' },
    mixed: { en: 'Mixed', ja: '混在' },
    importFromGuild: { en: 'Import from server', ja: 'サーバーから取り込み' },
    copyModalTitle: { en: 'Import server settings', ja: 'サーバー設定を取り込み' },
    sourceGuildId: { en: 'Source server ID', ja: 'コピー元サーバーID' },
    sourceGuildPlaceholder: { en: 'Server A guild ID', ja: 'コピー元(A)のサーバーID' },
    copySameGuild: { en: 'Source and destination servers must be different.', ja: 'コピー元とコピー先には別のサーバーを指定してください。' },
    copyNoTargetPermission: { en: 'You need Manage Channels, Manage Server, or Administrator permission in this server before importing settings.', ja: 'このサーバーに設定を取り込むには、チャンネル管理、サーバー管理、または管理者権限が必要です。' },
    copyDone: { en: 'Imported {settings} setting(s) from {source} across {providers} provider(s).', ja: '{source} から {providers} 個のプロバイダーにわたり {settings} 件の設定を取り込みました。' },
    copySkippedTargets: { en: 'Skipped {count} channel/role target(s) because IDs differ between servers.', ja: 'サーバー間でIDが異なるため、チャンネル/ロール対象 {count} 件は取り込みませんでした。' },
    updatedAllProvidersSetting: { en: 'Updated {setting} for all providers: {value}', ja: 'すべてのプロバイダーの「{setting}」を {value} にしました。' },
    setDefaultLanguage: { en: 'Set default language', ja: 'デフォルト言語を設定' },
    defaultLanguagePlaceholder: { en: 'en-US, ja, fr, ko, zh-CN...', ja: 'en-US, ja, fr, ko, zh-CN...' },
    unsupportedLocale: { en: 'Unsupported locale: {value}. Supported locales: {locales}', ja: '未対応のロケールです: {value}。対応ロケール: {locales}' },
};

const PROVIDER_LABEL_OVERRIDES = {
    twitter: 'Twitter / X',
    pixiv: 'Pixiv',
    booth: 'Booth',
    twitch: 'Twitch',
    tiktok: 'TikTok',
    youtube: 'YouTube',
    niconico: 'Niconico',
    amazon: 'Amazon',
    github: 'GitHub',
    steam: 'Steam',
};

function getProviders() {
    return loadProviders().map(provider => ({
        id: provider.id,
        label: PROVIDER_LABEL_OVERRIDES[provider.id] || provider.id,
        provider,
    }));
}

function getProviderLabels() {
    return Object.fromEntries(getProviders().map(provider => [provider.id, provider.label]));
}

function isBulkProvider(providerId) {
    return providerId === BULK_PROVIDER_ID;
}

function getProviderLabel(providerId, locale) {
    if (isBulkProvider(providerId)) return localText('allProviders', locale);
    return getProviderLabels()[providerId] || providerId;
}

function findProviderDefinition(providerId) {
    return getProviders().find(provider => provider.id === providerId)?.provider || { id: providerId, enabledByDefault: false };
}

function uiText(key, locale, replacements = {}) {
    return catalogText(`gui.${key}`, locale, replacements) || key;
}

function localText(key, locale, replacements = {}) {
    const bucket = LOCAL_TEXT[key];
    if (!bucket) return key;
    let text = localize(bucket, locale) || bucket.en || key;
    for (const [name, value] of Object.entries(replacements)) {
        text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
}

function shouldPreferSpecText(locale) {
    const normalized = String(locale || '').toLowerCase();
    return normalized === 'en' || normalized.startsWith('en-') || normalized.startsWith('ja');
}

function specText(value, locale) {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value;
    return localize(value, locale);
}

function specLabel(spec, locale) {
    if (spec.key === 'enabled') return `${uiText('provider', locale)}: ${uiText('enabled', locale)}`;
    const preferred = shouldPreferSpecText(locale) ? specText(spec.label, locale) : null;
    return preferred || catalogText(`gui.settings.${spec.key}.label`, locale) || specText(spec.label, locale) || spec.label;
}

function specDescription(spec, locale) {
    if (spec.key === 'enabled') return `${uiText('enable', locale)} / ${uiText('disable', locale)} ${uiText('provider', locale)}`;
    const preferred = shouldPreferSpecText(locale) ? specText(spec.description, locale) : null;
    return preferred || catalogText(`gui.settings.${spec.key}.description`, locale) || specText(spec.description, locale) || spec.description;
}

function buttonOptionLabel(option, locale) {
    return catalogText(`gui.buttons.${option.key}`, locale) || option.label;
}

function choiceLabel(spec, choice, locale) {
    const preferred = shouldPreferSpecText(locale) ? specText(choice.label, locale) : null;
    return preferred || catalogText(`gui.choices.${spec.key}.${choice.value}`, locale) || specText(choice.label, locale) || choice.label;
}

function outputItemLabel(item, locale) {
    return specText(item.label, locale) || item.label || item.value;
}

function outputItemDescription(item, locale) {
    return specText(item.description, locale) || item.description;
}

const BUTTON_VISIBILITY_OPTIONS = [
    { key: 'showMediaAsAttachments', label: 'Media as attachments' },
    { key: 'showAttachmentsAsEmbedsImage', label: 'Media in embeds' },
    { key: 'translate', label: 'Translate' },
    { key: 'delete', label: 'Delete' },
    { key: 'savetweet', label: 'Save tweet' },
];

function getSettingSpecs(providerId) {
    if (isBulkProvider(providerId)) return getBulkSettingSpecs();
    const provider = getProviders().find(candidate => candidate.id === providerId)?.provider;
    if (provider) return getProviderSettingSpecs(provider);
    return [overviewSpec()];
}

function findSpec(providerId, settingKey) {
    return getSettingSpecs(providerId).find(spec => spec.key === settingKey) || overviewSpec();
}

function normalizeProviderId(providerId) {
    if (providerId === BULK_PROVIDER_ID) return BULK_PROVIDER_ID;
    return getProviderLabels()[providerId] ? providerId : DEFAULT_PROVIDER_ID;
}

function normalizeSettingKey(providerId, settingKey) {
    return findSpec(providerId, settingKey).key;
}

function hasPermission(permissions, flag) {
    if (!permissions) return false;
    if (typeof permissions.has === 'function') return permissions.has(flag);
    try {
        return new PermissionsBitField(BigInt(permissions)).has(flag);
    } catch {
        return false;
    }
}

function hasSettingsPermission(permissions) {
    return (
        hasPermission(permissions, PermissionsBitField.Flags.ManageChannels)
        || hasPermission(permissions, PermissionsBitField.Flags.ManageGuild)
        || hasPermission(permissions, PermissionsBitField.Flags.Administrator)
    );
}

function hasAdminPerm(interaction) {
    const permissions = interaction.memberPermissions || interaction.member?.permissions;
    return hasSettingsPermission(permissions);
}

async function replyNoPermission(interaction) {
    const payload = { content: uiText('noPermission', interaction.locale), ephemeral: true };
    if (interaction.replied || interaction.deferred) return await interaction.followUp(payload);
    return await interaction.reply(payload);
}

async function updateGuiMessage(interaction, payload) {
    if (interaction.replied || interaction.deferred) {
        return await interaction.editReply(payload);
    }
    return await interaction.update(payload);
}

async function deferGuiMessageUpdate(interaction) {
    if (!interaction.replied && !interaction.deferred) {
        await interaction.deferUpdate();
    }
}

async function deferModalResult(interaction) {
    if (interaction.replied || interaction.deferred) return;
    if (interaction.isFromMessage()) {
        await interaction.deferUpdate();
        return;
    }
    await interaction.deferReply({ ephemeral: true });
}

function parseCustomId(customId) {
    const parts = String(customId || '').split(':');
    return parts[0] === CUSTOM_ID_PREFIX ? parts : null;
}

function truncate(value, maxLength) {
    const text = String(value ?? '');
    if (text.length <= maxLength) return text;
    if (maxLength <= 3) return text.slice(0, maxLength);
    return text.slice(0, maxLength - 3) + '...';
}

function boolLabel(value, locale) {
    return value === true ? uiText('enabled', locale) : uiText('disabled', locale);
}

async function getSettingValueForSpec(providerId, spec, guildId) {
    if (spec.kind === 'providerEnabled') return await isProviderEnabled(findProviderDefinition(providerId), guildId);
    return await getSetting({ id: providerId }, spec.settingKey, guildId);
}

async function getBulkSettingValues(spec, guildId) {
    const values = [];
    for (const provider of getProviders()) {
        values.push({
            providerId: provider.id,
            label: provider.label,
            value: await getSettingValueForSpec(provider.id, spec, guildId),
        });
    }
    return values;
}

function aggregateBoolean(values) {
    if (values.every(item => item.value === true)) return true;
    if (values.every(item => item.value !== true)) return false;
    return null;
}

function aggregateChoice(values) {
    if (values.length === 0) return undefined;
    const first = values[0].value;
    return values.every(item => String(item.value) === String(first)) ? first : undefined;
}

function choiceOptions(spec) {
    return Array.isArray(spec.choices) ? spec.choices : [];
}

function normalizeMultiChoiceValue(spec, value) {
    const validKeys = new Set(choiceOptions(spec).map(item => String(item.value)));
    const out = [];
    const source = Array.isArray(value) ? value : [];
    for (const item of source) {
        const key = String(item || '').trim();
        if (validKeys.has(key) && !out.includes(key)) out.push(key);
    }
    return out;
}

async function getBooleanSettingValue(providerId, spec, guildId) {
    if (isBulkProvider(providerId)) {
        return aggregateBoolean(await getBulkSettingValues(spec, guildId));
    }
    if (spec.kind === 'providerEnabled') return await isProviderEnabled(findProviderDefinition(providerId), guildId);
    return await getSetting({ id: providerId }, spec.settingKey, guildId) === true;
}

async function setProviderGuildSetting(providerId, settingKey, guildId, value) {
    await setSetting({ id: providerId }, settingKey, guildId, value);
}

async function normalizeTargetSetting(providerId, settingKey, guildId) {
    const raw = await getSetting({ id: providerId }, settingKey, guildId);
    let out = raw && typeof raw === 'object' ? {
        user: Array.isArray(raw.user) ? [...raw.user] : [],
        channel: Array.isArray(raw.channel) ? [...raw.channel] : [],
        role: Array.isArray(raw.role) ? [...raw.role] : [],
    } : null;

    return out || { user: [], channel: [], role: [] };
}

async function setTargetSetting(providerId, settingKey, guildId, value) {
    await setSetting({ id: providerId }, settingKey, guildId, value);
}

async function normalizeButtonVisibility(providerId, guildId) {
    const raw = await getSetting({ id: providerId }, 'button_invisible', guildId);
    const base = {
        ...button_invisible_template,
        savetweet: false,
    };
    if (!raw || typeof raw !== 'object') return base;
    return { ...base, ...raw };
}

async function setButtonVisibility(providerId, guildId, value) {
    await setSetting({ id: providerId }, 'button_invisible', guildId, value);
}

function getButtonOptions(providerId) {
    return BUTTON_VISIBILITY_OPTIONS.filter(option => providerId === 'twitter' || option.key !== 'savetweet');
}

async function normalizeOutputVisibility(providerId, spec, guildId) {
    const validKeys = new Set(getOutputItems(spec).map(item => item.value));
    return normalizeHiddenOutputItems(await getSetting({ id: providerId }, spec.settingKey, guildId))
        .filter(key => validKeys.has(key));
}

async function setOutputVisibility(providerId, settingKey, guildId, value) {
    await setSetting({ id: providerId }, settingKey, guildId, normalizeHiddenOutputItems(value));
}

async function normalizeMultiChoiceSetting(providerId, spec, guildId) {
    return normalizeMultiChoiceValue(spec, await getSetting({ id: providerId }, spec.settingKey, guildId));
}

async function setMultiChoiceSetting(providerId, spec, guildId, value) {
    await setSetting({ id: providerId }, spec.settingKey, guildId, normalizeMultiChoiceValue(spec, value));
}

async function normalizeBannedWords(providerId, guildId) {
    const raw = await getSetting({ id: providerId }, 'bannedWords', guildId);
    return Array.isArray(raw) ? [...raw] : [];
}

async function setBannedWords(providerId, guildId, words) {
    const uniqueWords = [];
    const seen = new Set();
    for (const word of words) {
        const normalized = String(word ?? '').normalize('NFC').trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        uniqueWords.push(normalized);
    }
    await setProviderGuildSetting(providerId, 'bannedWords', guildId, uniqueWords);
}

async function applySettingValue(providerId, settingKey, guildId, value) {
    if (isBulkProvider(providerId)) {
        const spec = findSpec(providerId, settingKey);
        if (!BULK_SETTING_KEYS.has(spec.key)) return;
        for (const provider of getProviders()) {
            await applySettingValue(provider.id, spec.settingKey, guildId, value);
        }
        return;
    }

    if (settingKey === 'enabled') {
        await setProviderEnabled(findProviderDefinition(providerId), guildId, value === true);
        return;
    }

    await setProviderGuildSetting(providerId, settingKey, guildId, value);

    if (providerId !== 'twitter') return;
    if (settingKey === 'legacy_mode' && value === true) {
        await setProviderGuildSetting(providerId, 'secondary_extract_mode', guildId, false);
    }
    if (settingKey === 'secondary_extract_mode' && value === true) {
        await setProviderGuildSetting(providerId, 'legacy_mode', guildId, false);
    }
}

function toggleValues(list, ids) {
    const values = [...list];
    let added = 0;
    let removed = 0;
    for (const id of ids) {
        const index = values.indexOf(id);
        if (index === -1) {
            values.push(id);
            added++;
        } else {
            values.splice(index, 1);
            removed++;
        }
    }
    return { values, added, removed };
}

function formatTarget(targetType, id) {
    if (targetType === 'user') return `<@${id}>`;
    if (targetType === 'channel') return `<#${id}>`;
    if (targetType === 'role') return `<@&${id}>`;
    return id;
}

function targetTypeLabel(targetType, locale) {
    if (targetType === 'user') return uiText('userTargets', locale);
    if (targetType === 'channel') return uiText('channelTargets', locale);
    if (targetType === 'role') return uiText('roleTargets', locale);
    return targetType;
}

async function applyTargetToggle(providerId, settingKey, guildId, targetType, ids, locale) {
    if (isBulkProvider(providerId)) {
        const providers = getProviders();
        const currentByProvider = [];
        for (const provider of providers) {
            currentByProvider.push({
                provider,
                current: await normalizeTargetSetting(provider.id, settingKey, guildId),
            });
        }

        const shouldRemove = new Map(ids.map(id => [
            id,
            currentByProvider.every(item => (item.current[targetType] || []).includes(id)),
        ]));

        for (const item of currentByProvider) {
            const nextValues = new Set(item.current[targetType] || []);
            for (const id of ids) {
                if (shouldRemove.get(id)) nextValues.delete(id);
                else nextValues.add(id);
            }
            await setTargetSetting(item.provider.id, settingKey, guildId, {
                ...item.current,
                [targetType]: [...nextValues],
            });
        }

        const spec = findSpec(BULK_PROVIDER_ID, settingKey);
        return localText('updatedAllProvidersSetting', locale, {
            setting: specLabel(spec, locale),
            value: targetTypeLabel(targetType, locale),
        });
    }

    const current = await normalizeTargetSetting(providerId, settingKey, guildId);
    const result = toggleValues(current[targetType] || [], ids);
    const next = { ...current, [targetType]: result.values };
    await setTargetSetting(providerId, settingKey, guildId, next);

    if (ids.length === 1) {
        const textKey = result.added === 1 ? 'addedTarget' : 'removedTarget';
        return uiText(textKey, locale, { target: formatTarget(targetType, ids[0]) });
    }
    return uiText('updatedTargets', locale, { targetType: targetTypeLabel(targetType, locale) });
}

async function applyButtonVisibilitySelection(providerId, guildId, hiddenButtonKeys, locale) {
    const selected = new Set(hiddenButtonKeys);
    if (isBulkProvider(providerId)) {
        const commonOptions = getButtonOptions(BULK_PROVIDER_ID);
        for (const provider of getProviders()) {
            const next = await normalizeButtonVisibility(provider.id, guildId);
            for (const option of commonOptions) {
                next[option.key] = selected.has(option.key);
            }
            if (provider.id !== 'twitter') delete next.savetweet;
            await setButtonVisibility(provider.id, guildId, next);
        }
        return localText('updatedAllProvidersSetting', locale, {
            setting: specLabel(findSpec(BULK_PROVIDER_ID, 'button_invisible'), locale),
            value: uiText('updatedHiddenButtons', locale),
        });
    }

    const next = await normalizeButtonVisibility(providerId, guildId);
    for (const option of getButtonOptions(providerId)) {
        next[option.key] = selected.has(option.key);
    }
    if (providerId !== 'twitter') delete next.savetweet;
    await setButtonVisibility(providerId, guildId, next);
    return uiText('updatedHiddenButtons', locale);
}

async function applyOutputVisibilitySelection(providerId, spec, guildId, hiddenItemKeys, locale, visibleItemKeys = null) {
    const validKeys = new Set(getOutputItems(spec).map(item => item.value));
    const selected = normalizeHiddenOutputItems(hiddenItemKeys).filter(key => validKeys.has(key));
    let next = selected;
    if (Array.isArray(visibleItemKeys)) {
        const visible = new Set(visibleItemKeys.filter(key => validKeys.has(key)));
        const current = await normalizeOutputVisibility(providerId, spec, guildId);
        next = current.filter(key => !visible.has(key));
        for (const key of selected) {
            if (!next.includes(key)) next.push(key);
        }
    }
    await setOutputVisibility(providerId, spec.settingKey, guildId, next);
    return `${specLabel(spec, locale)}: ${outputVisibilityValueSummary(spec, next, locale)}`;
}

async function applyMultiChoiceSelection(providerId, spec, guildId, selectedKeys, locale) {
    const next = normalizeMultiChoiceValue(spec, selectedKeys);
    await setMultiChoiceSetting(providerId, spec, guildId, next);
    return `${specLabel(spec, locale)}: ${multiChoiceValueSummary(spec, next, locale)}`;
}

async function applyBannedWordInput(providerId, guildId, rawWord, locale) {
    const word = String(rawWord ?? '').normalize('NFC').trim();
    if (!word) return uiText('bannedWordEmpty', locale);

    const words = await normalizeBannedWords(providerId, guildId);
    const index = words.indexOf(word);
    if (index === -1) {
        words.push(word);
        await setBannedWords(providerId, guildId, words);
        return uiText('addedBannedWord', locale, { word });
    }

    words.splice(index, 1);
    await setBannedWords(providerId, guildId, words);
    return uiText('removedBannedWord', locale, { word });
}

function supportedLocaleCodes() {
    return DISCORD_LOCALE_OPTIONS.map(option => option.value).join(', ');
}

async function applyDefaultLanguageInput(providerId, settingKey, guildId, rawValue, locale) {
    const raw = String(rawValue ?? '').trim();
    const normalized = normalizeDiscordLocale(raw);
    if (!normalized) {
        return localText('unsupportedLocale', locale, {
            value: raw || uiText('empty', locale),
            locales: supportedLocaleCodes(),
        });
    }

    const spec = findSpec(providerId, settingKey);
    await applySettingValue(providerId, spec.settingKey, guildId, normalized);
    const valueLabel = formatDiscordLocaleName(normalized);
    return isBulkProvider(providerId)
        ? localText('updatedAllProvidersSetting', locale, { setting: specLabel(spec, locale), value: valueLabel })
        : `${specLabel(spec, locale)}: ${valueLabel}`;
}

async function removeBannedWords(providerId, guildId, selectedIndexes, locale) {
    const indexes = new Set(
        (selectedIndexes || [])
            .map(value => Number(value))
            .filter(value => Number.isInteger(value) && value >= 0)
    );
    const currentWords = await normalizeBannedWords(providerId, guildId);
    const words = currentWords.filter((_word, index) => !indexes.has(index));
    const removedCount = currentWords.length - words.length;
    await setBannedWords(providerId, guildId, words);
    return uiText('removedBannedWordsCount', locale, { count: removedCount });
}

function canManageMessages(interaction) {
    const permissions = interaction.guild?.members?.me?.permissions;
    if (!permissions) return true;
    return hasPermission(permissions, PermissionsBitField.Flags.ManageMessages);
}

function formatChoiceValue(spec, value, locale) {
    if (spec.key === 'defaultLanguage') {
        const normalized = normalizeDiscordLocale(value);
        if (normalized) return formatDiscordLocaleName(normalized);
    }
    const choice = (spec.choices || []).find(option => String(option.value) === String(value));
    return choice ? choiceLabel(spec, choice, locale) : String(value ?? '(unset)');
}

function multiChoiceValueSummary(spec, value, locale) {
    const selected = new Set(normalizeMultiChoiceValue(spec, value));
    const labels = choiceOptions(spec)
        .filter(choice => selected.has(String(choice.value)))
        .map(choice => choiceLabel(spec, choice, locale));
    return labels.length === 0 ? uiText('none', locale) : labels.join(', ');
}

function formatSpecValue(spec, value, locale) {
    if (spec.kind === 'providerEnabled' || spec.kind === 'bool') return boolLabel(value === true, locale);
    if (spec.kind === 'choice') return formatChoiceValue(spec, value, locale);
    if (spec.kind === 'multiChoice') return multiChoiceValueSummary(spec, value, locale);
    return value === undefined ? '(unset)' : String(value);
}

function targetCountSummary(setting, locale) {
    const target = setting && typeof setting === 'object' ? setting : {};
    return [
        `${uiText('users', locale)}: ${Array.isArray(target.user) ? target.user.length : 0}`,
        `${uiText('channels', locale)}: ${Array.isArray(target.channel) ? target.channel.length : 0}`,
        `${uiText('roles', locale)}: ${Array.isArray(target.role) ? target.role.length : 0}`,
    ].join(', ');
}

function buttonVisibilityValueSummary(providerId, value, locale) {
    const visibility = value && typeof value === 'object' ? value : {};
    const hidden = getButtonOptions(providerId)
        .filter(option => visibility[option.key] === true)
        .map(option => buttonOptionLabel(option, locale));
    return hidden.length === 0 ? uiText('none', locale) : hidden.join(', ');
}

function getOutputItems(spec) {
    return Array.isArray(spec.outputItems) ? spec.outputItems : [];
}

function outputVisibilityValueSummary(spec, value, locale) {
    const hiddenKeys = new Set(normalizeHiddenOutputItems(value));
    const hidden = getOutputItems(spec)
        .filter(item => hiddenKeys.has(item.value))
        .map(item => outputItemLabel(item, locale));
    return hidden.length === 0 ? uiText('none', locale) : hidden.join(', ');
}

async function formatBulkSettingValue(spec, guildId, locale) {
    const values = await getBulkSettingValues(spec, guildId);
    if (values.length === 0) return uiText('none', locale);

    if (spec.kind === 'targets') {
        return values
            .map(item => `${item.label}: ${targetCountSummary(item.value, locale)}`)
            .join('\n');
    }

    if (spec.kind === 'buttonVisibility') {
        return values
            .map(item => `${item.label}: ${buttonVisibilityValueSummary(item.providerId, item.value, locale)}`)
            .join('\n');
    }

    if (spec.kind === 'outputVisibility') {
        return values
            .map(item => `${item.label}: ${outputVisibilityValueSummary(spec, item.value, locale)}`)
            .join('\n');
    }

    if (spec.kind === 'multiChoice') {
        return values
            .map(item => `${item.label}: ${multiChoiceValueSummary(spec, item.value, locale)}`)
            .join('\n');
    }

    if (spec.kind === 'providerEnabled' || spec.kind === 'bool') {
        const aggregate = aggregateBoolean(values);
        if (aggregate !== null) return boolLabel(aggregate, locale);
    }

    if (spec.kind === 'choice') {
        const aggregate = aggregateChoice(values);
        if (aggregate !== undefined) return formatChoiceValue(spec, aggregate, locale);
    }

    return values
        .map(item => `${item.label}: ${formatSpecValue(spec, item.value, locale)}`)
        .join('\n');
}

async function formatTargetSummary(providerId, settingKey, guildId, locale) {
    const target = await normalizeTargetSetting(providerId, settingKey, guildId);
    return [
        `${uiText('users', locale)}: ${target.user.length}`,
        `${uiText('channels', locale)}: ${target.channel.length}`,
        `${uiText('roles', locale)}: ${target.role.length}`,
    ].join('\n');
}

async function formatButtonVisibilitySummary(providerId, guildId, locale) {
    const visibility = await normalizeButtonVisibility(providerId, guildId);
    const hidden = getButtonOptions(providerId)
        .filter(option => visibility[option.key] === true)
        .map(option => buttonOptionLabel(option, locale));
    return hidden.length === 0 ? uiText('none', locale) : hidden.join('\n');
}

async function formatOutputVisibilitySummary(providerId, spec, guildId, locale) {
    const value = await getSetting({ id: providerId }, spec.settingKey, guildId);
    return outputVisibilityValueSummary(spec, value, locale);
}

async function formatBannedWordsSummary(providerId, guildId, locale) {
    const words = await normalizeBannedWords(providerId, guildId);
    if (words.length === 0) return uiText('none', locale);
    const shown = words.slice(0, 10).map(word => `\`${truncate(word, 80)}\``);
    const suffix = words.length > shown.length
        ? `\n${uiText('moreItems', locale, { count: words.length - shown.length })}`
        : '';
    return shown.join('\n') + suffix;
}

async function formatSettingValue(providerId, spec, guildId, locale) {
    if (isBulkProvider(providerId)) return await formatBulkSettingValue(spec, guildId, locale);
    if (spec.kind === 'targets') return await formatTargetSummary(providerId, spec.settingKey, guildId, locale);
    if (spec.kind === 'buttonVisibility') return await formatButtonVisibilitySummary(providerId, guildId, locale);
    if (spec.kind === 'outputVisibility') return await formatOutputVisibilitySummary(providerId, spec, guildId, locale);
    if (spec.kind === 'bannedWords') return await formatBannedWordsSummary(providerId, guildId, locale);

    if (spec.kind === 'providerEnabled') return boolLabel(await getBooleanSettingValue(providerId, spec, guildId), locale);
    const value = await getSetting({ id: providerId }, spec.settingKey, guildId);
    if (spec.kind === 'bool') return boolLabel(value === true, locale);
    if (spec.kind === 'choice') return formatChoiceValue(spec, value, locale);
    if (spec.kind === 'multiChoice') return multiChoiceValueSummary(spec, value, locale);
    return value === undefined ? '(unset)' : String(value);
}

function buildProviderSelect(providerId, settingKey, locale) {
    const options = [
        {
            label: localText('allProviders', locale),
            value: BULK_PROVIDER_ID,
            default: providerId === BULK_PROVIDER_ID,
        },
        ...getProviders().map(provider => ({
            label: provider.label,
            value: provider.id,
            default: provider.id === providerId,
        })),
    ];

    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:provider:${settingKey}`)
            .setPlaceholder(uiText('provider', locale))
            .addOptions(options)
    );
}

function buildSettingSelect(providerId, settingKey, locale) {
    const options = getSettingSpecs(providerId).map(spec => ({
        label: truncate(specLabel(spec, locale), 100),
        value: spec.key,
        description: truncate(specDescription(spec, locale), 100),
        default: spec.key === settingKey,
    }));
    const chunks = [];
    for (let i = 0; i < options.length; i += 25) chunks.push(options.slice(i, i + 25));

    return chunks.map((chunk, index) => new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(index === 0
                ? `${CUSTOM_ID_PREFIX}:setting:${providerId}`
                : `${CUSTOM_ID_PREFIX}:setting:${providerId}:${index}`)
            .setPlaceholder(index === 0 ? uiText('setting', locale) : `${uiText('setting', locale)} ${index + 1}`)
            .addOptions(chunk)
    ));
}

function buildUtilityButtons(providerId, settingKey, locale) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:refresh:${providerId}:${settingKey}`)
            .setLabel(uiText('refresh', locale))
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:close:${providerId}:${settingKey}`)
            .setLabel(uiText('close', locale))
            .setStyle(ButtonStyle.Secondary)
    );
}

function buildOverviewUtilityButtons(providerId, locale) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:modalOpen:copyGuildSettings:${providerId}:${DEFAULT_SETTING_KEY}`)
            .setLabel(localText('importFromGuild', locale))
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:refresh:${providerId}:${DEFAULT_SETTING_KEY}`)
            .setLabel(uiText('refresh', locale))
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:close:${providerId}:${DEFAULT_SETTING_KEY}`)
            .setLabel(uiText('close', locale))
            .setStyle(ButtonStyle.Secondary)
    );
}

async function buildBoolControls(providerId, spec, guildId, locale) {
    const value = await getBooleanSettingValue(providerId, spec, guildId);
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:bool:${providerId}:${spec.key}:1`)
                .setLabel(uiText('enable', locale))
                .setStyle(value === true ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setDisabled(value === true),
            new ButtonBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:bool:${providerId}:${spec.key}:0`)
                .setLabel(uiText('disable', locale))
                .setStyle(value === false ? ButtonStyle.Danger : ButtonStyle.Secondary)
                .setDisabled(value === false),
            new ButtonBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:refresh:${providerId}:${spec.key}`)
                .setLabel(uiText('refresh', locale))
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:close:${providerId}:${spec.key}`)
                .setLabel(uiText('close', locale))
                .setStyle(ButtonStyle.Secondary)
        ),
    ];
}

async function buildChoiceControls(providerId, spec, guildId, locale) {
    const currentValue = isBulkProvider(providerId)
        ? aggregateChoice(await getBulkSettingValues(spec, guildId))
        : await getSetting({ id: providerId }, spec.settingKey, guildId);
    if (spec.key === 'defaultLanguage') {
        return buildDefaultLanguageControls(providerId, spec, currentValue, locale);
    }
    return [
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:choice:${providerId}:${spec.key}`)
                .setPlaceholder(uiText('value', locale))
                .addOptions((spec.choices || []).map(choice => ({
                    label: truncate(choiceLabel(spec, choice, locale), 100),
                    value: String(choice.value),
                    default: String(choice.value) === String(currentValue),
                })))
        ),
        buildUtilityButtons(providerId, spec.key, locale),
    ];
}

function buildDefaultLanguageControls(providerId, spec, currentValue, locale) {
    const normalized = normalizeDiscordLocale(currentValue);
    const currentLabel = normalized ? formatDiscordLocaleName(normalized) : uiText('empty', locale);
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:modalOpen:defaultLanguage:${providerId}:${spec.key}`)
                .setLabel(localText('setDefaultLanguage', locale))
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:refresh:${providerId}:${spec.key}`)
                .setLabel(uiText('refresh', locale))
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:close:${providerId}:${spec.key}`)
                .setLabel(uiText('close', locale))
                .setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:noop:${providerId}:${spec.key}`)
                .setLabel(truncate(currentLabel, 80))
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true)
        ),
    ];
}

async function buildMultiChoiceControls(providerId, spec, guildId, locale) {
    const currentValues = new Set(isBulkProvider(providerId)
        ? []
        : await normalizeMultiChoiceSetting(providerId, spec, guildId));
    const options = choiceOptions(spec);
    if (options.length === 0) return [buildUtilityButtons(providerId, spec.key, locale)];

    return [
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:multiChoice:${providerId}:${spec.key}`)
                .setPlaceholder(specLabel(spec, locale))
                .setMinValues(0)
                .setMaxValues(options.length)
                .addOptions(options.map(choice => ({
                    label: truncate(choiceLabel(spec, choice, locale), 100),
                    value: String(choice.value),
                    default: currentValues.has(String(choice.value)),
                })))
        ),
        buildUtilityButtons(providerId, spec.key, locale),
    ];
}

async function buildButtonVisibilityControls(providerId, guildId, locale) {
    const visibility = await normalizeButtonVisibility(providerId, guildId);
    const options = getButtonOptions(providerId);
    return [
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:buttonVisibility:${providerId}`)
                .setPlaceholder(uiText('hiddenButtons', locale))
                .setMinValues(0)
                .setMaxValues(options.length)
                .addOptions(options.map(option => ({
                    label: buttonOptionLabel(option, locale),
                    value: option.key,
                    default: visibility[option.key] === true,
                })))
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:buttonVisibilityPreset:${providerId}:none`)
                .setLabel(uiText('showAll', locale))
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:buttonVisibilityPreset:${providerId}:all`)
                .setLabel(uiText('hideAll', locale))
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:refresh:${providerId}:button_invisible`)
                .setLabel(uiText('refresh', locale))
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:close:${providerId}:button_invisible`)
                .setLabel(uiText('close', locale))
                .setStyle(ButtonStyle.Secondary)
        ),
    ];
}

async function buildOutputVisibilityControls(providerId, spec, guildId, locale) {
    const hiddenItems = new Set(await normalizeOutputVisibility(providerId, spec, guildId));
    const options = getOutputItems(spec);
    if (options.length === 0) return [buildUtilityButtons(providerId, spec.key, locale)];

    const chunks = [];
    for (let i = 0; i < options.length; i += 25) chunks.push(options.slice(i, i + 25));
    const selectRows = chunks.map((chunk, index) => (
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(chunks.length === 1
                    ? `${CUSTOM_ID_PREFIX}:outputVisibility:${providerId}:${spec.key}`
                    : `${CUSTOM_ID_PREFIX}:outputVisibility:${providerId}:${spec.key}:${index}`)
                .setPlaceholder(chunks.length === 1 ? specLabel(spec, locale) : `${specLabel(spec, locale)} ${index + 1}`)
                .setMinValues(0)
                .setMaxValues(chunk.length)
                .addOptions(chunk.map(option => {
                    const out = {
                        label: truncate(outputItemLabel(option, locale), 100),
                        value: option.value,
                        default: hiddenItems.has(option.value),
                    };
                    const description = outputItemDescription(option, locale);
                    if (description) out.description = truncate(description, 100);
                    return out;
                }))
        )
    ));

    return [
        ...selectRows,
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:outputVisibilityPreset:${providerId}:${spec.key}:none`)
                .setLabel(uiText('showAll', locale))
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:outputVisibilityPreset:${providerId}:${spec.key}:all`)
                .setLabel(uiText('hideAll', locale))
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:refresh:${providerId}:${spec.key}`)
                .setLabel(uiText('refresh', locale))
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:close:${providerId}:${spec.key}`)
                .setLabel(uiText('close', locale))
                .setStyle(ButtonStyle.Secondary)
        ),
    ];
}

function buildTargetControls(providerId, spec, locale) {
    return [
        new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:target:${providerId}:${spec.key}:user`)
                .setPlaceholder(uiText('toggleUsers', locale))
                .setMinValues(1)
                .setMaxValues(10)
        ),
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:target:${providerId}:${spec.key}:channel`)
                .setPlaceholder(uiText('toggleChannels', locale))
                .setMinValues(1)
                .setMaxValues(10)
        ),
        new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:target:${providerId}:${spec.key}:role`)
                .setPlaceholder(uiText('toggleRoles', locale))
                .setMinValues(1)
                .setMaxValues(10)
        ),
    ];
}

async function buildBannedWordControls(providerId, guildId, locale) {
    const rows = [];
    const words = await normalizeBannedWords(providerId, guildId);
    if (words.length > 0) {
        const shownWords = words.slice(0, 25);
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:bannedRemove:${providerId}`)
                .setPlaceholder(uiText('removeBannedWords', locale))
                .setMinValues(1)
                .setMaxValues(shownWords.length)
                .addOptions(shownWords.map((word, index) => ({
                    label: truncate(word, 100),
                    value: String(index),
                })))
        ));
    }

    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:modalOpen:bannedWords:${providerId}`)
            .setLabel(uiText('addRemoveWord', locale))
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:refresh:${providerId}:bannedWords`)
            .setLabel(uiText('refresh', locale))
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:close:${providerId}:bannedWords`)
            .setLabel(uiText('close', locale))
            .setStyle(ButtonStyle.Secondary)
    ));
    return rows;
}

async function buildControls(providerId, spec, guildId, locale) {
    if (spec.kind === 'bool' || spec.kind === 'providerEnabled') {
        return await buildBoolControls(providerId, spec, guildId, locale);
    }
    if (spec.kind === 'choice') return await buildChoiceControls(providerId, spec, guildId, locale);
    if (spec.kind === 'multiChoice') return await buildMultiChoiceControls(providerId, spec, guildId, locale);
    if (spec.kind === 'buttonVisibility') return await buildButtonVisibilityControls(providerId, guildId, locale);
    if (spec.kind === 'outputVisibility') return await buildOutputVisibilityControls(providerId, spec, guildId, locale);
    if (spec.kind === 'targets') return buildTargetControls(providerId, spec, locale);
    if (spec.kind === 'bannedWords') return await buildBannedWordControls(providerId, guildId, locale);
    if (spec.kind === 'overview') return [buildOverviewUtilityButtons(providerId, locale)];
    return [buildUtilityButtons(providerId, spec.key, locale)];
}

function fallbackText(value, locale) {
    return value || uiText('empty', locale);
}

async function buildFields(providerId, spec, guildId, locale) {
    if (spec.kind !== 'overview') {
        return [
            {
                name: uiText('currentValue', locale),
                value: fallbackText(truncate(await formatSettingValue(providerId, spec, guildId, locale), 1024), locale),
                inline: false,
            },
            {
                name: uiText('setting', locale),
                value: truncate(specDescription(spec, locale), 1024),
                inline: false,
            },
        ];
    }

    const fields = [];
    for (const candidate of getSettingSpecs(providerId).filter(candidate => candidate.kind !== 'overview')) {
        fields.push({
            name: truncate(specLabel(candidate, locale), 256),
            value: fallbackText(truncate(await formatSettingValue(providerId, candidate, guildId, locale), 1024), locale),
            inline: candidate.kind === 'bool' || candidate.kind === 'choice',
        });
    }
    return fields;
}

async function buildGuiPayload(providerId, settingKey, guildId, notice = null, locale = 'en-US') {
    const normalizedProviderId = normalizeProviderId(providerId);
    const normalizedSettingKey = normalizeSettingKey(normalizedProviderId, settingKey);
    const spec = findSpec(normalizedProviderId, normalizedSettingKey);
    const providerLabel = getProviderLabel(normalizedProviderId, locale);
    const embed = {
        title: uiText('title', locale, { provider: providerLabel }),
        description: spec.kind === 'overview'
            ? (isBulkProvider(normalizedProviderId) ? localText('allProviderSettings', locale) : uiText('selectSettingToEdit', locale))
            : uiText('editing', locale, { label: specLabel(spec, locale) }),
        color: 0x1DA1F2,
        fields: await buildFields(normalizedProviderId, spec, guildId, locale),
    };
    if (notice) embed.footer = { text: truncate(notice, 2048) };

    const controls = await buildControls(normalizedProviderId, spec, guildId, locale);
    return {
        content: '',
        embeds: [embed],
        components: [
            buildProviderSelect(normalizedProviderId, normalizedSettingKey, locale),
            ...buildSettingSelect(normalizedProviderId, normalizedSettingKey, locale),
            ...controls,
        ],
        allowedMentions: { parse: [] },
    };
}

function buildBannedWordModal(providerId, locale) {
    const wordInput = new TextInputBuilder()
        .setCustomId(BANNED_WORD_INPUT_ID)
        .setLabel(uiText('word', locale))
        .setPlaceholder(uiText('bannedWordPlaceholder', locale))
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);

    return new ModalBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:modal:bannedWords:${providerId}`)
        .setTitle(uiText('bannedWordModalTitle', locale))
        .addComponents({
            type: 1,
            components: [wordInput.toJSON()],
        });
}

function buildDefaultLanguageModal(providerId, settingKey, locale) {
    const languageInput = new TextInputBuilder()
        .setCustomId(DEFAULT_LANGUAGE_INPUT_ID)
        .setLabel(localText('setDefaultLanguage', locale))
        .setPlaceholder(localText('defaultLanguagePlaceholder', locale))
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(16);

    return new ModalBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:modal:defaultLanguage:${providerId}:${settingKey}`)
        .setTitle(localText('setDefaultLanguage', locale))
        .addComponents({
            type: 1,
            components: [languageInput.toJSON()],
        });
}

function buildCopySettingsModal(providerId, settingKey, locale) {
    const sourceGuildInput = new TextInputBuilder()
        .setCustomId(COPY_SOURCE_GUILD_INPUT_ID)
        .setLabel(localText('sourceGuildId', locale))
        .setPlaceholder(localText('sourceGuildPlaceholder', locale))
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(32);

    return new ModalBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:modal:copyGuildSettings:${providerId}:${settingKey}`)
        .setTitle(localText('copyModalTitle', locale))
        .addComponents({
            type: 1,
            components: [sourceGuildInput.toJSON()],
        });
}

function normalizeGuildIdInput(value) {
    return String(value ?? '').trim();
}

function cloneSettingValue(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function onlyUserTargets(setting) {
    const normalized = {
        user: Array.isArray(setting?.user) ? [...new Set(setting.user.map(String).filter(Boolean))] : [],
        channel: [],
        role: [],
    };
    const skipped = (Array.isArray(setting?.channel) ? setting.channel.length : 0)
        + (Array.isArray(setting?.role) ? setting.role.length : 0);
    return { value: normalized, skipped };
}

async function copySettingForProvider(providerId, spec, sourceGuildId, targetGuildId) {
    let skippedTargets = 0;
    let value;

    if (spec.kind === 'targets') {
        const copied = onlyUserTargets(await normalizeTargetSetting(providerId, spec.settingKey, sourceGuildId));
        value = copied.value;
        skippedTargets = copied.skipped;
    } else if (spec.kind === 'buttonVisibility') {
        value = await normalizeButtonVisibility(providerId, sourceGuildId);
    } else if (spec.kind === 'outputVisibility') {
        value = await normalizeOutputVisibility(providerId, spec, sourceGuildId);
    } else if (spec.kind === 'bannedWords') {
        value = await normalizeBannedWords(providerId, sourceGuildId);
    } else {
        value = await getSettingValueForSpec(providerId, spec, sourceGuildId);
    }

    await applySettingValue(providerId, spec.settingKey, targetGuildId, cloneSettingValue(value));
    return { copied: 1, skippedTargets };
}

async function copyGuiSettingsBetweenGuilds(sourceGuildId, targetGuildId) {
    let copied = 0;
    let skippedTargets = 0;
    const providers = getProviders();

    for (const provider of providers) {
        const specs = getSettingSpecs(provider.id).filter(spec => spec.kind !== 'overview');
        for (const spec of specs) {
            const result = await copySettingForProvider(provider.id, spec, sourceGuildId, targetGuildId);
            copied += result.copied;
            skippedTargets += result.skippedTargets;
        }
    }

    return {
        copied,
        skippedTargets,
        providerCount: providers.length,
    };
}

async function importSettingsFromGuild(interaction, sourceGuildId, targetGuildId) {
    if (!sourceGuildId) return localText('sourceGuildId', interaction.locale);
    if (sourceGuildId === targetGuildId) return localText('copySameGuild', interaction.locale);

    if (!hasAdminPerm(interaction)) return localText('copyNoTargetPermission', interaction.locale);

    const result = await copyGuiSettingsBetweenGuilds(sourceGuildId, targetGuildId);
    const lines = [
        localText('copyDone', interaction.locale, {
            source: sourceGuildId,
            settings: result.copied,
            providers: result.providerCount,
        }),
    ];
    if (result.skippedTargets > 0) {
        lines.push(localText('copySkippedTargets', interaction.locale, { count: result.skippedTargets }));
    }
    return lines.join('\n');
}

async function execute(interaction) {
    if (!hasAdminPerm(interaction)) {
        return await interaction.editReply(uiText('noPermission', interaction.locale));
    }

    const providerId = normalizeProviderId(interaction.options.getString('provider') || DEFAULT_PROVIDER_ID);
    return await interaction.editReply(await buildGuiPayload(providerId, DEFAULT_SETTING_KEY, interaction.guildId, null, interaction.locale));
}

async function handleComponent(interaction) {
    const parts = parseCustomId(interaction.customId);
    if (!parts) return false;

    if (!hasAdminPerm(interaction)) {
        await replyNoPermission(interaction);
        return true;
    }

    const action = parts[1];
    if (action === 'modalOpen' && parts[2] === 'bannedWords') {
        if (!canManageMessages(interaction)) {
            await deferGuiMessageUpdate(interaction);
            await updateGuiMessage(interaction, await buildGuiPayload(
                parts[3],
                'bannedWords',
                interaction.guildId,
                uiText('manageMessagesRequired', interaction.locale),
                interaction.locale
            ));
            return true;
        }
        await interaction.showModal(buildBannedWordModal(normalizeProviderId(parts[3]), interaction.locale));
        return true;
    }
    if (action === 'modalOpen' && parts[2] === 'defaultLanguage') {
        const providerId = normalizeProviderId(parts[3]);
        const settingKey = normalizeSettingKey(providerId, parts[4] || 'defaultLanguage');
        await interaction.showModal(buildDefaultLanguageModal(providerId, settingKey, interaction.locale));
        return true;
    }
    if (action === 'modalOpen' && parts[2] === 'copyGuildSettings') {
        const providerId = normalizeProviderId(parts[3]);
        const settingKey = normalizeSettingKey(providerId, parts[4] || DEFAULT_SETTING_KEY);
        await interaction.showModal(buildCopySettingsModal(providerId, settingKey, interaction.locale));
        return true;
    }

    if (action === 'close') {
        await interaction.update({ content: uiText('closed', interaction.locale), embeds: [], components: [] });
        return true;
    }

    let providerId = normalizeProviderId(parts[2]);
    let settingKey = normalizeSettingKey(providerId, parts[3] || DEFAULT_SETTING_KEY);
    let notice = null;
    const needsPersistence = [
        'bool',
        'choice',
        'multiChoice',
        'buttonVisibility',
        'buttonVisibilityPreset',
        'outputVisibility',
        'outputVisibilityPreset',
        'target',
        'bannedRemove',
    ].includes(action);

    if (needsPersistence) {
        await deferGuiMessageUpdate(interaction);
    }

    if (action === 'provider') {
        providerId = normalizeProviderId(interaction.values[0]);
        settingKey = normalizeSettingKey(providerId, parts[2] || DEFAULT_SETTING_KEY);
    } else if (action === 'setting') {
        providerId = normalizeProviderId(parts[2]);
        settingKey = normalizeSettingKey(providerId, interaction.values[0]);
    } else if (action === 'bool') {
        const spec = findSpec(providerId, settingKey);
        await applySettingValue(providerId, spec.settingKey, interaction.guildId, parts[4] === '1');
        const valueLabel = boolLabel(parts[4] === '1', interaction.locale);
        notice = isBulkProvider(providerId)
            ? localText('updatedAllProvidersSetting', interaction.locale, { setting: specLabel(spec, interaction.locale), value: valueLabel })
            : `${specLabel(spec, interaction.locale)}: ${valueLabel}`;
    } else if (action === 'choice') {
        const spec = findSpec(providerId, settingKey);
        const selectedValue = interaction.values[0];
        const value = typeof spec.parseValue === 'function' ? spec.parseValue(selectedValue) : selectedValue;
        await applySettingValue(providerId, spec.settingKey, interaction.guildId, value);
        const valueLabel = formatChoiceValue(spec, value, interaction.locale);
        notice = isBulkProvider(providerId)
            ? localText('updatedAllProvidersSetting', interaction.locale, { setting: specLabel(spec, interaction.locale), value: valueLabel })
            : `${specLabel(spec, interaction.locale)}: ${valueLabel}`;
    } else if (action === 'multiChoice') {
        const spec = findSpec(providerId, settingKey);
        notice = await applyMultiChoiceSelection(providerId, spec, interaction.guildId, interaction.values || [], interaction.locale);
    } else if (action === 'buttonVisibility') {
        settingKey = 'button_invisible';
        notice = await applyButtonVisibilitySelection(providerId, interaction.guildId, interaction.values || [], interaction.locale);
    } else if (action === 'buttonVisibilityPreset') {
        settingKey = 'button_invisible';
        const optionKeys = parts[3] === 'all' ? getButtonOptions(providerId).map(option => option.key) : [];
        notice = await applyButtonVisibilitySelection(providerId, interaction.guildId, optionKeys, interaction.locale);
    } else if (action === 'outputVisibility') {
        settingKey = normalizeSettingKey(providerId, parts[3] || 'hidden_output_items');
        const spec = findSpec(providerId, settingKey);
        const pageIndex = Number(parts[4]);
        const visibleItems = Number.isInteger(pageIndex) && pageIndex >= 0
            ? getOutputItems(spec).slice(pageIndex * 25, pageIndex * 25 + 25).map(option => option.value)
            : null;
        notice = await applyOutputVisibilitySelection(providerId, spec, interaction.guildId, interaction.values || [], interaction.locale, visibleItems);
    } else if (action === 'outputVisibilityPreset') {
        settingKey = normalizeSettingKey(providerId, parts[3] || 'hidden_output_items');
        const spec = findSpec(providerId, settingKey);
        const optionKeys = parts[4] === 'all' ? getOutputItems(spec).map(option => option.value) : [];
        notice = await applyOutputVisibilitySelection(providerId, spec, interaction.guildId, optionKeys, interaction.locale);
    } else if (action === 'target') {
        const spec = findSpec(providerId, settingKey);
        const targetType = parts[4];
        notice = await applyTargetToggle(providerId, spec.settingKey, interaction.guildId, targetType, interaction.values || [], interaction.locale);
    } else if (action === 'bannedRemove') {
        settingKey = 'bannedWords';
        if (!canManageMessages(interaction)) {
            notice = uiText('manageMessagesRequired', interaction.locale);
        } else {
            notice = await removeBannedWords(providerId, interaction.guildId, interaction.values || [], interaction.locale);
        }
    } else if (action === 'refresh') {
        // Redraw current state below.
    } else {
        notice = uiText('unknownGuiAction', interaction.locale);
    }

    await updateGuiMessage(interaction, await buildGuiPayload(providerId, settingKey, interaction.guildId, notice, interaction.locale));
    return true;
}

async function handleModalSubmit(interaction) {
    const parts = parseCustomId(interaction.customId);
    if (!parts || parts[1] !== 'modal') return false;

    if (!hasAdminPerm(interaction)) {
        await replyNoPermission(interaction);
        return true;
    }

    const modalKey = parts[2];
    let providerId = normalizeProviderId(parts[3]);
    let notice = uiText('unknownForm', interaction.locale);
    let settingKey = DEFAULT_SETTING_KEY;
    await deferModalResult(interaction);

    if (modalKey === 'bannedWords') {
        settingKey = 'bannedWords';
        if (!canManageMessages(interaction)) {
            notice = uiText('manageMessagesRequired', interaction.locale);
        } else {
            notice = await applyBannedWordInput(
                providerId,
                interaction.guildId,
                interaction.fields.getTextInputValue(BANNED_WORD_INPUT_ID),
                interaction.locale
            );
        }
    } else if (modalKey === 'defaultLanguage') {
        providerId = normalizeProviderId(parts[3]);
        settingKey = normalizeSettingKey(providerId, parts[4] || 'defaultLanguage');
        notice = await applyDefaultLanguageInput(
            providerId,
            settingKey,
            interaction.guildId,
            interaction.fields.getTextInputValue(DEFAULT_LANGUAGE_INPUT_ID),
            interaction.locale
        );
    } else if (modalKey === 'copyGuildSettings') {
        providerId = normalizeProviderId(parts[3]);
        settingKey = normalizeSettingKey(providerId, parts[4] || DEFAULT_SETTING_KEY);
        notice = await importSettingsFromGuild(
            interaction,
            normalizeGuildIdInput(interaction.fields.getTextInputValue(COPY_SOURCE_GUILD_INPUT_ID)),
            interaction.guildId
        );
    }

    const payload = await buildGuiPayload(providerId, settingKey, interaction.guildId, notice, interaction.locale);
    await interaction.editReply(payload);
    return true;
}

module.exports.execute = execute;
module.exports.handleComponent = handleComponent;
module.exports.handleModalSubmit = handleModalSubmit;
module.exports.definition = {
    name: 'guisetting',
    name_localizations: toDiscordLocalizationsForKey('gui.commandName'),
    description: 'Change settings with a GUI',
    description_localizations: toDiscordLocalizationsForKey('gui.commandDescription'),
    options: [
        {
            name: 'provider',
            description: 'Provider to open first',
            description_localizations: toDiscordLocalizationsForKey('gui.providerOptionDescription'),
            type: ApplicationCommandOptionType.String,
            required: false,
            choices: [
                { name: 'All providers', value: BULK_PROVIDER_ID },
                ...getProviders().map(provider => ({ name: provider.label, value: provider.id })),
            ],
        },
    ],
};

module.exports._internal = {
    applyBannedWordInput,
    applyDefaultLanguageInput,
    applySettingValue,
    buildGuiPayload,
    copyGuiSettingsBetweenGuilds,
    getSettingSpecs,
    importSettingsFromGuild,
    normalizeButtonVisibility,
    normalizeTargetSetting,
};

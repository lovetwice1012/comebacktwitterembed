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
const { settings, saveSettings } = require('../../settings');
const { loadProviders } = require('../../providers/_loader');
const {
    getSetting,
    isProviderEnabled,
    setProviderEnabled,
    setSetting,
} = require('../../providers/_provider_settings');
const { button_invisible_template } = require('../../utils');
const {
    catalogText,
    toDiscordLocalizationsForKey,
} = require('../../i18n');

const CUSTOM_ID_PREFIX = 'guisetting';
const DEFAULT_PROVIDER_ID = 'twitter';
const DEFAULT_SETTING_KEY = 'overview';
const BANNED_WORD_INPUT_ID = 'guisetting-banned-word';

const PROVIDER_LABEL_OVERRIDES = {
    twitter: 'Twitter / X',
    pixiv: 'Pixiv',
    booth: 'Booth',
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

function findProviderDefinition(providerId) {
    return getProviders().find(provider => provider.id === providerId)?.provider || { id: providerId, enabledByDefault: false };
}

function uiText(key, locale, replacements = {}) {
    return catalogText(`gui.${key}`, locale, replacements) || key;
}

function specLabel(spec, locale) {
    if (spec.key === 'enabled') return `${uiText('provider', locale)}: ${uiText('enabled', locale)}`;
    return catalogText(`gui.settings.${spec.key}.label`, locale) || spec.label;
}

function specDescription(spec, locale) {
    if (spec.key === 'enabled') return `${uiText('enable', locale)} / ${uiText('disable', locale)} ${uiText('provider', locale)}`;
    return catalogText(`gui.settings.${spec.key}.description`, locale) || spec.description;
}

function buttonOptionLabel(option, locale) {
    return catalogText(`gui.buttons.${option.key}`, locale) || option.label;
}

function choiceLabel(spec, choice, locale) {
    return catalogText(`gui.choices.${spec.key}.${choice.value}`, locale) || choice.label;
}

const TWITTER_LEGACY_KEYS = {
    defaultLanguage: 'defaultLanguage',
    editOriginalIfTranslate: 'editOriginalIfTranslate',
    extract_bot_message: 'extract_bot_message',
    legacy_mode: 'legacy_mode',
    passive_mode: 'passive_mode',
    bannedWords: 'bannedWords',
    anonymous_expand: 'anonymous_expand',
    secondary_extract_mode: 'secondary_extract_mode',
    secondary_extract_mode_multiple_images: 'secondary_extract_mode_multiple_images',
    secondary_extract_mode_video: 'secondary_extract_mode_video',
    sendMediaAsAttachmentsAsDefault: 'sendMediaAsAttachmentsAsDefault',
    deletemessageifonlypostedtweetlink: 'deletemessageifonlypostedtweetlink',
    deletemessageifonlypostedtweetlink_secoundaryextractmode: 'deletemessageifonlypostedtweetlink_secoundaryextractmode',
    alwaysreplyifpostedtweetlink: 'alwaysreplyifpostedtweetlink',
    quote_repost_max_depth: 'quote_repost_max_depth',
    quote_repost_do_not_extract: 'quote_repost_do_not_extract',
    button_invisible: 'button_invisible',
    button_disabled: 'button_disabled',
};

const BUTTON_VISIBILITY_OPTIONS = [
    { key: 'showMediaAsAttachments', label: 'Media as attachments' },
    { key: 'showAttachmentsAsEmbedsImage', label: 'Media in embeds' },
    { key: 'translate', label: 'Translate' },
    { key: 'delete', label: 'Delete' },
    { key: 'savetweet', label: 'Save tweet' },
];

const COMMON_SPECS = [
    {
        key: 'enabled',
        label: 'Provider enabled',
        description: 'Enable or disable this provider in the guild.',
        kind: 'providerEnabled',
        settingKey: 'enabled',
    },
    {
        key: 'disable',
        label: 'Disable extraction',
        description: 'Toggle disabled users, channels, and roles.',
        kind: 'targets',
        settingKey: 'disable',
    },
    {
        key: 'defaultLanguage',
        label: 'Default language',
        description: 'Language used by translate actions.',
        kind: 'choice',
        settingKey: 'defaultLanguage',
        choices: [
            { label: 'English', value: 'en' },
            { label: 'Japanese', value: 'ja' },
        ],
    },
    {
        key: 'editOriginalIfTranslate',
        label: 'Edit original after translate',
        description: 'Edit the original response when translating.',
        kind: 'bool',
        settingKey: 'editOriginalIfTranslate',
    },
    {
        key: 'extract_bot_message',
        label: 'Extract bot messages',
        description: 'Allow links posted by bots to be expanded.',
        kind: 'bool',
        settingKey: 'extract_bot_message',
    },
    {
        key: 'button_invisible',
        label: 'Hide buttons',
        description: 'Choose which response buttons should be hidden.',
        kind: 'buttonVisibility',
        settingKey: 'button_invisible',
    },
    {
        key: 'button_disabled',
        label: 'Disable buttons for targets',
        description: 'Toggle users, channels, and roles that cannot use buttons.',
        kind: 'targets',
        settingKey: 'button_disabled',
    },
];

const TWITTER_SPECS = [
    {
        key: 'bannedWords',
        label: 'Banned words',
        description: 'Add or remove words blocked from expansion.',
        kind: 'bannedWords',
        settingKey: 'bannedWords',
    },
    {
        key: 'sendMediaAsAttachmentsAsDefault',
        label: 'Media as attachments by default',
        description: 'Send media as attachments by default.',
        kind: 'bool',
        settingKey: 'sendMediaAsAttachmentsAsDefault',
    },
    {
        key: 'deletemessageifonlypostedtweetlink',
        label: 'Delete link-only message',
        description: 'Delete the source message when it only contains a tweet link.',
        kind: 'bool',
        settingKey: 'deletemessageifonlypostedtweetlink',
    },
    {
        key: 'deletemessageifonlypostedtweetlink_secoundaryextractmode',
        label: 'Delete link-only in secondary mode',
        description: 'Also delete link-only messages in secondary extract mode.',
        kind: 'bool',
        settingKey: 'deletemessageifonlypostedtweetlink_secoundaryextractmode',
    },
    {
        key: 'alwaysreplyifpostedtweetlink',
        label: 'Always reply to tweet links',
        description: 'Always reply when a tweet link is posted.',
        kind: 'bool',
        settingKey: 'alwaysreplyifpostedtweetlink',
    },
    {
        key: 'anonymous_expand',
        label: 'Anonymous expand',
        description: 'Hide requester and author information in expanded tweets.',
        kind: 'bool',
        settingKey: 'anonymous_expand',
    },
    {
        key: 'quote_repost_do_not_extract',
        label: 'Do not extract quote reposts',
        description: 'Skip expansion for quoted repost content.',
        kind: 'bool',
        settingKey: 'quote_repost_do_not_extract',
    },
    {
        key: 'quote_repost_max_depth',
        label: 'Quote repost max depth',
        description: 'Maximum quote repost expansion depth.',
        kind: 'choice',
        settingKey: 'quote_repost_max_depth',
        choices: Array.from({ length: 11 }, (_value, index) => ({
            label: index === 0 ? 'Unlimited' : String(index),
            value: String(index),
        })),
        parseValue: value => Number(value),
    },
    {
        key: 'legacy_mode',
        label: 'Legacy mode',
        description: 'Use legacy expansion behavior.',
        kind: 'bool',
        settingKey: 'legacy_mode',
    },
    {
        key: 'passive_mode',
        label: 'Passive mode',
        description: 'Send only media-view buttons.',
        kind: 'bool',
        settingKey: 'passive_mode',
    },
    {
        key: 'secondary_extract_mode',
        label: 'Secondary extract mode',
        description: 'Only send when selected secondary targets match.',
        kind: 'bool',
        settingKey: 'secondary_extract_mode',
    },
    {
        key: 'secondary_extract_mode_multiple_images',
        label: 'Secondary target: multiple images',
        description: 'Match posts with multiple images in secondary mode.',
        kind: 'bool',
        settingKey: 'secondary_extract_mode_multiple_images',
    },
    {
        key: 'secondary_extract_mode_video',
        label: 'Secondary target: videos',
        description: 'Match posts with videos in secondary mode.',
        kind: 'bool',
        settingKey: 'secondary_extract_mode_video',
    },
];

const PIXIV_SPECS = [
    {
        key: 'pixiv_images_per_step',
        label: 'Images per step',
        description: 'Number of Pixiv images sent per response step.',
        kind: 'choice',
        settingKey: 'pixiv_images_per_step',
        choices: [
            { label: '4', value: '4' },
            { label: '10', value: '10' },
        ],
        parseValue: value => Number(value),
    },
];

function overviewSpec() {
    return {
        key: DEFAULT_SETTING_KEY,
        label: 'Overview',
        description: 'Current GUI-editable settings.',
        kind: 'overview',
    };
}

function getSettingSpecs(providerId) {
    const specs = [overviewSpec(), ...COMMON_SPECS];
    if (providerId === 'twitter') return [...specs, ...TWITTER_SPECS];
    if (providerId === 'pixiv') return [...specs, ...PIXIV_SPECS];
    if (getProviderLabels()[providerId]) return specs;
    return [overviewSpec()];
}

function findSpec(providerId, settingKey) {
    return getSettingSpecs(providerId).find(spec => spec.key === settingKey) || overviewSpec();
}

function normalizeProviderId(providerId) {
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

function hasAdminPerm(interaction) {
    const permissions = interaction.memberPermissions || interaction.member?.permissions;
    return (
        hasPermission(permissions, PermissionsBitField.Flags.ManageChannels)
        || hasPermission(permissions, PermissionsBitField.Flags.ManageGuild)
        || hasPermission(permissions, PermissionsBitField.Flags.Administrator)
    );
}

async function replyNoPermission(interaction) {
    const payload = { content: uiText('noPermission', interaction.locale), ephemeral: true };
    if (interaction.replied || interaction.deferred) return await interaction.followUp(payload);
    return await interaction.reply(payload);
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

function getBooleanSettingValue(providerId, spec, guildId) {
    if (spec.kind === 'providerEnabled') return isProviderEnabled(findProviderDefinition(providerId), guildId);
    return getSetting({ id: providerId }, spec.settingKey, guildId) === true;
}

function ensureLegacyBucket(key) {
    if (!settings[key] || typeof settings[key] !== 'object') settings[key] = {};
    return settings[key];
}

function setProviderGuildSetting(providerId, settingKey, guildId, value) {
    setSetting({ id: providerId }, settingKey, guildId, value);
    if (providerId !== 'twitter') return;

    const legacyKey = TWITTER_LEGACY_KEYS[settingKey];
    if (!legacyKey) return;
    ensureLegacyBucket(legacyKey)[guildId] = value;
}

function normalizeTargetSetting(providerId, settingKey, guildId) {
    const raw = getSetting({ id: providerId }, settingKey, guildId);
    let out = raw && typeof raw === 'object' ? {
        user: Array.isArray(raw.user) ? [...raw.user] : [],
        channel: Array.isArray(raw.channel) ? [...raw.channel] : [],
        role: Array.isArray(raw.role) ? [...raw.role] : [],
    } : null;

    if (!out && providerId === 'twitter' && settingKey === 'disable') {
        out = {
            user: Array.isArray(settings.disable?.user) ? [...settings.disable.user] : [],
            channel: Array.isArray(settings.disable?.channel) ? [...settings.disable.channel] : [],
            role: Array.isArray(settings.disable?.role?.[guildId]) ? [...settings.disable.role[guildId]] : [],
        };
    }

    return out || { user: [], channel: [], role: [] };
}

function setTargetSetting(providerId, settingKey, guildId, value) {
    setSetting({ id: providerId }, settingKey, guildId, value);
    if (providerId !== 'twitter') return;

    if (settingKey === 'disable') {
        settings.disable.user = [...value.user];
        settings.disable.channel = [...value.channel];
        settings.disable.role[guildId] = [...value.role];
        return;
    }

    if (settingKey === 'button_disabled') {
        settings.button_disabled[guildId] = {
            user: [...value.user],
            channel: [...value.channel],
            role: [...value.role],
        };
    }
}

function normalizeButtonVisibility(providerId, guildId) {
    const raw = getSetting({ id: providerId }, 'button_invisible', guildId);
    const base = {
        ...button_invisible_template,
        savetweet: false,
    };
    if (!raw || typeof raw !== 'object') return base;
    return { ...base, ...raw };
}

function setButtonVisibility(providerId, guildId, value) {
    setSetting({ id: providerId }, 'button_invisible', guildId, value);
    if (providerId === 'twitter') settings.button_invisible[guildId] = { ...value };
}

function getButtonOptions(providerId) {
    return BUTTON_VISIBILITY_OPTIONS.filter(option => providerId === 'twitter' || option.key !== 'savetweet');
}

function normalizeBannedWords(providerId, guildId) {
    const raw = getSetting({ id: providerId }, 'bannedWords', guildId);
    return Array.isArray(raw) ? [...raw] : [];
}

function setBannedWords(providerId, guildId, words) {
    const uniqueWords = [];
    const seen = new Set();
    for (const word of words) {
        const normalized = String(word ?? '').normalize('NFC').trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        uniqueWords.push(normalized);
    }
    setProviderGuildSetting(providerId, 'bannedWords', guildId, uniqueWords);
}

function applySettingValue(providerId, settingKey, guildId, value) {
    if (settingKey === 'enabled') {
        setProviderEnabled(findProviderDefinition(providerId), guildId, value === true);
        return;
    }

    setProviderGuildSetting(providerId, settingKey, guildId, value);

    if (providerId !== 'twitter') return;
    if (settingKey === 'legacy_mode' && value === true) {
        setProviderGuildSetting(providerId, 'secondary_extract_mode', guildId, false);
    }
    if (settingKey === 'secondary_extract_mode' && value === true) {
        setProviderGuildSetting(providerId, 'legacy_mode', guildId, false);
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

function applyTargetToggle(providerId, settingKey, guildId, targetType, ids, locale) {
    const current = normalizeTargetSetting(providerId, settingKey, guildId);
    const result = toggleValues(current[targetType] || [], ids);
    const next = { ...current, [targetType]: result.values };
    setTargetSetting(providerId, settingKey, guildId, next);

    if (ids.length === 1) {
        const textKey = result.added === 1 ? 'addedTarget' : 'removedTarget';
        return uiText(textKey, locale, { target: formatTarget(targetType, ids[0]) });
    }
    return uiText('updatedTargets', locale, { targetType: targetTypeLabel(targetType, locale) });
}

function applyButtonVisibilitySelection(providerId, guildId, hiddenButtonKeys, locale) {
    const selected = new Set(hiddenButtonKeys);
    const next = normalizeButtonVisibility(providerId, guildId);
    for (const option of getButtonOptions(providerId)) {
        next[option.key] = selected.has(option.key);
    }
    if (providerId !== 'twitter') delete next.savetweet;
    setButtonVisibility(providerId, guildId, next);
    return uiText('updatedHiddenButtons', locale);
}

function applyBannedWordInput(providerId, guildId, rawWord, locale) {
    const word = String(rawWord ?? '').normalize('NFC').trim();
    if (!word) return uiText('bannedWordEmpty', locale);

    const words = normalizeBannedWords(providerId, guildId);
    const index = words.indexOf(word);
    if (index === -1) {
        words.push(word);
        setBannedWords(providerId, guildId, words);
        return uiText('addedBannedWord', locale, { word });
    }

    words.splice(index, 1);
    setBannedWords(providerId, guildId, words);
    return uiText('removedBannedWord', locale, { word });
}

function removeBannedWords(providerId, guildId, selectedIndexes, locale) {
    const indexes = new Set(
        (selectedIndexes || [])
            .map(value => Number(value))
            .filter(value => Number.isInteger(value) && value >= 0)
    );
    const currentWords = normalizeBannedWords(providerId, guildId);
    const words = currentWords.filter((_word, index) => !indexes.has(index));
    const removedCount = currentWords.length - words.length;
    setBannedWords(providerId, guildId, words);
    return uiText('removedBannedWordsCount', locale, { count: removedCount });
}

function canManageMessages(interaction) {
    const permissions = interaction.guild?.members?.me?.permissions;
    if (!permissions) return true;
    return hasPermission(permissions, PermissionsBitField.Flags.ManageMessages);
}

function formatChoiceValue(spec, value, locale) {
    const choice = (spec.choices || []).find(option => String(option.value) === String(value));
    return choice ? choiceLabel(spec, choice, locale) : String(value ?? '(unset)');
}

function formatTargetSummary(providerId, settingKey, guildId, locale) {
    const target = normalizeTargetSetting(providerId, settingKey, guildId);
    return [
        `${uiText('users', locale)}: ${target.user.length}`,
        `${uiText('channels', locale)}: ${target.channel.length}`,
        `${uiText('roles', locale)}: ${target.role.length}`,
    ].join('\n');
}

function formatButtonVisibilitySummary(providerId, guildId, locale) {
    const visibility = normalizeButtonVisibility(providerId, guildId);
    const hidden = getButtonOptions(providerId)
        .filter(option => visibility[option.key] === true)
        .map(option => buttonOptionLabel(option, locale));
    return hidden.length === 0 ? uiText('none', locale) : hidden.join('\n');
}

function formatBannedWordsSummary(providerId, guildId, locale) {
    const words = normalizeBannedWords(providerId, guildId);
    if (words.length === 0) return uiText('none', locale);
    const shown = words.slice(0, 10).map(word => `\`${truncate(word, 80)}\``);
    const suffix = words.length > shown.length
        ? `\n${uiText('moreItems', locale, { count: words.length - shown.length })}`
        : '';
    return shown.join('\n') + suffix;
}

function formatSettingValue(providerId, spec, guildId, locale) {
    if (spec.kind === 'targets') return formatTargetSummary(providerId, spec.settingKey, guildId, locale);
    if (spec.kind === 'buttonVisibility') return formatButtonVisibilitySummary(providerId, guildId, locale);
    if (spec.kind === 'bannedWords') return formatBannedWordsSummary(providerId, guildId, locale);

    if (spec.kind === 'providerEnabled') return boolLabel(getBooleanSettingValue(providerId, spec, guildId), locale);
    const value = getSetting({ id: providerId }, spec.settingKey, guildId);
    if (spec.kind === 'bool') return boolLabel(value === true, locale);
    if (spec.kind === 'choice') return formatChoiceValue(spec, value, locale);
    return value === undefined ? '(unset)' : String(value);
}

function buildProviderSelect(providerId, settingKey, locale) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:provider:${settingKey}`)
            .setPlaceholder(uiText('provider', locale))
            .addOptions(getProviders().map(provider => ({
                label: provider.label,
                value: provider.id,
                default: provider.id === providerId,
            })))
    );
}

function buildSettingSelect(providerId, settingKey, locale) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:setting:${providerId}`)
            .setPlaceholder(uiText('setting', locale))
            .addOptions(getSettingSpecs(providerId).map(spec => ({
                label: truncate(specLabel(spec, locale), 100),
                value: spec.key,
                description: truncate(specDescription(spec, locale), 100),
                default: spec.key === settingKey,
            })))
    );
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

function buildBoolControls(providerId, spec, guildId, locale) {
    const value = getBooleanSettingValue(providerId, spec, guildId);
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:bool:${providerId}:${spec.key}:1`)
                .setLabel(uiText('enable', locale))
                .setStyle(value ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setDisabled(value),
            new ButtonBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:bool:${providerId}:${spec.key}:0`)
                .setLabel(uiText('disable', locale))
                .setStyle(value ? ButtonStyle.Secondary : ButtonStyle.Danger)
                .setDisabled(!value),
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

function buildChoiceControls(providerId, spec, guildId, locale) {
    const currentValue = getSetting({ id: providerId }, spec.settingKey, guildId);
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

function buildButtonVisibilityControls(providerId, guildId, locale) {
    const visibility = normalizeButtonVisibility(providerId, guildId);
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

function buildBannedWordControls(providerId, guildId, locale) {
    const rows = [];
    const words = normalizeBannedWords(providerId, guildId);
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

function buildControls(providerId, spec, guildId, locale) {
    if (spec.kind === 'bool') return buildBoolControls(providerId, spec, guildId, locale);
    if (spec.kind === 'choice') return buildChoiceControls(providerId, spec, guildId, locale);
    if (spec.kind === 'buttonVisibility') return buildButtonVisibilityControls(providerId, guildId, locale);
    if (spec.kind === 'targets') return buildTargetControls(providerId, spec, locale);
    if (spec.kind === 'bannedWords') return buildBannedWordControls(providerId, guildId, locale);
    return [buildUtilityButtons(providerId, spec.key, locale)];
}

function fallbackText(value, locale) {
    return value || uiText('empty', locale);
}

function buildFields(providerId, spec, guildId, locale) {
    if (spec.kind !== 'overview') {
        return [
            {
                name: uiText('currentValue', locale),
                value: fallbackText(truncate(formatSettingValue(providerId, spec, guildId, locale), 1024), locale),
                inline: false,
            },
            {
                name: uiText('setting', locale),
                value: truncate(specDescription(spec, locale), 1024),
                inline: false,
            },
        ];
    }

    return getSettingSpecs(providerId)
        .filter(candidate => candidate.kind !== 'overview')
        .map(candidate => ({
            name: truncate(specLabel(candidate, locale), 256),
            value: fallbackText(truncate(formatSettingValue(providerId, candidate, guildId, locale), 1024), locale),
            inline: candidate.kind === 'bool' || candidate.kind === 'choice',
        }));
}

function buildGuiPayload(providerId, settingKey, guildId, notice = null, locale = 'en-US') {
    const normalizedProviderId = normalizeProviderId(providerId);
    const normalizedSettingKey = normalizeSettingKey(normalizedProviderId, settingKey);
    const spec = findSpec(normalizedProviderId, normalizedSettingKey);
    const providerLabel = getProviderLabels()[normalizedProviderId] || normalizedProviderId;
    const embed = {
        title: uiText('title', locale, { provider: providerLabel }),
        description: spec.kind === 'overview'
            ? uiText('selectSettingToEdit', locale)
            : uiText('editing', locale, { label: specLabel(spec, locale) }),
        color: 0x1DA1F2,
        fields: buildFields(normalizedProviderId, spec, guildId, locale),
    };
    if (notice) embed.footer = { text: truncate(notice, 2048) };

    return {
        content: '',
        embeds: [embed],
        components: [
            buildProviderSelect(normalizedProviderId, normalizedSettingKey, locale),
            buildSettingSelect(normalizedProviderId, normalizedSettingKey, locale),
            ...buildControls(normalizedProviderId, spec, guildId, locale),
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

async function execute(interaction) {
    if (!hasAdminPerm(interaction)) {
        return await interaction.editReply(uiText('noPermission', interaction.locale));
    }

    const providerId = normalizeProviderId(interaction.options.getString('provider') || DEFAULT_PROVIDER_ID);
    return await interaction.editReply(buildGuiPayload(providerId, DEFAULT_SETTING_KEY, interaction.guildId, null, interaction.locale));
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
            await interaction.update(buildGuiPayload(
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

    if (action === 'close') {
        await interaction.update({ content: uiText('closed', interaction.locale), embeds: [], components: [] });
        return true;
    }

    let providerId = normalizeProviderId(parts[2]);
    let settingKey = normalizeSettingKey(providerId, parts[3] || DEFAULT_SETTING_KEY);
    let notice = null;

    if (action === 'provider') {
        providerId = normalizeProviderId(interaction.values[0]);
        settingKey = normalizeSettingKey(providerId, parts[2] || DEFAULT_SETTING_KEY);
    } else if (action === 'setting') {
        providerId = normalizeProviderId(parts[2]);
        settingKey = normalizeSettingKey(providerId, interaction.values[0]);
    } else if (action === 'bool') {
        const spec = findSpec(providerId, settingKey);
        applySettingValue(providerId, spec.settingKey, interaction.guildId, parts[4] === '1');
        await saveSettings(settings);
        notice = `${specLabel(spec, interaction.locale)}: ${boolLabel(parts[4] === '1', interaction.locale)}`;
    } else if (action === 'choice') {
        const spec = findSpec(providerId, settingKey);
        const selectedValue = interaction.values[0];
        const value = typeof spec.parseValue === 'function' ? spec.parseValue(selectedValue) : selectedValue;
        applySettingValue(providerId, spec.settingKey, interaction.guildId, value);
        await saveSettings(settings);
        notice = `${specLabel(spec, interaction.locale)}: ${formatChoiceValue(spec, value, interaction.locale)}`;
    } else if (action === 'buttonVisibility') {
        settingKey = 'button_invisible';
        notice = applyButtonVisibilitySelection(providerId, interaction.guildId, interaction.values || [], interaction.locale);
        await saveSettings(settings);
    } else if (action === 'buttonVisibilityPreset') {
        settingKey = 'button_invisible';
        const optionKeys = parts[3] === 'all' ? getButtonOptions(providerId).map(option => option.key) : [];
        notice = applyButtonVisibilitySelection(providerId, interaction.guildId, optionKeys, interaction.locale);
        await saveSettings(settings);
    } else if (action === 'target') {
        const spec = findSpec(providerId, settingKey);
        const targetType = parts[4];
        notice = applyTargetToggle(providerId, spec.settingKey, interaction.guildId, targetType, interaction.values || [], interaction.locale);
        await saveSettings(settings);
    } else if (action === 'bannedRemove') {
        settingKey = 'bannedWords';
        if (!canManageMessages(interaction)) {
            notice = uiText('manageMessagesRequired', interaction.locale);
        } else {
            notice = removeBannedWords(providerId, interaction.guildId, interaction.values || [], interaction.locale);
            await saveSettings(settings);
        }
    } else if (action === 'refresh') {
        // Redraw current state below.
    } else {
        notice = uiText('unknownGuiAction', interaction.locale);
    }

    await interaction.update(buildGuiPayload(providerId, settingKey, interaction.guildId, notice, interaction.locale));
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
    const providerId = normalizeProviderId(parts[3]);
    let notice = uiText('unknownForm', interaction.locale);
    let settingKey = DEFAULT_SETTING_KEY;

    if (modalKey === 'bannedWords') {
        settingKey = 'bannedWords';
        if (!canManageMessages(interaction)) {
            notice = uiText('manageMessagesRequired', interaction.locale);
        } else {
            notice = applyBannedWordInput(
                providerId,
                interaction.guildId,
                interaction.fields.getTextInputValue(BANNED_WORD_INPUT_ID),
                interaction.locale
            );
            await saveSettings(settings);
        }
    }

    const payload = buildGuiPayload(providerId, settingKey, interaction.guildId, notice, interaction.locale);
    if (interaction.isFromMessage()) await interaction.update(payload);
    else await interaction.reply({ ...payload, ephemeral: true });
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
            choices: getProviders().map(provider => ({ name: provider.label, value: provider.id })),
        },
    ],
};

module.exports._internal = {
    applyBannedWordInput,
    applySettingValue,
    buildGuiPayload,
    getSettingSpecs,
    normalizeButtonVisibility,
    normalizeTargetSetting,
};

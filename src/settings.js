'use strict';

const fs = require('fs');

const SETTINGS_FILE = './settings.json';

const SETTINGS_DEFAULT_FILE = {
    disable: { user: [], channel: [], role: {} },
    bannedWords: {},
    defaultLanguage: {},
    editOriginalIfTranslate: {},
    sendMediaAsAttachmentsAsDefault: {},
    deletemessageifonlypostedtweetlink: {},
    alwaysreplyifpostedtweetlink: {},
    button_invisible: {},
    button_disabled: {},
    extract_bot_message: {},
    quote_repost_do_not_extract: {},
    legacy_mode: {},
    passive_mode: {},
    anonymous_expand: {},
    secondary_extract_mode: {},
    secondary_extract_mode_multiple_images: {},
    secondary_extract_mode_video: {},
    save_tweet_quota_override: {},
    deletemessageifonlypostedtweetlink_secoundaryextractmode: {},
    byProvider: {},
};

// 既存設定に対して後から追加されたキーのデフォルト値。
// パスは "a.b" 形式でネスト指定可能。
const SETTINGS_MIGRATIONS = {
    'disable.role': {},
    defaultLanguage: {},
    editOriginalIfTranslate: {},
    sendMediaAsAttachmentsAsDefault: {},
    deletemessageifonlypostedtweetlink: {},
    alwaysreplyifpostedtweetlink: {},
    button_invisible: {},
    button_disabled: {},
    extract_bot_message: {},
    quote_repost_do_not_extract: {},
    legacy_mode: {},
    passive_mode: {},
    anonymous_expand: {},
    secondary_extract_mode: {},
    secondary_extract_mode_multiple_images: {},
    secondary_extract_mode_video: {},
    save_tweet_quota_override: {},
    deletemessageifonlypostedtweetlink_secoundaryextractmode: {},
    quote_repost_max_depth: {},
    byProvider: {},
};

function getButtonInvisibleSettings(guildId, providerId = null, setting = null) {
    setting = setting || settings;

    if (providerId) {
        const providerSettings = setting.byProvider?.[providerId]?.button_invisible;
        if (providerSettings && providerSettings[guildId] !== undefined) return providerSettings[guildId];
    }

    return setting.button_invisible[guildId] || {};
}

function detectProviderIdFromMessage(message) {
    const url = message?.embeds?.[0]?.url || '';
    if (/pixiv\.net|phixiv\.net|ppxiv\.net/.test(url)) return 'pixiv';
    if (/booth\.pm/.test(url)) return 'booth';
    if (/twitter\.com|x\.com|vxtwitter\.com|fxtwitter\.com|twidata\.sprink\.cloud/.test(url)) return 'twitter';
    return null;
}

function saveSettings(settings) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4));
}

function applySettingsMigrations(settings) {
    let changed = false;
    for (const [keyPath, defaultValue] of Object.entries(SETTINGS_MIGRATIONS)) {
        const segments = keyPath.split('.');
        let target = settings;
        for (let i = 0; i < segments.length - 1; i++) {
            target = target[segments[i]];
            if (target === undefined) break;
        }
        if (target === undefined) continue;
        const last = segments[segments.length - 1];
        if (target[last] === undefined) {
            target[last] = defaultValue;
            changed = true;
        }
    }
    return changed;
}

function migrateLegacyTwitterSettings(settings) {
    if (!settings.byProvider) settings.byProvider = {};
    if (!settings.byProvider.twitter) settings.byProvider.twitter = {};

    const legacyMap = {
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

    let changed = false;
    for (const [providerKey, legacyKey] of Object.entries(legacyMap)) {
        if (!settings.byProvider.twitter[providerKey]) settings.byProvider.twitter[providerKey] = {};
        const legacyBucket = settings[legacyKey];
        if (!legacyBucket || typeof legacyBucket !== 'object') continue;
        for (const [guildId, value] of Object.entries(legacyBucket)) {
            if (settings.byProvider.twitter[providerKey][guildId] === undefined) {
                settings.byProvider.twitter[providerKey][guildId] = value;
                changed = true;
            }
        }
    }

    return changed;
}

if (!fs.existsSync(SETTINGS_FILE)) {
    saveSettings(SETTINGS_DEFAULT_FILE);
}
const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
if (applySettingsMigrations(settings) || migrateLegacyTwitterSettings(settings)) {
    saveSettings(settings);
}

// guild の button_invisible 設定に従い、無効化対象の custom_id を持つボタンを除外。
// 親 ActionRow が空になった場合はその ActionRow も除外する。
function checkComponentIncludesDisabledButtonAndIfFindDeleteIt(components, guildId, providerId = null, setting = null) {
    setting = setting || settings;
    const invisibleSettings = getButtonInvisibleSettings(guildId, providerId, setting);

    if (Object.values(invisibleSettings).every(value => value === false)) {
        return components;
    }

    return components.reduce((acc, component) => {
        if (!component.components || component.components.length === 0) return acc;

        const filteredComponents = component.components.filter(subComponent => {
            const id = (subComponent.data && subComponent.data.custom_id)
                || subComponent.custom_id
                || subComponent.customId;
            const baseId = typeof id === 'string' ? id.split(':')[0] : id;
            return baseId ? !(baseId in invisibleSettings && invisibleSettings[baseId] === true) : true;
        });

        if (filteredComponents.length > 0) {
            component.components = filteredComponents;
            acc.push(component);
        }
        return acc;
    }, []);
}

module.exports = {
    SETTINGS_FILE,
    SETTINGS_DEFAULT_FILE,
    SETTINGS_MIGRATIONS,
    saveSettings,
    applySettingsMigrations,
    settings,
    getButtonInvisibleSettings,
    detectProviderIdFromMessage,
    checkComponentIncludesDisabledButtonAndIfFindDeleteIt,
};

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
};

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

if (!fs.existsSync(SETTINGS_FILE)) {
    saveSettings(SETTINGS_DEFAULT_FILE);
}
const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
if (applySettingsMigrations(settings)) {
    saveSettings(settings);
}

// guild の button_invisible 設定に従い、無効化対象の custom_id を持つボタンを除外。
// 親 ActionRow が空になった場合はその ActionRow も除外する。
function checkComponentIncludesDisabledButtonAndIfFindDeleteIt(components, guildId, setting = null) {
    setting = setting || settings;
    const invisibleSettings = setting.button_invisible[guildId] || {};

    if (Object.values(invisibleSettings).every(value => value === false)) {
        return components;
    }

    return components.reduce((acc, component) => {
        if (!component.components || component.components.length === 0) return acc;

        const filteredComponents = component.components.filter(subComponent => {
            const id = subComponent.data && subComponent.data.custom_id;
            return id ? !(id in invisibleSettings && invisibleSettings[id] === true) : true;
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
    checkComponentIncludesDisabledButtonAndIfFindDeleteIt,
};

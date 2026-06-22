'use strict';

/**
 * プロバイダ単位の設定名前空間アクセサ。
 *
 * 値の格納先:
 *   settings.byProvider[providerId][key][guildId]
 *
 * 読み出し時のフォールバック順:
 *   1. settings.byProvider[providerId][key][guildId]
 *   2. (Twitter のみ) settings[key][guildId]               ← レガシー互換
 *   3. PROVIDER_DEFAULTS[key]
 *   4. undefined
 *
 * これにより既存ギルドの Twitter 設定はそのまま動き続け、新サイトを追加しても
 * その設定は別 namespace に保存されて Twitter には影響しない。
 */

const { settings } = require('../settings');

/** プロバイダ間で共通な機能の既定値 */
const PROVIDER_DEFAULTS = {
    enabled:                                              undefined, // provider.enabledByDefault が優先
    defaultLanguage:                                      undefined,
    editOriginalIfTranslate:                              false,
    extract_bot_message:                                  false,
    legacy_mode:                                          undefined, // 起動時に権限から決定
    passive_mode:                                         false,
    bannedWords:                                          [],
    button_invisible:                                     undefined,
    button_disabled:                                      undefined,
    anonymous_expand:                                     false,
    pixiv_images_per_step:                                undefined,
    secondary_extract_mode:                               false,
    secondary_extract_mode_multiple_images:               true,
    secondary_extract_mode_video:                         true,
    sendMediaAsAttachmentsAsDefault:                      false,
    deletemessageifonlypostedtweetlink:                   false,
    deletemessageifonlypostedtweetlink_secoundaryextractmode: false,
    alwaysreplyifpostedtweetlink:                         false,
    quote_repost_max_depth:                               0,
    quote_repost_do_not_extract:                          false,
};

/** Twitter のレガシー global キー (settings.<key>[gid] で書かれていた) */
const LEGACY_TWITTER_KEYS = new Set(Object.keys(PROVIDER_DEFAULTS).filter(k => k !== 'enabled'));

const LEGACY_TWITTER_KEY_MAP = {
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

function ensureNs(providerId, key) {
    if (!settings.byProvider) settings.byProvider = {};
    if (!settings.byProvider[providerId]) settings.byProvider[providerId] = {};
    if (!settings.byProvider[providerId][key]) settings.byProvider[providerId][key] = {};
    return settings.byProvider[providerId][key];
}

/**
 * @param {{id: string}} provider
 * @returns {any}
 */
function getSetting(provider, key, guildId) {
    const ns = settings.byProvider?.[provider.id]?.[key];
    if (ns && ns[guildId] !== undefined) return ns[guildId];
    // Twitter レガシー互換
    if (provider.id === 'twitter' && LEGACY_TWITTER_KEYS.has(key)) {
        const legacyKey = LEGACY_TWITTER_KEY_MAP[key] || key;
        if (settings[legacyKey] && settings[legacyKey][guildId] !== undefined) {
            return settings[legacyKey][guildId];
        }
    }
    return PROVIDER_DEFAULTS[key];
}

function setSetting(provider, key, guildId, value) {
    const ns = ensureNs(provider.id, key);
    ns[guildId] = value;
}

/**
 * provider 全設定をフラットなスナップショットで返す。
 * extractor へ渡す `settings` 引数を作る用。
 * 解決順は getSetting と同じ (per-provider → Twitter レガシー → defaults)。
 * @returns {Object<string, any>}
 */
function getProviderSettings(provider, guildId) {
    /** @type {any} */
    const out = {};
    for (const key of Object.keys(PROVIDER_DEFAULTS)) {
        const v = getSetting(provider, key, guildId);
        if (v !== undefined) out[key] = v;
    }
    // provider が独自にセットしているキーも拾う
    const ns = settings.byProvider?.[provider.id];
    if (ns) {
        for (const key of Object.keys(ns)) {
            if (out[key] === undefined && ns[key][guildId] !== undefined) out[key] = ns[key][guildId];
        }
    }
    return out;
}

/** プロバイダがそのギルドで有効か (`enabled[gid]` 未設定なら provider.enabledByDefault) */
function isProviderEnabled(provider, guildId) {
    const ns = settings.byProvider?.[provider.id]?.enabled;
    if (ns && ns[guildId] !== undefined) return ns[guildId] === true;
    return provider.enabledByDefault === true;
}

function setProviderEnabled(provider, guildId, value) {
    const ns = ensureNs(provider.id, 'enabled');
    ns[guildId] = value === true;
}

module.exports = {
    PROVIDER_DEFAULTS,
    getSetting,
    setSetting,
    getProviderSettings,
    isProviderEnabled,
    setProviderEnabled,
};

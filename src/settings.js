'use strict';

const fs = require('fs');
const path = require('path');
const { TABLES, ensureDatabaseSchema } = require('./db_schema');
const { normalizeHiddenOutputItems } = require('./providers/_output_visibility');

const SETTINGS_FILE = path.join(__dirname, '..', 'settings.json');

let _config = {};
try {
    const requireFn = require;
    _config = requireFn('../config.json');
} catch {
    _config = {};
}

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
    quote_repost_depth_by_account: {},
    legacy_mode: {},
    passive_mode: {},
    anonymous_expand: {},
    non_nsfw_channel_sensitive_restriction_enabled: {},
    sensitive_content_allowed_targets: {},
    sensitive_content_excluded_targets: {},
    pixiv_sensitive_non_nsfw_channel_sensitive_restriction_enabled: {},
    pixiv_sensitive_sensitive_content_allowed_targets: {},
    pixiv_sensitive_sensitive_content_excluded_targets: {},
    pixiv_r18_non_nsfw_channel_sensitive_restriction_enabled: {},
    pixiv_r18_sensitive_content_allowed_targets: {},
    pixiv_r18_sensitive_content_excluded_targets: {},
    pixiv_r18g_non_nsfw_channel_sensitive_restriction_enabled: {},
    pixiv_r18g_sensitive_content_allowed_targets: {},
    pixiv_r18g_sensitive_content_excluded_targets: {},
    secondary_extract_mode: {},
    secondary_extract_mode_multiple_images: {},
    secondary_extract_mode_video: {},
    save_tweet_quota_override: {},
    deletemessageifonlypostedtweetlink_secoundaryextractmode: {},
    quote_repost_max_depth: {},
    byProvider: {},
    pixiv_images_per_step: {},
    youtube_description_max_length: {},
    tiktok_hq: {},
    twitter_stats_layout: {},
    twitter_text_mode: {},
    twitter_quote_mode: {},
    twitter_quote_layout: {},
    youtube_video_list_limit: {},
    pixiv_caption_max_length: {},
    pixiv_tag_limit: {},
    pixiv_sensitive_display_mode: {},
    pixiv_r18_display_mode: {},
    pixiv_r18g_display_mode: {},
    instagram_caption_max_length: {},
    instagram_media_limit: {},
    github_card_style: {},
    hidden_output_items: {},
    display_density: {},
    media_display_mode: {},
    failure_display_policy: {},
    tiktok_description_max_length: {},
    tiktok_image_limit: {},
    tiktok_video_fallback_mode: {},
    niconico_description_max_length: {},
    spotify_description_max_length: {},
    twitch_description_max_length: {},
    steam_description_max_length: {},
    steam_image_source: {},
    amazon_description_max_length: {},
    amazon_extract_targets: {},
    booth_description_max_length: {},
    booth_image_limit: {},
    booth_adult_display_mode: {},
};

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
    quote_repost_depth_by_account: {},
    legacy_mode: {},
    passive_mode: {},
    anonymous_expand: {},
    non_nsfw_channel_sensitive_restriction_enabled: {},
    sensitive_content_allowed_targets: {},
    sensitive_content_excluded_targets: {},
    pixiv_sensitive_non_nsfw_channel_sensitive_restriction_enabled: {},
    pixiv_sensitive_sensitive_content_allowed_targets: {},
    pixiv_sensitive_sensitive_content_excluded_targets: {},
    pixiv_r18_non_nsfw_channel_sensitive_restriction_enabled: {},
    pixiv_r18_sensitive_content_allowed_targets: {},
    pixiv_r18_sensitive_content_excluded_targets: {},
    pixiv_r18g_non_nsfw_channel_sensitive_restriction_enabled: {},
    pixiv_r18g_sensitive_content_allowed_targets: {},
    pixiv_r18g_sensitive_content_excluded_targets: {},
    secondary_extract_mode: {},
    secondary_extract_mode_multiple_images: {},
    secondary_extract_mode_video: {},
    save_tweet_quota_override: {},
    deletemessageifonlypostedtweetlink_secoundaryextractmode: {},
    quote_repost_max_depth: {},
    byProvider: {},
    pixiv_images_per_step: {},
    youtube_description_max_length: {},
    tiktok_hq: {},
    twitter_stats_layout: {},
    twitter_text_mode: {},
    twitter_quote_mode: {},
    twitter_quote_layout: {},
    youtube_video_list_limit: {},
    pixiv_caption_max_length: {},
    pixiv_tag_limit: {},
    pixiv_sensitive_display_mode: {},
    pixiv_r18_display_mode: {},
    pixiv_r18g_display_mode: {},
    instagram_caption_max_length: {},
    instagram_media_limit: {},
    github_card_style: {},
    hidden_output_items: {},
    display_density: {},
    media_display_mode: {},
    failure_display_policy: {},
    tiktok_description_max_length: {},
    tiktok_image_limit: {},
    tiktok_video_fallback_mode: {},
    niconico_description_max_length: {},
    spotify_description_max_length: {},
    twitch_description_max_length: {},
    steam_description_max_length: {},
    steam_image_source: {},
    amazon_description_max_length: {},
    amazon_extract_targets: {},
    booth_description_max_length: {},
    booth_image_limit: {},
    booth_adult_display_mode: {},
};

const LEGACY_TWITTER_GUILD_KEYS = [
    'bannedWords',
    'defaultLanguage',
    'editOriginalIfTranslate',
    'sendMediaAsAttachmentsAsDefault',
    'deletemessageifonlypostedtweetlink',
    'alwaysreplyifpostedtweetlink',
    'button_invisible',
    'button_disabled',
    'extract_bot_message',
    'quote_repost_do_not_extract',
    'quote_repost_depth_by_account',
    'legacy_mode',
    'passive_mode',
    'anonymous_expand',
    'secondary_extract_mode',
    'secondary_extract_mode_multiple_images',
    'secondary_extract_mode_video',
    'deletemessageifonlypostedtweetlink_secoundaryextractmode',
    'quote_repost_max_depth',
];

const PROVIDER_SETTING_COLUMNS = {
    enabled: {
        column: 'enabled',
        type: 'bool',
    },
    defaultLanguage: {
        column: 'default_language',
        type: 'string',
    },
    editOriginalIfTranslate: {
        column: 'edit_original_if_translate',
        type: 'bool',
    },
    extract_bot_message: {
        column: 'extract_bot_message',
        type: 'bool',
    },
    legacy_mode: {
        column: 'legacy_mode',
        type: 'bool',
    },
    passive_mode: {
        column: 'passive_mode',
        type: 'bool',
    },
    anonymous_expand: {
        column: 'anonymous_expand',
        type: 'bool',
    },
    secondary_extract_mode: {
        column: 'secondary_extract_mode',
        type: 'bool',
    },
    secondary_extract_mode_multiple_images: {
        column: 'secondary_extract_mode_multiple_images',
        type: 'bool',
    },
    secondary_extract_mode_video: {
        column: 'secondary_extract_mode_video',
        type: 'bool',
    },
    sendMediaAsAttachmentsAsDefault: {
        column: 'send_media_as_attachments_as_default',
        type: 'bool',
    },
    deletemessageifonlypostedtweetlink: {
        column: 'delete_if_only_posted_tweet_link',
        type: 'bool',
    },
    deletemessageifonlypostedtweetlink_secoundaryextractmode: {
        column: 'delete_if_only_posted_tweet_link_secondary_extract_mode',
        type: 'bool',
    },
    alwaysreplyifpostedtweetlink: {
        column: 'always_reply_if_posted_tweet_link',
        type: 'bool',
    },
    quote_repost_max_depth: {
        column: 'quote_repost_max_depth',
        type: 'int',
    },
    quote_repost_do_not_extract: {
        column: 'quote_repost_do_not_extract',
        type: 'bool',
    },
    quote_repost_depth_by_account: {
        column: 'quote_repost_depth_by_account',
        type: 'jsonObject',
    },
    non_nsfw_channel_sensitive_restriction_enabled: {
        column: 'non_nsfw_channel_sensitive_restriction_enabled',
        type: 'bool',
    },
    pixiv_images_per_step: {
        column: 'pixiv_images_per_step',
        type: 'int',
    },
    youtube_description_max_length: {
        column: 'youtube_description_max_length',
        type: 'int',
    },
    youtube_video_list_limit: {
        column: 'youtube_video_list_limit',
        type: 'int',
    },
    tiktok_hq: {
        column: 'tiktok_hq',
        type: 'bool',
    },
    twitter_text_mode: {
        column: 'twitter_text_mode',
        type: 'string',
    },
    twitter_stats_layout: {
        column: 'twitter_stats_layout',
        type: 'string',
    },
    twitter_quote_mode: {
        column: 'twitter_quote_mode',
        type: 'string',
    },
    twitter_quote_layout: {
        column: 'twitter_quote_layout',
        type: 'string',
    },
    pixiv_caption_max_length: {
        column: 'pixiv_caption_max_length',
        type: 'int',
    },
    pixiv_tag_limit: {
        column: 'pixiv_tag_limit',
        type: 'string',
    },
    pixiv_sensitive_display_mode: {
        column: 'pixiv_sensitive_display_mode',
        type: 'string',
    },
    pixiv_r18_display_mode: {
        column: 'pixiv_r18_display_mode',
        type: 'string',
    },
    pixiv_r18g_display_mode: {
        column: 'pixiv_r18g_display_mode',
        type: 'string',
    },
    pixiv_sensitive_non_nsfw_channel_sensitive_restriction_enabled: {
        column: 'pixiv_sensitive_non_nsfw_channel_sensitive_restriction_enabled',
        type: 'bool',
    },
    pixiv_r18_non_nsfw_channel_sensitive_restriction_enabled: {
        column: 'pixiv_r18_non_nsfw_channel_sensitive_restriction_enabled',
        type: 'bool',
    },
    pixiv_r18g_non_nsfw_channel_sensitive_restriction_enabled: {
        column: 'pixiv_r18g_non_nsfw_channel_sensitive_restriction_enabled',
        type: 'bool',
    },
    instagram_caption_max_length: {
        column: 'instagram_caption_max_length',
        type: 'int',
    },
    instagram_media_limit: {
        column: 'instagram_media_limit',
        type: 'int',
    },
    github_card_style: {
        column: 'github_card_style',
        type: 'string',
    },
    hidden_output_items: {
        column: 'hidden_output_items',
        type: 'jsonArray',
    },
    display_density: {
        column: 'display_density',
        type: 'string',
    },
    media_display_mode: {
        column: 'media_display_mode',
        type: 'string',
    },
    failure_display_policy: {
        column: 'failure_display_policy',
        type: 'string',
    },
    tiktok_description_max_length: {
        column: 'tiktok_description_max_length',
        type: 'int',
    },
    tiktok_image_limit: {
        column: 'tiktok_image_limit',
        type: 'int',
    },
    tiktok_video_fallback_mode: {
        column: 'tiktok_video_fallback_mode',
        type: 'string',
    },
    niconico_description_max_length: {
        column: 'niconico_description_max_length',
        type: 'int',
    },
    spotify_description_max_length: {
        column: 'spotify_description_max_length',
        type: 'int',
    },
    twitch_description_max_length: {
        column: 'twitch_description_max_length',
        type: 'int',
    },
    steam_description_max_length: {
        column: 'steam_description_max_length',
        type: 'int',
    },
    steam_image_source: {
        column: 'steam_image_source',
        type: 'string',
    },
    amazon_description_max_length: {
        column: 'amazon_description_max_length',
        type: 'int',
    },
    amazon_extract_targets: {
        column: 'amazon_extract_targets',
        type: 'jsonArray',
    },
    booth_description_max_length: {
        column: 'booth_description_max_length',
        type: 'int',
    },
    booth_image_limit: {
        column: 'booth_image_limit',
        type: 'int',
    },
    booth_adult_display_mode: {
        column: 'booth_adult_display_mode',
        type: 'string',
    },
};

const PROVIDER_SETTING_COLUMN_NAMES = Object.values(PROVIDER_SETTING_COLUMNS).map(spec => spec.column);

const PROVIDER_TARGET_SETTING_TABLES = {
    sensitive_content_allowed_targets: TABLES.guildProviderSensitiveContentAllowedTargets,
    sensitive_content_excluded_targets: TABLES.guildProviderSensitiveContentExcludedTargets,
    pixiv_sensitive_sensitive_content_allowed_targets: TABLES.guildProviderPixivSensitiveContentAllowedTargets,
    pixiv_sensitive_sensitive_content_excluded_targets: TABLES.guildProviderPixivSensitiveContentExcludedTargets,
    pixiv_r18_sensitive_content_allowed_targets: TABLES.guildProviderPixivR18SensitiveContentAllowedTargets,
    pixiv_r18_sensitive_content_excluded_targets: TABLES.guildProviderPixivR18SensitiveContentExcludedTargets,
    pixiv_r18g_sensitive_content_allowed_targets: TABLES.guildProviderPixivR18gSensitiveContentAllowedTargets,
    pixiv_r18g_sensitive_content_excluded_targets: TABLES.guildProviderPixivR18gSensitiveContentExcludedTargets,
};

function cloneValue(value) {
    return JSON.parse(JSON.stringify(value));
}

function getSettingsStorageMode() {
    const storageConfig = _config.settings || {};
    const raw = process.env.SETTINGS_STORAGE || storageConfig.storage || _config.settingsStorage || 'mysql';
    const mode = String(raw).toLowerCase();
    if (mode !== 'mysql' && mode !== 'file') {
        throw new Error(`Unsupported SETTINGS_STORAGE: ${raw}`);
    }
    return mode;
}

function writeSettingsFile(nextSettings, filePath = SETTINGS_FILE) {
    fs.writeFileSync(filePath, JSON.stringify(nextSettings, null, 4));
}

function applyBaseDefaults(candidate) {
    const defaults = cloneValue(SETTINGS_DEFAULT_FILE);
    const source = candidate && typeof candidate === 'object' ? candidate : {};
    return {
        ...defaults,
        ...source,
        disable: {
            ...defaults.disable,
            ...(source.disable && typeof source.disable === 'object' ? source.disable : {}),
        },
        byProvider: source.byProvider && typeof source.byProvider === 'object' ? source.byProvider : {},
    };
}

function applySettingsMigrations(nextSettings) {
    let changed = false;
    for (const [keyPath, defaultValue] of Object.entries(SETTINGS_MIGRATIONS)) {
        const segments = keyPath.split('.');
        let target = nextSettings;
        for (let i = 0; i < segments.length - 1; i++) {
            target = target[segments[i]];
            if (target === undefined) break;
        }
        if (target === undefined) continue;
        const last = segments[segments.length - 1];
        if (target[last] === undefined) {
            target[last] = cloneValue(defaultValue);
            changed = true;
        }
    }
    return changed;
}

function migrateLegacyTwitterSettings(nextSettings) {
    if (!nextSettings.byProvider) nextSettings.byProvider = {};
    if (!nextSettings.byProvider.twitter) nextSettings.byProvider.twitter = {};

    let changed = false;
    for (const key of LEGACY_TWITTER_GUILD_KEYS) {
        if (!nextSettings.byProvider.twitter[key]) nextSettings.byProvider.twitter[key] = {};
        const legacyBucket = nextSettings[key];
        if (!legacyBucket || typeof legacyBucket !== 'object') continue;
        for (const [guildId, value] of Object.entries(legacyBucket)) {
            if (nextSettings.byProvider.twitter[key][guildId] === undefined) {
                nextSettings.byProvider.twitter[key][guildId] = value;
                changed = true;
            }
        }
    }

    return changed;
}

function normalizeSettings(candidate) {
    const nextSettings = applyBaseDefaults(candidate);
    const migrationChanged = applySettingsMigrations(nextSettings);
    const legacyChanged = migrateLegacyTwitterSettings(nextSettings);
    const changed = migrationChanged || legacyChanged;
    return { settings: nextSettings, changed };
}

function loadSettingsFromFile(filePath = SETTINGS_FILE, options = {}) {
    const createIfMissing = options.createIfMissing !== false;
    if (!fs.existsSync(filePath)) {
        if (!createIfMissing) {
            throw new Error(`Settings file not found: ${filePath}`);
        }
        const defaults = cloneValue(SETTINGS_DEFAULT_FILE);
        writeSettingsFile(defaults, filePath);
        return { settings: defaults, changed: true };
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const normalized = normalizeSettings(parsed);
    if (normalized.changed && createIfMissing) {
        writeSettingsFile(normalized.settings, filePath);
    }
    return normalized;
}

function replaceSettingsContents(target, source) {
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, source);
}

function ensureProviderSettingBucket(nextSettings, providerId, key) {
    if (!nextSettings.byProvider) nextSettings.byProvider = {};
    if (!nextSettings.byProvider[providerId]) nextSettings.byProvider[providerId] = {};
    if (!nextSettings.byProvider[providerId][key]) nextSettings.byProvider[providerId][key] = {};
    return nextSettings.byProvider[providerId][key];
}

function setProviderGuildSetting(nextSettings, providerId, guildId, key, value) {
    ensureProviderSettingBucket(nextSettings, providerId, key)[guildId] = value;
    if (providerId !== 'twitter') return;

    if (key === 'disable') {
        if (Array.isArray(value.role)) nextSettings.disable.role[guildId] = [...value.role];
    } else if (key === 'disable.role') {
        nextSettings.disable.role[guildId] = value;
    } else if (LEGACY_TWITTER_GUILD_KEYS.includes(key)) {
        nextSettings[key][guildId] = value;
    }
}

function convertDatabaseValue(row, spec) {
    const raw = row[spec.column];
    if (raw === null || raw === undefined) return undefined;
    if (spec.type === 'bool') return raw === true || raw === 1;
    if (spec.type === 'int') return Number(raw);
    if (spec.type === 'jsonArray') return normalizeHiddenOutputItems(raw);
    if (spec.type === 'jsonObject') return normalizeQuoteDepthByAccount(raw);
    return raw;
}

function normalizeQuoteDepthByAccount(raw) {
    let source = raw;
    if (typeof source === 'string') {
        try {
            source = source.trim() ? JSON.parse(source) : {};
        } catch {
            source = {};
        }
    }
    if (!source || typeof source !== 'object' || Array.isArray(source)) return {};

    const out = {};
    for (const [account, depth] of Object.entries(source)) {
        const handle = String(account || '').trim().replace(/^@/, '').toLowerCase();
        const numericDepth = Number(depth);
        if (!/^[a-z0-9_]{1,15}$/.test(handle)) continue;
        if (!Number.isInteger(numericDepth) || numericDepth < 0) continue;
        out[handle] = numericDepth;
    }
    return out;
}

function makeArraySetting(values) {
    return Array.from(values || []);
}

function makeTargetObject() {
    return { user: [], channel: [], role: [] };
}

function getGroupedTarget(groups, providerId, guildId) {
    const key = `${providerId}\0${guildId}`;
    if (!groups.has(key)) {
        groups.set(key, { providerId, guildId, value: makeTargetObject() });
    }
    return groups.get(key).value;
}

async function loadProviderTargetSetting(queryDatabase, nextSettings, settingKey, table) {
    const groups = new Map();
    const rows = await queryDatabase(
        `SELECT provider_id, guild_id, target_type, target_id
         FROM ${table}`
    );
    for (const row of rows) {
        getGroupedTarget(groups, row.provider_id, row.guild_id)[row.target_type].push(row.target_id);
    }
    for (const group of groups.values()) {
        setProviderGuildSetting(nextSettings, group.providerId, group.guildId, settingKey, group.value);
    }
    return rows.length;
}

function addProviderGuild(providerIds, guildIds, providerId, guildId) {
    providerIds.add(providerId);
    guildIds.add(guildId);
}

async function ensureProviderAndGuildRows(queryDatabase, providerIds, guildIds) {
    for (const providerId of providerIds) {
        await queryDatabase(
            `INSERT INTO ${TABLES.providers} (provider_id)
             VALUES (?)
             ON DUPLICATE KEY UPDATE provider_id = provider_id`,
            [providerId]
        );
    }
    for (const guildId of guildIds) {
        await queryDatabase(
            `INSERT INTO ${TABLES.guilds} (guild_id)
             VALUES (?)
             ON DUPLICATE KEY UPDATE guild_id = guild_id`,
            [guildId]
        );
    }
}

async function loadSettingsFromDatabase() {
    const { queryDatabase } = require('./db');
    await ensureDatabaseSchema();

    const nextSettings = cloneValue(SETTINGS_DEFAULT_FILE);
    let foundRows = 0;

    const quotaRows = await queryDatabase(
        `SELECT user_id, save_tweet_quota_override_bytes
         FROM ${TABLES.users}
         WHERE save_tweet_quota_override_bytes IS NOT NULL`
    );
    foundRows += quotaRows.length;
    for (const row of quotaRows) {
        nextSettings.save_tweet_quota_override[row.user_id] = row.save_tweet_quota_override_bytes;
    }

    const settingRows = await queryDatabase(`SELECT * FROM ${TABLES.guildProviderSettings}`);
    foundRows += settingRows.length;
    for (const row of settingRows) {
        for (const [settingKey, spec] of Object.entries(PROVIDER_SETTING_COLUMNS)) {
            const value = convertDatabaseValue(row, spec);
            if (value !== undefined) {
                setProviderGuildSetting(nextSettings, row.provider_id, row.guild_id, settingKey, value);
            }
        }
    }

    const disableGroups = new Map();
    const disableRows = await queryDatabase(
        `SELECT provider_id, guild_id, target_type, target_id
         FROM ${TABLES.guildProviderDisableTargets}`
    );
    foundRows += disableRows.length;
    for (const row of disableRows) {
        getGroupedTarget(disableGroups, row.provider_id, row.guild_id)[row.target_type].push(row.target_id);
    }
    for (const group of disableGroups.values()) {
        setProviderGuildSetting(nextSettings, group.providerId, group.guildId, 'disable', group.value);
    }

    for (const [settingKey, table] of Object.entries(PROVIDER_TARGET_SETTING_TABLES)) {
        foundRows += await loadProviderTargetSetting(queryDatabase, nextSettings, settingKey, table);
    }

    const bannedWordRows = await queryDatabase(
        `SELECT provider_id, guild_id, word
         FROM ${TABLES.guildProviderBannedWords}`
    );
    foundRows += bannedWordRows.length;
    const bannedWordGroups = new Map();
    for (const row of bannedWordRows) {
        const key = `${row.provider_id}\0${row.guild_id}`;
        if (!bannedWordGroups.has(key)) {
            bannedWordGroups.set(key, { providerId: row.provider_id, guildId: row.guild_id, words: new Set() });
        }
        bannedWordGroups.get(key).words.add(row.word);
    }
    for (const group of bannedWordGroups.values()) {
        setProviderGuildSetting(nextSettings, group.providerId, group.guildId, 'bannedWords', makeArraySetting(group.words));
    }

    const buttonVisibilityRows = await queryDatabase(
        `SELECT provider_id, guild_id, button_key, hidden
         FROM ${TABLES.guildProviderButtonVisibility}`
    );
    foundRows += buttonVisibilityRows.length;
    const buttonVisibilityGroups = new Map();
    for (const row of buttonVisibilityRows) {
        const key = `${row.provider_id}\0${row.guild_id}`;
        if (!buttonVisibilityGroups.has(key)) {
            buttonVisibilityGroups.set(key, { providerId: row.provider_id, guildId: row.guild_id, value: {} });
        }
        buttonVisibilityGroups.get(key).value[row.button_key] = row.hidden === true || row.hidden === 1;
    }
    for (const group of buttonVisibilityGroups.values()) {
        setProviderGuildSetting(nextSettings, group.providerId, group.guildId, 'button_invisible', group.value);
    }

    const buttonDisabledGroups = new Map();
    const buttonDisabledRows = await queryDatabase(
        `SELECT provider_id, guild_id, target_type, target_id
         FROM ${TABLES.guildProviderButtonDisabledTargets}`
    );
    foundRows += buttonDisabledRows.length;
    for (const row of buttonDisabledRows) {
        getGroupedTarget(buttonDisabledGroups, row.provider_id, row.guild_id)[row.target_type].push(row.target_id);
    }
    for (const group of buttonDisabledGroups.values()) {
        setProviderGuildSetting(nextSettings, group.providerId, group.guildId, 'button_disabled', group.value);
    }

    if (foundRows === 0) return null;
    return normalizeSettings(nextSettings);
}

function collectProviderScalarRows(normalized) {
    const rows = new Map();
    const put = (providerId, guildId, settingKey, value) => {
        const spec = PROVIDER_SETTING_COLUMNS[settingKey];
        if (!spec || value === undefined) return;
        const key = `${providerId}\0${guildId}`;
        if (!rows.has(key)) rows.set(key, { providerId, guildId, values: {} });
        rows.get(key).values[spec.column] = value;
    };

    for (const settingKey of Object.keys(PROVIDER_SETTING_COLUMNS)) {
        const legacyBucket = normalized[settingKey];
        if (legacyBucket && typeof legacyBucket === 'object') {
            for (const [guildId, value] of Object.entries(legacyBucket)) {
                put('twitter', guildId, settingKey, value);
            }
        }
    }

    for (const [providerId, providerSettings] of Object.entries(normalized.byProvider || {})) {
        if (!providerSettings || typeof providerSettings !== 'object') continue;
        for (const [settingKey, bucket] of Object.entries(providerSettings)) {
            if (!PROVIDER_SETTING_COLUMNS[settingKey] || !bucket || typeof bucket !== 'object') continue;
            for (const [guildId, value] of Object.entries(bucket)) {
                put(providerId, guildId, settingKey, value);
            }
        }
    }

    return [...rows.values()];
}

function addTargetRow(targetRows, providerId, guildId, targetType, targetId) {
    if (!targetId) return;
    targetRows.set(`${providerId}\0${guildId}\0${targetType}\0${targetId}`, {
        providerId,
        guildId,
        targetType,
        targetId,
    });
}

function collectTargetRows(normalized, settingKey, legacyBucket) {
    const rows = new Map();
    if (legacyBucket && typeof legacyBucket === 'object') {
        for (const [guildId, setting] of Object.entries(legacyBucket)) {
            if (!setting || typeof setting !== 'object') continue;
            for (const targetType of ['user', 'channel', 'role']) {
                for (const targetId of setting[targetType] || []) {
                    addTargetRow(rows, 'twitter', guildId, targetType, targetId);
                }
            }
        }
    }

    for (const [providerId, providerSettings] of Object.entries(normalized.byProvider || {})) {
        const bucket = providerSettings?.[settingKey];
        if (!bucket || typeof bucket !== 'object') continue;
        for (const [guildId, setting] of Object.entries(bucket)) {
            if (!setting || typeof setting !== 'object') continue;
            for (const targetType of ['user', 'channel', 'role']) {
                for (const targetId of setting[targetType] || []) {
                    addTargetRow(rows, providerId, guildId, targetType, targetId);
                }
            }
        }
    }

    return [...rows.values()];
}

function collectDisableTargetRows(normalized) {
    const rows = new Map();
    for (const row of collectTargetRows(normalized, 'disable', null)) {
        rows.set(`${row.providerId}\0${row.guildId}\0${row.targetType}\0${row.targetId}`, row);
    }
    for (const [guildId, roleIds] of Object.entries(normalized.disable?.role || {})) {
        for (const roleId of roleIds || []) {
            addTargetRow(rows, 'twitter', guildId, 'role', roleId);
        }
    }
    return [...rows.values()];
}

function collectBannedWordRows(normalized) {
    const rows = new Map();
    const put = (providerId, guildId, word) => {
        const normalizedWord = String(word ?? '').normalize('NFC').trim();
        if (!normalizedWord) return;
        rows.set(`${providerId}\0${guildId}\0${normalizedWord}`, { providerId, guildId, word: normalizedWord });
    };

    for (const [guildId, words] of Object.entries(normalized.bannedWords || {})) {
        for (const word of words || []) put('twitter', guildId, word);
    }
    for (const [providerId, providerSettings] of Object.entries(normalized.byProvider || {})) {
        const bucket = providerSettings?.bannedWords;
        if (!bucket || typeof bucket !== 'object') continue;
        for (const [guildId, words] of Object.entries(bucket)) {
            for (const word of words || []) put(providerId, guildId, word);
        }
    }

    return [...rows.values()];
}

function collectButtonVisibilityRows(normalized) {
    const rows = new Map();
    const put = (providerId, guildId, buttonKey, hidden) => {
        if (hidden === undefined) return;
        rows.set(`${providerId}\0${guildId}\0${buttonKey}`, {
            providerId,
            guildId,
            buttonKey,
            hidden: hidden === true,
        });
    };

    for (const [guildId, setting] of Object.entries(normalized.button_invisible || {})) {
        for (const [buttonKey, hidden] of Object.entries(setting || {})) put('twitter', guildId, buttonKey, hidden);
    }
    for (const [providerId, providerSettings] of Object.entries(normalized.byProvider || {})) {
        const bucket = providerSettings?.button_invisible;
        if (!bucket || typeof bucket !== 'object') continue;
        for (const [guildId, setting] of Object.entries(bucket)) {
            for (const [buttonKey, hidden] of Object.entries(setting || {})) put(providerId, guildId, buttonKey, hidden);
        }
    }

    return [...rows.values()];
}

async function saveSettingsToDatabase(nextSettings) {
    const { queryDatabase } = require('./db');
    await ensureDatabaseSchema();

    const normalized = normalizeSettings(nextSettings).settings;
    const providerIds = new Set();
    const guildIds = new Set();
    const scalarRows = collectProviderScalarRows(normalized);
    const disableRows = collectDisableTargetRows(normalized);
    const providerTargetRows = Object.entries(PROVIDER_TARGET_SETTING_TABLES).map(([settingKey, table]) => ({
        settingKey,
        table,
        rows: collectTargetRows(normalized, settingKey, null),
    }));
    const bannedWordRows = collectBannedWordRows(normalized);
    const buttonVisibilityRows = collectButtonVisibilityRows(normalized);
    const buttonDisabledRows = collectTargetRows(normalized, 'button_disabled', normalized.button_disabled);

    for (const row of [...scalarRows, ...disableRows, ...providerTargetRows.flatMap(group => group.rows), ...bannedWordRows, ...buttonVisibilityRows, ...buttonDisabledRows]) {
        addProviderGuild(providerIds, guildIds, row.providerId, row.guildId);
    }

    await queryDatabase('START TRANSACTION');
    try {
        await queryDatabase(`DELETE FROM ${TABLES.guildProviderButtonDisabledTargets}`);
        await queryDatabase(`DELETE FROM ${TABLES.guildProviderButtonVisibility}`);
        await queryDatabase(`DELETE FROM ${TABLES.guildProviderBannedWords}`);
        for (const group of providerTargetRows) {
            await queryDatabase(`DELETE FROM ${group.table}`);
        }
        await queryDatabase(`DELETE FROM ${TABLES.guildProviderDisableTargets}`);
        await queryDatabase(`DELETE FROM ${TABLES.guildProviderSettings}`);
        await queryDatabase(`UPDATE ${TABLES.users} SET save_tweet_quota_override_bytes = NULL`);

        await ensureProviderAndGuildRows(queryDatabase, providerIds, guildIds);

        for (const row of scalarRows) {
            const columnSpecs = Object.values(PROVIDER_SETTING_COLUMNS);
            const values = columnSpecs.map(spec => {
                const value = row.values[spec.column];
                if (value === undefined) return null;
                if (typeof value === 'boolean') return value ? 1 : 0;
                if (spec.type === 'jsonArray') return JSON.stringify(normalizeHiddenOutputItems(value));
                if (spec.type === 'jsonObject') return JSON.stringify(normalizeQuoteDepthByAccount(value));
                return value;
            });
            await queryDatabase(
                `INSERT INTO ${TABLES.guildProviderSettings}
                 (provider_id, guild_id, ${PROVIDER_SETTING_COLUMN_NAMES.join(', ')})
                 VALUES (?, ?, ${PROVIDER_SETTING_COLUMN_NAMES.map(() => '?').join(', ')})`,
                [row.providerId, row.guildId, ...values]
            );
        }

        for (const row of disableRows) {
            await queryDatabase(
                `INSERT INTO ${TABLES.guildProviderDisableTargets}
                 (provider_id, guild_id, target_type, target_id)
                 VALUES (?, ?, ?, ?)`,
                [row.providerId, row.guildId, row.targetType, row.targetId]
            );
        }

        for (const group of providerTargetRows) {
            for (const row of group.rows) {
                await queryDatabase(
                    `INSERT INTO ${group.table}
                     (provider_id, guild_id, target_type, target_id)
                     VALUES (?, ?, ?, ?)`,
                    [row.providerId, row.guildId, row.targetType, row.targetId]
                );
            }
        }

        for (const row of bannedWordRows) {
            await queryDatabase(
                `INSERT INTO ${TABLES.guildProviderBannedWords}
                 (provider_id, guild_id, word)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE word = VALUES(word)`,
                [row.providerId, row.guildId, row.word]
            );
        }

        for (const row of buttonVisibilityRows) {
            await queryDatabase(
                `INSERT INTO ${TABLES.guildProviderButtonVisibility}
                 (provider_id, guild_id, button_key, hidden)
                 VALUES (?, ?, ?, ?)`,
                [row.providerId, row.guildId, row.buttonKey, row.hidden ? 1 : 0]
            );
        }

        for (const row of buttonDisabledRows) {
            await queryDatabase(
                `INSERT INTO ${TABLES.guildProviderButtonDisabledTargets}
                 (provider_id, guild_id, target_type, target_id)
                 VALUES (?, ?, ?, ?)`,
                [row.providerId, row.guildId, row.targetType, row.targetId]
            );
        }

        for (const [userId, quota] of Object.entries(normalized.save_tweet_quota_override || {})) {
            await queryDatabase(
                `INSERT INTO ${TABLES.users} (user_id, registered_at_ms, save_tweet_quota_override_bytes)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE save_tweet_quota_override_bytes = VALUES(save_tweet_quota_override_bytes)`,
                [userId, Date.now(), quota]
            );
        }

        await queryDatabase('COMMIT');
    } catch (err) {
        await queryDatabase('ROLLBACK').catch(() => {});
        throw err;
    }
}

const settings = cloneValue(SETTINGS_DEFAULT_FILE);

function saveSettings(nextSettings = settings) {
    void nextSettings;
    return Promise.reject(new Error('saveSettings(settings) is disabled. Use DB-scoped setting APIs instead.'));
}

async function initializeSettings() {
    const mode = getSettingsStorageMode();

    if (mode === 'file') {
        throw new Error('SETTINGS_STORAGE=file is no longer supported. Use MySQL-backed settings.');
    }

    await ensureDatabaseSchema();
    replaceSettingsContents(settings, cloneValue(SETTINGS_DEFAULT_FILE));
    return settings;
}

async function getButtonInvisibleSettings(guildId, providerId = null) {
    const { getSetting } = require('./providers/_provider_settings');
    return await getSetting({ id: providerId || 'twitter' }, 'button_invisible', guildId) || {};
}

function detectProviderIdFromMessage(message) {
    const url = message?.embeds?.[0]?.url || '';
    if (/open\.spotify\.com/.test(url)) return 'spotify';
    if (/pixiv\.net|phixiv\.net|ppxiv\.net/.test(url)) return 'pixiv';
    if (/booth\.pm/.test(url)) return 'booth';
    if (/twitch\.tv/.test(url)) return 'twitch';
    if (/instagram\.com/.test(url)) return 'instagram';
    if (/youtube\.com|youtu\.be|youtube-nocookie\.com/.test(url)) return 'youtube';
    if (/nicovideo\.jp|nico\.ms/.test(url)) return 'niconico';
    if (/twitter\.com|x\.com|vxtwitter\.com|fxtwitter\.com|twidata\.sprink\.cloud/.test(url)) return 'twitter';
    return null;
}

async function checkComponentIncludesDisabledButtonAndIfFindDeleteIt(components, guildId, providerId = null) {
    const invisibleSettings = await getButtonInvisibleSettings(guildId, providerId);

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
    LEGACY_TWITTER_GUILD_KEYS,
    PROVIDER_SETTING_COLUMNS,
    getSettingsStorageMode,
    initializeSettings,
    loadSettingsFromFile,
    loadSettingsFromDatabase,
    saveSettingsToDatabase,
    ensureSettingsTable: ensureDatabaseSchema,
    normalizeSettings,
    saveSettings,
    applySettingsMigrations,
    migrateLegacyTwitterSettings,
    settings,
    getButtonInvisibleSettings,
    detectProviderIdFromMessage,
    checkComponentIncludesDisabledButtonAndIfFindDeleteIt,
};

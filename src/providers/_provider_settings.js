'use strict';

const { TABLES, ensureDatabaseSchema } = require('../db_schema');
const { button_disabled_template, button_invisible_template } = require('../utils');
const { normalizeHiddenOutputItems } = require('./_output_visibility');

const PROVIDER_DEFAULTS = {
    enabled:                                              undefined,
    defaultLanguage:                                      'ja',
    editOriginalIfTranslate:                              false,
    extract_bot_message:                                  false,
    legacy_mode:                                          undefined,
    passive_mode:                                         false,
    disable:                                              undefined,
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
    youtube_description_max_length:                       undefined,
    youtube_video_list_limit:                             undefined,
    tiktok_hq:                                             false,
    twitter_stats_layout:                                  'description',
    twitter_text_mode:                                     'normal',
    twitter_quote_mode:                                    'full',
    twitter_quote_layout:                                  'separate',
    pixiv_caption_max_length:                              undefined,
    pixiv_tag_limit:                                       undefined,
    instagram_caption_max_length:                          undefined,
    instagram_media_limit:                                 undefined,
    github_card_style:                                     'generated',
    hidden_output_items:                                   [],
    display_density:                                       'standard',
    media_display_mode:                                    'embed',
    failure_display_policy:                                'silent',
    tiktok_description_max_length:                         undefined,
    tiktok_image_limit:                                    undefined,
    tiktok_video_fallback_mode:                            undefined,
    niconico_description_max_length:                       undefined,
    spotify_description_max_length:                        undefined,
    twitch_description_max_length:                         undefined,
    steam_description_max_length:                          undefined,
    steam_image_source:                                    'header',
    amazon_description_max_length:                         undefined,
    amazon_extract_targets:                                 ['product', 'prime_video', 'music'],
    booth_description_max_length:                          undefined,
    booth_image_limit:                                     undefined,
    booth_adult_display_mode:                              'normal',
};

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
    booth_image_limit: {
        column: 'booth_image_limit',
        type: 'int',
    },
    booth_adult_display_mode: {
        column: 'booth_adult_display_mode',
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
};

function queryDatabase() {
    return require('../db').queryDatabase;
}

const TEST_MEMORY_VALUES = new Map();

function isTestStorageMode() {
    return process.env.NODE_ENV === 'test';
}

function cloneValue(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function testMemoryKey(providerId, guildId, key) {
    return `${providerId}\0${guildId}\0${key}`;
}

function getLegacyTestSetting(provider, key, guildId) {
    let legacySettings;
    try {
        legacySettings = require('../settings').settings;
    } catch {
        return undefined;
    }

    const providerBucket = legacySettings.byProvider?.[provider.id]?.[key];
    if (providerBucket && Object.prototype.hasOwnProperty.call(providerBucket, guildId)) {
        return cloneValue(providerBucket[guildId]);
    }

    if (provider.id !== 'twitter') return undefined;
    if (key === 'disable') {
        return normalizeTargetSetting({
            user: legacySettings.disable?.user || [],
            channel: legacySettings.disable?.channel || [],
            role: legacySettings.disable?.role?.[guildId] || [],
        });
    }

    const legacyBucket = legacySettings[key];
    if (legacyBucket && typeof legacyBucket === 'object' && Object.prototype.hasOwnProperty.call(legacyBucket, guildId)) {
        return cloneValue(legacyBucket[guildId]);
    }
    return undefined;
}

function getTestMemorySetting(provider, key, guildId) {
    const stored = TEST_MEMORY_VALUES.get(testMemoryKey(provider.id, guildId, key));
    if (stored !== undefined) return cloneValue(stored);
    const legacy = getLegacyTestSetting(provider, key, guildId);
    if (legacy !== undefined) return legacy;
    if (key === 'disable') return normalizeTargetSetting();
    if (key === 'button_disabled') return normalizeButtonDisabled();
    if (key === 'bannedWords') return [];
    if (key === 'button_invisible') return normalizeButtonVisibility();
    return settingDefault(provider, key);
}

function setTestMemorySetting(provider, key, guildId, value) {
    TEST_MEMORY_VALUES.set(testMemoryKey(provider.id, guildId, key), cloneValue(value));
}

function normalizeProvider(provider) {
    if (typeof provider === 'string') return { id: provider };
    return provider || { id: 'twitter' };
}

function normalizeTargetSetting(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        user: Array.isArray(source.user) ? [...new Set(source.user)] : [],
        channel: Array.isArray(source.channel) ? [...new Set(source.channel)] : [],
        role: Array.isArray(source.role) ? [...new Set(source.role)] : [],
    };
}

function normalizeButtonVisibility(raw) {
    return {
        ...button_invisible_template,
        savetweet: false,
        ...(raw && typeof raw === 'object' ? raw : {}),
    };
}

function normalizeButtonDisabled(raw) {
    return {
        ...button_disabled_template,
        ...normalizeTargetSetting(raw),
    };
}

function convertDatabaseValue(raw, spec) {
    if (raw === null || raw === undefined) return undefined;
    if (spec.type === 'bool') return raw === true || raw === 1;
    if (spec.type === 'int') return Number(raw);
    if (spec.type === 'jsonArray') return normalizeHiddenOutputItems(raw);
    return raw;
}

function toDatabaseValue(value, spec) {
    if (value === undefined) return null;
    if (spec.type === 'bool') return value === true ? 1 : 0;
    if (spec.type === 'int') return Number(value);
    if (spec.type === 'jsonArray') return JSON.stringify(normalizeHiddenOutputItems(value));
    return value;
}

async function ensureProviderAndGuild(providerId, guildId) {
    await ensureDatabaseSchema();
    const query = queryDatabase();
    await query(
        `INSERT INTO ${TABLES.providers} (provider_id)
         VALUES (?)
         ON DUPLICATE KEY UPDATE provider_id = provider_id`,
        [providerId]
    );
    await query(
        `INSERT INTO ${TABLES.guilds} (guild_id)
         VALUES (?)
         ON DUPLICATE KEY UPDATE guild_id = guild_id`,
        [guildId]
    );
}

function settingDefault(provider, key) {
    if (key === 'enabled') return provider.enabledByDefault === true;
    if (key === 'youtube_description_max_length') return provider.id === 'youtube' ? 1400 : undefined;
    if (key === 'pixiv_caption_max_length') return provider.id === 'pixiv' ? 350 : undefined;
    if (key === 'instagram_caption_max_length') return provider.id === 'instagram' ? 3000 : undefined;
    if (key === 'instagram_media_limit') return provider.id === 'instagram' ? 10 : undefined;
    if (key === 'tiktok_description_max_length') return provider.id === 'tiktok' ? 900 : undefined;
    if (key === 'tiktok_video_fallback_mode') return provider.id === 'tiktok' ? 'video_url' : undefined;
    if (key === 'niconico_description_max_length') return provider.id === 'niconico' ? 1400 : undefined;
    if (key === 'spotify_description_max_length') return provider.id === 'spotify' ? 350 : undefined;
    if (key === 'twitch_description_max_length') return provider.id === 'twitch' ? 1500 : undefined;
    if (key === 'steam_description_max_length') return provider.id === 'steam' ? 900 : undefined;
    if (key === 'steam_image_source') return provider.id === 'steam' ? 'header' : undefined;
    if (key === 'amazon_description_max_length') return provider.id === 'amazon' ? 700 : undefined;
    if (key === 'amazon_extract_targets') return provider.id === 'amazon' ? cloneValue(PROVIDER_DEFAULTS.amazon_extract_targets) : undefined;
    if (key === 'booth_description_max_length') return provider.id === 'booth' ? 350 : undefined;
    if (key === 'booth_adult_display_mode') return provider.id === 'booth' ? 'normal' : undefined;
    return PROVIDER_DEFAULTS[key];
}

async function getScalarSetting(provider, key, guildId) {
    const spec = PROVIDER_SETTING_COLUMNS[key];
    if (!spec) return settingDefault(provider, key);

    await ensureDatabaseSchema();
    const rows = await queryDatabase()(
        `SELECT ${spec.column} AS value
         FROM ${TABLES.guildProviderSettings}
         WHERE provider_id = ? AND guild_id = ?
         LIMIT 1`,
        [provider.id, guildId]
    );
    const value = convertDatabaseValue(rows[0]?.value, spec);
    return value === undefined ? settingDefault(provider, key) : value;
}

async function setScalarSetting(provider, key, guildId, value) {
    const spec = PROVIDER_SETTING_COLUMNS[key];
    if (!spec) return;

    await ensureProviderAndGuild(provider.id, guildId);
    await queryDatabase()(
        `INSERT INTO ${TABLES.guildProviderSettings} (provider_id, guild_id, ${spec.column})
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE ${spec.column} = VALUES(${spec.column})`,
        [provider.id, guildId, toDatabaseValue(value, spec)]
    );
}

async function getRowsByTargetTable(table, providerId, guildId) {
    await ensureDatabaseSchema();
    return await queryDatabase()(
        `SELECT target_type, target_id
         FROM ${table}
         WHERE provider_id = ? AND guild_id = ?`,
        [providerId, guildId]
    );
}

function targetRowsToSetting(rows) {
    const setting = { user: [], channel: [], role: [] };
    for (const row of rows || []) {
        if (setting[row.target_type]) setting[row.target_type].push(row.target_id);
    }
    return normalizeTargetSetting(setting);
}

async function getDisableSetting(provider, guildId) {
    const providerRows = await getRowsByTargetTable(TABLES.guildProviderDisableTargets, provider.id, guildId);
    return targetRowsToSetting(providerRows);
}

async function replaceTargetRows(table, providerId, guildId, value) {
    const setting = normalizeTargetSetting(value);
    await ensureProviderAndGuild(providerId, guildId);
    const query = queryDatabase();
    await query('START TRANSACTION');
    try {
        await query(`DELETE FROM ${table} WHERE provider_id = ? AND guild_id = ?`, [providerId, guildId]);
        for (const targetType of ['user', 'channel', 'role']) {
            for (const targetId of setting[targetType]) {
                await query(
                    `INSERT INTO ${table} (provider_id, guild_id, target_type, target_id)
                     VALUES (?, ?, ?, ?)`,
                    [providerId, guildId, targetType, targetId]
                );
            }
        }
        await query('COMMIT');
    } catch (err) {
        await query('ROLLBACK').catch(() => {});
        throw err;
    }
}

async function setDisableSetting(provider, guildId, value) {
    const setting = normalizeTargetSetting(value);
    await replaceTargetRows(TABLES.guildProviderDisableTargets, provider.id, guildId, setting);
}

async function getBannedWords(provider, guildId) {
    await ensureDatabaseSchema();
    const rows = await queryDatabase()(
        `SELECT word
         FROM ${TABLES.guildProviderBannedWords}
         WHERE provider_id = ? AND guild_id = ?
         ORDER BY word`,
        [provider.id, guildId]
    );
    return rows.map(row => row.word);
}

async function setBannedWords(provider, guildId, words) {
    await ensureProviderAndGuild(provider.id, guildId);
    const normalizedWords = [];
    const seen = new Set();
    for (const word of words || []) {
        const normalized = String(word ?? '').normalize('NFC').trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        normalizedWords.push(normalized);
    }

    const query = queryDatabase();
    await query('START TRANSACTION');
    try {
        await query(
            `DELETE FROM ${TABLES.guildProviderBannedWords}
             WHERE provider_id = ? AND guild_id = ?`,
            [provider.id, guildId]
        );
        for (const word of normalizedWords) {
            await query(
                `INSERT INTO ${TABLES.guildProviderBannedWords} (provider_id, guild_id, word)
                 VALUES (?, ?, ?)`,
                [provider.id, guildId, word]
            );
        }
        await query('COMMIT');
    } catch (err) {
        await query('ROLLBACK').catch(() => {});
        throw err;
    }
}

async function getButtonVisibility(provider, guildId) {
    await ensureDatabaseSchema();
    const rows = await queryDatabase()(
        `SELECT button_key, hidden
         FROM ${TABLES.guildProviderButtonVisibility}
         WHERE provider_id = ? AND guild_id = ?`,
        [provider.id, guildId]
    );
    const value = {};
    for (const row of rows) value[row.button_key] = row.hidden === true || row.hidden === 1;
    return normalizeButtonVisibility(value);
}

async function setButtonVisibility(provider, guildId, value) {
    const visibility = normalizeButtonVisibility(value);
    if (provider.id !== 'twitter') delete visibility.savetweet;

    await ensureProviderAndGuild(provider.id, guildId);
    const query = queryDatabase();
    await query('START TRANSACTION');
    try {
        await query(
            `DELETE FROM ${TABLES.guildProviderButtonVisibility}
             WHERE provider_id = ? AND guild_id = ?`,
            [provider.id, guildId]
        );
        for (const [buttonKey, hidden] of Object.entries(visibility)) {
            await query(
                `INSERT INTO ${TABLES.guildProviderButtonVisibility} (provider_id, guild_id, button_key, hidden)
                 VALUES (?, ?, ?, ?)`,
                [provider.id, guildId, buttonKey, hidden === true ? 1 : 0]
            );
        }
        await query('COMMIT');
    } catch (err) {
        await query('ROLLBACK').catch(() => {});
        throw err;
    }
}

async function getSetting(providerInput, key, guildId) {
    const provider = normalizeProvider(providerInput);
    if (isTestStorageMode()) return getTestMemorySetting(provider, key, guildId);
    if (key === 'disable') return await getDisableSetting(provider, guildId);
    if (key === 'button_disabled') {
        return normalizeButtonDisabled(targetRowsToSetting(
            await getRowsByTargetTable(TABLES.guildProviderButtonDisabledTargets, provider.id, guildId)
        ));
    }
    if (key === 'bannedWords') return await getBannedWords(provider, guildId);
    if (key === 'button_invisible') return await getButtonVisibility(provider, guildId);
    return await getScalarSetting(provider, key, guildId);
}

async function setSetting(providerInput, key, guildId, value) {
    const provider = normalizeProvider(providerInput);
    if (isTestStorageMode()) return setTestMemorySetting(provider, key, guildId, value);
    if (key === 'disable') return await setDisableSetting(provider, guildId, value);
    if (key === 'button_disabled') {
        return await replaceTargetRows(TABLES.guildProviderButtonDisabledTargets, provider.id, guildId, value);
    }
    if (key === 'bannedWords') return await setBannedWords(provider, guildId, value);
    if (key === 'button_invisible') return await setButtonVisibility(provider, guildId, value);
    return await setScalarSetting(provider, key, guildId, value);
}

async function getProviderSettings(providerInput, guildId) {
    const provider = normalizeProvider(providerInput);
    const out = {};
    for (const key of Object.keys(PROVIDER_DEFAULTS)) {
        const value = await getSetting(provider, key, guildId);
        if (value !== undefined) out[key] = value;
    }
    return out;
}

async function isProviderEnabled(providerInput, guildId) {
    return await getSetting(providerInput, 'enabled', guildId) === true;
}

async function setProviderEnabled(providerInput, guildId, value) {
    return await setSetting(providerInput, 'enabled', guildId, value === true);
}

async function getSaveTweetQuotaOverride(userId) {
    if (isTestStorageMode()) {
        const value = TEST_MEMORY_VALUES.get(testMemoryKey('user', userId, 'save_tweet_quota_override'));
        return value === undefined ? undefined : Number(value);
    }
    await ensureDatabaseSchema();
    const rows = await queryDatabase()(
        `SELECT save_tweet_quota_override_bytes AS quota
         FROM ${TABLES.users}
         WHERE user_id = ?
         LIMIT 1`,
        [userId]
    );
    const quota = rows[0]?.quota;
    return quota === null || quota === undefined ? undefined : Number(quota);
}

async function setSaveTweetQuotaOverride(userId, quota) {
    if (isTestStorageMode()) {
        TEST_MEMORY_VALUES.set(testMemoryKey('user', userId, 'save_tweet_quota_override'), quota);
        return;
    }
    await ensureDatabaseSchema();
    await queryDatabase()(
        `INSERT INTO ${TABLES.users} (user_id, registered_at_ms, save_tweet_quota_override_bytes)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE save_tweet_quota_override_bytes = VALUES(save_tweet_quota_override_bytes)`,
        [userId, Date.now(), quota]
    );
}

module.exports = {
    PROVIDER_DEFAULTS,
    PROVIDER_SETTING_COLUMNS,
    getSetting,
    setSetting,
    getProviderSettings,
    isProviderEnabled,
    setProviderEnabled,
    getSaveTweetQuotaOverride,
    setSaveTweetQuotaOverride,
    _internal: {
        normalizeButtonDisabled,
        normalizeButtonVisibility,
        normalizeTargetSetting,
        TEST_MEMORY_VALUES,
    },
};

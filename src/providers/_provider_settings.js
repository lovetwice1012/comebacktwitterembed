'use strict';

const { TABLES, ensureDatabaseSchema } = require('../db_schema');
const { button_disabled_template, button_invisible_template } = require('../utils');

const PROVIDER_DEFAULTS = {
    enabled:                                              undefined,
    defaultLanguage:                                      undefined,
    editOriginalIfTranslate:                              false,
    extract_bot_message:                                  false,
    legacy_mode:                                          undefined,
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
    youtube_description_max_length:                       undefined,
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
};

function queryDatabase() {
    return require('../db').queryDatabase;
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
    return raw;
}

function toDatabaseValue(value, spec) {
    if (value === undefined) return null;
    if (spec.type === 'bool') return value === true ? 1 : 0;
    if (spec.type === 'int') return Number(value);
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
    },
};

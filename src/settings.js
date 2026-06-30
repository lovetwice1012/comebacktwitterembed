'use strict';

const fs = require('fs');
const path = require('path');
const { TABLES, ensureDatabaseSchema } = require('./db_schema');

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
    'legacy_mode',
    'passive_mode',
    'anonymous_expand',
    'secondary_extract_mode',
    'secondary_extract_mode_multiple_images',
    'secondary_extract_mode_video',
    'deletemessageifonlypostedtweetlink_secoundaryextractmode',
    'quote_repost_max_depth',
];

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

function parseDatabaseJson(value) {
    let raw = value;
    if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
    if (typeof raw !== 'string') raw = JSON.stringify(raw);
    return JSON.parse(raw);
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

    if (key === 'disable.role') {
        nextSettings.disable.role[guildId] = value;
    } else if (LEGACY_TWITTER_GUILD_KEYS.includes(key)) {
        nextSettings[key][guildId] = value;
    }
}

function collectGuildSettingRows(nextSettings) {
    const rows = new Map();
    const put = (providerId, guildId, key, value) => {
        if (value === undefined) return;
        rows.set(`${providerId}\0${guildId}\0${key}`, {
            providerId,
            guildId,
            key,
            value,
        });
    };

    for (const [guildId, value] of Object.entries(nextSettings.disable?.role || {})) {
        put('twitter', guildId, 'disable.role', value);
    }

    for (const key of LEGACY_TWITTER_GUILD_KEYS) {
        const bucket = nextSettings[key];
        if (!bucket || typeof bucket !== 'object') continue;
        for (const [guildId, value] of Object.entries(bucket)) {
            put('twitter', guildId, key, value);
        }
    }

    for (const [providerId, providerSettings] of Object.entries(nextSettings.byProvider || {})) {
        if (!providerSettings || typeof providerSettings !== 'object') continue;
        for (const [key, bucket] of Object.entries(providerSettings)) {
            if (!bucket || typeof bucket !== 'object') continue;
            for (const [guildId, value] of Object.entries(bucket)) {
                put(providerId, guildId, key, value);
            }
        }
    }

    return [...rows.values()];
}

async function loadSettingsFromDatabase() {
    const { queryDatabase } = require('./db');
    await ensureDatabaseSchema();

    const nextSettings = cloneValue(SETTINGS_DEFAULT_FILE);
    let foundRows = 0;

    const globalRows = await queryDatabase(`SELECT setting_key, setting_value FROM ${TABLES.globalSettings}`);
    foundRows += globalRows.length;
    for (const row of globalRows) {
        const value = parseDatabaseJson(row.setting_value);
        if (row.setting_key === 'disable.user') nextSettings.disable.user = Array.isArray(value) ? value : [];
        else if (row.setting_key === 'disable.channel') nextSettings.disable.channel = Array.isArray(value) ? value : [];
    }

    const quotaRows = await queryDatabase(
        `SELECT user_id, save_tweet_quota_override_bytes
         FROM ${TABLES.users}
         WHERE save_tweet_quota_override_bytes IS NOT NULL`
    );
    foundRows += quotaRows.length;
    for (const row of quotaRows) {
        nextSettings.save_tweet_quota_override[row.user_id] = row.save_tweet_quota_override_bytes;
    }

    const settingRows = await queryDatabase(
        `SELECT provider_id, guild_id, setting_key, setting_value
         FROM ${TABLES.guildProviderSettings}`
    );
    foundRows += settingRows.length;
    for (const row of settingRows) {
        setProviderGuildSetting(
            nextSettings,
            row.provider_id,
            row.guild_id,
            row.setting_key,
            parseDatabaseJson(row.setting_value)
        );
    }

    if (foundRows === 0) return null;
    return normalizeSettings(nextSettings);
}

async function saveSettingsToDatabase(nextSettings) {
    const { queryDatabase } = require('./db');
    await ensureDatabaseSchema();

    const normalized = normalizeSettings(nextSettings).settings;
    const rows = collectGuildSettingRows(normalized);

    await queryDatabase('START TRANSACTION');
    try {
        await queryDatabase(`DELETE FROM ${TABLES.guildProviderSettings}`);
        await queryDatabase(`DELETE FROM ${TABLES.globalSettings}`);
        await queryDatabase(`UPDATE ${TABLES.users} SET save_tweet_quota_override_bytes = NULL`);

        const globalRows = [
            ['disable.user', normalized.disable.user || []],
            ['disable.channel', normalized.disable.channel || []],
        ];
        for (const [key, value] of globalRows) {
            await queryDatabase(
                `INSERT INTO ${TABLES.globalSettings} (setting_key, setting_value)
                 VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
                [key, JSON.stringify(value)]
            );
        }

        for (const row of rows) {
            await queryDatabase(
                `INSERT INTO ${TABLES.guildProviderSettings} (provider_id, guild_id, setting_key, setting_value)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
                [row.providerId, row.guildId, row.key, JSON.stringify(row.value)]
            );
        }

        for (const [userId, quota] of Object.entries(normalized.save_tweet_quota_override || {})) {
            await queryDatabase(
                `INSERT INTO ${TABLES.users} (user_id, registered_at_ms, save_tweet_quota_override_bytes)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE save_tweet_quota_override_bytes = VALUES(save_tweet_quota_override_bytes)`,
                [userId, new Date().getTime(), quota]
            );
        }

        await queryDatabase('COMMIT');
    } catch (err) {
        await queryDatabase('ROLLBACK').catch(() => {});
        throw err;
    }
}

let activeStorage = 'file';
let saveQueue = Promise.resolve();
const loaded = loadSettingsFromFile();
const settings = loaded.settings;

function saveSettings(nextSettings = settings) {
    if (activeStorage === 'mysql') {
        saveQueue = saveQueue.catch(() => {}).then(() => saveSettingsToDatabase(nextSettings));
        return saveQueue;
    }
    writeSettingsFile(normalizeSettings(nextSettings).settings);
    return Promise.resolve();
}

async function initializeSettings() {
    const mode = getSettingsStorageMode();

    if (mode === 'file') {
        activeStorage = 'file';
        const fileSettings = loadSettingsFromFile();
        replaceSettingsContents(settings, fileSettings.settings);
        return settings;
    }

    activeStorage = 'mysql';
    const databaseSettings = await loadSettingsFromDatabase();
    if (databaseSettings) {
        replaceSettingsContents(settings, databaseSettings.settings);
        if (databaseSettings.changed) await saveSettings(settings);
        return settings;
    }

    const defaults = cloneValue(SETTINGS_DEFAULT_FILE);
    replaceSettingsContents(settings, defaults);
    await saveSettings(settings);
    console.warn(
        'No settings found in the redesigned MySQL schema. '
        + 'Default settings were created. Run scripts/migrate_settings_to_mysql.js to import settings.json.'
    );
    return settings;
}

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
    LEGACY_TWITTER_GUILD_KEYS,
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

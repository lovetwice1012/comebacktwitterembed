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
};

const PROVIDER_SETTING_COLUMN_NAMES = Object.values(PROVIDER_SETTING_COLUMNS).map(spec => spec.column);

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
    return raw;
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

    const globalDisableRows = await queryDatabase(`SELECT target_type, target_id FROM ${TABLES.globalDisableTargets}`);
    foundRows += globalDisableRows.length;
    for (const row of globalDisableRows) {
        if (row.target_type === 'user') nextSettings.disable.user.push(row.target_id);
        else if (row.target_type === 'channel') nextSettings.disable.channel.push(row.target_id);
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
    const bannedWordRows = collectBannedWordRows(normalized);
    const buttonVisibilityRows = collectButtonVisibilityRows(normalized);
    const buttonDisabledRows = collectTargetRows(normalized, 'button_disabled', normalized.button_disabled);

    for (const row of [...scalarRows, ...disableRows, ...bannedWordRows, ...buttonVisibilityRows, ...buttonDisabledRows]) {
        addProviderGuild(providerIds, guildIds, row.providerId, row.guildId);
    }

    await queryDatabase('START TRANSACTION');
    try {
        await queryDatabase(`DELETE FROM ${TABLES.guildProviderButtonDisabledTargets}`);
        await queryDatabase(`DELETE FROM ${TABLES.guildProviderButtonVisibility}`);
        await queryDatabase(`DELETE FROM ${TABLES.guildProviderBannedWords}`);
        await queryDatabase(`DELETE FROM ${TABLES.guildProviderDisableTargets}`);
        await queryDatabase(`DELETE FROM ${TABLES.guildProviderSettings}`);
        await queryDatabase(`DELETE FROM ${TABLES.globalDisableTargets}`);
        await queryDatabase(`UPDATE ${TABLES.users} SET save_tweet_quota_override_bytes = NULL`);

        await ensureProviderAndGuildRows(queryDatabase, providerIds, guildIds);

        for (const targetType of ['user', 'channel']) {
            for (const targetId of new Set(normalized.disable?.[targetType] || [])) {
                await queryDatabase(
                    `INSERT INTO ${TABLES.globalDisableTargets} (target_type, target_id)
                     VALUES (?, ?)`,
                    [targetType, targetId]
                );
            }
        }

        for (const row of scalarRows) {
            const values = PROVIDER_SETTING_COLUMN_NAMES.map(column => {
                const value = row.values[column];
                if (value === undefined) return null;
                if (typeof value === 'boolean') return value ? 1 : 0;
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

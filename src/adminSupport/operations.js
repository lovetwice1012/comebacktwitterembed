'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { id } = require('./discord');
const { defaults, hash, providers } = require('./inspect');
const settings = require('../providers/_provider_settings');
const specs = require('../providers/_setting_specs');
const { TABLES, ensureDatabaseSchema } = require('../db_schema');
const db = require('../db');
const telemetry = require('./telemetry');

function providerFor(value) {
    const provider = providers().find(item => item.id === value);
    if (!provider) throw new Error(`Unknown provider: ${value}`);
    return provider;
}
function catalog() {
    return providers().map(provider => ({ id: provider.id, name: provider.id,
        defaults: defaults(provider), specs: telemetry.serializable(specs.getProviderSettingSpecs(provider)),
        keys: Object.keys(settings.PROVIDER_DEFAULTS) }));
}
function validateSetting(provider, key, value) {
    if (!Object.prototype.hasOwnProperty.call(settings.PROVIDER_DEFAULTS, key)) throw new Error(`Unknown setting: ${key}`);
    const scalar = settings.PROVIDER_SETTING_COLUMNS[key];
    if (scalar?.type === 'bool' && typeof value !== 'boolean') throw new Error(`${key} requires a boolean.`);
    if (scalar?.type === 'int' && (!Number.isSafeInteger(value) || value < 0 || value > 100000)) throw new Error(`${key} requires an integer from 0 to 100000.`);
    if (scalar?.type === 'string' && typeof value !== 'string') throw new Error(`${key} requires a string.`);
    if ((key === 'bannedWords' || scalar?.type === 'jsonArray') && !Array.isArray(value)) throw new Error(`${key} requires an array.`);
    if ((key === 'disable' || key === 'button_disabled' || /sensitive_content_(allowed|excluded)_targets$/.test(key))) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} requires user/channel/role arrays.`);
        for (const targetType of ['user', 'channel', 'role']) {
            if (value[targetType] !== undefined && !Array.isArray(value[targetType])) throw new Error(`${key}.${targetType} must be an array.`);
            for (const targetId of value[targetType] || []) id(targetId, `${key}.${targetType}`);
        }
    }
    const spec = specs.getProviderSettingSpecs(provider).find(item => (item.settingKey || item.key) === key);
    if (spec?.choices) {
        const choices = Array.isArray(value) ? value : [value];
        if (!choices.every(item => spec.choices.some(choice => String(choice.value) === String(item)))) throw new Error(`${key} value is not an available choice.`);
    }
    if (JSON.stringify(value).length > 262144) throw new Error('Setting exceeds 256 KiB.');
}
async function settingAction(type, input) {
    if (type === 'settings.catalog') return catalog();
    const provider = providerFor(input.providerId);
    const guildId = id(input.guildId, 'guildId');
    await ensureDatabaseSchema();
    if (type === 'settings.get') {
        const current = await settings.getProviderSettings(provider, guildId);
        return { guildId, providerId: provider.id, settings: current, hash: hash(current), defaults: defaults(provider), specs: catalog().find(item => item.id === provider.id).specs };
    }
    let result;
    try {
        result = await db.withDatabaseTransaction(async query => {
            // All settings writers touch these keys. The row lock precedes the
            // fresh read/CAS and is held through settings, audit and invalidation.
            await query(`INSERT IGNORE INTO ${TABLES.providers} (provider_id) VALUES (?)`, [provider.id]);
            await query(`INSERT IGNORE INTO ${TABLES.guilds} (guild_id) VALUES (?)`, [guildId]);
            await query(`INSERT IGNORE INTO ${TABLES.guildProviderSettings} (provider_id,guild_id) VALUES (?,?)`, [provider.id,guildId]);
            await query(`SELECT guild_id FROM ${TABLES.guildProviderSettings} WHERE provider_id=? AND guild_id=? FOR UPDATE`, [provider.id,guildId]);
            const before = await settings._internal.loadProviderSettings(provider, guildId);
            const beforeHash = hash(before);
            if (!input.expectedHash || input.expectedHash !== beforeHash) throw Object.assign(new Error('The settings changed or expectedHash is missing. Read settings again before applying.'), { code: 'SETTINGS_CONFLICT', currentHash: beforeHash });
            let changes;
            if (type === 'settings.copy') {
                const source = await settings._internal.loadProviderSettings(provider, id(input.sourceGuildId, 'sourceGuildId'));
                changes = Object.fromEntries(Object.entries(source).filter(([key]) => Object.hasOwn(settings.PROVIDER_DEFAULTS, key)));
            } else if (type === 'settings.reset') {
                const keys = input.key ? [input.key] : Object.keys(settings.PROVIDER_DEFAULTS);
                changes = {};
                for (const key of keys) {
                    if (!Object.hasOwn(settings.PROVIDER_DEFAULTS, key)) throw new Error(`Unknown setting: ${key}`);
                    changes[key] = settings.PROVIDER_SETTING_COLUMNS[key] ? undefined
                        : key === 'bannedWords' ? [] : key === 'button_invisible' ? {} : { user: [], channel: [], role: [] };
                }
            } else changes = input.changes || { [input.key]: input.value };
            for (const [key, value] of Object.entries(changes)) {
                if (type !== 'settings.reset') validateSetting(provider, key, value);
                await settings.setSetting(provider, key, guildId, value);
            }
            const after = await settings._internal.loadProviderSettings(provider, guildId);
            const actionId = telemetry.current()?.operation_id || null;
            await query(`INSERT INTO ${TABLES.dashboardAuditLogs} (guild_id,provider_id,setting_key,actor_user_id,actor_username_snapshot,action,before_json,after_json,request_id) VALUES (?,?,?,?,?,?,?,?,?)`,
                [guildId,provider.id,Object.keys(changes).join(',').slice(0,191),process.env.ADMIN_OWNER_ID || '796972193287503913','admin-support-worker',type,JSON.stringify(before),JSON.stringify(after),actionId]);
            return { guildId, providerId: provider.id, before, settings: after, hash: hash(after), appliedKeys: Object.keys(changes),
                reflectionStatus: 'saved; invalidation committed atomically. A Bot settings event with this hash confirms actual use.' };
        });
    } finally { settings._internal.clearProviderSettingsCache(provider.id, guildId); }
    telemetry.event('settings', 'saved', result);
    return result;
}
function rowId(value) {
    if (!/^\d{1,20}$/.test(String(value))) throw new Error('A valid row id is required.');
    return String(value);
}
async function autoextractAction(type, input) {
    await ensureDatabaseSchema();
    const userId = input.userId ? id(input.userId, 'userId') : null;
    if (type === 'autoextract.list') {
        const rows = await db.queryDatabase(`SELECT t.*, w.webhook_url FROM ${TABLES.autoExtractTargets} t JOIN ${TABLES.webhookEndpoints} w ON w.id=t.webhook_endpoint_id WHERE (? IS NULL OR t.user_id=?) AND t.id>? ORDER BY t.id LIMIT 201`, [userId, userId, rowId(input.afterId || 0)]);
        return { rows: rows.slice(0, 200), nextCursor: rows.length > 200 ? String(rows[199].id) : null };
    }
    if (type === 'autoextract.quota') {
        if (!userId) throw new Error('userId is required.');
        if (input.additionalSlots !== undefined) {
            if (!Number.isSafeInteger(input.additionalSlots) || input.additionalSlots < 0 || input.additionalSlots > 100000) throw new Error('additionalSlots must be an integer from 0 to 100000.');
            await db.queryDatabase(`INSERT INTO ${TABLES.users} (user_id, registered_at_ms, additional_auto_extract_slots) VALUES (?,?,?) ON DUPLICATE KEY UPDATE additional_auto_extract_slots=VALUES(additional_auto_extract_slots)`, [userId, Date.now(), input.additionalSlots]);
        }
        const [users, used, total] = await Promise.all([
            db.queryDatabase(`SELECT additional_auto_extract_slots FROM ${TABLES.users} WHERE user_id=?`, [userId]),
            db.queryDatabase(`SELECT premium_slot,COUNT(*) AS total FROM ${TABLES.autoExtractTargets} WHERE user_id=? AND enabled=1 GROUP BY premium_slot`, [userId]),
            db.queryDatabase(`SELECT COUNT(*) AS total FROM ${TABLES.autoExtractTargets} WHERE premium_slot=0 AND enabled=1`),
        ]);
        return { userId, additionalSlots: users[0]?.additional_auto_extract_slots || 0, used, globalFreeUsed: total[0]?.total, globalFreeLimit: 175, userFreeLimit: 5 };
    }
    if (type === 'autoextract.delete') {
        const before = await db.queryDatabase(`SELECT * FROM ${TABLES.autoExtractTargets} WHERE id=?`, [rowId(input.id)]);
        if (!before.length) throw new Error('Auto extraction registration does not exist.');
        await db.queryDatabase(`DELETE FROM ${TABLES.autoExtractTargets} WHERE id=?`, [rowId(input.id)]);
        return { deleted: before[0] };
    }
    let webhookId;
    if (input.webhookUrl) {
        if (!/^https:\/\/discord\.com\/api\/webhooks\/\d+\/[a-zA-Z0-9_-]+$/.test(input.webhookUrl)) throw new Error('A Discord webhook URL is required.');
        const response = await require('../providerFetch').withDeadline(require('node-fetch'))(input.webhookUrl, { size: 1048576 });
        const webhook = await response.json();
        if (!response.ok) throw new Error(`Webhook validation HTTP ${response.status}`);
        if (input.guildId && webhook.guild_id !== input.guildId) throw new Error('Webhook belongs to another server.');
        const inserted = await db.queryDatabase(`INSERT INTO ${TABLES.webhookEndpoints} (webhook_url_hash,webhook_url) VALUES (?,?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`, [crypto.createHash('sha256').update(input.webhookUrl).digest('hex'), input.webhookUrl]);
        webhookId = inserted.insertId;
    }
    if (type === 'autoextract.update') {
        const before = await db.queryDatabase(`SELECT * FROM ${TABLES.autoExtractTargets} WHERE id=?`, [rowId(input.id)]);
        if (!before.length) throw new Error('Auto extraction registration does not exist.');
        await db.queryDatabase(`UPDATE ${TABLES.autoExtractTargets} SET webhook_endpoint_id=?,enabled=? WHERE id=?`, [webhookId || before[0].webhook_endpoint_id, input.enabled === undefined ? before[0].enabled : input.enabled ? 1 : 0, rowId(input.id)]);
        return { before: before[0], id: input.id, webhookEndpointId: webhookId || before[0].webhook_endpoint_id, enabled: input.enabled ?? Boolean(before[0].enabled) };
    }
    if (!userId || !webhookId || !/^[a-zA-Z0-9_]{1,15}$/.test(input.username || '')) throw new Error('userId, valid Twitter username and webhookUrl are required.');
    const quota = await autoextractAction('autoextract.quota', { userId });
    const free = Number(quota.used.find(item => item.premium_slot === 0)?.total || 0);
    const premium = Number(quota.used.find(item => item.premium_slot === 1)?.total || 0);
    const usePremium = free >= 5 || Number(quota.globalFreeUsed) >= 175;
    if (usePremium && premium >= quota.additionalSlots) throw new Error('No free or additional auto extraction slots remain.');
    await db.ensureUserExistsInDatabase(userId);
    await db.queryDatabase(`INSERT IGNORE INTO ${TABLES.twitterAccounts} (twitter_username) VALUES (?)`, [input.username]);
    const result = await db.queryDatabase(`INSERT INTO ${TABLES.autoExtractTargets} (user_id,twitter_username,webhook_endpoint_id,premium_slot,last_extracted_at_ms,created_at_ms) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE enabled=1`, [userId, input.username, webhookId, usePremium ? 1 : 0, Date.now(), Date.now()]);
    return { id: result.insertId, userId, username: input.username, webhookEndpointId: webhookId, premium: usePremium };
}
async function safeSavedPath(userId, tweetId) {
    const root = path.resolve(process.env.SAVES_DIR || path.join(process.env.ADMIN_SUPPORT_DATA_DIR || path.resolve(__dirname, '../..'), 'saves'));
    const target = path.resolve(root, id(userId, 'userId'), ...(tweetId ? [rowId(tweetId)] : []));
    if (!target.startsWith(root + path.sep)) throw new Error('Saved data path is outside saves.');
    let cursor = root;
    for (const part of path.relative(root, target).split(path.sep)) {
        cursor = path.join(cursor, part);
        const stat = await fs.lstat(cursor).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (stat?.isSymbolicLink()) throw new Error('Symbolic links are not accepted for saved-data operations.');
    }
    return target;
}
async function savedAction(type, input) {
    const userId = id(input.userId, 'userId');
    const userPath = await safeSavedPath(userId);
    if (type === 'saved.quota') {
        if (input.quotaBytes !== undefined) {
            if (input.quotaBytes !== null && (!Number.isSafeInteger(input.quotaBytes) || input.quotaBytes < 0)) throw new Error('quotaBytes must be a nonnegative integer or null.');
            await settings.setSaveTweetQuotaOverride(userId, input.quotaBytes);
        }
        let usedBytes = 0;
        const walk = async directory => {
            for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
                if (entry.isSymbolicLink()) continue;
                const file = path.join(directory, entry.name);
                if (entry.isDirectory()) await walk(file); else usedBytes += (await fs.stat(file)).size;
            }
        };
        await walk(userPath);
        return { userId, quotaBytes: await settings.getSaveTweetQuotaOverride(userId) ?? 104857600, usedBytes };
    }
    if (type === 'saved.list') {
        const entries = await fs.readdir(userPath, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        const names = entries.filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name)).map(entry => entry.name).sort().filter(name => !input.afterId || name > input.afterId);
        const rows = [];
        for (const tweetId of names.slice(0, 100)) {
            try { rows.push({ tweetId, data: JSON.parse(await fs.readFile(path.join(userPath, tweetId, 'data.json'), 'utf8')) }); }
            catch (error) { rows.push({ tweetId, error: telemetry.errorData(error) }); }
        }
        return { rows, nextCursor: names.length > 100 ? names[99] : null };
    }
    if (type === 'saved.save') return require('../components/savetweet').saveTweetByUrl(userId, input.url);
    const target = await safeSavedPath(userId, input.tweetId);
    if (type === 'saved.delete') {
        await fs.access(target);
        // Keep a recoverable trash copy; never recurse through a computed link.
        const trash = path.join(path.dirname(userPath), '.admin-trash');
        await fs.mkdir(trash, { recursive: true });
        const receipt = `${userId}-${rowId(input.tweetId)}-${crypto.randomUUID()}`;
        await fs.rename(target, path.join(trash, receipt));
        return { deleted: true, userId, tweetId: input.tweetId, recoveryReceipt: receipt };
    }
    const data = JSON.parse(await fs.readFile(path.join(target, 'data.json'), 'utf8'));
    const files = [];
    for (const entry of await fs.readdir(target, { withFileTypes: true })) if (entry.isFile()) files.push({ name: entry.name, bytes: (await fs.stat(path.join(target, entry.name))).size });
    return { userId, tweetId: input.tweetId, data, files };
}
async function accessAction(type, input) {
    await ensureDatabaseSchema();
    const guildId = id(input.guildId, 'guildId');
    if (type === 'access.list') return { rows: await db.queryDatabase(`SELECT * FROM ${TABLES.dashboardDelegatedAccessGrants} WHERE guild_id=? ORDER BY grant_id`, [guildId]) };
    if (!['user', 'role'].includes(input.targetType)) throw new Error('targetType must be user or role.');
    const targetId = id(input.targetId, 'targetId');
    if (type === 'access.delete') return db.queryDatabase(`DELETE FROM ${TABLES.dashboardDelegatedAccessGrants} WHERE guild_id=? AND target_type=? AND target_id=?`, [guildId, input.targetType, targetId]);
    if (!['view', 'edit'].includes(input.accessLevel)) throw new Error('accessLevel must be view or edit.');
    const actor = id(process.env.ADMIN_OWNER_ID || '796972193287503913', 'ADMIN_OWNER_ID');
    await db.queryDatabase(`INSERT INTO ${TABLES.dashboardDelegatedAccessGrants} (guild_id,target_type,target_id,access_level,granted_by_user_id) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE access_level=VALUES(access_level),granted_by_user_id=VALUES(granted_by_user_id)`, [guildId, input.targetType, targetId, input.accessLevel, actor]);
    return { guildId, targetType: input.targetType, targetId, accessLevel: input.accessLevel };
}
module.exports = { catalog, settingAction, autoextractAction, savedAction, accessAction, validateSetting, safeSavedPath };

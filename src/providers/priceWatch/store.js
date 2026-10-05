'use strict';

const crypto = require('crypto');
const db = require('../../db');
const { TABLES, ensureDatabaseSchema } = require('../../db_schema');
const { nextIntervalMs, normalizeSource } = require('./index');

const SOURCE_LEASE_MS = 2 * 60 * 1000;
const DELIVERY_LEASE_MS = 45 * 1000;
const INITIAL_JITTER_MS = 5 * 60 * 1000;

function integer(value, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function error(message, code) {
    return Object.assign(new Error(message), { code });
}

function webhookUrlValid(value) {
    return /^https:\/\/discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(String(value || '').trim());
}

function webhookHash(url) {
    return crypto.createHash('sha256').update(url).digest('hex');
}

function json(value, fallback = {}) {
    try { return JSON.stringify(value); } catch { return JSON.stringify(fallback); }
}

function parseJson(value, fallback = {}) {
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch { return fallback; }
}

function normalizeDestination(value) {
    const destination = String(value || 'dm').toLowerCase();
    if (!['dm', 'webhook'].includes(destination)) throw error('Price-watch destination must be DM or webhook.', 'PRICE_WATCH_INVALID_DESTINATION');
    return destination;
}

function finiteThreshold(value, minimum, maximum) {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number < minimum || number > maximum) return null;
    return number;
}

function normalizeRule(input) {
    const mode = String(input.mode || '').toLowerCase();
    if (mode === 'change') return { mode, maxPriceAmount: null, minDiscountPercent: null, ruleKey: 'change' };
    if (mode !== 'threshold') throw error('Price-watch mode must be change or threshold.', 'PRICE_WATCH_INVALID_MODE');
    const maxPriceAmount = finiteThreshold(input.maxPriceAmount, 0, 999999999999999);
    const minDiscountPercent = finiteThreshold(input.minDiscountPercent, 0.01, 100);
    if (maxPriceAmount === null && minDiscountPercent === null) {
        throw error('Set a maximum price or minimum discount percentage.', 'PRICE_WATCH_THRESHOLD_REQUIRED');
    }
    return {
        mode,
        maxPriceAmount,
        minDiscountPercent,
        ruleKey: `threshold:${maxPriceAmount === null ? '' : maxPriceAmount}:${minDiscountPercent === null ? '' : minDiscountPercent}`,
    };
}

async function upsertWebhook(query, url) {
    const hash = webhookHash(url);
    const result = await query(
        `INSERT INTO ${TABLES.webhookEndpoints} (webhook_url_hash, webhook_url)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id), webhook_url=VALUES(webhook_url)`,
        [hash, url]
    );
    if (result.insertId) return String(result.insertId);
    const rows = await query(`SELECT id FROM ${TABLES.webhookEndpoints} WHERE webhook_url_hash=? LIMIT 1`, [hash]);
    if (!rows[0]?.id) throw error('Webhook endpoint could not be saved.', 'PRICE_WATCH_WEBHOOK_STORE_FAILED');
    return String(rows[0].id);
}

async function registerTarget(input, options = {}) {
    const providerId = String(input.providerId || '').toLowerCase();
    const normalized = normalizeSource(providerId, { url: input.productUrl, locale: input.locale });
    const destinationType = normalizeDestination(input.destinationType);
    const rule = normalizeRule(input);
    const userId = String(input.userId || '');
    if (!/^\d{1,32}$/.test(userId)) throw error('A valid user id is required.', 'PRICE_WATCH_INVALID_USER');
    const webhookUrl = String(input.webhookUrl || '').trim();
    if (destinationType === 'webhook' && !webhookUrlValid(webhookUrl)) throw error('A Discord webhook URL is required.', 'PRICE_WATCH_INVALID_WEBHOOK');
    const now = integer(options.now, Date.now(), 0);
    const random = options.random || Math.random;
    const jitter = integer(options.initialJitterMs, INITIAL_JITTER_MS, 0, 24 * 60 * 60 * 1000);

    await ensureDatabaseSchema();
    await db.ensureUserExistsInDatabase(userId);
    return await db.withDatabaseTransaction(async query => {
        const webhookEndpointId = destinationType === 'webhook' ? await upsertWebhook(query, webhookUrl) : null;
        const destinationKey = destinationType === 'dm' ? `dm:${userId}` : `webhook:${webhookEndpointId}`;
        const initialDue = now + Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * jitter);
        await query(
            `INSERT INTO ${TABLES.priceWatchSources}
             (provider_id, product_key, product_url, source_locale, product_name, state_json, poll_interval_ms, next_check_at_ms, created_at_ms)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
             ON DUPLICATE KEY UPDATE product_url=VALUES(product_url), product_name=COALESCE(VALUES(product_name), product_name), id=LAST_INSERT_ID(id)`,
            [providerId, normalized.productKey, normalized.productUrl, normalized.sourceLocale, input.productName ? String(input.productName).slice(0, 1024) : null, nextIntervalMs(providerId), initialDue, now]
        );
        const sourceRows = await query(
            `SELECT id, initialized_at_ms FROM ${TABLES.priceWatchSources} WHERE provider_id=? AND product_key=? AND source_locale=? LIMIT 1`,
            [providerId, normalized.productKey, normalized.sourceLocale]
        );
        const source = sourceRows[0];
        if (!source?.id) throw error('Price-watch source could not be saved.', 'PRICE_WATCH_SOURCE_STORE_FAILED');
        await query(
            `INSERT INTO ${TABLES.priceWatchTargets}
             (source_id, user_id, guild_id, origin_channel_id, destination_type, destination_key, webhook_endpoint_id,
              watch_mode, rule_key, max_price_amount, min_discount_percent, enabled, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
             ON DUPLICATE KEY UPDATE baseline_at_ms=IF(enabled=0,NULL,baseline_at_ms),condition_active=IF(enabled=0,0,condition_active),created_at_ms=IF(enabled=0,VALUES(created_at_ms),created_at_ms),enabled=1, id=LAST_INSERT_ID(id)`,
            [
                source.id,
                userId,
                input.guildId ? String(input.guildId) : null,
                input.channelId ? String(input.channelId) : null,
                destinationType,
                destinationKey,
                webhookEndpointId,
                rule.mode,
                rule.ruleKey,
                rule.maxPriceAmount,
                rule.minDiscountPercent,
                now,
            ]
        );
        const targetRows = await query(
            `SELECT id FROM ${TABLES.priceWatchTargets}
             WHERE source_id=? AND user_id=? AND destination_key=? AND watch_mode=? AND rule_key=? LIMIT 1`,
            [source.id, userId, destinationKey, rule.mode, rule.ruleKey]
        );
        return {
            id: String(targetRows[0]?.id || ''),
            providerId,
            productUrl: normalized.productUrl,
            destinationType,
            mode: rule.mode,
            initialCheckNotBeforeMs: source.initialized_at_ms ? null : initialDue,
        };
    });
}

async function deleteTarget(userId, targetId) {
    if (!/^\d{1,20}$/.test(String(targetId))) throw error('A valid price-watch ID is required.', 'PRICE_WATCH_INVALID_ID');
    await ensureDatabaseSchema();
    return await db.withDatabaseTransaction(async query => {
        const rows = await query(`SELECT source_id FROM ${TABLES.priceWatchTargets} WHERE id=? AND user_id=? LIMIT 1`, [String(targetId), String(userId)]);
        if (!rows.length) throw error('Price-watch registration does not exist.', 'PRICE_WATCH_NOT_FOUND');
        const sourceId = rows[0].source_id;
        await query(`DELETE FROM ${TABLES.priceWatchTargets} WHERE id=? AND user_id=?`, [String(targetId), String(userId)]);
        await query(`DELETE FROM ${TABLES.priceWatchSources} WHERE id=? AND NOT EXISTS (SELECT 1 FROM ${TABLES.priceWatchTargets} WHERE source_id=?)`, [sourceId, sourceId]);
        return { id: String(targetId), deleted: true };
    });
}

async function claimDueSources(now, limit = 32) {
    const rows = await db.queryDatabase(
        `SELECT s.* FROM ${TABLES.priceWatchSources} s
         WHERE s.next_check_at_ms<=? AND s.lease_expires_at_ms<=?
           AND EXISTS (SELECT 1 FROM ${TABLES.priceWatchTargets} t WHERE t.source_id=s.id AND t.enabled=1)
         ORDER BY s.next_check_at_ms ASC, s.id ASC LIMIT ?`,
        [now, now, integer(limit, 32, 1, 128)]
    );
    const claimed = [];
    for (const source of rows) {
        const token = crypto.randomUUID();
        const result = await db.queryDatabase(
            `UPDATE ${TABLES.priceWatchSources}
             SET lease_token=?, lease_expires_at_ms=?
             WHERE id=? AND next_check_at_ms<=? AND lease_expires_at_ms<=?`,
            [token, now + SOURCE_LEASE_MS, source.id, now, now]
        );
        if (Number(result.affectedRows || 0) === 1) claimed.push({ ...source, lease_token: token });
    }
    return claimed;
}

async function sourceTargets(sourceId) {
    return await db.queryDatabase(
        `SELECT t.*, w.webhook_url,COALESCE(m.revision,1) AS configuration_revision
         FROM ${TABLES.priceWatchTargets} t
         LEFT JOIN ${TABLES.webhookEndpoints} w ON w.id=t.webhook_endpoint_id
         LEFT JOIN automation_monitors m ON m.target_kind='price' AND m.target_id=t.id
         WHERE t.source_id=? AND t.enabled=1 ORDER BY t.id`,
        [sourceId]
    );
}

async function completeSource(source, snapshot, events, targetStates, now, nextCheckAtMs) {
    await db.withDatabaseTransaction(async query => {
        const updated = await query(
            `UPDATE ${TABLES.priceWatchSources}
             SET product_name=COALESCE(?, product_name), state_json=?, initialized_at_ms=COALESCE(initialized_at_ms, ?),
                 last_checked_at_ms=?, next_check_at_ms=?, lease_token=NULL, lease_expires_at_ms=0,
                 failure_count=0, last_error_code=NULL, last_error_at_ms=NULL
             WHERE id=? AND lease_token=? AND lease_expires_at_ms>?`,
            [snapshot.productName || null, json(snapshot), now, now, nextCheckAtMs, source.id, source.lease_token, Date.now()]
        );
        if (Number(updated.affectedRows) !== 1) throw error('Price-watch source lease was lost.', 'PRICE_WATCH_LEASE_LOST');
        const eligibleTargets = new Set();
        for (const state of targetStates) {
            const rows = await query(`SELECT t.*,COALESCE(m.revision,1) AS configuration_revision FROM ${TABLES.priceWatchTargets} t LEFT JOIN automation_monitors m ON m.target_kind='price' AND m.target_id=t.id WHERE t.id=? AND t.source_id=? AND t.enabled=1 FOR UPDATE`, [state.targetId, source.id]);
            const target = rows[0];
            if (!target || state.ruleKey !== target.rule_key || state.destinationKey !== target.destination_key || Number(state.configurationRevision) !== Number(target.configuration_revision)) continue;
            eligibleTargets.add(String(state.targetId));
            await query(`UPDATE ${TABLES.priceWatchTargets} SET condition_active=?,baseline_at_ms=COALESCE(baseline_at_ms,?) WHERE id=?`, [state.conditionActive ? 1 : 0, now, state.targetId]);
        }
        for (const event of events) {
            if (!eligibleTargets.has(String(event.targetId))) continue;
            await query(
                `INSERT IGNORE INTO ${TABLES.priceWatchDeliveries}
                 (target_id, event_key, message_text, event_json, status, next_attempt_at_ms)
                 VALUES (?, ?, ?, ?, 'pending', ?)`,
                [event.targetId, event.eventKey, event.messageText, event.event ? json(event.event) : null, now]
            );
        }
    });
}

async function failSource(source, errorObject, now, nextCheckAtMs) {
    await db.queryDatabase(
        `UPDATE ${TABLES.priceWatchSources}
         SET last_checked_at_ms=?, next_check_at_ms=?, lease_token=NULL, lease_expires_at_ms=0,
             failure_count=failure_count+1, last_error_code=?, last_error_at_ms=?
         WHERE id=? AND lease_token=?`,
        [now, nextCheckAtMs, String(errorObject?.code || 'PRICE_WATCH_UPSTREAM_ERROR').slice(0, 96), now, source.id, source.lease_token]
    );
}

async function rescheduleSource(source, nextCheckAtMs) {
    await db.queryDatabase(
        `UPDATE ${TABLES.priceWatchSources} SET next_check_at_ms=?, lease_token=NULL, lease_expires_at_ms=0 WHERE id=? AND lease_token=?`,
        [nextCheckAtMs, source.id, source.lease_token]
    );
}

async function reserveProvider(providerId, spacingMs, now) {
    const stateId = `price:${providerId}`;
    await db.queryDatabase(`INSERT IGNORE INTO ${TABLES.autoWatchProviderStates} (provider_id) VALUES (?)`, [stateId]);
    const rows = await db.queryDatabase(`SELECT next_allowed_at_ms, cooldown_until_ms FROM ${TABLES.autoWatchProviderStates} WHERE provider_id=? LIMIT 1`, [stateId]);
    const current = rows[0] || {};
    const notBefore = Math.max(Number(current.next_allowed_at_ms || 0), Number(current.cooldown_until_ms || 0));
    if (notBefore > now) return { allowed: false, nextCheckAtMs: notBefore };
    const nextAllowedAtMs = now + Math.max(0, Number(spacingMs || 0));
    const result = await db.queryDatabase(
        `UPDATE ${TABLES.autoWatchProviderStates}
         SET next_allowed_at_ms=?
         WHERE provider_id=? AND next_allowed_at_ms<=? AND cooldown_until_ms<=?`,
        [nextAllowedAtMs, stateId, now, now]
    );
    if (Number(result.affectedRows || 0) === 1) return { allowed: true, nextCheckAtMs: nextAllowedAtMs };
    const retry = await db.queryDatabase(`SELECT next_allowed_at_ms, cooldown_until_ms FROM ${TABLES.autoWatchProviderStates} WHERE provider_id=? LIMIT 1`, [stateId]);
    return { allowed: false, nextCheckAtMs: Math.max(Number(retry[0]?.next_allowed_at_ms || 0), Number(retry[0]?.cooldown_until_ms || 0), now + 1000) };
}

async function cooldownProvider(providerId, untilMs) {
    const stateId = `price:${providerId}`;
    await db.queryDatabase(
        `INSERT INTO ${TABLES.autoWatchProviderStates} (provider_id, next_allowed_at_ms, cooldown_until_ms)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
            next_allowed_at_ms=GREATEST(next_allowed_at_ms, VALUES(next_allowed_at_ms)),
            cooldown_until_ms=GREATEST(cooldown_until_ms, VALUES(cooldown_until_ms))`,
        [stateId, untilMs, untilMs]
    );
}

async function claimDueDeliveries(now, limit = 64) {
    const rows = await db.queryDatabase(
        `SELECT d.*, t.destination_type, t.user_id, t.webhook_endpoint_id, w.webhook_url
         FROM ${TABLES.priceWatchDeliveries} d
         JOIN ${TABLES.priceWatchTargets} t ON t.id=d.target_id
         LEFT JOIN ${TABLES.webhookEndpoints} w ON w.id=t.webhook_endpoint_id
         WHERE d.status='pending' AND d.next_attempt_at_ms<=? AND d.lease_expires_at_ms<=? AND t.enabled=1
         ORDER BY d.next_attempt_at_ms ASC, d.id ASC LIMIT ?`,
        [now, now, integer(limit, 64, 1, 256)]
    );
    const claimed = [];
    for (const delivery of rows) {
        const token = crypto.randomUUID();
        const result = await db.queryDatabase(
            `UPDATE ${TABLES.priceWatchDeliveries}
             SET lease_token=?, lease_expires_at_ms=?
             WHERE id=? AND status='pending' AND next_attempt_at_ms<=? AND lease_expires_at_ms<=?`,
            [token, now + DELIVERY_LEASE_MS, delivery.id, now, now]
        );
        if (Number(result.affectedRows || 0) === 1) claimed.push({ ...delivery, lease_token: token });
    }
    return claimed;
}

async function markDeliverySent(delivery, now) {
    await db.queryDatabase(
        `UPDATE ${TABLES.priceWatchDeliveries}
         SET status='sent', sent_at_ms=?, lease_token=NULL, lease_expires_at_ms=0,
             last_error_code=NULL, last_error_at_ms=NULL
         WHERE id=? AND lease_token=?`,
        [now, delivery.id, delivery.lease_token]
    );
}

async function markDeliverySuppressed(delivery, now) {
    await db.queryDatabase(
        `UPDATE ${TABLES.priceWatchDeliveries}
         SET status='suppressed', sent_at_ms=?, lease_token=NULL, lease_expires_at_ms=0,
             last_error_code='PRICE_WATCH_RECOVERY_QUARANTINED', last_error_at_ms=?
         WHERE id=? AND lease_token=?`,
        [now, now, delivery.id, delivery.lease_token]
    );
}

async function failDelivery(delivery, errorObject, now, nextAttemptAtMs, permanent = false) {
    const exhausted = Number(delivery.attempt_count || 0) + 1 >= 10;
    const final = permanent || exhausted;
    await db.queryDatabase(
        `UPDATE ${TABLES.priceWatchDeliveries}
         SET status=?, attempt_count=attempt_count+1, next_attempt_at_ms=?, lease_token=NULL, lease_expires_at_ms=0,
             last_error_code=?, last_error_at_ms=?
         WHERE id=? AND lease_token=?`,
        [final ? 'failed' : 'pending', final ? 0 : nextAttemptAtMs, String(errorObject?.code || 'PRICE_WATCH_DELIVERY_FAILED').slice(0, 96), now, delivery.id, delivery.lease_token]
    );
    if (final && [401, 403, 404].includes(Number(errorObject?.status))) {
        await db.queryDatabase(`UPDATE ${TABLES.priceWatchTargets} SET enabled=0 WHERE id=?`, [delivery.target_id]);
    }
}

module.exports = {
    INITIAL_JITTER_MS,
    claimDueDeliveries,
    claimDueSources,
    cooldownProvider,
    completeSource,
    deleteTarget,
    failDelivery,
    failSource,
    markDeliverySent,
    markDeliverySuppressed,
    normalizeRule,
    parseJson,
    registerTarget,
    routeAutomation: (delivery, now) => require('../../automation/runtime').route('price', delivery, now),
    reserveProvider,
    rescheduleSource,
    sourceTargets,
    _internal: { finiteThreshold, normalizeDestination, webhookUrlValid },
};

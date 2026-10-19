'use strict';

const crypto = require('crypto');
const db = require('../../db');
const { TABLES, ensureDatabaseSchema } = require('../../db_schema');
const { effectivePollIntervalMs, monitorConfig, normalizeSource, provider, ratePolicy } = require('./index');
const fetchWithDeadline = require('../../providerFetch').withDeadline(require('node-fetch'));
const eligibility = require('./eligibility');
const entitlements = require('../../automation/entitlements');
const { withRateOperation } = require('../../automation/rate-operation');

const FREE_SLOT_LIMIT = 175;
const USER_FREE_SLOT_LIMIT = 5;
const SOURCE_LEASE_MS = 2 * 60 * 1000;
const DELIVERY_LEASE_MS = 45 * 1000;
const INITIAL_JITTER_MS = 5 * 60 * 1000;
const LEGACY_BACKLOG_SCAN_ROWS = 8;
let legacyBacklogScanAfterId = '0';

function integer(value, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) return fallback;
    return number;
}

function rowId(value, label = 'id') {
    if (!/^\d{1,20}$/.test(String(value))) throw Object.assign(new Error(`A valid ${label} is required.`), { code: 'AUTO_WATCH_INVALID_ID' });
    return String(value);
}

function safeErrorCode(error) {
    return String(error?.code || 'AUTO_WATCH_UPSTREAM_ERROR').slice(0, 96);
}

function sourceStateJson(value) {
    try { return JSON.stringify(value && typeof value === 'object' ? value : {}); } catch { return '{}'; }
}

function sourceCursorJson(value) {
    try { return JSON.stringify(value && typeof value === 'object' ? value : { seenContentIds: [] }); } catch { return '{"seenContentIds":[]}'; }
}

function error(message, code) {
    return Object.assign(new Error(message), { code });
}

function webhookUrlValid(value) {
    return /^https:\/\/discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(String(value || '').trim());
}

function normalizeDestinationType(value) {
    const type = String(value || 'webhook').toLowerCase();
    if (!['dm', 'webhook'].includes(type)) {
        throw error('Automatic-watch destination must be DM or webhook.', 'AUTO_WATCH_INVALID_DESTINATION');
    }
    return type;
}

function canonicalWebhookHash(webhookUrl) {
    return crypto.createHash('sha256').update(webhookUrl).digest('hex');
}

async function validateWebhook(webhookUrl, options = {}) {
    const url = String(webhookUrl || '').trim();
    if (!webhookUrlValid(url)) throw error('A Discord webhook URL is required.', 'AUTO_WATCH_INVALID_WEBHOOK');
    const fetch = options.fetch || fetchWithDeadline;
    const response = await fetch(url, { method: 'GET', timeout: integer(options.timeoutMs, 15000, 1000, 60000), size: 1048576 });
    let body = null;
    try { body = await response.json(); } catch { /* status error below */ }
    if (!response.ok || body?.type !== 1 || !/^\d{16,22}$/.test(String(body?.id || ''))
        || !/^\d{16,22}$/.test(String(body?.guild_id || ''))
        || !/^\d{16,22}$/.test(String(body?.channel_id || ''))) {
        throw Object.assign(error(`Webhook validation failed (HTTP ${response.status}).`, 'AUTO_WATCH_INVALID_WEBHOOK'), { status: response.status });
    }
    return { id: String(body.id), guildId: String(body.guild_id), channelId: String(body.channel_id) };
}

async function upsertWebhook(query, webhookUrl) {
    const result = await query(
        `INSERT INTO ${TABLES.webhookEndpoints} (webhook_url_hash, webhook_url)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id), webhook_url=VALUES(webhook_url)`,
        [canonicalWebhookHash(webhookUrl), webhookUrl]
    );
    if (result.insertId) return String(result.insertId);
    const rows = await query(`SELECT id FROM ${TABLES.webhookEndpoints} WHERE webhook_url_hash=? LIMIT 1`, [canonicalWebhookHash(webhookUrl)]);
    if (!rows[0]?.id) throw error('Webhook endpoint could not be saved.', 'AUTO_WATCH_WEBHOOK_STORE_FAILED');
    return String(rows[0].id);
}

async function slotDecision(query, userId) {
    await entitlements.assertSlotAvailable(query, userId, 'auto');
    const usage = await entitlements.listOwnerSlots(query, userId);
    return { premiumSlot: usage.usedSlots >= USER_FREE_SLOT_LIMIT ? 1 : 0, userFree: Math.min(usage.usedSlots, USER_FREE_SLOT_LIMIT),
        userPremium: Math.max(0, usage.usedSlots - USER_FREE_SLOT_LIMIT), globalFree: 0, additional: Math.max(0, usage.slotLimit - USER_FREE_SLOT_LIMIT) };
}

async function registerTarget(input, options = {}) {
    await ensureDatabaseSchema();
    return withRateOperation(db, { userId: String(input.userId || '') }, 'monitor', () => registerTargetAdmitted(input, options), { rateLimiter: options.operationRateLimiter });
}

async function registerTargetAdmitted(input, options = {}) {
    const providerId = String(input.providerId || '').toLowerCase();
    const normalized = normalizeSource(providerId, input.source);
    const rule = provider(providerId);
    const now = integer(options.now, Date.now(), 0);
    const random = options.random || Math.random;
    const jitterMs = integer(options.initialJitterMs ?? process.env.AUTO_WATCH_INITIAL_JITTER_MS, INITIAL_JITTER_MS, 0, 24 * 60 * 60 * 1000);
    const sourcePollMs = rule.defaultPollMs;
    const destinationType = normalizeDestinationType(input.destinationType);
    const webhookUrl = String(input.webhookUrl || '').trim();
    if (destinationType === 'webhook' && !webhookUrlValid(webhookUrl)) throw error('A Discord webhook URL is required.', 'AUTO_WATCH_INVALID_WEBHOOK');
    const userId = String(input.userId || '');
    if (!/^\d{1,32}$/.test(userId)) throw error('A valid user id is required.', 'AUTO_WATCH_INVALID_USER');

    await ensureDatabaseSchema();
    await eligibility.assertRegistrationAllowed(db.queryDatabase, userId);
    await db.ensureUserExistsInDatabase(userId);
    return await db.withDatabaseTransaction(async query => {
        await entitlements.lockOwner(query, userId);
        const slotLock = crypto.createHash('sha256').update('auto-watch-slots').digest('hex');
        await query('INSERT IGNORE INTO automation_counters (counter_key,used_count,expires_at_ms) VALUES (?,0,0)', [slotLock]);
        await query('SELECT counter_key FROM automation_counters WHERE counter_key=? FOR UPDATE', [slotLock]);
        await eligibility.assertRegistrationAllowed(query, userId, true);
        const webhookEndpointId = destinationType === 'webhook' ? await upsertWebhook(query, webhookUrl) : null;
        let destinationKey = destinationType === 'dm' ? `dm:${userId}`
            : input.destinationChannelId ? `channel:${input.guildId}:${input.destinationChannelId}` : `webhook:${webhookEndpointId}`;
        const initialDue = now + Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * jitterMs);
        await query(
            `INSERT INTO ${TABLES.autoWatchSources}
             (provider_id, source_key, source_url, state_json, cursor_json, poll_interval_ms, next_check_at_ms, created_at_ms)
             VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)
             ON DUPLICATE KEY UPDATE source_url=VALUES(source_url), id=LAST_INSERT_ID(id)`,
            [providerId, normalized.sourceKey, normalized.sourceUrl, sourcePollMs, initialDue, now]
        );
        const sourceRows = await query(
            `SELECT id, initialized_at_ms FROM ${TABLES.autoWatchSources} WHERE provider_id=? AND source_key=? LIMIT 1`,
            [providerId, normalized.sourceKey]
        );
        const source = sourceRows[0];
        if (!source?.id) throw error('Automatic-watch source could not be saved.', 'AUTO_WATCH_SOURCE_STORE_FAILED');
        const existingRows = input.destinationChannelId ? await query(
            `SELECT id, enabled, premium_slot, destination_key FROM ${TABLES.autoWatchTargets}
             WHERE user_id=? AND source_id=? AND destination_key IN (?,?)
             ORDER BY (destination_key=?) DESC LIMIT 1`,
            [userId, source.id, destinationKey, `webhook:${webhookEndpointId}`, destinationKey]
        ) : await query(
            `SELECT id, enabled, premium_slot FROM ${TABLES.autoWatchTargets}
             WHERE user_id=? AND source_id=? AND destination_key=? LIMIT 1`,
            [userId, source.id, destinationKey]
        );
        let existing = existingRows[0];
        if (!existing && input.destinationChannelId) existing = await require('./channel-registration').legacyChannelRegistration(query, {
            kind: 'auto', userId, sourceId: source.id, guildId: String(input.guildId), channelId: String(input.destinationChannelId), endpointId: webhookEndpointId,
            verify: options.validateWebhook || ((url, verifyOptions) => validateWebhook(url, { ...verifyOptions, fetch: options.fetch })),
        });
        // Reusing an older purpose-named webhook must return its existing
        // registration without changing its key or invalidating pending jobs.
        if (existing?.destination_key) destinationKey = existing.destination_key;
        if (existing) await (options.service || require('../../automation/service').createService(db)).validateRegistrationWorkflow(query, { userId }, 'auto', String(existing.id));
        await entitlements.assertSlotAvailable(query, userId, 'auto', existing?.id);
        const slot = { premiumSlot: existing ? Number(existing.premium_slot) ? 1 : 0 : 0 };
        await query(
            `INSERT INTO ${TABLES.autoWatchTargets}
             (user_id, source_id, guild_id, origin_channel_id, origin_channel_nsfw, source_locale,
              destination_type, destination_key, webhook_endpoint_id, premium_slot, enabled, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
             ON DUPLICATE KEY UPDATE
                baseline_at_ms=IF(enabled=0, NULL, baseline_at_ms),
                last_polled_at_ms=IF(enabled=0,NULL,last_polled_at_ms),
                next_poll_at_ms=IF(enabled=0,NULL,next_poll_at_ms),
                last_notification_window_at_ms=IF(enabled=0,NULL,last_notification_window_at_ms),
                created_at_ms=IF(enabled=0, VALUES(created_at_ms), created_at_ms),
                enabled=1, premium_slot=VALUES(premium_slot), webhook_endpoint_id=VALUES(webhook_endpoint_id), id=LAST_INSERT_ID(id)`,
            [
                userId,
                source.id,
                input.guildId ? String(input.guildId) : null,
                input.channelId ? String(input.channelId) : null,
                input.channelNsfw === true ? 1 : 0,
                input.sourceLocale ? String(input.sourceLocale).slice(0, 16) : null,
                destinationType,
                destinationKey,
                webhookEndpointId,
                slot.premiumSlot,
                now,
            ]
        );
        await require('./intervalPolicy').bringSourceForward(query, userId, source.id, now);
        const targetRows = await query(
            `SELECT id FROM ${TABLES.autoWatchTargets} WHERE user_id=? AND source_id=? AND destination_key=? LIMIT 1`,
            [userId, source.id, destinationKey]
        );
        const allocated = await entitlements.assignSlot(query, userId, 'auto', String(targetRows[0]?.id || ''));
        slot.premiumSlot = allocated.slotIndex > USER_FREE_SLOT_LIMIT ? 1 : 0;
        await query(`UPDATE ${TABLES.autoWatchTargets} SET premium_slot=? WHERE id=? AND user_id=?`, [slot.premiumSlot, targetRows[0].id, userId]);
        return {
            id: String(targetRows[0]?.id || ''),
            providerId,
            sourceKey: normalized.sourceKey,
            sourceUrl: normalized.sourceUrl,
            premium: slot.premiumSlot === 1,
            destinationType,
            initialCheckNotBeforeMs: source.initialized_at_ms ? null : initialDue,
        };
    });
}

async function listTargets(userId) {
    await ensureDatabaseSchema();
    const rows = await db.queryDatabase(
        `SELECT t.id, t.enabled, t.premium_slot, t.created_at_ms, t.destination_type,
                t.youtube_include_releases,t.youtube_include_community,
                t.last_polled_at_ms,t.next_poll_at_ms,
                s.provider_id, s.source_key, s.source_url, s.last_checked_at_ms, s.next_check_at_ms,
                s.failure_count, s.last_error_code,
                w.id AS webhook_endpoint_id
         FROM ${TABLES.autoWatchTargets} t
         JOIN ${TABLES.autoWatchSources} s ON s.id=t.source_id
         LEFT JOIN ${TABLES.webhookEndpoints} w ON w.id=t.webhook_endpoint_id
         WHERE t.user_id=? ORDER BY t.id`,
        [String(userId)]
    );
    return rows.map(row => ({
        id: String(row.id),
        providerId: row.provider_id,
        sourceKey: row.source_key,
        sourceUrl: row.source_url,
        enabled: Boolean(row.enabled),
        premium: Boolean(row.premium_slot),
        destinationType: row.destination_type,
        ...(row.provider_id === 'youtube' ? { youtubeOptions: require('../youtube/watch-options').optionsFromRow(row) } : {}),
        webhookEndpointId: row.webhook_endpoint_id ? String(row.webhook_endpoint_id) : null,
        ...require('./target-timing').targetTiming(row),
        failureCount: Number(row.failure_count || 0),
        lastErrorCode: row.last_error_code || null,
    }));
}

async function deleteTarget(userId, targetId) {
    await ensureDatabaseSchema();
    return await db.withDatabaseTransaction(async query => {
        await entitlements.lockOwner(query, String(userId));
        const rows = await query(
            `SELECT source_id FROM ${TABLES.autoWatchTargets} WHERE id=? AND user_id=? LIMIT 1`,
            [rowId(targetId, 'watch id'), String(userId)]
        );
        if (!rows.length) throw error('Automatic-watch registration does not exist.', 'AUTO_WATCH_NOT_FOUND');
        const sourceId = rows[0].source_id;
        await query(`SELECT id FROM ${TABLES.autoWatchSources} WHERE id=? FOR UPDATE`, [sourceId]);
        await query(`DELETE FROM ${TABLES.autoWatchTargets} WHERE id=? AND user_id=?`, [rowId(targetId, 'watch id'), String(userId)]);
        await entitlements.releaseSlot(query, String(userId), 'auto', String(targetId));
        await query(
            `DELETE FROM ${TABLES.autoWatchSources}
             WHERE id=? AND NOT EXISTS (SELECT 1 FROM ${TABLES.autoWatchTargets} WHERE source_id=?)`,
            [sourceId, sourceId]
        );
        return { id: String(targetId), deleted: true };
    });
}

async function activeSourceCounts() {
    const rows = await db.queryDatabase(
        `SELECT s.provider_id, COUNT(*) AS total
         FROM ${TABLES.autoWatchSources} s
         WHERE EXISTS (SELECT 1 FROM ${TABLES.autoWatchTargets} t WHERE t.source_id=s.id AND t.enabled=1)
         GROUP BY s.provider_id`
    );
    return new Map(rows.map(row => [row.provider_id, Number(row.total || 0)]));
}

function sourceLeaseMs(config = monitorConfig()) {
    return Math.max(SOURCE_LEASE_MS, config.timeoutMs * 5 + 30000);
}

async function rescueLegacyBacklog(now) {
    // Read a bounded primary-key page, not every future source or its payload.
    // At most one complete cursor is read/repaired per claim call. Later calls
    // continue the sweep; the durable marker survives a restart/local failure.
    const rows = await db.queryDatabase(`SELECT id,next_check_at_ms,lease_expires_at_ms,
        CASE WHEN JSON_VALID(cursor_json) THEN JSON_TYPE(JSON_EXTRACT(cursor_json,'$.deferredItems'))='ARRAY'
            AND JSON_LENGTH(JSON_EXTRACT(cursor_json,'$.deferredItems'))>0
            AND JSON_CONTAINS_PATH(cursor_json,'one','$.nextRemoteCheckAtMs')=0 ELSE 0 END AS legacy_backlog
        FROM auto_watch_sources WHERE id>? ORDER BY id LIMIT ?`, [legacyBacklogScanAfterId, LEGACY_BACKLOG_SCAN_ROWS]);
    if (!rows.length) { legacyBacklogScanAfterId = '0'; return; }
    for (const candidate of rows) {
        legacyBacklogScanAfterId = String(candidate.id);
        if (!Number(candidate.legacy_backlog) || Number(candidate.next_check_at_ms) <= now || Number(candidate.lease_expires_at_ms) > now) continue;
        const source = (await db.queryDatabase('SELECT cursor_json,next_check_at_ms,initialized_at_ms FROM auto_watch_sources WHERE id=?', [candidate.id]))[0];
        if (!source || !Number(source.initialized_at_ms) || Number(source.next_check_at_ms) <= now) return;
        if (typeof source.cursor_json !== 'string' || Buffer.byteLength(source.cursor_json) > 15 * 1024 * 1024) return;
        let cursor;
        try {
            cursor = JSON.parse(source.cursor_json);
            if (Object.hasOwn(cursor, 'nextRemoteCheckAtMs') || !Array.isArray(cursor.seenContentIds) || cursor.seenContentIds.length > 5000
                || !Array.isArray(cursor.deferredItems) || !cursor.deferredItems.length || cursor.deferredItems.length > 5000
                || cursor.deferredItems.some(item => !item || typeof item.contentId !== 'string' || !item.contentId || item.contentId.length > 255
                    || typeof item.url !== 'string' || !item.url || !Number.isSafeInteger(item.discoveredAtMs) || item.discoveredAtMs < 0)
                || Buffer.byteLength(JSON.stringify(cursor.deferredItems)) > 12 * 1024 * 1024) return;
            // Load lazily after module initialization: this pure authoritative
            // parser validates legacy observation pairs and cursor bounds too.
            require('./runner')._internal.parseCursor(cursor);
        } catch { return; }
        const remoteAt = Number(source.next_check_at_ms);
        if (!Number.isSafeInteger(remoteAt) || remoteAt < 0) return;
        const repaired = { ...cursor, nextRemoteCheckAtMs: remoteAt };
        const fingerprint = crypto.createHash('sha256').update(source.cursor_json).digest('hex');
        await db.queryDatabase(`UPDATE auto_watch_sources SET cursor_json=?,next_check_at_ms=?
            WHERE id=? AND next_check_at_ms=? AND lease_expires_at_ms<=? AND SHA2(cursor_json,256)=?
            AND EXISTS (SELECT 1 FROM auto_watch_targets t WHERE t.source_id=auto_watch_sources.id AND t.enabled=1)`,
        [sourceCursorJson(repaired), now, candidate.id, remoteAt, now, fingerprint]);
        return;
    }
    if (rows.length < LEGACY_BACKLOG_SCAN_ROWS) legacyBacklogScanAfterId = '0';
}

async function claimDueSources(now, limit = 16, config = monitorConfig()) {
    await rescueLegacyBacklog(now);
    const leaseMs = sourceLeaseMs(config);
    const boundedLimit = integer(limit, 16, 1, 128);
    const rows = await db.queryDatabase(
        `SELECT s.*,
         EXISTS(SELECT 1 FROM auto_watch_targets yt WHERE yt.source_id=s.id AND yt.enabled=1 AND yt.youtube_include_releases=1) AS youtube_fetch_releases,
         EXISTS(SELECT 1 FROM auto_watch_targets yt WHERE yt.source_id=s.id AND yt.enabled=1 AND yt.youtube_include_community=1) AS youtube_fetch_community,
         (SELECT MIN(COALESCE(u.auto_watch_interval_minutes*60000,s.poll_interval_ms))
          FROM ${TABLES.autoWatchTargets} t JOIN ${TABLES.users} u ON u.user_id=t.user_id WHERE t.source_id=s.id AND t.enabled=1) AS requested_poll_interval_ms,
         EXISTS(SELECT 1 FROM ${TABLES.autoWatchTargets} t JOIN ${TABLES.users} u ON u.user_id=t.user_id
          WHERE t.source_id=s.id AND t.enabled=1 AND u.auto_watch_interval_minutes IS NOT NULL) AS has_user_interval,
         EXISTS(SELECT 1 FROM automation_notification_boost_slots b JOIN auto_watch_targets bt ON bt.id=b.target_id
          WHERE b.target_kind='auto' AND bt.source_id=s.id AND bt.enabled=1) AS has_slot_boost
         FROM ${TABLES.autoWatchSources} s
         WHERE s.next_check_at_ms<=?
           AND s.lease_expires_at_ms<=?
           AND EXISTS (SELECT 1 FROM ${TABLES.autoWatchTargets} t WHERE t.source_id=s.id AND t.enabled=1)
         ORDER BY s.next_check_at_ms ASC, s.id ASC LIMIT ?`,
        [now, now, boundedLimit]
    );
    const claimed = [];
    for (const source of rows) {
        if (Number(source.has_slot_boost)) Object.assign(source, await require('../../automation/monitor-cadence').sourceSchedule(db.queryDatabase, source, now));
        const leaseToken = crypto.randomUUID();
        const result = await db.queryDatabase(
            `UPDATE ${TABLES.autoWatchSources}
             SET lease_token=?, lease_expires_at_ms=?
             WHERE id=? AND next_check_at_ms<=? AND lease_expires_at_ms<=?`,
            [leaseToken, now + leaseMs, source.id, now, now]
        );
        if (Number(result.affectedRows || 0) !== 1) continue;
        claimed.push({ ...source, lease_token: leaseToken, lease_expires_at_ms: now + leaseMs });
    }
    return claimed;
}

async function currentPollInterval(query, sourceId, now) {
    const schedule = (await query(`SELECT s.*,
            (SELECT MIN(COALESCE(u.auto_watch_interval_minutes*60000,s.poll_interval_ms)) FROM auto_watch_targets t
             JOIN users u ON u.user_id=t.user_id WHERE t.source_id=s.id AND t.enabled=1) AS requested_poll_interval_ms,
            EXISTS(SELECT 1 FROM auto_watch_targets t JOIN users u ON u.user_id=t.user_id
             WHERE t.source_id=s.id AND t.enabled=1 AND u.auto_watch_interval_minutes IS NOT NULL) AS has_user_interval,
            EXISTS(SELECT 1 FROM automation_notification_boost_slots b JOIN auto_watch_targets bt ON bt.id=b.target_id
             WHERE b.target_kind='auto' AND bt.source_id=s.id AND bt.enabled=1) AS has_slot_boost
            FROM auto_watch_sources s WHERE s.id=?`, [sourceId]))[0];
    if (!schedule) return null;
    const counts = await activeSourceCounts();
    if (Number(schedule.has_slot_boost)) Object.assign(schedule, await require('../../automation/monitor-cadence').sourceSchedule(query, schedule, now));
    return computedPollInterval(schedule, counts.get(schedule.provider_id) || 1);
}

async function completeSource(source, result) {
    const values = [
        sourceStateJson(result.state),
        sourceCursorJson(result.cursor),
        result.etag || null,
        result.lastModified || null,
        result.initializedAtMs || null,
        result.nextCheckAtMs,
        result.checkedAtMs,
        source.id,
        source.lease_token,
    ];
    await db.withDatabaseTransaction(async query => {
        await query(`SELECT id FROM ${TABLES.autoWatchSources} WHERE id=? AND lease_token=? FOR UPDATE`, [source.id, source.lease_token]);
        const interval = await currentPollInterval(query, source.id, result.checkedAtMs);
        if (interval !== null) values[5] = result.checkedAtMs + interval;
        if (result.cursor?.deferredItems?.length) {
            // Materialize the durable tail on later local ticks without bringing
            // forward the next upstream request or spending another API permit.
            result.cursor.nextRemoteCheckAtMs = values[5];
            values[1] = sourceCursorJson(result.cursor);
            values[5] = result.checkedAtMs + integer(process.env.AUTO_WATCH_TICK_MS, 30000, 5000, 600000);
        }
        const updated = await query(
        `UPDATE ${TABLES.autoWatchSources}
         SET state_json=?, cursor_json=?, etag=?, last_modified=?, initialized_at_ms=COALESCE(initialized_at_ms, ?),
             next_check_at_ms=?, last_checked_at_ms=?, lease_token=NULL, lease_expires_at_ms=0,
             failure_count=0, last_error_code=NULL, last_error_at_ms=NULL
         WHERE id=? AND lease_token=? AND lease_expires_at_ms>?`,
        [...values, Date.now()]
        );
        if (Number(updated.affectedRows) !== 1) throw error('Automatic-watch source lease was lost.', 'AUTO_WATCH_LEASE_LOST');
        if (result.items?.length) await createItemsAndDeliveries(source, result.items, result.checkedAtMs);
        const targets = await query(`SELECT t.id,t.next_poll_at_ms,t.user_id,
            (SELECT slot_cost FROM automation_monitor_cadence c WHERE c.target_kind='auto' AND c.target_id=t.id AND c.owner_user_id=t.user_id) AS slot_cost,
            (SELECT COALESCE(u.auto_watch_interval_minutes*60000,(SELECT poll_interval_ms FROM auto_watch_sources WHERE id=t.source_id))
             FROM users u WHERE u.user_id=t.user_id) AS interval_ms
            FROM auto_watch_targets t
            WHERE t.source_id=? AND t.enabled=1 FOR UPDATE`, [source.id]);
        for (const target of targets) {
            if (Number(target.slot_cost) > 1) target.interval_ms = (await require('../../automation/monitor-cadence').runtimeCadence(query, target.user_id, 'auto', String(target.id), Number(target.interval_ms), result.checkedAtMs)).intervalMs;
            if (Number(target.next_poll_at_ms || 0) > result.checkedAtMs) continue;
            await query('UPDATE auto_watch_targets SET last_polled_at_ms=?,next_poll_at_ms=? WHERE id=?',
                [result.checkedAtMs, result.checkedAtMs + Number(target.interval_ms), target.id]);
        }
        await query(`UPDATE ${TABLES.autoWatchTargets} SET baseline_at_ms=? WHERE source_id=? AND enabled=1 AND baseline_at_ms IS NULL`, [result.checkedAtMs, source.id]);
        if (source.provider_id === 'youtube') await query(`UPDATE auto_watch_targets SET
            youtube_releases_baseline_at_ms=IF(?=1 AND youtube_include_releases=1,COALESCE(youtube_releases_baseline_at_ms,?),youtube_releases_baseline_at_ms),
            youtube_community_baseline_at_ms=IF(?=1 AND youtube_include_community=1,COALESCE(youtube_community_baseline_at_ms,?),youtube_community_baseline_at_ms)
            WHERE source_id=? AND enabled=1`, [result.state?.youtubeTabs?.releases?.initialized === true ? 1 : 0, result.checkedAtMs,
                result.state?.youtubeTabs?.community?.initialized === true ? 1 : 0, result.checkedAtMs, source.id]);
    });
}

async function completeBacklog(source, result) {
    return db.withDatabaseTransaction(async query => {
        const rows = await query(`SELECT * FROM ${TABLES.autoWatchSources}
            WHERE id=? AND lease_token=? AND lease_expires_at_ms>? FOR UPDATE`, [source.id, source.lease_token, Date.now()]);
        if (!rows.length) throw error('Automatic-watch source lease was lost.', 'AUTO_WATCH_LEASE_LOST');
        let nextCheckAtMs = result.nextCheckAtMs;
        if (!result.cursor?.deferredItems?.length && !rows[0].last_error_code && Number(rows[0].last_checked_at_ms) > 0) {
            // An interval change during local admission applies to the next
            // real poll. A recorded upstream failure keeps its retry/backoff.
            const interval = await currentPollInterval(query, source.id, result.processedAtMs);
            if (interval !== null) nextCheckAtMs = Math.max(result.processedAtMs + integer(process.env.AUTO_WATCH_TICK_MS, 30000, 5000, 600000), Number(rows[0].last_checked_at_ms) + interval);
        }
        if (result.items?.length) await createItemsAndDeliveries(source, result.items, result.processedAtMs);
        const updated = await query(`UPDATE ${TABLES.autoWatchSources}
            SET cursor_json=?,next_check_at_ms=?,lease_token=NULL,lease_expires_at_ms=0
            WHERE id=? AND lease_token=? AND lease_expires_at_ms>?`,
        [sourceCursorJson(result.cursor), nextCheckAtMs, source.id, source.lease_token, Date.now()]);
        if (Number(updated.affectedRows) !== 1) throw error('Automatic-watch source lease was lost.', 'AUTO_WATCH_LEASE_LOST');
    });
}

async function rescheduleSource(source, nextCheckAtMs) {
    await db.queryDatabase(
        `UPDATE ${TABLES.autoWatchSources}
         SET next_check_at_ms=?, lease_token=NULL, lease_expires_at_ms=0
         WHERE id=? AND lease_token=?`,
        [nextCheckAtMs, source.id, source.lease_token]
    );
}

async function _failSource(source, failure) {
    await db.queryDatabase(
        `UPDATE ${TABLES.autoWatchSources}
         SET next_check_at_ms=?, last_checked_at_ms=?, lease_token=NULL, lease_expires_at_ms=0,
             failure_count=failure_count+1, last_error_code=?, last_error_at_ms=?
         WHERE id=? AND lease_token=?`,
        [failure.nextCheckAtMs, failure.checkedAtMs, safeErrorCode(failure.error), failure.checkedAtMs, source.id, source.lease_token]
    );
}

function windowKey(kind, now) {
    if (kind === 'minute') return `m:${Math.floor(now / (60 * 1000))}`;
    if (kind === 'hour') return `h:${Math.floor(now / (60 * 60 * 1000))}`;
    return `d:${new Date(now).toISOString().slice(0, 10)}`;
}

function nextWindowAt(kind, now) {
    const unit = kind === 'minute' ? 60 * 1000 : kind === 'hour' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    return (Math.floor(now / unit) + 1) * unit;
}

async function reserveWindow(query, providerId, kind, budget, units, now) {
    if (!budget) return true;
    if (units > Number(budget)) return false;
    const key = windowKey(kind, now);
    await query(
        `INSERT IGNORE INTO ${TABLES.autoWatchProviderUsage} (provider_id, window_key, used_units)
         VALUES (?, ?, 0)`,
        [providerId, key]
    );
    const result = await query(
        `UPDATE ${TABLES.autoWatchProviderUsage}
         SET used_units=used_units+?
         WHERE provider_id=? AND window_key=? AND used_units<=?`,
        [units, providerId, key, Math.max(0, Number(budget) - units)]
    );
    return Number(result.affectedRows || 0) === 1;
}

async function providerState(providerId) {
    await db.queryDatabase(
        `INSERT IGNORE INTO ${TABLES.autoWatchProviderStates} (provider_id) VALUES (?)`,
        [providerId]
    );
    const rows = await db.queryDatabase(`SELECT * FROM ${TABLES.autoWatchProviderStates} WHERE provider_id=? LIMIT 1`, [providerId]);
    return rows[0] || { provider_id: providerId, next_allowed_at_ms: 0, cooldown_until_ms: 0 };
}

async function reserveProviderRequest(providerId, policy, now) {
    const current = await providerState(providerId);
    const notBefore = Math.max(Number(current.cooldown_until_ms || 0), Number(current.next_allowed_at_ms || 0));
    if (notBefore > now) return { allowed: false, nextCheckAtMs: notBefore, reason: 'provider_pacing' };
    const nextAllowedAtMs = now + Math.max(0, Number(policy.globalSpacingMs || 0));
    const claimed = await db.queryDatabase(
        `UPDATE ${TABLES.autoWatchProviderStates}
         SET next_allowed_at_ms=?
         WHERE provider_id=? AND cooldown_until_ms<=? AND next_allowed_at_ms<=?`,
        [nextAllowedAtMs, providerId, now, now]
    );
    if (Number(claimed.affectedRows || 0) !== 1) {
        const refreshed = await providerState(providerId);
        return { allowed: false, nextCheckAtMs: Math.max(Number(refreshed.cooldown_until_ms || 0), Number(refreshed.next_allowed_at_ms || 0), now + 1000), reason: 'provider_pacing' };
    }
    const units = Math.max(1, Number(policy.requestCost || 1));
    const checks = [
        ['minute', policy.minuteRequestBudget],
        ['hour', policy.hourlyRequestBudget],
        ['day', policy.dailyRequestBudget],
    ];
    for (const [kind, budget] of checks) {
        if (await reserveWindow(db.queryDatabase, providerId, kind, budget, units, now)) continue;
        const retryAt = nextWindowAt(kind, now);
        await db.queryDatabase(
            `UPDATE ${TABLES.autoWatchProviderStates}
             SET next_allowed_at_ms=GREATEST(next_allowed_at_ms, ?) WHERE provider_id=?`,
            [retryAt, providerId]
        );
        return { allowed: false, nextCheckAtMs: retryAt, reason: `${kind}_budget` };
    }
    return { allowed: true, nextCheckAtMs: nextAllowedAtMs };
}

async function recordProviderRateLimit(providerId, rateLimit, now) {
    if (!rateLimit || !Number.isFinite(Number(rateLimit.limit)) || !Number.isFinite(Number(rateLimit.remaining))) return;
    const limit = Math.max(1, Number(rateLimit.limit));
    const remaining = Math.max(0, Number(rateLimit.remaining));
    const resetAtMs = Number(rateLimit.resetAtMs) || null;
    // Stop our own traffic once at least half of a documented shared bucket is
    // consumed. This leaves capacity for normal link expansion and admin work.
    const reserveFloor = Math.ceil(limit * 0.5);
    const cooldown = remaining <= reserveFloor && resetAtMs && resetAtMs > now ? resetAtMs : 0;
    await db.queryDatabase(
        `INSERT INTO ${TABLES.autoWatchProviderStates}
         (provider_id, cooldown_until_ms, last_rate_limit_limit, last_rate_limit_remaining, last_rate_limit_reset_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
             cooldown_until_ms=GREATEST(cooldown_until_ms, VALUES(cooldown_until_ms)),
             last_rate_limit_limit=VALUES(last_rate_limit_limit),
             last_rate_limit_remaining=VALUES(last_rate_limit_remaining),
             last_rate_limit_reset_at_ms=VALUES(last_rate_limit_reset_at_ms)`,
        [providerId, cooldown, limit, remaining, resetAtMs]
    );
}

async function cooldownProvider(providerId, untilMs) {
    await db.queryDatabase(
        `INSERT INTO ${TABLES.autoWatchProviderStates} (provider_id, cooldown_until_ms, next_allowed_at_ms)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
             cooldown_until_ms=GREATEST(cooldown_until_ms, VALUES(cooldown_until_ms)),
             next_allowed_at_ms=GREATEST(next_allowed_at_ms, VALUES(next_allowed_at_ms))`,
        [providerId, untilMs, untilMs]
    );
}

async function createItemsAndDeliveries(source, items, now) {
    const targets = await db.queryDatabase(
        `SELECT t.id,t.created_at_ms,t.baseline_at_ms,t.next_poll_at_ms,t.last_notification_window_at_ms,t.user_id,
            t.youtube_include_releases,t.youtube_include_community,t.youtube_releases_since_ms,t.youtube_community_since_ms,
            t.youtube_releases_baseline_at_ms,t.youtube_community_baseline_at_ms,
            (SELECT slot_cost FROM automation_monitor_cadence c WHERE c.target_kind='auto' AND c.target_id=t.id AND c.owner_user_id=t.user_id) AS slot_cost,
            (SELECT COALESCE(u.auto_watch_interval_minutes*60000,(SELECT poll_interval_ms FROM auto_watch_sources WHERE id=t.source_id))
             FROM users u WHERE u.user_id=t.user_id) AS interval_ms
         FROM ${TABLES.autoWatchTargets} t
         WHERE t.source_id=? AND t.enabled=1 AND t.baseline_at_ms IS NOT NULL FOR UPDATE`,
        [source.id]
    );
    for (const target of targets) if (Number(target.slot_cost) > 1) target.interval_ms = (await require('../../automation/monitor-cadence').runtimeCadence(db.queryDatabase, target.user_id, 'auto', String(target.id), Number(target.interval_ms), now)).intervalMs;
    let created = 0;
    for (const item of items) {
        const result = await db.queryDatabase(
            `INSERT IGNORE INTO ${TABLES.autoWatchItems}
             (source_id, content_key, content_url, published_at_ms, title, payload_json, discovered_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [source.id, String(item.contentId), String(item.url), item.publishedAtMs || null, item.title ? String(item.title).slice(0, 1024) : null, sourceStateJson(item),
                Number.isSafeInteger(item.discoveredAtMs) && item.discoveredAtMs >= 0 && item.discoveredAtMs <= now ? item.discoveredAtMs : now]
        );
        let itemId;
        if (Number(result.affectedRows || 0) === 1) {
            itemId = result.insertId;
            created += 1;
        } else {
            const existing = await db.queryDatabase(
                `SELECT id, discovered_at_ms FROM ${TABLES.autoWatchItems} WHERE source_id=? AND content_key=? LIMIT 1`,
                [source.id, String(item.contentId)]
            );
            itemId = existing[0]?.id;
        }
        if (!itemId) continue;
        const itemRows = await db.queryDatabase(`SELECT discovered_at_ms FROM ${TABLES.autoWatchItems} WHERE id=? LIMIT 1`, [itemId]);
        const discoveredAtMs = Number(itemRows[0]?.discovered_at_ms || now);
        for (const target of targets) {
            // A newly registered watcher must not receive older discoveries
            // merely because a prior delivery was repaired after a restart.
            if (Number(target.created_at_ms || 0) > discoveredAtMs || Number(target.baseline_at_ms) >= discoveredAtMs) continue;
            if (source.provider_id === 'youtube' && !require('../youtube/watch-options').acceptsItem(target, item, discoveredAtMs)) continue;
            const cadenceDueAtMs = Math.max(now, Number(target.next_poll_at_ms || 0),
                Number(target.last_notification_window_at_ms || 0) ? Number(target.last_notification_window_at_ms) + Number(target.interval_ms) : 0);
            await db.queryDatabase(
                `INSERT IGNORE INTO ${TABLES.autoWatchDeliveries}
                 (item_id, target_id, status, next_attempt_at_ms,cadence_due_at_ms)
                 VALUES (?, ?, 'pending', ?,?)`,
                [itemId, target.id, cadenceDueAtMs, cadenceDueAtMs]
            );
        }
    }
    return { created };
}

async function claimDueDeliveries(now, limit = 32) {
    const rows = await db.queryDatabase(
        `SELECT d.*, i.content_url, i.discovered_at_ms, i.payload_json, i.content_key, i.title, i.published_at_ms, s.provider_id, s.source_key,
                t.destination_type, t.guild_id, t.origin_channel_id, t.origin_channel_nsfw, t.source_locale,
                t.user_id AS destination_user_id, t.webhook_endpoint_id, w.webhook_url,t.last_notification_window_at_ms,t.baseline_at_ms,t.notification_window_json,
                COALESCE((SELECT auto_watch_interval_minutes*60000 FROM users WHERE user_id=t.user_id),s.poll_interval_ms) AS base_interval_ms,
                (SELECT slot_cost FROM automation_monitor_cadence c WHERE c.target_kind='auto' AND c.target_id=t.id AND c.owner_user_id=t.user_id) AS slot_cost
         FROM ${TABLES.autoWatchDeliveries} d
         JOIN ${TABLES.autoWatchItems} i ON i.id=d.item_id
         JOIN ${TABLES.autoWatchTargets} t ON t.id=d.target_id
         JOIN ${TABLES.autoWatchSources} s ON s.id=i.source_id
         LEFT JOIN ${TABLES.webhookEndpoints} w ON w.id=t.webhook_endpoint_id
         WHERE d.status='pending' AND d.next_attempt_at_ms<=? AND d.lease_expires_at_ms<=? AND t.enabled=1
         ORDER BY d.next_attempt_at_ms ASC, d.id ASC LIMIT ?`,
        [now, now, integer(limit, 32, 1, 256)]
    );
    const claimed = [];
    for (const delivery of rows) {
        let cadenceClaim = null;
        if (delivery.slot_cost != null) {
            const cadence = await require('../../automation/monitor-cadence').runtimeCadence(db.queryDatabase, delivery.destination_user_id, 'auto', String(delivery.target_id), Number(delivery.base_interval_ms), now);
            const anchor = Number(delivery.last_notification_window_at_ms || delivery.baseline_at_ms || 0);
            const windows = require('../../automation/native-notification-window');
            const inWindow = windows.contains(windows.readWindow(delivery, cadence, now), delivery);
            // Keep the legacy claim shape for internal consumers; authority is
            // the durable target receipt, rechecked under its lock at handoff.
            cadenceClaim = { updatedAtMs: cadence.updatedAtMs, effectiveSlotCost: cadence.effectiveSlotCost, intervalMs: cadence.intervalMs, baseIntervalMs: cadence.baseIntervalMs, anchorAtMs: anchor };
            const due = Math.max(Number(delivery.next_attempt_at_ms), !inWindow && anchor ? anchor + cadence.intervalMs : 0);
            if (due > now) {
                await db.queryDatabase("UPDATE auto_watch_deliveries SET next_attempt_at_ms=? WHERE id=? AND status='pending' AND lease_expires_at_ms<=?", [due, delivery.id, now]);
                continue;
            }
        }
        const leaseToken = crypto.randomUUID();
        const result = await db.queryDatabase(
            `UPDATE ${TABLES.autoWatchDeliveries}
             SET lease_token=?, lease_expires_at_ms=?,cadence_due_at_ms=COALESCE(cadence_due_at_ms,next_attempt_at_ms)
             WHERE id=? AND status='pending' AND next_attempt_at_ms<=? AND lease_expires_at_ms<=?`,
            [leaseToken, now + DELIVERY_LEASE_MS, delivery.id, now, now]
        );
        if (Number(result.affectedRows || 0) === 1) claimed.push({ ...delivery, lease_token: leaseToken,
            cadence_due_at_ms: delivery.cadence_due_at_ms ?? delivery.next_attempt_at_ms, cadence_claim: cadenceClaim });
    }
    return claimed;
}

async function markDeliverySent(delivery, now) {
    await db.queryDatabase(
        `UPDATE ${TABLES.autoWatchDeliveries}
         SET status='sent', sent_at_ms=?, lease_token=NULL, lease_expires_at_ms=0,
             last_error_code=NULL, last_error_at_ms=NULL
         WHERE id=? AND lease_token=?`,
        [now, delivery.id, delivery.lease_token]
    );
}

async function markDeliverySuppressed(delivery, now) {
    await db.queryDatabase(
        `UPDATE ${TABLES.autoWatchDeliveries}
         SET status='suppressed', sent_at_ms=?, lease_token=NULL, lease_expires_at_ms=0,
             last_error_code='AUTO_WATCH_RECOVERY_QUARANTINED', last_error_at_ms=?
         WHERE id=? AND lease_token=?`,
        [now, now, delivery.id, delivery.lease_token]
    );
}

async function failDelivery(delivery, failure) {
    const permanent = failure.permanent === true || Number(delivery.attempt_count || 0) + 1 >= 10;
    await db.queryDatabase(
        `UPDATE ${TABLES.autoWatchDeliveries}
         SET status=?, attempt_count=attempt_count+1, next_attempt_at_ms=?, lease_token=NULL, lease_expires_at_ms=0,
             last_error_code=?, last_error_at_ms=?
         WHERE id=? AND lease_token=?`,
        [permanent ? 'failed' : 'pending', permanent ? 0 : failure.nextAttemptAtMs, safeErrorCode(failure.error), failure.atMs, delivery.id, delivery.lease_token]
    );
    if (permanent && [401, 403, 404].includes(Number(failure.status))) {
        await db.queryDatabase(`UPDATE ${TABLES.autoWatchTargets} SET enabled=0 WHERE id=?`, [delivery.target_id]);
    }
}

function computedPollInterval(source, activeSourceCount, _config) {
    return effectivePollIntervalMs(source.provider_id, activeSourceCount, source.requested_poll_interval_ms ?? source.poll_interval_ms,
        { userOverride: Number(source.has_user_interval) > 0 });
}

function policyFor(providerId, _config) {
    return ratePolicy(providerId);
}

module.exports = {
    completeBacklog,
    atomicSourceCompletion: true,
    DELIVERY_LEASE_MS,
    FREE_SLOT_LIMIT,
    INITIAL_JITTER_MS,
    SOURCE_LEASE_MS,
    USER_FREE_SLOT_LIMIT,
    activeSourceCounts,
    claimDueDeliveries,
    claimDueSources,
    completeSource,
    computedPollInterval,
    cooldownProvider,
    createItemsAndDeliveries,
    deleteTarget,
    failDelivery,
    failSource: _failSource,
    listTargets,
    markDeliverySent,
    markDeliverySuppressed,
    policyFor,
    recordProviderRateLimit,
    registerTarget,
    assertRegistrationAllowed: userId => eligibility.assertRegistrationAllowed(db.queryDatabase, userId),
    routeAutomation: (delivery, now) => require('../../automation/runtime').route('auto', delivery, now),
    reserveProviderRequest,
    rescheduleSource,
    validateWebhook,
    _internal: {
        canonicalWebhookHash,
        normalizeDestinationType,
        nextWindowAt,
        rowId,
        safeErrorCode,
        slotDecision,
        sourceCursorJson,
        sourceStateJson,
        sourceLeaseMs,
        webhookUrlValid,
        windowKey,
    },
};

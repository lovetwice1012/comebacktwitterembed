'use strict';

const crypto = require('crypto');
const { TABLES } = require('./db_schema');
const { discordErrorCode } = require('./utils');

const DEFAULT_BUCKET_SIZE_SECONDS = 60;
const DEFAULT_EVENT_RETENTION_DAYS = 30;
const DEFAULT_FLUSH_DELAY_MS = 5000;
const DEFAULT_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_EVENT_QUEUE = 5000;
const MAX_DETAILS_LENGTH = 12000;
const SEVERITIES = new Set(['debug', 'info', 'warn', 'error', 'fatal']);

const eventQueue = [];
const bucketIncrements = new Map();

let flushTimer = null;
let flushInProgress = false;
let lastFlushWarningAt = 0;
let lastPruneAt = 0;

function nowMs() {
    return Date.now();
}

function toDbString(value, maxLength = null) {
    if (value === undefined || value === null) return null;
    const text = String(value);
    return maxLength && text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeSeverity(value) {
    const severity = String(value || 'error').toLowerCase();
    return SEVERITIES.has(severity) ? severity : 'error';
}

function blankForBucket(value, maxLength = null) {
    const text = toDbString(value, maxLength);
    return text ?? '';
}

function hashValue(value) {
    if (value === undefined || value === null || value === '') return null;
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeJsonStringify(value) {
    if (value === undefined || value === null) return null;
    const seen = new WeakSet();
    const json = JSON.stringify(value, (_key, current) => {
        if (typeof current === 'bigint') return String(current);
        if (typeof current === 'function') return `[Function ${current.name || 'anonymous'}]`;
        if (current && typeof current === 'object') {
            if (seen.has(current)) return '[Circular]';
            seen.add(current);
        }
        return current;
    });
    if (!json) return null;
    return json.length > MAX_DETAILS_LENGTH ? json.slice(0, MAX_DETAILS_LENGTH) : json;
}

function normalizeUrlForStorage(rawUrl) {
    if (!rawUrl) return null;
    try {
        const url = new URL(String(rawUrl));
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch {
        return String(rawUrl).split(/[?#]/)[0] || String(rawUrl);
    }
}

function endpointKeyFromUrl(rawUrl) {
    if (!rawUrl) return null;
    try {
        const url = new URL(String(rawUrl));
        const firstSegment = url.pathname.split('/').filter(Boolean)[0];
        return firstSegment ? `${url.hostname}/${firstSegment}` : url.hostname;
    } catch {
        return null;
    }
}

function httpStatusFromError(err) {
    const direct = Number(err?.status ?? err?.statusCode ?? err?.response?.status);
    if (Number.isInteger(direct) && direct >= 100 && direct <= 599) return direct;

    const message = String(err?.message || '');
    const match = message.match(/\b([1-5][0-9]{2})\b/);
    if (!match) return null;
    const status = Number(match[1]);
    return status >= 100 && status <= 599 ? status : null;
}

function isJsonDecodeError(err) {
    const message = String(err?.message || '');
    return err?.name === 'SyntaxError'
        || err instanceof SyntaxError
        || /JSON|Unexpected token|Unexpected end of JSON/i.test(message);
}

function classifyErrorType(err, fallbackType = 'unknown') {
    const code = discordErrorCode(err);
    if (code === 10008) return 'discord_unknown_message';
    if (code === 10062) return 'discord_unknown_interaction';
    if (code === 40060) return 'discord_interaction_already_acknowledged';
    if (code === 50001 || code === 50013) return 'discord_missing_permissions';
    if (code === 20028 || code === 31001 || code === 429) return 'discord_rate_limited';
    if (isJsonDecodeError(err)) return 'provider_api_json_decode_error';
    if (httpStatusFromError(err)) return 'provider_api_http_error';
    return fallbackType;
}

function extractMessageContext(message) {
    if (!message) return {};
    return {
        authorUserId: message.author?.id ?? message.user?.id ?? null,
        guildId: message.guildId ?? message.guild?.id ?? null,
        guildNameSnapshot: message.guild?.name ?? null,
        channelId: message.channelId ?? message.channel?.id ?? null,
        channelNameSnapshot: message.channel?.name ?? null,
        messageId: message.id ?? null,
    };
}

function extractInteractionContext(interaction) {
    if (!interaction) return {};
    const messageContext = extractMessageContext(interaction.message);
    return {
        ...messageContext,
        authorUserId: interaction.user?.id ?? messageContext.authorUserId ?? null,
        guildId: interaction.guildId ?? interaction.guild?.id ?? messageContext.guildId ?? null,
        guildNameSnapshot: interaction.guild?.name ?? messageContext.guildNameSnapshot ?? null,
        channelId: interaction.channelId ?? interaction.channel?.id ?? messageContext.channelId ?? null,
        channelNameSnapshot: interaction.channel?.name ?? messageContext.channelNameSnapshot ?? null,
        commandName: interaction.commandName ?? null,
        componentId: typeof interaction.customId === 'string' ? interaction.customId : null,
    };
}

/**
 * @param {Record<string, any>} context
 * @returns {Record<string, any>}
 */
function mergeContext(context = {}) {
    const messageContext = extractMessageContext(context.message);
    const interactionContext = extractInteractionContext(context.interaction);
    return {
        ...messageContext,
        ...interactionContext,
        ...context,
    };
}

function createErrorEventRow(err, context = {}) {
    const merged = mergeContext(context);
    const occurredAtMs = Number.isFinite(merged.occurredAtMs) ? Math.floor(merged.occurredAtMs) : nowMs();
    const retentionDays = Number.isFinite(merged.retentionDays) ? merged.retentionDays : DEFAULT_EVENT_RETENTION_DAYS;
    const rawUrl = toDbString(merged.url ?? merged.rawUrl);
    const normalizedUrl = toDbString(merged.normalizedUrl ?? normalizeUrlForStorage(rawUrl));
    const errorMessage = err?.message ? String(err.message) : String(err ?? '');
    const details = {
        ...(merged.details && typeof merged.details === 'object' ? merged.details : {}),
        error_name: err?.name ?? null,
        error_message: errorMessage || null,
        error_code: err?.code ?? err?.rawError?.code ?? null,
    };

    return {
        occurred_at_ms: occurredAtMs,
        expires_at_ms: retentionDays > 0 ? occurredAtMs + retentionDays * 24 * 60 * 60 * 1000 : null,
        error_type: toDbString(merged.errorType ?? classifyErrorType(err, merged.fallbackType ?? 'unknown'), 96) || 'unknown',
        severity: normalizeSeverity(merged.severity),
        source: toDbString(merged.source, 96),
        provider_id: toDbString(merged.providerId ?? merged.provider_id, 64),
        endpoint_key: toDbString(merged.endpointKey ?? endpointKeyFromUrl(rawUrl), 191),
        raw_url: rawUrl,
        normalized_url: normalizedUrl,
        url_hash: hashValue(rawUrl || normalizedUrl),
        author_user_id: toDbString(merged.authorUserId ?? merged.author_user_id, 32),
        guild_id: toDbString(merged.guildId ?? merged.guild_id, 32),
        guild_name_snapshot: toDbString(merged.guildNameSnapshot ?? merged.guild_name_snapshot, 255),
        channel_id: toDbString(merged.channelId ?? merged.channel_id, 32),
        channel_name_snapshot: toDbString(merged.channelNameSnapshot ?? merged.channel_name_snapshot, 255),
        message_id: toDbString(merged.messageId ?? merged.message_id, 32),
        command_name: toDbString(merged.commandName ?? merged.command_name, 64),
        component_id: toDbString(merged.componentId ?? merged.component_id, 191),
        discord_code: discordErrorCode(err) ?? null,
        http_status: merged.httpStatus ?? httpStatusFromError(err),
        stack_hash: hashValue(err?.stack || errorMessage),
        message_hash: hashValue(errorMessage),
        details_json: safeJsonStringify(details),
    };
}

function bucketStartMs(occurredAtMs, bucketSizeSeconds = DEFAULT_BUCKET_SIZE_SECONDS) {
    const sizeMs = bucketSizeSeconds * 1000;
    return Math.floor(occurredAtMs / sizeMs) * sizeMs;
}

function bucketKey(table, row) {
    return [
        table,
        row.bucket_start_ms,
        row.bucket_size_seconds,
        row.error_type || row.metric_name,
        row.severity || '',
        row.provider_id,
        row.guild_id,
        row.endpoint_key,
    ].join('\u0001');
}

function enqueueBucket(table, row) {
    const key = bucketKey(table, row);
    const current = bucketIncrements.get(key);
    if (current) {
        current.count += row.count;
        return;
    }
    bucketIncrements.set(key, { table, row: { ...row } });
}

function enqueueEvent(row) {
    if (eventQueue.length >= MAX_EVENT_QUEUE) eventQueue.shift();
    eventQueue.push(row);
}

function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushErrorTrackingQueue().catch(warnFlushFailure);
    }, DEFAULT_FLUSH_DELAY_MS);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function warnFlushFailure(err) {
    const timestamp = nowMs();
    if (timestamp - lastFlushWarningAt < 60000) return;
    lastFlushWarningAt = timestamp;
    console.warn('[errorTracking] Failed to flush error tracking queue:', err?.message || err);
}

function incrementErrorBucket(row) {
    enqueueBucket(TABLES.botErrorBuckets, {
        bucket_start_ms: bucketStartMs(row.occurred_at_ms),
        bucket_size_seconds: DEFAULT_BUCKET_SIZE_SECONDS,
        error_type: row.error_type,
        severity: row.severity,
        provider_id: blankForBucket(row.provider_id, 64),
        guild_id: blankForBucket(row.guild_id, 32),
        endpoint_key: blankForBucket(row.endpoint_key, 191),
        count: 1,
    });
}

function recordMetric(metricName, context = {}, count = 1) {
    if (!metricName || !Number.isFinite(count) || count <= 0) return;
    const merged = mergeContext(context);
    const occurredAtMs = Number.isFinite(merged.occurredAtMs) ? Math.floor(merged.occurredAtMs) : nowMs();
    enqueueBucket(TABLES.botMetricBuckets, {
        bucket_start_ms: bucketStartMs(occurredAtMs),
        bucket_size_seconds: DEFAULT_BUCKET_SIZE_SECONDS,
        metric_name: toDbString(metricName, 96),
        provider_id: blankForBucket(merged.providerId ?? merged.provider_id, 64),
        guild_id: blankForBucket(merged.guildId ?? merged.guild_id, 32),
        endpoint_key: blankForBucket(merged.endpointKey ?? endpointKeyFromUrl(merged.url ?? merged.rawUrl), 191),
        count: Math.floor(count),
    });
    scheduleFlush();
}

function recordError(err, context = {}) {
    try {
        const row = createErrorEventRow(err, context);
        enqueueEvent(row);
        incrementErrorBucket(row);
        recordMetric(`error.${row.error_type}`, {
            occurredAtMs: row.occurred_at_ms,
            providerId: row.provider_id,
            guildId: row.guild_id,
            endpointKey: row.endpoint_key,
        });
        scheduleFlush();
    } catch (recordErr) {
        warnFlushFailure(recordErr);
    }
}

function recordProviderError(providerId, err, message, url, context = {}) {
    recordError(err, {
        fallbackType: 'provider_extract_failed',
        source: 'provider.extract',
        providerId,
        message,
        url,
        ...context,
    });
    recordMetric('provider_extract_error', {
        providerId,
        message,
        url,
        endpointKey: context.endpointKey,
    });
}

async function insertErrorEvent(queryDatabase, row) {
    await queryDatabase(
        `INSERT INTO ${TABLES.botErrorEvents} (
            occurred_at_ms, expires_at_ms, error_type, severity, source, provider_id, endpoint_key,
            raw_url, normalized_url, url_hash, author_user_id, guild_id, guild_name_snapshot,
            channel_id, channel_name_snapshot, message_id, command_name, component_id,
            discord_code, http_status, stack_hash, message_hash, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            row.occurred_at_ms,
            row.expires_at_ms,
            row.error_type,
            row.severity,
            row.source,
            row.provider_id,
            row.endpoint_key,
            row.raw_url,
            row.normalized_url,
            row.url_hash,
            row.author_user_id,
            row.guild_id,
            row.guild_name_snapshot,
            row.channel_id,
            row.channel_name_snapshot,
            row.message_id,
            row.command_name,
            row.component_id,
            row.discord_code,
            row.http_status,
            row.stack_hash,
            row.message_hash,
            row.details_json,
        ],
    );
}

async function upsertErrorBucket(queryDatabase, row) {
    await queryDatabase(
        `INSERT INTO ${TABLES.botErrorBuckets} (
            bucket_start_ms, bucket_size_seconds, error_type, severity, provider_id, guild_id, endpoint_key, count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE count = count + VALUES(count), updated_at = CURRENT_TIMESTAMP`,
        [
            row.bucket_start_ms,
            row.bucket_size_seconds,
            row.error_type,
            row.severity,
            row.provider_id,
            row.guild_id,
            row.endpoint_key,
            row.count,
        ],
    );
}

async function upsertMetricBucket(queryDatabase, row) {
    await queryDatabase(
        `INSERT INTO ${TABLES.botMetricBuckets} (
            bucket_start_ms, bucket_size_seconds, metric_name, provider_id, guild_id, endpoint_key, count
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE count = count + VALUES(count), updated_at = CURRENT_TIMESTAMP`,
        [
            row.bucket_start_ms,
            row.bucket_size_seconds,
            row.metric_name,
            row.provider_id,
            row.guild_id,
            row.endpoint_key,
            row.count,
        ],
    );
}

async function pruneExpiredErrorEvents(queryDatabase, timestampMs = nowMs()) {
    await queryDatabase(
        `DELETE FROM ${TABLES.botErrorEvents}
        WHERE expires_at_ms IS NOT NULL AND expires_at_ms < ?
        LIMIT 1000`,
        [timestampMs],
    );
}

async function flushErrorTrackingQueue() {
    if (flushInProgress) return;
    if (eventQueue.length === 0 && bucketIncrements.size === 0) return;

    flushInProgress = true;
    const events = eventQueue.splice(0, eventQueue.length);
    const buckets = [...bucketIncrements.values()];
    bucketIncrements.clear();

    try {
        const { queryDatabase } = require('./db');
        for (const row of events) await insertErrorEvent(queryDatabase, row);
        for (const item of buckets) {
            if (item.table === TABLES.botErrorBuckets) await upsertErrorBucket(queryDatabase, item.row);
            else if (item.table === TABLES.botMetricBuckets) await upsertMetricBucket(queryDatabase, item.row);
        }
        const timestamp = nowMs();
        if (timestamp - lastPruneAt > DEFAULT_PRUNE_INTERVAL_MS) {
            lastPruneAt = timestamp;
            await pruneExpiredErrorEvents(queryDatabase, timestamp);
        }
    } catch (err) {
        warnFlushFailure(err);
    } finally {
        flushInProgress = false;
        if (eventQueue.length > 0 || bucketIncrements.size > 0) scheduleFlush();
    }
}

module.exports = {
    classifyErrorType,
    endpointKeyFromUrl,
    flushErrorTrackingQueue,
    normalizeUrlForStorage,
    pruneExpiredErrorEvents,
    recordError,
    recordMetric,
    recordProviderError,
    _internal: {
        bucketStartMs,
        createErrorEventRow,
        httpStatusFromError,
        isJsonDecodeError,
        safeJsonStringify,
    },
};

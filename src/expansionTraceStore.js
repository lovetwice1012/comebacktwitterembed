'use strict';

// Expansion traces are deliberately written outside the in-memory analytics
// batches. A restart can therefore leave a useful, durable `interrupted` row
// instead of silently losing the in-flight provider request.
const crypto = require('node:crypto');
const { queryDatabase } = require('./db');
const { TABLES } = require('./db_schema');

const TERMINAL_STATES = new Set(['completed', 'failed', 'skipped', 'interrupted']);
const activeTraceIds = new Set();
const SENSITIVE_KEY = /(?:authorization|cookie|token|key|secret|password|stkn)/i;
const URL_KEY = /(?:url|uri|href|src|attachment)/i;

function limit(value, maximum) {
    const text = String(value ?? '');
    return text.length <= maximum ? text : text.slice(0, maximum) + '…';
}

function safeUrl(value) {
    if (value === undefined || value === null) return null;
    try {
        const url = new URL(String(value));
        url.username = '';
        url.password = '';
        url.hash = '';
        for (const key of [...url.searchParams.keys()]) {
            if (SENSITIVE_KEY.test(key)) url.searchParams.delete(key);
        }
        return limit(url.toString(), 4096);
    } catch {
        return limit(value, 4096);
    }
}

function errorSummary(error) {
    if (!error) return null;
    return {
        name: limit(error.name || 'Error', 128),
        code: error.code === undefined ? null : limit(error.code, 128),
        status: Number.isFinite(Number(error.status || error.statusCode)) ? Number(error.status || error.statusCode) : null,
        message: limit(error.message || error, 4096),
    };
}

function safeValue(value, key = '', depth = 0, seen = new WeakSet()) {
    if (value === undefined || value === null) return null;
    if (SENSITIVE_KEY.test(key)) return undefined;
    if (value instanceof Error) return errorSummary(value);
    if (typeof value === 'string') return URL_KEY.test(key) ? safeUrl(value) : limit(value, 4096);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return String(value);
    if (typeof value !== 'object') return limit(value, 1024);
    if (depth >= 8 || seen.has(value)) return '[truncated]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 32).map(item => safeValue(item, '', depth + 1, seen));
    const result = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 64)) {
        const safeChild = safeValue(childValue, childKey, depth + 1, seen);
        if (safeChild !== undefined) result[childKey] = safeChild;
    }
    return result;
}

function safeJson(value, maximum = 65535) {
    if (value === undefined || value === null) return null;
    const serialized = JSON.stringify(safeValue(value));
    if (serialized.length <= maximum) return serialized;
    return JSON.stringify({
        truncated: true,
        bytes: Buffer.byteLength(serialized),
        sha256: crypto.createHash('sha256').update(serialized).digest('hex'),
    });
}

function messageFields(message = {}) {
    return {
        guildId: message.guildId ?? message.guild?.id ?? null,
        channelId: message.channelId ?? message.channel?.id ?? null,
        authorUserId: message.author?.id ?? message.user?.id ?? null,
        messageId: message.id ?? null,
    };
}

async function persist(operation, traceId) {
    try {
        await operation();
        return true;
    } catch (error) {
        // Do not turn an evidence-storage outage into a provider outage. The
        // durable row is retried at later state transitions and on shutdown.
        console.warn(`[expansionTrace] ${traceId} was not persisted: ${limit(error?.message || error, 512)}`);
        return false;
    }
}

async function beginExpansionTrace({ traceId = crypto.randomUUID(), bootId, providerId, url, message }) {
    const now = Date.now();
    const rawUrl = safeUrl(url);
    const fields = messageFields(message);
    const persisted = await persist(() => queryDatabase(
        `INSERT INTO ${TABLES.botProviderExpansionTraces} (
            trace_id, boot_id, state, created_at_ms, updated_at_ms,
            provider_id, raw_url, normalized_url, url_hash,
            guild_id, channel_id, author_user_id, message_id
        ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            traceId, limit(bootId || '', 64), now, now,
            limit(providerId || '', 64) || null, rawUrl, rawUrl,
            rawUrl ? crypto.createHash('sha256').update(rawUrl).digest('hex') : null,
            fields.guildId, fields.channelId, fields.authorUserId, fields.messageId,
        ],
        { timeoutMs: 5000, logErrors: false }
    ), traceId);
    if (persisted) activeTraceIds.add(traceId);
    return { traceId, persisted };
}

async function updateExpansionTrace(traceId, { state, outcome = null, reasonCode = null, output = undefined, delivery = undefined, error = undefined } = {}) {
    if (!traceId || !state) return false;
    const terminal = TERMINAL_STATES.has(state);
    const now = Date.now();
    const persisted = await persist(() => queryDatabase(
        `UPDATE ${TABLES.botProviderExpansionTraces}
         SET state=?, outcome=?, reason_code=?, updated_at_ms=?,
             completed_at_ms=COALESCE(?, completed_at_ms),
             output_json=COALESCE(?, output_json),
             delivery_json=COALESCE(?, delivery_json),
             error_json=COALESCE(?, error_json)
         WHERE trace_id=?`,
        [
            state, outcome === null ? null : limit(outcome, 64), reasonCode === null ? null : limit(reasonCode, 96), now,
            terminal ? now : null,
            output === undefined ? null : safeJson(output),
            delivery === undefined ? null : safeJson(delivery),
            error === undefined ? null : safeJson(errorSummary(error)),
            traceId,
        ],
        { timeoutMs: 5000, logErrors: false }
    ), traceId);
    if (persisted && terminal) activeTraceIds.delete(traceId);
    return persisted;
}

async function reconcileInterruptedExpansionTraces(bootId) {
    const now = Date.now();
    return await persist(() => queryDatabase(
        `UPDATE ${TABLES.botProviderExpansionTraces}
         SET state='interrupted', outcome='interrupted', reason_code='process_restarted',
             updated_at_ms=?, completed_at_ms=?
         WHERE state IN ('queued', 'processing', 'sending')
           AND completed_at_ms IS NULL
           AND boot_id <> ?`,
        [now, now, limit(bootId || '', 64)],
        { timeoutMs: 5000, logErrors: false }
    ), 'startup-reconciliation');
}

async function interruptActiveExpansionTraces(reasonCode = 'process_stopping') {
    const traceIds = [...activeTraceIds];
    if (traceIds.length === 0) return true;
    const now = Date.now();
    const placeholders = traceIds.map(() => '?').join(',');
    const persisted = await persist(() => queryDatabase(
        `UPDATE ${TABLES.botProviderExpansionTraces}
         SET state='interrupted', outcome='interrupted', reason_code=?, updated_at_ms=?, completed_at_ms=?
         WHERE trace_id IN (${placeholders})
           AND state IN ('queued', 'processing', 'sending')
           AND completed_at_ms IS NULL`,
        [limit(reasonCode, 96), now, now, ...traceIds],
        { timeoutMs: 5000, logErrors: false }
    ), 'shutdown-interruption');
    if (persisted) activeTraceIds.clear();
    return persisted;
}

module.exports = {
    beginExpansionTrace,
    updateExpansionTrace,
    reconcileInterruptedExpansionTraces,
    interruptActiveExpansionTraces,
    _internal: {
        activeTraceIds,
        errorSummary,
        safeJson,
        safeUrl,
        safeValue,
    },
};

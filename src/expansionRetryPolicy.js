'use strict';

const { urlIdentity } = require('./providers/_url_identity');
const RETRY_COOLDOWN_MS = 30000;
const MAX_HISTORY = 100;
const RETRYABLE_OUTCOMES = new Set(['extract_exception', 'extract_failed', 'queue_rejected']);

function traceKey(row) {
    return urlIdentity(row.provider_id, row.raw_url);
}

function canRetryHistory(rows, now = Date.now()) {
    if (!rows.length) return false;
    // Any attempted/uncertain delivery blocks a blanket resend, including an
    // older success followed by a newer failure. Unknown legacy states fail closed.
    if (!rows.every(row => row.state === 'failed' && RETRYABLE_OUTCOMES.has(row.outcome)
        && row.has_delivery === 0 && row.has_output === 0)) return false;
    const latest = Math.max(...rows.map(row => Number(row.updated_at_ms)));
    return Number.isFinite(latest) && now - latest >= RETRY_COOLDOWN_MS;
}

function groupHistory(rows) {
    const grouped = new Map();
    for (const row of rows) {
        const key = traceKey(row);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(row);
    }
    return grouped;
}

module.exports = { RETRY_COOLDOWN_MS, MAX_HISTORY, canRetryHistory, groupHistory, traceKey };

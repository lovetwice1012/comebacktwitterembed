'use strict';

const { createHash } = require('node:crypto');

// The agent rejects an individual JSON event above 8 MiB. Keep each event
// within the existing 6 MiB batch budget, including Go's JSON HTML escaping.
const MAX_EVENT_BYTES = 6 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
function agentEncodedBytes(json) {
    return Buffer.byteLength(json.replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`));
}
function binaryMetadata(value) {
    const bytes = Buffer.isBuffer(value) ? value : ArrayBuffer.isView(value)
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        : value instanceof ArrayBuffer ? Buffer.from(value) : null;
    return bytes ? { type: 'binary', omitted: true, byteLength: bytes.length, sha256: hash(bytes) } : null;
}

const IDENTITY_FIELDS = ['event_id', 'eventId', 'id', 'trace_id', 'runId', 'requestId', 'request_id', 'operation_id',
    'parent_span_id', 'span_id', 'sequence', 'stage', 'kind', 'occurred_at', 'occurredAt', 'boot_id', 'build_revision',
    'instrumentation_version', 'fleet_node', 'fleet_epoch', 'trigger_type', 'triggerType', 'guild_id', 'guildId',
    'channel_id', 'channelId', 'user_id', 'userId', 'message_id', 'messageId', 'provider_id', 'provider', 'interaction_id', 'url',
    'shard_id', 'shardId', 'actor_id', 'actorId', 'initiated_via', 'initiatedVia', 'outcome', 'durationMs'];

function compactValue(value, depth = 0) {
    if (typeof value === 'string' && Buffer.byteLength(value) > 128 * 1024) {
        return { omitted: true, type: 'string', byteLength: Buffer.byteLength(value), sha256: hash(value) };
    }
    if (!value || typeof value !== 'object') return value;
    if (depth >= 12 || (Array.isArray(value) && value.length > 256) || (!Array.isArray(value) && Object.keys(value).length > 256)) {
        const json = JSON.stringify(value);
        return { omitted: true, type: Array.isArray(value) ? 'array' : 'object', byteLength: Buffer.byteLength(json), sha256: hash(json) };
    }
    if (Array.isArray(value)) return value.map(item => compactValue(item, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactValue(item, depth + 1)]));
}

function boundEvent(row, archiveFile) {
    const json = JSON.stringify(row), originalBytes = Buffer.byteLength(json), encodedBytes = agentEncodedBytes(json);
    if (encodedBytes <= MAX_EVENT_BYTES) return row;
    let result = compactValue(row);
    if (!result || typeof result !== 'object' || Array.isArray(result)) result = {};
    if (agentEncodedBytes(JSON.stringify(result)) > MAX_EVENT_BYTES - 4096) result = {};
    for (const key of IDENTITY_FIELDS) {
        const value = row[key];
        if (typeof value === 'string') result[key] = value.slice(0, key === 'url' ? 4096 : 512);
        else if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' || value === null) result[key] = value;
    }
    const details = result.details && typeof result.details === 'object' && !Array.isArray(result.details) ? result.details : {};
    result.details = { ...details, truncation: { reason: 'event_size_limit', originalBytes, agentEncodedBytes: encodedBytes,
        sha256: hash(json), omittedFields: Object.keys(row).filter(key => !IDENTITY_FIELDS.includes(key)).slice(0, 64).map(key => key.slice(0, 128)),
        ...(archiveFile ? { archiveFile } : {}) } };
    return result;
}

module.exports = { MAX_EVENT_BYTES, agentEncodedBytes, binaryMetadata, boundEvent };

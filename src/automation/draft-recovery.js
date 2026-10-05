'use strict';

// Browser-only data contract: no endpoint secrets, network, or server writes.
const MAX_BYTES = 3 * 1024 * 1024, MAX_AGE_MS = 24 * 60 * 60 * 1000;
const credentials = /https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/|(?:["']?(?:access_token|client_secret|webhook_?url|webhook_token|authorization|password)["']?\s*[:=])/i;
function recoveryKey(ownerId, guildId) {
    if (!/^\d{16,22}$/.test(ownerId || '') || guildId && !/^\d{16,22}$/.test(guildId)) throw new Error('DRAFT_OWNER_INVALID');
    return `automation:recovery:v1:${ownerId}:${guildId || 'personal'}`;
}
function encodeRecovery(record, now = Date.now()) {
    recoveryKey(record.ownerId, record.guildId);
    const allowed = ['ownerId', 'guildId', 'workflowId', 'baseRevision', 'scope', 'definition', 'bindings', 'textDraft'];
    const value = Object.fromEntries(allowed.map(key => [key, record[key] ?? null]));
    const text = JSON.stringify({ ...value, schemaVersion: 1, savedAtMs: now });
    if (credentials.test(text) || credentials.test(record.textDraft?.text || '')) throw new Error('DRAFT_CONTAINS_CREDENTIALS');
    if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error('DRAFT_RECOVERY_SIZE');
    validateRecord(JSON.parse(text), now);
    return text;
}
function validateRecord(value, now) {
    if (!value || value.schemaVersion !== 1 || !Number.isFinite(value.savedAtMs) || value.savedAtMs > now + 60000 || now - value.savedAtMs > MAX_AGE_MS) throw new Error('DRAFT_RECOVERY_EXPIRED');
    recoveryKey(value.ownerId, value.guildId);
    if (!['private', 'guild'].includes(value.scope) || value.scope === 'guild' && !value.guildId) throw new Error('DRAFT_RECOVERY_SCOPE');
    if (value.workflowId !== null && !/^[0-9a-f-]{36}$/i.test(value.workflowId || '')) throw new Error('DRAFT_RECOVERY_ID');
    if (value.workflowId && (!Number.isSafeInteger(value.baseRevision) || value.baseRevision < 1)) throw new Error('DRAFT_RECOVERY_REVISION');
    const rule = value.definition;
    if (!rule || rule.schemaVersion !== 1 || typeof rule.name !== 'string' || !Array.isArray(rule.nodes) || rule.nodes.length > 128 || !Array.isArray(rule.edges) || rule.edges.length > 256) throw new Error('DRAFT_RECOVERY_RULE');
    if (!value.bindings || typeof value.bindings !== 'object' || Array.isArray(value.bindings)) throw new Error('DRAFT_RECOVERY_BINDINGS');
    if (value.textDraft && (!['json', 'yaml'].includes(value.textDraft.format) || typeof value.textDraft.text !== 'string' || value.textDraft.text.length > 1048576)) throw new Error('DRAFT_RECOVERY_TEXT');
    return value;
}
function decodeRecovery(text, ownerId, guildId, now = Date.now()) {
    if (typeof text !== 'string' || text.length > MAX_BYTES || new TextEncoder().encode(text).byteLength > MAX_BYTES || credentials.test(text)) throw new Error('DRAFT_RECOVERY_UNSAFE');
    const value = validateRecord(JSON.parse(text), now);
    if (value.ownerId !== ownerId || (value.guildId || null) !== (guildId || null)) throw new Error('DRAFT_OWNER_MISMATCH');
    if (credentials.test(value.textDraft?.text || '')) throw new Error('DRAFT_CONTAINS_CREDENTIALS');
    return value;
}
module.exports = { recoveryKey, encodeRecovery, decodeRecovery, MAX_AGE_MS };

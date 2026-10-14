'use strict';

const { randomBytes } = require('node:crypto');
const { lockOwner } = require('./entitlements');

const MAX_FRAME_BYTES = 64 * 1024;
const STATES = new Set(['awaiting', 'connecting', 'listening', 'requires_reenrollment', 'stopped', 'error']);
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
function identity(input) {
    if (!input || typeof input.subscriptionId !== 'string' || !UUID.test(input.subscriptionId)
        || typeof input.ownerUserId !== 'string' || !/^[0-9]{1,32}$/.test(input.ownerUserId)) fail('X_PUSH_IDENTITY_INVALID');
}
function leaseIdentity(lease) {
    identity(lease);
    if (typeof lease.token !== 'string' || !/^[0-9a-f]{64}$/.test(lease.token)
        || !Number.isSafeInteger(lease.revision) || lease.revision < 1) fail('X_PUSH_LEASE_LOST');
}
function validReason(reason) {
    if (reason !== null && (typeof reason !== 'string' || !/^X_PUSH_[A-Z_]{1,55}$/.test(reason))) fail('X_PUSH_STATE_INVALID');
}
function safeHeaders(headers) {
    if (headers === null || headers === undefined) return {};
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(headers))) fail('X_PUSH_FRAME_INVALID');
    const allowed = new Set(['encoding', 'encryption', 'crypto_key', 'encryption_key']);
    const result = {};
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(headers))) {
        if (!allowed.has(name) || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string'
            || Buffer.byteLength(descriptor.value) > 4096 || /[\r\n\0]/.test(descriptor.value)) fail('X_PUSH_FRAME_INVALID');
        result[name] = descriptor.value;
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 8192) fail('X_PUSH_FRAME_INVALID');
    return result;
}
function validateFrame(input) {
    if (!input || typeof input.version !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(input.version)
        || typeof input.data !== 'string' || input.data.length > MAX_FRAME_BYTES || !/^[A-Za-z0-9_-]*$/.test(input.data)
        || !['received', 'decryption_failed'].includes(input.status)
        || input.ackCode !== (input.status === 'received' ? 100 : 101)) fail('X_PUSH_FRAME_INVALID');
    const headers = safeHeaders(input.headers);
    if (Buffer.byteLength(JSON.stringify({ data: input.data, headers, version: input.version })) > MAX_FRAME_BYTES) fail('X_PUSH_FRAME_INVALID');
    return headers;
}
function inboxDto(row, ownerUserId) {
    return { id: String(row.id), subscriptionId: row.subscription_id, ownerUserId,
        revision: Number(row.subscription_revision), version: row.version,
        data: row.data_ciphertext, headers: JSON.parse(row.headers_json), ackCode: Number(row.ack_code),
        status: row.status, receivedAtMs: Number(row.received_at_ms), routedAtMs: row.routed_at_ms === null ? null : Number(row.routed_at_ms) };
}
function stateDto(row, clock) {
    if (!row) return null;
    const expired = ['connecting', 'listening'].includes(row.state) && Number(row.lease_expires_at_ms || 0) <= clock;
    return { subscriptionId: row.id || row.subscription_id, state: expired ? 'stopped' : row.state || 'awaiting', reasonCode: expired ? 'X_PUSH_LEASE_EXPIRED' : row.reason_code || null,
        revision: Number(row.revision || row.subscription_revision),
        retryAtMs: row.retry_at_ms == null ? null : Number(row.retry_at_ms), retryAttempt: Number(row.retry_attempt || 0),
        connectedAtMs: row.last_connected_at_ms == null ? null : Number(row.last_connected_at_ms), updatedAtMs: Number(row.updated_at_ms) };
}

function createXPushStore(db, options = {}) {
    const now = options.now || Date.now, leaseMs = options.leaseMs === undefined ? 30000 : options.leaseMs;
    if (!db || typeof db.withDatabaseTransaction !== 'function' || typeof db.queryDatabase !== 'function'
        || !Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 300000) fail('X_PUSH_STORE_CONFIG_INVALID');
    // Keep the owner -> subscription -> receiver lock order used by intake and
    // deletion. A delete cannot race a fenced inbox commit or resurrect a lease.
    async function locked(input, work) {
        identity(input);
        try {
            return await db.withDatabaseTransaction(async query => {
                await lockOwner(query, input.ownerUserId);
                const subscription = (await query('SELECT * FROM automation_x_subscriptions WHERE id=? AND owner_user_id=? FOR UPDATE', [input.subscriptionId, input.ownerUserId]))[0];
                if (!subscription) fail('X_PUSH_SUBSCRIPTION_NOT_FOUND');
                const receiver = (await query('SELECT * FROM automation_x_push_receivers WHERE subscription_id=? FOR UPDATE', [input.subscriptionId]))[0];
                return work(query, subscription, receiver);
            });
        } catch (error) {
            if (typeof error?.code === 'string' && error.code.startsWith('X_PUSH_')) throw error;
            fail('X_PUSH_STORE_UNAVAILABLE');
        }
    }
    function fence(lease, subscription, receiver) {
        leaseIdentity(lease);
        if (!receiver || Number(subscription.revision) !== lease.revision || Number(receiver.subscription_revision) !== lease.revision
            || receiver.lease_token !== lease.token || Number(receiver.lease_expires_at_ms) <= now()) fail('X_PUSH_LEASE_LOST');
    }
    async function claim(input) {
        if (typeof input?.workerId !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(input.workerId)) fail('X_PUSH_WORKER_INVALID');
        return locked(input, async (query, subscription, receiver) => {
            if (receiver?.state === 'requires_reenrollment' || receiver?.lease_token && Number(receiver.lease_expires_at_ms) > now()
                || Number(receiver?.retry_at_ms || 0) > now()) return null;
            const token = randomBytes(32).toString('hex'), expiresAtMs = now() + leaseMs, revision = Number(subscription.revision);
            await query(`INSERT INTO automation_x_push_receivers (subscription_id,state,reason_code,lease_token,worker_id,subscription_revision,lease_expires_at_ms,updated_at_ms)
                VALUES (?,'connecting',NULL,?,?,?,?,?) ON DUPLICATE KEY UPDATE state='connecting',reason_code=NULL,lease_token=VALUES(lease_token),worker_id=VALUES(worker_id),subscription_revision=VALUES(subscription_revision),lease_expires_at_ms=VALUES(lease_expires_at_ms),updated_at_ms=VALUES(updated_at_ms)`,
                [input.subscriptionId, token, input.workerId, revision, expiresAtMs, now()]);
            let sealedEnvelope;
            try { sealedEnvelope = JSON.parse(subscription.sealed_json); } catch { fail('X_PUSH_VAULT_INVALID'); }
            return { subscriptionId: input.subscriptionId, ownerUserId: input.ownerUserId, revision, token, expiresAtMs, sealedEnvelope };
        });
    }
    async function renew(lease, { authorize } = { authorize: undefined }) {
        return locked(lease, async (query, subscription, receiver) => {
            fence(lease, subscription, receiver);
            if (authorize) await authorize(query);
            fence(lease, subscription, receiver);
            const expiresAtMs = now() + leaseMs;
            await query('UPDATE automation_x_push_receivers SET lease_expires_at_ms=?,updated_at_ms=? WHERE subscription_id=?', [expiresAtMs, now(), lease.subscriptionId]);
            // Check the original locked row, not the proposed new expiration.
            // A delayed UPDATE must roll back instead of reviving an expired
            // generation after the socket watchdog has already closed it.
            fence(lease, subscription, receiver);
            return { ...lease, expiresAtMs };
        });
    }
    async function assertLease(lease, { authorize } = { authorize: undefined }) {
        return locked(lease, async (query, subscription, receiver) => {
            fence(lease, subscription, receiver);
            if (authorize) await authorize(query);
            fence(lease, subscription, receiver);
            return true;
        });
    }
    async function markState(lease, state, reasonCode = null) {
        if (!STATES.has(state)) fail('X_PUSH_STATE_INVALID');
        validReason(reasonCode);
        return locked(lease, async (query, subscription, receiver) => {
            fence(lease, subscription, receiver);
            await query(`UPDATE automation_x_push_receivers SET state=?,reason_code=?,updated_at_ms=?${state === 'listening' ? ',last_connected_at_ms=?' : ''} WHERE subscription_id=?`,
                [state, reasonCode, now(), ...(state === 'listening' ? [now()] : []), lease.subscriptionId]);
            return { state, reasonCode };
        });
    }
    async function release(lease, { state = 'stopped', reasonCode = null } = {}) {
        if (!['stopped', 'error', 'requires_reenrollment'].includes(state)) fail('X_PUSH_STATE_INVALID');
        validReason(reasonCode);
        return locked(lease, async (query, subscription, receiver) => {
            fence(lease, subscription, receiver);
            await query('UPDATE automation_x_push_receivers SET state=?,reason_code=?,lease_token=NULL,worker_id=NULL,lease_expires_at_ms=NULL,updated_at_ms=? WHERE subscription_id=?', [state, reasonCode, now(), lease.subscriptionId]);
            return true;
        });
    }
    async function recordFrame(lease, input, { authorize } = { authorize: undefined }) {
        const headers = validateFrame(input);
        return locked(lease, async (query, subscription, receiver) => {
            fence(lease, subscription, receiver);
            // The worker's trusted rollout guard runs under the same owner
            // lock as revocation, immediately before this receipt is written.
            if (authorize) await authorize(query);
            let row = (await query('SELECT * FROM automation_x_push_inbox WHERE subscription_id=? AND version=?', [lease.subscriptionId, input.version]))[0];
            const duplicate = Boolean(row);
            if (!row) {
                const result = await query(`INSERT INTO automation_x_push_inbox (subscription_id,subscription_revision,version,data_ciphertext,headers_json,ack_code,status,received_at_ms) VALUES (?,?,?,?,?,?,?,?)`,
                    [lease.subscriptionId, lease.revision, input.version, input.data, JSON.stringify(headers), input.ackCode, input.status, now()]);
                row = (await query('SELECT * FROM automation_x_push_inbox WHERE id=?', [result.insertId]))[0];
            }
            // Time can elapse during a slow database operation. Throwing here
            // rolls back the insert, and the caller must close without an ACK.
            fence(lease, subscription, receiver);
            return { ...inboxDto(row, lease.ownerUserId), duplicate };
        });
    }
    async function markRouted(lease, id) {
        if (!/^[0-9]{1,20}$/.test(String(id))) fail('X_PUSH_INBOX_INVALID');
        return locked(lease, async (query, subscription, receiver) => {
            fence(lease, subscription, receiver);
            const result = await query("UPDATE automation_x_push_inbox SET status='routed',routed_at_ms=? WHERE id=? AND subscription_id=? AND subscription_revision=? AND status='received'", [now(), String(id), lease.subscriptionId, lease.revision]);
            return result.affectedRows === 1;
        });
    }
    async function auditUse(lease, outcome) {
        if (!['opened', 'failed'].includes(outcome)) fail('X_PUSH_AUDIT_INVALID');
        return locked(lease, async (query, subscription, receiver) => {
            fence(lease, subscription, receiver);
            await query('INSERT INTO automation_audit (actor_user_id,entity_id,action,detail_json,created_at_ms) VALUES (?,?,?,?,?)',
                [lease.ownerUserId, lease.subscriptionId, 'x.push.vault.open', JSON.stringify({ revision: lease.revision, outcome }), now()]);
        });
    }
    async function getInbox(input) {
        identity(input);
        if (!/^[0-9]{1,20}$/.test(String(input.id))) fail('X_PUSH_INBOX_INVALID');
        const rows = await db.queryDatabase('SELECT i.* FROM automation_x_push_inbox i JOIN automation_x_subscriptions s ON s.id=i.subscription_id WHERE i.id=? AND i.subscription_id=? AND s.owner_user_id=?', [String(input.id), input.subscriptionId, input.ownerUserId]);
        return rows[0] ? inboxDto(rows[0], input.ownerUserId) : null;
    }
    async function listInbox(input) {
        identity(input);
        const afterId = input.afterId || '0', limit = input.limit === undefined ? 100 : input.limit;
        if (!/^[0-9]{1,20}$/.test(String(afterId)) || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('X_PUSH_INBOX_INVALID');
        const rows = await db.queryDatabase("SELECT i.* FROM automation_x_push_inbox i JOIN automation_x_subscriptions s ON s.id=i.subscription_id WHERE i.subscription_id=? AND s.owner_user_id=? AND i.id>? AND i.status='received' ORDER BY i.id LIMIT ?", [input.subscriptionId, input.ownerUserId, String(afterId), limit]);
        return rows.map(row => inboxDto(row, input.ownerUserId));
    }
    async function status(input) {
        identity(input);
        const rows = await db.queryDatabase('SELECT s.id,s.revision,s.updated_at_ms,r.state,r.reason_code,r.last_connected_at_ms,r.lease_expires_at_ms,r.retry_at_ms,r.retry_attempt FROM automation_x_subscriptions s LEFT JOIN automation_x_push_receivers r ON r.subscription_id=s.id WHERE s.id=? AND s.owner_user_id=?', [input.subscriptionId, input.ownerUserId]);
        return stateDto(rows[0], now());
    }
    async function list(ownerUserId) {
        if (typeof ownerUserId !== 'string' || !/^[0-9]{1,32}$/.test(ownerUserId)) fail('X_PUSH_IDENTITY_INVALID');
        const rows = await db.queryDatabase('SELECT s.id,s.revision,s.updated_at_ms,r.state,r.reason_code,r.last_connected_at_ms,r.lease_expires_at_ms,r.retry_at_ms,r.retry_attempt FROM automation_x_subscriptions s LEFT JOIN automation_x_push_receivers r ON r.subscription_id=s.id WHERE s.owner_user_id=? ORDER BY s.id LIMIT 100', [ownerUserId]);
        return rows.map(row => stateDto(row, now()));
    }
    /** @param {any} lease @param {number|undefined} intervalMinutes @param {{resolveInterval?:(query:any)=>Promise<number|null|undefined>,resolveProcessing?:(query:any)=>Promise<{effectiveMode:string,intervalMinutes:number|null}>}} [options] */
    async function beginProcessing(lease, intervalMinutes, options = {}) {
        if (options.resolveInterval !== undefined && typeof options.resolveInterval !== 'function') fail('X_PUSH_PROCESSING_INVALID');
        if (options.resolveProcessing !== undefined && typeof options.resolveProcessing !== 'function'
            || options.resolveProcessing && options.resolveInterval) fail('X_PUSH_PROCESSING_INVALID');
        if (!options.resolveInterval && !options.resolveProcessing && (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080)) fail('X_PUSH_PROCESSING_INVALID');
        return locked(lease, async (query, subscription, receiver) => {
            fence(lease, subscription, receiver);
            // Recheck the owner's persisted choice and the current contract's
            // explicit permission under the same owner lock as plan changes.
            // A zero delay is available only through this trusted resolver.
            const processing = options.resolveProcessing ? await options.resolveProcessing(query) : null;
            const processingMode = processing ? processing.effectiveMode : 'batch';
            const selectedInterval = processingMode === 'realtime' ? 0
                : processing ? processing.intervalMinutes : options.resolveInterval ? await options.resolveInterval(query) : intervalMinutes;
            fence(lease, subscription, receiver);
            if (!['batch', 'realtime'].includes(processingMode) || !Number.isSafeInteger(selectedInterval)
                || selectedInterval < (processingMode === 'realtime' ? 0 : 1) || selectedInterval > 10080)
                return { ready: false, code: 'X_MONITOR_NOT_CONFIGURED' };
            if (receiver.process_window_at_ms != null) {
                // An interrupted realtime window must honor batch cadence after
                // revocation or an explicit switch to batch, keeping its cursor.
                if (processingMode === 'batch' && receiver.process_window_mode === 'realtime') {
                    const dueAtMs = Number(receiver.last_process_at_ms ?? receiver.process_window_at_ms) + selectedInterval * 60000;
                    if (dueAtMs > now()) return { ready: false, dueAtMs };
                }
                return { ready: true, windowAtMs: Number(receiver.process_window_at_ms), cursorId: String(receiver.process_cursor_id), processingMode };
            }
            const dueAtMs = receiver.last_process_at_ms == null ? now() : Number(receiver.last_process_at_ms) + selectedInterval * 60000;
            if (dueAtMs > now()) return { ready: false, dueAtMs };
            const windowAtMs = now();
            await query('UPDATE automation_x_push_receivers SET process_window_at_ms=?,process_window_mode=?,process_cursor_id=0 WHERE subscription_id=?', [windowAtMs, processingMode, lease.subscriptionId]);
            fence(lease, subscription, receiver);
            return { ready: true, windowAtMs, cursorId: '0', processingMode };
        });
    }
    async function advanceProcessing(lease, input) {
        if (!input || !Number.isSafeInteger(input.windowAtMs) || input.windowAtMs < 0 || !/^[1-9]\d{0,19}$/.test(String(input.cursorId))) fail('X_PUSH_PROCESSING_INVALID');
        return locked(lease, async (query, subscription, receiver) => {
            fence(lease, subscription, receiver);
            if (receiver.process_window_at_ms == null || Number(receiver.process_window_at_ms) !== input.windowAtMs
                || BigInt(input.cursorId) < BigInt(receiver.process_cursor_id)) fail('X_PUSH_PROCESSING_INVALID');
            await query('UPDATE automation_x_push_receivers SET process_cursor_id=? WHERE subscription_id=?', [String(input.cursorId), lease.subscriptionId]);
            fence(lease, subscription, receiver);
        });
    }
    async function completeProcessing(lease, input) {
        if (!input || !Number.isSafeInteger(input.windowAtMs) || input.windowAtMs < 0) fail('X_PUSH_PROCESSING_INVALID');
        return locked(lease, async (query, subscription, receiver) => {
            fence(lease, subscription, receiver);
            if (receiver.process_window_at_ms == null || Number(receiver.process_window_at_ms) !== input.windowAtMs) fail('X_PUSH_PROCESSING_INVALID');
            // Reset on every completed window: records which remained pending
            // are reconsidered next time, even when later records were routed.
            await query('UPDATE automation_x_push_receivers SET last_process_at_ms=?,process_window_at_ms=NULL,process_window_mode=NULL,process_cursor_id=0 WHERE subscription_id=?', [input.windowAtMs, lease.subscriptionId]);
            fence(lease, subscription, receiver);
        });
    }
    async function markUnsupported(lease, id) {
        if (!/^[1-9]\d{0,19}$/.test(String(id))) fail('X_PUSH_INBOX_INVALID');
        return locked(lease, async (query, subscription, receiver) => {
            fence(lease, subscription, receiver);
            const result = await query("UPDATE automation_x_push_inbox SET status='unsupported' WHERE id=? AND subscription_id=? AND subscription_revision=? AND status='received'", [String(id), lease.subscriptionId, lease.revision]);
            fence(lease, subscription, receiver);
            return result.affectedRows === 1;
        });
    }
    async function recordRetry(input, reasonCode, delayMs) {
        if (!Number.isSafeInteger(input?.revision) || input.revision < 1) fail('X_PUSH_IDENTITY_INVALID');
        validReason(reasonCode);
        if (reasonCode === null || !Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > 86400000) fail('X_PUSH_RETRY_INVALID');
        return locked(input, async (query, subscription, receiver) => {
            if (Number(subscription.revision) !== input.revision) fail('X_PUSH_REVISION_CONFLICT');
            const previous = { retryAtMs: receiver?.retry_at_ms == null ? null : Number(receiver.retry_at_ms), retryAttempt: Number(receiver?.retry_attempt || 0) };
            // A late supervisor callback cannot change an active successor or
            // turn a subscription requiring explicit reenrollment into a retry.
            if (receiver?.state === 'requires_reenrollment' || receiver?.lease_token && Number(receiver.lease_expires_at_ms) > now())
                return { recorded: false, ...previous };
            const retryAttempt = Math.min(64, (Number(receiver?.subscription_revision) === input.revision ? previous.retryAttempt : 0) + 1);
            const retryAtMs = Math.max(now() + delayMs, previous.retryAtMs || 0);
            await query(`INSERT INTO automation_x_push_receivers (subscription_id,state,reason_code,subscription_revision,retry_at_ms,retry_attempt,updated_at_ms)
                VALUES (?,'error',?,?,?,?,?) ON DUPLICATE KEY UPDATE state='error',reason_code=VALUES(reason_code),subscription_revision=VALUES(subscription_revision),retry_at_ms=VALUES(retry_at_ms),retry_attempt=VALUES(retry_attempt),lease_token=NULL,worker_id=NULL,lease_expires_at_ms=NULL,updated_at_ms=VALUES(updated_at_ms)`,
                [input.subscriptionId, reasonCode, input.revision, retryAtMs, retryAttempt, now()]);
            return { recorded: true, retryAtMs, retryAttempt };
        });
    }
    async function resetRetry(lease) {
        return locked(lease, async (query, subscription, receiver) => {
            fence(lease, subscription, receiver);
            await query('UPDATE automation_x_push_receivers SET retry_at_ms=NULL,retry_attempt=0 WHERE subscription_id=?', [lease.subscriptionId]);
            fence(lease, subscription, receiver);
            return { retryAtMs: null, retryAttempt: 0 };
        });
    }
    return { claim, renew, assertLease, markState, release, recordFrame, markRouted, auditUse, getInbox, listInbox, status, list, leaseMs,
        beginProcessing, advanceProcessing, completeProcessing, markUnsupported, recordRetry, resetRetry };
}

module.exports = { createXPushStore, MAX_FRAME_BYTES, safeHeaders, validateFrame };

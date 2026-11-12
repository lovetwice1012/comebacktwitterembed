'use strict';

// Preparation for processing already-persisted X receipts without a socket.
// This capability remains inert unless a trusted caller explicitly enables it
// AND provides a fleet-compatibility verifier. A boolean or environment flag
// alone is not evidence that old receiver workers have stopped.
const { randomBytes } = require('node:crypto');
const { lockOwner } = require('./entitlements');
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };

function validateIdentity(input) {
    if (!input || typeof input.subscriptionId !== 'string' || !UUID.test(input.subscriptionId)
        || typeof input.ownerUserId !== 'string' || !/^[0-9]{1,32}$/.test(input.ownerUserId)) fail('X_PUSH_IDENTITY_INVALID');
}
function validateLease(lease) {
    validateIdentity(lease);
    if (lease.purpose !== 'processing' || typeof lease.token !== 'string' || !/^[0-9a-f]{64}$/.test(lease.token)
        || !Number.isSafeInteger(lease.revision) || lease.revision < 1) fail('X_PUSH_LEASE_LOST');
}

function createOfflineLease(db, { enabled = false, assertCompatible, now = Date.now, leaseMs = 30000 } = {}) {
    if (!db || typeof db.withDatabaseTransaction !== 'function' || typeof now !== 'function'
        || typeof enabled !== 'boolean' || assertCompatible !== undefined && typeof assertCompatible !== 'function'
        || !Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 300000) fail('X_PUSH_OFFLINE_CONFIG_INVALID');
    function compatible() {
        if (!enabled) return false;
        try {
            // This verifier runs while database rows are locked. It may only
            // inspect an already-available local proof and return immediately;
            // never await network or fleet discovery inside a transaction.
            const verdict = assertCompatible?.();
            if (verdict !== true) {
                if (verdict && typeof verdict.then === 'function') Promise.resolve(verdict).catch(() => {});
                fail('X_PUSH_OFFLINE_COMPATIBILITY_UNVERIFIED');
            }
        }
        catch { fail('X_PUSH_OFFLINE_COMPATIBILITY_UNVERIFIED'); }
        return true;
    }
    async function locked(input, work) {
        validateIdentity(input);
        try {
            return await db.withDatabaseTransaction(async query => {
                await lockOwner(query, input.ownerUserId);
                const subscription = (await query('SELECT * FROM automation_x_subscriptions WHERE id=? AND owner_user_id=? FOR UPDATE',
                    [input.subscriptionId, input.ownerUserId]))[0];
                if (!subscription) fail('X_PUSH_SUBSCRIPTION_NOT_FOUND');
                const receiver = (await query('SELECT * FROM automation_x_push_receivers WHERE subscription_id=? FOR UPDATE', [input.subscriptionId]))[0];
                if (!receiver) return null;
                for (const name of ['processing_lease_token', 'processing_worker_id', 'processing_lease_expires_at_ms', 'processing_revision', 'connection_generation'])
                    if (!Object.hasOwn(receiver, name)) fail('X_PUSH_OFFLINE_MIGRATION_REQUIRED');
                return work(query, subscription, receiver);
            });
        } catch (error) {
            if (typeof error?.code === 'string' && error.code.startsWith('X_PUSH_')) throw error;
            fail('X_PUSH_STORE_UNAVAILABLE');
        }
    }
    function fence(lease, subscription, receiver) {
        validateLease(lease);
        if (Number(subscription.revision) !== lease.revision || Number(receiver.subscription_revision) !== lease.revision
            || Number(receiver.processing_revision) !== lease.revision || receiver.processing_lease_token !== lease.token
            || !Number.isSafeInteger(Number(receiver.processing_lease_expires_at_ms)) || Number(receiver.processing_lease_expires_at_ms) <= now())
            fail('X_PUSH_LEASE_LOST');
    }
    function hasActiveLease(token, expiry) {
        if (token == null && expiry == null) return false;
        if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token) || expiry == null || !Number.isSafeInteger(Number(expiry))) fail('X_PUSH_OFFLINE_STATE_INVALID');
        return Number(expiry) > now();
    }
    async function claim(input, { authorize } = {}) {
        validateIdentity(input);
        if (typeof input.workerId !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(input.workerId)
            || typeof authorize !== 'function') fail('X_PUSH_OFFLINE_CONFIG_INVALID');
        if (!await compatible()) return null;
        return locked(input, async (query, subscription, receiver) => {
            if (!await compatible()) fail('X_PUSH_OFFLINE_COMPATIBILITY_UNVERIFIED');
            await authorize(query);
            const processing = [receiver.processing_lease_token, receiver.processing_worker_id, receiver.processing_lease_expires_at_ms, receiver.processing_revision];
            if (processing.some(value => value != null) && (typeof receiver.processing_lease_token !== 'string'
                || !/^[0-9a-f]{64}$/.test(receiver.processing_lease_token) || typeof receiver.processing_worker_id !== 'string'
                || !/^[A-Za-z0-9_.:-]{1,64}$/.test(receiver.processing_worker_id) || receiver.processing_lease_expires_at_ms == null
                || !Number.isSafeInteger(Number(receiver.processing_lease_expires_at_ms)) || receiver.processing_revision == null
                || !Number.isSafeInteger(Number(receiver.processing_revision)))) fail('X_PUSH_OFFLINE_STATE_INVALID');
            if (receiver.state === 'requires_reenrollment' || Number(receiver.subscription_revision) !== Number(subscription.revision)
                || hasActiveLease(receiver.lease_token, receiver.lease_expires_at_ms)
                || hasActiveLease(receiver.processing_lease_token, receiver.processing_lease_expires_at_ms)) return null;
            const generation = Number(receiver.connection_generation), revision = Number(subscription.revision);
            if (!Number.isSafeInteger(generation) || generation < 0 || !Number.isSafeInteger(revision) || revision < 1) fail('X_PUSH_OFFLINE_STATE_INVALID');
            const inbox = await query("SELECT id FROM automation_x_push_inbox WHERE subscription_id=? AND subscription_revision=? AND status='received' LIMIT 1 FOR UPDATE",
                [input.subscriptionId, revision]);
            if (!inbox.length) return null;
            const monitors = await query(`SELECT id FROM automation_x_monitors WHERE owner_user_id=? AND enabled=1 AND state='ready'
                AND CASE WHEN JSON_VALID(notification_settings_json) THEN JSON_UNQUOTE(JSON_EXTRACT(notification_settings_json,'$.subscriptionId')) ELSE NULL END=? LIMIT 1`,
            [input.ownerUserId, input.subscriptionId]);
            if (!monitors.length) return null;
            let sealedEnvelope;
            try { sealedEnvelope = JSON.parse(subscription.sealed_json); } catch { fail('X_PUSH_VAULT_INVALID'); }
            const token = randomBytes(32).toString('hex'), expiresAtMs = now() + leaseMs;
            if (!Number.isSafeInteger(expiresAtMs)) fail('X_PUSH_OFFLINE_STATE_INVALID');
            await query(`UPDATE automation_x_push_receivers SET processing_lease_token=?,processing_worker_id=?,processing_lease_expires_at_ms=?,processing_revision=? WHERE subscription_id=?`,
                [token, input.workerId, expiresAtMs, revision, input.subscriptionId]);
            if (!await compatible()) fail('X_PUSH_OFFLINE_COMPATIBILITY_UNVERIFIED');
            await authorize(query);
            if (expiresAtMs <= now()) fail('X_PUSH_LEASE_LOST');
            return { subscriptionId: input.subscriptionId, ownerUserId: input.ownerUserId, revision, token, expiresAtMs,
                connectionGeneration: generation, purpose: 'processing', sealedEnvelope };
        });
    }
    async function renew(lease, { authorize } = {}) {
        validateLease(lease); if (typeof authorize !== 'function') fail('X_PUSH_OFFLINE_CONFIG_INVALID');
        if (!await compatible()) fail('X_PUSH_OFFLINE_COMPATIBILITY_UNVERIFIED');
        return locked(lease, async (query, subscription, receiver) => {
            fence(lease, subscription, receiver); await authorize(query);
            const expiresAtMs = now() + leaseMs;
            if (!Number.isSafeInteger(expiresAtMs)) fail('X_PUSH_OFFLINE_STATE_INVALID');
            await query('UPDATE automation_x_push_receivers SET processing_lease_expires_at_ms=? WHERE subscription_id=?', [expiresAtMs, lease.subscriptionId]);
            fence(lease, subscription, receiver);
            if (!await compatible()) fail('X_PUSH_OFFLINE_COMPATIBILITY_UNVERIFIED');
            return { ...lease, expiresAtMs };
        });
    }
    async function release(lease) {
        validateLease(lease);
        // Release is allowed after rollout or compatibility is withdrawn; it
        // only clears this token and never changes connection/retry status.
        return locked(lease, async (query, subscription, receiver) => {
            fence(lease, subscription, receiver);
            await query('UPDATE automation_x_push_receivers SET processing_lease_token=NULL,processing_worker_id=NULL,processing_lease_expires_at_ms=NULL,processing_revision=NULL WHERE subscription_id=?', [lease.subscriptionId]);
            fence(lease, subscription, receiver);
            return true;
        });
    }
    return Object.freeze({ claim, renew, release, leaseMs });
}
module.exports = { createOfflineLease };

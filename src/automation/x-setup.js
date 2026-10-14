'use strict';

const { randomBytes, randomUUID, createHash, createPublicKey, timingSafeEqual } = require('node:crypto');
const { requireActor, AutomationError } = require('./service');
const { lockOwner } = require('./entitlements');
const { parseTransferFile, identifyTransfer, createTransferPublicSealer, MAX_FILE_BYTES } = require('./x-setup-transfer');
const { evaluateXRollout, requireXEnrollment } = require('./x-rollout-policy');
const { resolveXProcessingPolicy } = require('./x-processing-policy');

const SESSION_TTL_MS = 10 * 60 * 1000;
const DOWNLOAD = Object.freeze({ url: '/api/automation/x-setup/download', version: '0.1.0-preview.4',
    sha256: 'c41a47ecb694cc8afe19ccfab3420d492a5a327b8264cb84b46da9ab1d7325db' });
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const hash = text => createHash('sha256').update(text).digest('hex');
const fail = (code, message, status = 422) => { throw new AutomationError(code, message, status); };

function exact(input, fields) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key)))
        fail('X_SETUP_INVALID_INPUT', '必要な設定だけを指定してください。');
}
function consent(input) {
    if (input.consent !== true) fail('X_SETUP_CONSENT_REQUIRED', '受信設定の取り扱いを確認して同意してください。');
}
function publicSubscription(row, currentTime = Date.now()) {
    const states = ['awaiting', 'connecting', 'listening', 'requires_reenrollment', 'stopped', 'error'];
    let receiverState = states.includes(row.receiver_state) ? row.receiver_state : 'awaiting';
    if (['connecting', 'listening'].includes(receiverState) && Number(row.lease_expires_at_ms || 0) <= currentTime) receiverState = 'stopped';
    return { id: row.id, state: 'stored', revision: Number(row.revision), browserVersion: row.browser_version,
        createdAtMs: Number(row.created_at_ms), updatedAtMs: Number(row.updated_at_ms), receiverState,
        boundMonitorCount: Number(row.bound_monitor_count || 0), lastReceivedAtMs: row.last_received_at_ms == null ? null : Number(row.last_received_at_ms),
        // These are inbox states, not Discord delivery counts. Return only
        // owner-scoped aggregates; ciphertext, headers and payload stay private.
        receiptCounts: { received: Number(row.received_count || 0), routed: Number(row.routed_count || 0),
            unsupported: Number(row.unsupported_count || 0), decryptionFailed: Number(row.decryption_failed_count || 0),
            unmatched: Number(row.unmatched_count || 0) } };
}

// The web process receives only a sealer. Decryption is an explicitly separate
// worker capability; there is no API to read plaintext, endpoints or key bytes.
function sealerFromEnvironment(env = process.env) {
    if (env.X_NOTIFICATION_INTAKE_ENABLED !== '1') return null;
    try {
        const keyText = env.X_NOTIFICATION_INTAKE_PUBLIC_KEY || '';
        if (keyText.length > 4096) return null;
        const key = Buffer.from(keyText, 'base64url');
        if (!key.length || key.toString('base64url') !== keyText) return null;
        const publicKey = createPublicKey({ key, format: 'der', type: 'spki' });
        return createTransferPublicSealer({ activeKeyId: env.X_NOTIFICATION_INTAKE_KEY_ID,
            publicKeys: { [env.X_NOTIFICATION_INTAKE_KEY_ID]: publicKey } });
    } catch { return null; }
}

/** Local preparation only. This module never connects to Mozilla, X or a worker. */
function createXSetup(db, options = {}) {
    const now = options.now || Date.now;
    const sealer = options.sealer === undefined ? sealerFromEnvironment() : options.sealer;
    const rolloutOptions = options.rolloutMode === undefined ? {} : { mode: options.rolloutMode };
    const receiverEnabled = options.receiverEnabled === undefined ? process.env.X_NOTIFICATION_RECEIVER_ENABLED === '1'
        && resolveXProcessingPolicy(process.env.X_NOTIFICATION_PROCESSING_POLICY) !== null : options.receiverEnabled === true;
    async function subscriptionRows(query, owner, filter = {}) {
        return query(`SELECT s.id,s.revision,s.browser_version,s.created_at_ms,s.updated_at_ms,r.state AS receiver_state,r.lease_expires_at_ms,
            (SELECT COUNT(*) FROM automation_x_monitors m WHERE m.owner_user_id=s.owner_user_id AND m.state<>'deleted'
                AND CASE WHEN JSON_VALID(m.notification_settings_json) THEN JSON_UNQUOTE(JSON_EXTRACT(m.notification_settings_json,'$.subscriptionId')) ELSE NULL END=s.id) AS bound_monitor_count,
            (SELECT MAX(i.received_at_ms) FROM automation_x_push_inbox i WHERE i.subscription_id=s.id) AS last_received_at_ms,
            (SELECT COUNT(*) FROM automation_x_push_inbox i WHERE i.subscription_id=s.id AND i.status='received') AS received_count,
            (SELECT COUNT(*) FROM automation_x_push_inbox i WHERE i.subscription_id=s.id AND i.status='routed') AS routed_count,
            (SELECT COUNT(*) FROM automation_x_push_inbox i WHERE i.subscription_id=s.id AND i.status='unsupported') AS unsupported_count,
            (SELECT COUNT(*) FROM automation_x_push_inbox i WHERE i.subscription_id=s.id AND i.status='decryption_failed') AS decryption_failed_count,
            (SELECT COUNT(*) FROM automation_x_push_inbox i WHERE i.subscription_id=s.id AND i.status='unmatched') AS unmatched_count
            FROM automation_x_subscriptions s LEFT JOIN automation_x_push_receivers r ON r.subscription_id=s.id
            WHERE s.owner_user_id=?${filter.id ? ' AND s.id=?' : filter.afterId ? ' AND s.id>?' : ''} ORDER BY s.id LIMIT 101`,
        filter.id ? [owner, filter.id] : filter.afterId ? [owner, filter.afterId] : [owner]);
    }
    function available() {
        if (!sealer || typeof sealer.seal !== 'function')
            fail('X_SETUP_NOT_CONFIGURED', 'ファイルの受付は準備中です。説明と保存ツールは利用できます。', 503);
    }
    async function audit(query, actor, id, action, detail) {
        // No session token, filename, UAID, channel, endpoint, file or plaintext.
        await query('INSERT INTO automation_audit (actor_user_id,entity_id,action,detail_json,created_at_ms) VALUES (?,?,?,?,?)',
            [actor.userId, id, action, JSON.stringify(detail), now()]);
    }
    async function checkSession(query, actor, token, lock = false) {
        if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token))
            fail('X_SETUP_SESSION_INVALID', '登録確認をやり直してください。', 409);
        const rows = await query(`SELECT * FROM automation_x_setup_sessions WHERE owner_user_id=?${lock ? ' FOR UPDATE' : ''}`, [actor.userId]);
        const row = rows[0], tokenHash = hash(token);
        if (!row || !/^[0-9a-f]{64}$/.test(row.token_hash) || !timingSafeEqual(Buffer.from(row.token_hash, 'hex'), Buffer.from(tokenHash, 'hex')) || Number(row.consent_version) !== 1)
            fail('X_SETUP_SESSION_INVALID', '登録確認をやり直してください。', 409);
        if (row.consumed_at_ms !== null) fail('X_SETUP_SESSION_USED', 'この登録確認は使用済みです。ファイルを選び直してください。', 409);
        if (Number(row.expires_at_ms) <= now()) fail('X_SETUP_SESSION_EXPIRED', '登録確認の有効期限が切れました。ファイルを選び直してください。', 409);
        return row;
    }
    async function status(actor, input = {}) {
        requireActor(actor);
        if (input.afterId && !UUID.test(input.afterId)) fail('INVALID_CURSOR', '一覧の位置を確認してください。');
        const rows = await subscriptionRows(db.queryDatabase, actor.userId, input);
        const rollout = await evaluateXRollout(db.queryDatabase, actor, rolloutOptions);
        return { available: Boolean(sealer) && rollout.eligible, reasonCode: !rollout.eligible ? rollout.reasonCode : sealer ? null : 'X_SETUP_NOT_CONFIGURED', rollout,
            receiverEnabled: receiverEnabled && rollout.eligible, download: DOWNLOAD, maxFileBytes: MAX_FILE_BYTES,
            subscriptions: rows.slice(0, 100).map(row => publicSubscription(row, now())), nextCursor: rows.length > 100 ? rows[99].id : null };
    }
    async function startSession(actor, input) {
        requireActor(actor); available(); exact(input, ['consent']); consent(input);
        await requireXEnrollment(db.queryDatabase, actor, rolloutOptions);
        const token = randomBytes(32).toString('hex'), created = now(), expiresAtMs = created + SESSION_TTL_MS;
        await db.withDatabaseTransaction(async query => {
            await lockOwner(query, actor.userId);
            await requireXEnrollment(query, actor, rolloutOptions);
            // Exactly one current session per owner keeps expired tokens bounded.
            await query(`INSERT INTO automation_x_setup_sessions (owner_user_id,token_hash,consent_version,expires_at_ms,consumed_at_ms,created_at_ms)
                VALUES (?,?,1,?,NULL,?) ON DUPLICATE KEY UPDATE token_hash=VALUES(token_hash),consent_version=1,expires_at_ms=VALUES(expires_at_ms),consumed_at_ms=NULL,created_at_ms=VALUES(created_at_ms)`,
                [actor.userId, hash(token), expiresAtMs, created]);
        });
        return { sessionId: token, expiresAtMs };
    }
    async function validate(actor, input) {
        requireActor(actor); available(); exact(input, ['sessionId', 'fileText']);
        await requireXEnrollment(db.queryDatabase, actor, rolloutOptions);
        await checkSession(db.queryDatabase, actor, input.sessionId);
        const file = parseTransferFile(input.fileText);
        return { valid: true, browserVersion: file.provenance.browserVersion, scope: file.push.scope, formatVersion: file.version };
    }
    async function importFile(actor, input) {
        requireActor(actor); available(); exact(input, ['sessionId', 'fileText', 'consent']); consent(input);
        await requireXEnrollment(db.queryDatabase, actor, rolloutOptions);
        // Check authentication/session before any key operations. Repeat under
        // the owner lock after parsing so concurrent imports cannot replay it.
        await checkSession(db.queryDatabase, actor, input.sessionId);
        const file = parseTransferFile(input.fileText), identity = identifyTransfer(file);
        try {
            return await db.withDatabaseTransaction(async query => {
                await lockOwner(query, actor.userId);
                await requireXEnrollment(query, actor, rolloutOptions);
                await checkSession(query, actor, input.sessionId, true);
                const matches = await query('SELECT * FROM automation_x_subscriptions WHERE uaid_hash=? OR channel_hash=? FOR UPDATE', [identity.uaidHash, identity.channelHash]);
                const existing = matches[0];
                if (matches.length && (matches.length !== 1 || existing.owner_user_id !== actor.userId || existing.content_hash !== identity.contentHash))
                    fail('X_SETUP_SUBSCRIPTION_CONFLICT', 'この受信設定は登録できません。自分の登録済み設定を確認し、必要なら削除してからやり直してください。', 409);
                let row = existing;
                if (!row) {
                    const id = randomUUID(), createdAtMs = now(), revision = 1;
                    const envelope = sealer.seal(file, { subscriptionId: id, ownerUserId: actor.userId, revision });
                    await query(`INSERT INTO automation_x_subscriptions (id,owner_user_id,uaid_hash,channel_hash,content_hash,sealed_json,key_id,browser_version,revision,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                        [id, actor.userId, identity.uaidHash, identity.channelHash, identity.contentHash, JSON.stringify(envelope), envelope.keyId, file.provenance.browserVersion, revision, createdAtMs, createdAtMs]);
                    row = { id, revision, browser_version: file.provenance.browserVersion, created_at_ms: createdAtMs, updated_at_ms: createdAtMs };
                }
                await query('UPDATE automation_x_setup_sessions SET consumed_at_ms=? WHERE owner_user_id=?', [now(), actor.userId]);
                await audit(query, actor, row.id, 'x.setup.import', { revision: Number(row.revision), duplicate: Boolean(existing), consentVersion: 1 });
                const saved = (await subscriptionRows(query, actor.userId, { id: row.id }))[0];
                return { subscription: publicSubscription(saved, now()), duplicate: Boolean(existing) };
            });
        } catch (error) {
            // Concurrent cross-owner inserts are constrained by UNIQUE hashes.
            // Do not expose SQL parameters or disclose the existing owner.
            if (error?.code === 'ER_DUP_ENTRY' || error?.code === 'ER_LOCK_DEADLOCK')
                fail('X_SETUP_SUBSCRIPTION_CONFLICT', 'この受信設定は登録できません。登録状態を確認してやり直してください。', 409);
            throw error;
        }
    }
    async function remove(actor, id, input) {
        requireActor(actor); exact(input, ['expectedRevision']);
        if (!UUID.test(id || '')) fail('NOT_FOUND', '受信設定が見つかりません。', 404);
        if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail('X_SETUP_INVALID_INPUT', '登録の版を確認してください。');
        return db.withDatabaseTransaction(async query => {
            await lockOwner(query, actor.userId);
            const row = (await query('SELECT id,revision FROM automation_x_subscriptions WHERE id=? AND owner_user_id=? FOR UPDATE', [id, actor.userId]))[0];
            if (!row) fail('NOT_FOUND', '受信設定が見つかりません。', 404);
            if (Number(row.revision) !== input.expectedRevision) fail('REVISION_CONFLICT', '受信設定が更新されています。一覧を更新してください。', 409);
            const bound = await query(`SELECT id FROM automation_x_monitors WHERE owner_user_id=? AND state<>'deleted'
                AND CASE WHEN JSON_VALID(notification_settings_json) THEN JSON_UNQUOTE(JSON_EXTRACT(notification_settings_json,'$.subscriptionId')) ELSE NULL END=? FOR UPDATE`, [actor.userId, id]);
            for (const monitor of bound) {
                await query("UPDATE automation_x_monitors SET notification_settings_json=JSON_REMOVE(notification_settings_json,'$.subscriptionId'),subscription_state='pending',revision=revision+1,updated_at_ms=? WHERE id=? AND owner_user_id=?", [now(), monitor.id, actor.userId]);
                await audit(query, actor, id, 'x.setup.unbind', { monitorId: String(monitor.id), subscriptionId: id });
            }
            // Physical deletion erases the encrypted material from the live DB.
            // External browser/X unsubscription remains a separate user action.
            await query('DELETE FROM automation_x_subscriptions WHERE id=? AND owner_user_id=?', [id, actor.userId]);
            // Invalidate a preview opened in another tab before this deletion.
            // Re-enrollment then requires an explicit fresh confirmation.
            await query('DELETE FROM automation_x_setup_sessions WHERE owner_user_id=?', [actor.userId]);
            await audit(query, actor, id, 'x.setup.delete', { revision: Number(row.revision) });
            return { deleted: true };
        });
    }
    return { status, startSession, validate, importFile, remove };
}
module.exports = { createXSetup, sealerFromEnvironment, SESSION_TTL_MS, DOWNLOAD };

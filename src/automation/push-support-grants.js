'use strict';

const { createHash, randomUUID } = require('node:crypto');
const OWNER = /^\d{1,32}$/;
const ID = /^[A-Za-z0-9:_-]{1,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX = Number.MAX_SAFE_INTEGER;
function failure(code, message, status = 422) { return Object.assign(new Error(message), { name: 'AutomationError', code, status }); }
function owner(value) {
    if (typeof value !== 'string' || !OWNER.test(value)) throw failure('AUTOMATION_INVALID_USER', '利用者を確認できません。');
    return value;
}
function administrator(actor) {
    if (!actor || typeof actor.userId !== 'string' || !OWNER.test(actor.userId)) throw failure('AUTH_REQUIRED', 'ログインが必要です。', 401);
    if (actor.isAdmin !== true) throw failure('AUTOMATION_FORBIDDEN', '支援枠の付与には管理者権限が必要です。', 403);
    return actor.userId;
}
function integer(value, minimum = 0, maximum = MAX, name = '枠数') {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw failure('AUTOMATION_SUPPORT_GRANT_INVALID', `${name}を確認してください。`);
    return value;
}
function stored(value) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw failure('AUTOMATION_SUPPORT_GRANT_CORRUPT', '保存された支援枠を確認できません。管理者による確認が必要です。', 503);
    return parsed;
}
function legacyManualSlots(value) {
    // Old administrative records can contain signed counters. Preserve the
    // raw value for CAS/audit while retaining the existing zero allowance for
    // negative legacy values. New immutable ledger entries stay nonnegative.
    const parsed = Number(value ?? 0);
    return Number.isSafeInteger(parsed) && parsed < 0 ? 0 : stored(parsed);
}
function clock(value = Date.now()) { return integer(value, 0, MAX - 1, '日時'); }
function sum(...values) {
    const result = values.reduce((total, value) => total + BigInt(stored(value)), 0n);
    if (result > BigInt(MAX)) throw failure('AUTOMATION_SUPPORT_GRANT_CORRUPT', '支援枠の合計を確認できません。管理者による確認が必要です。', 503);
    return Number(result);
}
function scopeOf(scope = require('./square-billing').getSquareScope()) {
    // Paused/misconfigured payments do not erase already verified holdings.
    // Credentials/configured are deliberately irrelevant to local ledger reads.
    return scope && ['sandbox', 'production'].includes(scope.environment) && typeof scope.merchantId === 'string' && ID.test(scope.merchantId)
        ? { environment: scope.environment, merchantId: scope.merchantId } : null;
}
function digest(...parts) { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }
function strict(input, fields) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) throw failure('AUTOMATION_SUPPORT_GRANT_INVALID', '支援枠の入力を確認してください。');
}
async function lockOwner(query, id) { await require('./entitlements').lockOwner(query, id); }
async function userRow(query, id) {
    return (await query('SELECT is_donor,additional_auto_extract_slots FROM users WHERE user_id=?', [id]))[0];
}
async function legacySquare(query, id, scope) {
    if (!scope) return { slots: 0, migrated: false };
    const row = (await query('SELECT * FROM automation_push_support_scope_snapshots WHERE owner_user_id=? AND environment=? AND merchant_id=?', [id, scope.environment, scope.merchantId]))[0];
    if (row) return { slots: stored(row.extra_slots), migrated: true };
    // Read-only fallback preserves the trusted recorded count, not historical
    // payment amounts or a recalculated cumulative purchase-unit policy.
    const old = (await query('SELECT extra_slots FROM automation_square_donation_unit_grants WHERE owner_user_id=? AND environment=? AND merchant_id=?', [id, scope.environment, scope.merchantId]))[0];
    return { slots: stored(old?.extra_slots ?? 0), migrated: false };
}

/** Must run inside caller's withDatabaseTransaction. No old amount is divided by 500. */
async function migrateLegacyGrants(query, userId, options = {}) {
    const id = owner(userId), now = clock(options.now), scope = scopeOf(options.scope);
    if (options.excludeAttemptId !== undefined && (typeof options.excludeAttemptId !== 'string' || !UUID.test(options.excludeAttemptId))) throw failure('AUTOMATION_SUPPORT_GRANT_INVALID', '決済の参照を確認してください。');
    await lockOwner(query, id);
    const manual = await userRow(query, id);
    await query(`INSERT INTO automation_push_support_owner_snapshots (owner_user_id,manual_slots,manual_supporter,snapshot_at_ms)
        VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE owner_user_id=VALUES(owner_user_id)`, [id, legacyManualSlots(manual?.additional_auto_extract_slots), Number(manual?.is_donor) === 1 ? 1 : 0, now]);
    let createdScopeSnapshot = false;
    if (scope) {
        const old = (await query('SELECT * FROM automation_square_donation_unit_grants WHERE owner_user_id=? AND environment=? AND merchant_id=?', [id, scope.environment, scope.merchantId]))[0];
        const snapshotId = randomUUID();
        await query(`INSERT INTO automation_push_support_scope_snapshots (owner_user_id,environment,merchant_id,snapshot_id,extra_slots,purchase_units,payment_count,snapshot_at_ms)
            VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE owner_user_id=VALUES(owner_user_id)`, [id, scope.environment, scope.merchantId, snapshotId, stored(old?.extra_slots ?? 0), stored(old?.purchase_units ?? 0), stored(old?.payment_count ?? 0), now]);
        const snapshot = (await query('SELECT * FROM automation_push_support_scope_snapshots WHERE owner_user_id=? AND environment=? AND merchant_id=? FOR UPDATE', [id, scope.environment, scope.merchantId]))[0];
        createdScopeSnapshot = snapshot.snapshot_id === snapshotId;
        if (createdScopeSnapshot) await query(`INSERT INTO automation_push_support_legacy_attempts (environment,merchant_id,attempt_id,owner_user_id,payment_id,classified_at_ms)
            SELECT environment,merchant_id,id,owner_user_id,payment_id,? FROM automation_square_donation_attempts
            WHERE owner_user_id=? AND environment=? AND merchant_id=? AND verified=1 AND (? IS NULL OR id<>?)`, [now, id, scope.environment, scope.merchantId, options.excludeAttemptId ?? null, options.excludeAttemptId ?? null]);
    }
    return { migrated: true, createdScopeSnapshot, ...await getSupporterHolding(query, id, now, options.scope) };
}

function historyDto(row) {
    if (!['square_payment', 'historical_admin', 'manual_adjustment'].includes(row.source_kind)
        || !Number.isSafeInteger(Number(row.slots)) || row.source_kind !== 'manual_adjustment' && Number(row.slots) < 0) {
        throw failure('AUTOMATION_SUPPORT_GRANT_CORRUPT', '保存された支援枠の履歴を確認できません。', 503);
    }
    let details;
    try { details = JSON.parse(row.details_json); } catch { throw failure('AUTOMATION_SUPPORT_GRANT_CORRUPT', '保存された支援枠の履歴を確認できません。', 503); }
    if (!details || typeof details !== 'object' || Array.isArray(details)) throw failure('AUTOMATION_SUPPORT_GRANT_CORRUPT', '保存された支援枠の履歴を確認できません。', 503);
    if (details.reason != null && (typeof details.reason !== 'string' || details.reason.length > 240)) throw failure('AUTOMATION_SUPPORT_GRANT_CORRUPT', '保存された付与の根拠を確認できません。', 503);
    return { grantId: row.grant_id, kind: row.source_kind, slots: Number(row.slots), purchasedSlots: stored(row.purchased_slots), reason: details.reason ?? null,
        amountYen: row.amount_yen == null ? null : stored(row.amount_yen), confirmedRefundedAmount: stored(row.confirmed_refunded_amount),
        financialReviewRequired: Number(row.confirmed_refunded_amount) > 0,
        actorUserId: row.actor_user_id || null, purchasedAtMs: Number(row.purchased_at_ms), createdAtMs: Number(row.created_at_ms) };
}
async function getSupporterGrantHistory(query, userId, options = {}) {
    const id = owner(userId), scope = scopeOf(options.scope), limit = integer(options.limit ?? 50, 1, 100);
    let cursor;
    if (options.cursor !== undefined && options.cursor !== null) {
        if (typeof options.cursor !== 'string' || !/^\d{1,16}:[0-9a-f]{64}$/.test(options.cursor)) throw failure('AUTOMATION_SUPPORT_GRANT_INVALID', '履歴の位置を確認してください。');
        const [time, grantId] = options.cursor.split(':'); cursor = { time: clock(Number(time)), grantId };
    }
    const params = [id];
    let condition = "source_kind IN ('historical_admin','manual_adjustment')";
    if (scope) { condition += ' OR (environment=? AND merchant_id=?)'; params.push(scope.environment, scope.merchantId); }
    if (cursor) params.push(cursor.time, cursor.time, cursor.grantId);
    const rows = await query(`SELECT * FROM automation_push_support_grants WHERE owner_user_id=? AND (${condition})
        ${cursor ? 'AND (created_at_ms<? OR (created_at_ms=? AND grant_id<?))' : ''} ORDER BY created_at_ms DESC,grant_id DESC LIMIT ${limit + 1}`, params);
    const hasMore = rows.length > limit, selected = rows.slice(0, limit), last = selected.at(-1);
    return { items: selected.map(historyDto), nextCursor: hasMore && last ? `${Number(last.created_at_ms)}:${last.grant_id}` : null };
}
async function getSupporterHolding(query, userId, now = Date.now(), requestedScope) {
    const id = owner(userId), scope = scopeOf(requestedScope); clock(now);
    const manual = await userRow(query, id), manualLegacySlots = legacyManualSlots(manual?.additional_auto_extract_slots);
    const old = await legacySquare(query, id, scope);
    const params = [id];
    let condition = "source_kind='historical_admin'";
    if (scope) { condition += " OR (source_kind='square_payment' AND environment=? AND merchant_id=?)"; params.push(scope.environment, scope.merchantId); }
    const total = (await query(`SELECT COALESCE(SUM(CASE WHEN source_kind='square_payment' THEN slots ELSE 0 END),0) AS new_paid_slots,
        COALESCE(SUM(CASE WHEN source_kind='historical_admin' THEN slots ELSE 0 END),0) AS historical_slots
        FROM automation_push_support_grants WHERE owner_user_id=? AND (${condition})`, params))[0];
    const newPaidSlots = stored(total?.new_paid_slots ?? 0), historicalSlots = stored(total?.historical_slots ?? 0);
    const legacySlots = sum(manualLegacySlots, old.slots, historicalSlots), canonicalSquareSlots = sum(old.slots, historicalSlots, newPaidSlots);
    const history = await getSupporterGrantHistory(query, id, { scope: requestedScope });
    return { manualLegacySlots, legacySquareSlots: old.slots, historicalSlots, legacySlots, newPaidSlots, paidSlots: newPaidSlots,
        canonicalSquareSlots, totalSupporterSlots: sum(manualLegacySlots, canonicalSquareSlots),
        isSupporter: Number(manual?.is_donor) === 1 || sum(legacySlots, newPaidSlots) > 0,
        migrationRequired: !(await query('SELECT owner_user_id FROM automation_push_support_owner_snapshots WHERE owner_user_id=?', [id]))[0] || !!scope && !old.migrated,
        history: history.items, historyCursor: history.nextCursor };
}
function grantConflict() { return failure('AUTOMATION_SUPPORT_GRANT_CONFLICT', '同じ出所IDで異なる支援枠の操作が記録されています。履歴を確認してください。', 409); }
async function assertHoldingFits(query, id) {
    // Current locking reads, rather than an older REPEATABLE READ snapshot,
    // include every grant serialized by the owner lock before this operation.
    const manual = (await query('SELECT additional_auto_extract_slots FROM users WHERE user_id=? FOR UPDATE', [id]))[0];
    const records = await query('SELECT source_kind,slots,environment,merchant_id FROM automation_push_support_grants WHERE owner_user_id=? FOR UPDATE', [id]);
    const snapshots = await query('SELECT environment,merchant_id,extra_slots FROM automation_push_support_scope_snapshots WHERE owner_user_id=? FOR UPDATE', [id]);
    const old = await query('SELECT environment,merchant_id,extra_slots FROM automation_square_donation_unit_grants WHERE owner_user_id=? FOR UPDATE', [id]);
    let common = BigInt(legacyManualSlots(manual?.additional_auto_extract_slots));
    const balances = new Map();
    for (const row of [...old, ...snapshots]) balances.set(JSON.stringify([row.environment, row.merchant_id]), BigInt(stored(row.extra_slots)));
    for (const row of records) {
        if (row.source_kind === 'historical_admin') common += BigInt(stored(row.slots));
        else if (row.source_kind === 'square_payment') {
            const key = JSON.stringify([row.environment, row.merchant_id]);
            balances.set(key, (balances.get(key) ?? 0n) + BigInt(stored(row.slots)));
        }
    }
    if (common > BigInt(MAX) || [...balances.values()].some(value => common + value > BigInt(MAX))) {
        throw failure('AUTOMATION_SUPPORT_GRANT_LIMIT', '支援枠の合計が保存可能な上限を超えます。付与数と履歴を確認してください。');
    }
}
async function insertGrant(query, entry) {
    const token = randomUUID();
    // A no-op upsert takes the current exclusive lock without a gap-lock
    // upgrade. A token distinguishes an insert even when CLIENT_FOUND_ROWS is
    // enabled. RR snapshots created before the owner lock cannot hide replay.
    try { await query(`INSERT INTO automation_push_support_grants (grant_id,insertion_token,owner_user_id,source_kind,source_id,environment,merchant_id,attempt_id,slots,purchased_slots,amount_yen,confirmed_refunded_amount,financial_observed_at_ms,actor_user_id,purchased_at_ms,created_at_ms,details_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE grant_id=grant_id`, [entry.grantId, token, entry.owner, entry.kind, entry.sourceId, entry.environment, entry.merchantId, entry.attemptId || null,
        entry.slots, entry.purchasedSlots, entry.amount ?? null, entry.refunded ?? 0, entry.observed ?? null, entry.actor || null, entry.purchasedAt, entry.now, entry.details]); }
    catch (cause) { if (cause?.code === 'ER_DUP_ENTRY') throw grantConflict(); throw cause; }
    const row = (await query('SELECT * FROM automation_push_support_grants WHERE grant_id=? FOR UPDATE', [entry.grantId]))[0];
    if (!row || row.owner_user_id !== entry.owner || Number(row.slots) !== entry.slots || Number(row.purchased_slots) !== entry.purchasedSlots
        || (row.amount_yen == null ? null : Number(row.amount_yen)) !== (entry.amount ?? null) || row.details_json !== entry.details) throw grantConflict();
    const inserted = row.insertion_token === token;
    if (inserted) {
        await assertHoldingFits(query, entry.owner);
        const hex = entry.grantId.slice(0, 32), entityId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        await query('INSERT INTO automation_audit (actor_user_id,entity_id,guild_id,action,detail_json,created_at_ms) VALUES (?,?,NULL,?,?,?)',
            [entry.actor || entry.owner, entityId, 'x.support.grant', JSON.stringify({ ownerUserId: entry.owner, grantId: entry.grantId, sourceKind: entry.kind, slots: entry.slots, purchasedSlots: entry.purchasedSlots }), entry.now]);
    }
    return { inserted, grant: historyDto(row) };
}

/** Trusted caller supplies only a local attempt ID; amounts/owners come from the
 * existing REST/webhook-verified ledger, never from request fields. */
async function applyVerifiedDonationGrant(query, attemptId, options = {}) {
    if (typeof attemptId !== 'string' || !UUID.test(attemptId)) throw failure('AUTOMATION_SUPPORT_GRANT_INVALID', '決済の参照を確認してください。');
    const scope = scopeOf(options.scope), now = clock(options.now);
    if (!scope) throw failure('AUTOMATION_SUPPORT_GRANT_SCOPE', '決済の環境を確認できません。', 503);
    let row = (await query('SELECT * FROM automation_square_donation_attempts WHERE id=? AND environment=? AND merchant_id=?', [attemptId, scope.environment, scope.merchantId]))[0];
    if (!row || Number(row.verified) !== 1 || row.state !== 'COMPLETED' || !ID.test(row.payment_id || '') || row.completed_at_ms == null) {
        throw failure('AUTOMATION_SUPPORT_PAYMENT_UNVERIFIED', '確認済みの完了した決済が必要です。', 409);
    }
    const id = owner(row.owner_user_id); await lockOwner(query, id);
    row = (await query('SELECT * FROM automation_square_donation_attempts WHERE id=? AND environment=? AND merchant_id=? AND owner_user_id=? FOR UPDATE', [attemptId, scope.environment, scope.merchantId, id]))[0];
    if (!row || Number(row.verified) !== 1 || row.state !== 'COMPLETED' || !ID.test(row.payment_id || '') || row.completed_at_ms == null) {
        throw failure('AUTOMATION_SUPPORT_PAYMENT_UNVERIFIED', '確認済みの完了した決済が必要です。', 409);
    }
    const migrated = (await query('SELECT snapshot_id FROM automation_push_support_scope_snapshots WHERE owner_user_id=? AND environment=? AND merchant_id=? FOR UPDATE', [id, scope.environment, scope.merchantId]))[0];
    if (!migrated) throw failure('AUTOMATION_SUPPORT_MIGRATION_REQUIRED', '旧支援枠の移行確認が必要です。', 409);
    const old = await query('SELECT owner_user_id FROM automation_push_support_legacy_attempts WHERE environment=? AND merchant_id=? AND (attempt_id=? OR payment_id=?) FOR UPDATE', [scope.environment, scope.merchantId, row.id, row.payment_id]);
    if (old.length) {
        if (old.some(record => record.owner_user_id !== id)) throw grantConflict();
        return { inserted: false, legacy: true, grant: null };
    }
    const amount = stored(row.amount), refunded = stored(row.refunded_amount);
    if (row.currency !== 'JPY' || amount < 500) return { inserted: false, legacy: false, grant: null };
    if (refunded > amount) throw failure('AUTOMATION_SUPPORT_GRANT_CORRUPT', '返金の記録を確認できません。', 503);
    const slots = Number(BigInt(amount) / 500n), grantId = digest('square_payment', scope.environment, scope.merchantId, row.payment_id);
    const result = await insertGrant(query, { grantId, owner: id, kind: 'square_payment', sourceId: row.payment_id, environment: scope.environment, merchantId: scope.merchantId,
        attemptId: row.id, slots, purchasedSlots: slots, amount, refunded, observed: now, purchasedAt: clock(Number(row.completed_at_ms)), now, details: '{}' });
    // Grant counts remain immutable; record verified financial changes for an
    // explicit future refund decision instead of silently removing paid slots.
    await query('UPDATE automation_push_support_grants SET confirmed_refunded_amount=GREATEST(confirmed_refunded_amount,?),financial_observed_at_ms=GREATEST(COALESCE(financial_observed_at_ms,0),?) WHERE grant_id=?', [refunded, now, grantId]);
    result.grant = historyDto((await query('SELECT * FROM automation_push_support_grants WHERE grant_id=? FOR UPDATE', [grantId]))[0]);
    return { ...result, legacy: false };
}
async function recordHistoricalSupportGrant(query, actor, input, options = {}) {
    const actorId = administrator(actor); strict(input, ['userId', 'idempotencyKey', 'slots', 'purchasedAtMs', 'alreadyIncludedInLegacy', 'reason']);
    const id = owner(input.userId), slots = integer(input.slots, 1), now = clock(options.now), purchasedAt = clock(input.purchasedAtMs ?? now);
    if (typeof input.idempotencyKey !== 'string' || !ID.test(input.idempotencyKey) || input.alreadyIncludedInLegacy !== undefined && typeof input.alreadyIncludedInLegacy !== 'boolean') throw failure('AUTOMATION_SUPPORT_GRANT_INVALID', '購入履歴の参照と付与数を確認してください。');
    if (input.reason !== undefined && (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 240)) throw failure('AUTOMATION_SUPPORT_GRANT_INVALID', '確認した購入回数と付与の根拠を指定してください。');
    await migrateLegacyGrants(query, id, options);
    const included = input.alreadyIncludedInLegacy === true;
    return insertGrant(query, { grantId: digest('historical_admin', input.idempotencyKey), owner: id, kind: 'historical_admin', sourceId: input.idempotencyKey,
        environment: 'manual', merchantId: '', slots: included ? 0 : slots, purchasedSlots: slots, actor: actorId, purchasedAt, now,
        details: JSON.stringify({ alreadyIncludedInLegacy: included, purchasedAtMs: input.purchasedAtMs ?? null, reason: input.reason?.trim() ?? null }) });
}
async function explicitAdminAdjustment(query, actor, input, options = {}) {
    const actorId = administrator(actor); strict(input, ['userId', 'idempotencyKey', 'expectedManualSlots', 'manualSlots', 'reason']);
    const id = owner(input.userId), expected = integer(input.expectedManualSlots, -2147483648, 2147483647), next = integer(input.manualSlots, 0, 2147483647), now = clock(options.now);
    if (typeof input.idempotencyKey !== 'string' || !ID.test(input.idempotencyKey) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 240) throw failure('AUTOMATION_SUPPORT_GRANT_INVALID', '変更の参照と理由を確認してください。');
    await migrateLegacyGrants(query, id, options);
    const grantId = digest('manual_adjustment', input.idempotencyKey), details = JSON.stringify({ expectedManualSlots: expected, manualSlots: next, reason: input.reason.trim() });
    const existing = (await query('SELECT * FROM automation_push_support_grants WHERE grant_id=?', [grantId]))[0];
    if (existing) {
        let prior;
        try { prior = JSON.parse(existing.details_json); } catch { throw grantConflict(); }
        // Retrying the same Discord operation can observe the already-updated
        // counter. The intended final count/reason define operation identity;
        // retain the original expected count in its immutable audit details.
        if (existing.owner_user_id !== id || prior.manualSlots !== next || prior.reason !== input.reason.trim()) throw grantConflict();
        return { inserted: false, grant: historyDto(existing) };
    }
    const current = integer(Number((await userRow(query, id))?.additional_auto_extract_slots ?? 0), -2147483648, 2147483647);
    if (current !== expected) throw grantConflict();
    await query('UPDATE users SET additional_auto_extract_slots=? WHERE user_id=? AND additional_auto_extract_slots=?', [next, id, expected]);
    return insertGrant(query, { grantId, owner: id, kind: 'manual_adjustment', sourceId: input.idempotencyKey, environment: 'manual', merchantId: '',
        slots: next - Math.max(0, expected), purchasedSlots: 0, actor: actorId, purchasedAt: now, now, details });
}
module.exports = { getSupporterHolding, migrateLegacyGrants, applyVerifiedDonationGrant, recordHistoricalSupportGrant, explicitAdminAdjustment, getSupporterGrantHistory };

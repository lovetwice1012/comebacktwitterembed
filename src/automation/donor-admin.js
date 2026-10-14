'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { requireActor, AutomationError } = require('./service');
const { lockOwner, inspectPlan } = require('./entitlements');
const { getSquareScope } = require('./square-billing');
const { getSquareDonationGrant } = require('./square-donations');
const USER = /^\d{1,32}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EDIT_FIELDS = new Set(['isDonor', 'extraSlots', 'paymentCount', 'purchaseUnits', 'displayName', 'note', 'reason', 'expectedUpdatedAtMs', 'expectedLegacyIsDonor', 'expectedLegacyExtraSlots']);
function fail(code, message, status = 422) { throw new AutomationError(code, message, status); }
function admin(actor) { requireActor(actor); if (actor.isAdmin !== true) fail('AUTOMATION_FORBIDDEN', '支援者の管理には管理者権限が必要です。', 403); return actor.userId; }
function userId(value) { if (typeof value !== 'string' || !USER.test(value)) fail('DONOR_INVALID_USER', '利用者IDは1〜32桁の数字で指定してください。'); return value; }
function integer(value, minimum, maximum, label) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail('DONOR_INVALID_INPUT', `${label}は${minimum}〜${maximum}の整数で指定してください。`); return value; }
function text(value, maximum, label, multiline = false, required = false) {
    if (typeof value !== 'string') fail('DONOR_INVALID_INPUT', `${label}を文字列で指定してください。`);
    const result = value.trim();
    const characters = [...result];
    const hasControl = characters.some(character => {
        const code = character.charCodeAt(0);
        return code === 127 || code < 32 && !(multiline && [9, 10, 13].includes(code));
    });
    if (characters.length > maximum || required && !result || hasControl) fail('DONOR_INVALID_INPUT', `${label}は${required ? '1' : '0'}〜${maximum}文字で入力してください。`);
    return result;
}
function safeNumber(value) { const number = Number(value); if (!Number.isSafeInteger(number) || number < 0) fail('DONOR_STATISTICS_INVALID', '支援の集計結果を確認できません。', 503); return number; }
function pageSize(value) { if (value == null || value === '') return 20; if (typeof value === 'string' && /^\d{1,2}$/.test(value)) value = Number(value); return integer(value, 1, 50, '表示件数'); }
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const encodeCursor = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function readCursor(raw, filter, history = false) {
    if (raw == null || raw === '') return null;
    if (typeof raw !== 'string' || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) fail('DONOR_INVALID_CURSOR', '一覧を読み直してください。');
    let cursor;
    try { cursor = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { fail('DONOR_INVALID_CURSOR', '一覧を読み直してください。'); }
    if (!cursor || cursor.filter !== filter || typeof cursor.id !== 'string' || (history ? !UUID.test(cursor.id || '') || !Number.isSafeInteger(cursor.at) || cursor.at < 0 : !USER.test(cursor.id || ''))) fail('DONOR_INVALID_CURSOR', '検索条件が変わっています。一覧を読み直してください。');
    return cursor;
}
function manualDto(row, profile) {
    return { isDonor: Number(row?.is_donor || 0) === 1, extraSlots: Number(row?.additional_auto_extract_slots || 0), paymentCount: Number(profile?.manual_payment_count || 0), purchaseUnits: Number(profile?.manual_purchase_units || 0), displayName: profile?.display_name || '', note: profile?.admin_note || '', updatedAtMs: profile ? Number(profile.updated_at_ms) : null };
}
function historyDto(row) {
    return { attemptId: row.id, state: row.state, amount: safeNumber(row.amount), currency: row.currency, refundedAmount: safeNumber(row.refunded_amount), netAmount: Number(row.verified) === 1 && row.state === 'COMPLETED' ? Math.max(0, Number(row.amount) - Number(row.refunded_amount)) : 0, verified: Number(row.verified) === 1, createdAtMs: Number(row.created_at_ms), completedAtMs: row.completed_at_ms == null ? null : Number(row.completed_at_ms) };
}

/** Administrator-only manual records; provider ledgers and automatic grants are read-only. */
function createDonorAdmin(db, options = {}) {
    const squareScope = getSquareScope(options.env), now = options.clock || Date.now;
    const scoped = [squareScope.environment, squareScope.merchantId];
    async function readManual(query, owner) {
        const rows = await query('SELECT user_id,is_donor,additional_auto_extract_slots FROM users WHERE user_id=?', [owner]);
        const profiles = await query('SELECT * FROM automation_donor_profiles WHERE owner_user_id=?', [owner]);
        return { row: rows[0], profile: profiles[0] };
    }
    async function squareSummaries(query, owners) {
        const summaries = new Map(owners.map(owner => [owner, { configured: squareScope.configured, environment: squareScope.environment, active: false, paymentCount: 0, totalsByCurrency: [] }]));
        if (!squareScope.configured || !owners.length) return summaries;
        const rows = await query(`SELECT owner_user_id,currency,SUM(amount) AS amount,SUM(refunded_amount) AS refunded_amount,
            SUM(GREATEST(CAST(amount AS DECIMAL(30,0))-refunded_amount,0)) AS net_amount,
            SUM(CASE WHEN amount>refunded_amount THEN 1 ELSE 0 END) AS payment_count
            FROM automation_square_donation_attempts WHERE environment=? AND merchant_id=? AND state='COMPLETED' AND verified=1
                AND owner_user_id IN (${owners.map(() => '?').join(',')}) GROUP BY owner_user_id,currency ORDER BY owner_user_id,currency`, [...scoped, ...owners]);
        for (const row of rows) {
            const summary = summaries.get(row.owner_user_id), paymentCount = safeNumber(row.payment_count);
            summary.totalsByCurrency.push({ currency: row.currency, amount: safeNumber(row.amount), refundedAmount: safeNumber(row.refunded_amount), netAmount: safeNumber(row.net_amount), paymentCount });
            summary.paymentCount = safeNumber(summary.paymentCount + paymentCount);
        }
        const policy = (await query(`SELECT p.currency,p.supporter_threshold,p.validity_days,u.unit_amount,u.slots_per_unit FROM automation_square_donation_policy p
            LEFT JOIN automation_square_donation_units_policy u ON u.environment=p.environment AND u.merchant_id=p.merchant_id AND u.policy_updated_at_ms=p.updated_at_ms
            WHERE p.environment=? AND p.merchant_id=?`, scoped))[0];
        if (policy?.currency) {
            const unit = Number(policy.unit_amount), slots = Number(policy.slots_per_unit), threshold = Number(policy.supporter_threshold);
            const cutoff = [threshold, Number.isSafeInteger(unit) && unit > 0 && Number.isSafeInteger(slots) && slots > 0 && slots <= 10000 ? unit : 0].filter(value => Number.isSafeInteger(value) && value > 0);
            if (cutoff.length) {
                const eligible = await query(`SELECT owner_user_id,SUM(GREATEST(CAST(amount AS DECIMAL(30,0))-refunded_amount,0)) AS net_amount FROM automation_square_donation_attempts
                    WHERE environment=? AND merchant_id=? AND currency=? AND state='COMPLETED' AND verified=1 AND completed_at_ms IS NOT NULL
                        AND (? IS NULL OR completed_at_ms>?) AND owner_user_id IN (${owners.map(() => '?').join(',')}) GROUP BY owner_user_id`, [...scoped, policy.currency, policy.validity_days, now() - Number(policy.validity_days || 0) * 86400000, ...owners]);
                for (const row of eligible) summaries.get(row.owner_user_id).active = safeNumber(row.net_amount) >= Math.min(...cutoff);
            }
        }
        return summaries;
    }
    function itemDto(owner, row, profile, square) {
        const manual = manualDto(row, profile);
        return { userId: owner, exists: !!row, manual, square, totals: { paymentCount: safeNumber(manual.paymentCount + square.paymentCount) } };
    }
    async function list(actor, input = {}) {
        admin(actor);
        const size = pageSize(input.pageSize), search = text(input.search ?? '', 120, '検索文字列');
        const filter = fingerprint(['list', search, squareScope]), cursor = readCursor(input.cursor, filter);
        const candidates = `SELECT user_id FROM users WHERE is_donor=1
            UNION SELECT user_id FROM users WHERE additional_auto_extract_slots>0
            UNION SELECT owner_user_id AS user_id FROM automation_donor_profiles
            ${squareScope.configured ? "UNION SELECT owner_user_id AS user_id FROM automation_square_donation_attempts WHERE environment=? AND merchant_id=? AND state='COMPLETED' AND verified=1" : ''}`;
        const candidateParams = squareScope.configured ? scoped : [];
        const escaped = search.replace(/[=%_]/g, value => '=' + value), searchSql = search ? ` AND (c.user_id=? OR p.display_name LIKE ? ESCAPE '=')` : '';
        const searchParams = search ? [search, escaped + '%'] : [];
        const from = `FROM (${candidates}) c LEFT JOIN users u ON u.user_id=c.user_id LEFT JOIN automation_donor_profiles p ON p.owner_user_id=c.user_id WHERE 1=1${searchSql}`;
        const count = await db.queryDatabase(`SELECT COUNT(*) AS total ${from}`, [...candidateParams, ...searchParams]);
        const rows = await db.queryDatabase(`SELECT c.user_id,u.user_id AS existing_user_id,u.is_donor,u.additional_auto_extract_slots,
            p.display_name,p.admin_note,p.manual_payment_count,p.manual_purchase_units,p.updated_at_ms ${from}${cursor ? ' AND c.user_id>?' : ''}
            ORDER BY c.user_id LIMIT ?`, [...candidateParams, ...searchParams, ...(cursor ? [cursor.id] : []), size + 1]);
        const more = rows.length > size; if (more) rows.pop();
        const summaries = await squareSummaries(db.queryDatabase, rows.map(row => row.user_id));
        const items = rows.map(row => itemDto(row.user_id, row.existing_user_id ? row : null, row.updated_at_ms == null ? null : row, summaries.get(row.user_id)));
        return { items, total: safeNumber(count[0].total), pageSize: size, nextCursor: more ? encodeCursor({ id: rows.at(-1).user_id, filter }) : null };
    }
    async function history(actor, owner, input = {}) {
        admin(actor); userId(owner);
        const size = pageSize(input.pageSize), filter = fingerprint(['history', owner, squareScope]), cursor = readCursor(input.cursor, filter, true);
        if (!squareScope.configured) return { items: [], pageSize: size, nextCursor: null };
        const rows = await db.queryDatabase(`SELECT id,state,amount,currency,refunded_amount,verified,created_at_ms,completed_at_ms FROM automation_square_donation_attempts
            WHERE owner_user_id=? AND environment=? AND merchant_id=? AND verified=1
                ${cursor ? 'AND (created_at_ms<? OR (created_at_ms=? AND id<?))' : ''} ORDER BY created_at_ms DESC,id DESC LIMIT ?`, [owner, ...scoped, ...(cursor ? [cursor.at, cursor.at, cursor.id] : []), size + 1]);
        const more = rows.length > size; if (more) rows.pop();
        return { items: rows.map(historyDto), pageSize: size, nextCursor: more ? encodeCursor({ at: Number(rows.at(-1).created_at_ms), id: rows.at(-1).id, filter }) : null };
    }
    async function usage(query, owner) {
        // Native registrations include paused and not-yet-adopted targets. Only
        // boost reservations still attached to those owners consume capacity.
        const targets = await query(`SELECT COUNT(*) AS used FROM (SELECT id FROM auto_watch_targets WHERE user_id=? UNION ALL SELECT id FROM price_watch_targets WHERE user_id=?) t`, [owner, owner]);
        const boosts = await query(`SELECT COUNT(*) AS used FROM automation_notification_boost_slots b WHERE b.owner_user_id=? AND
            ((b.target_kind='auto' AND EXISTS (SELECT 1 FROM auto_watch_targets t WHERE t.id=b.target_id AND t.user_id=b.owner_user_id))
             OR (b.target_kind='price' AND EXISTS (SELECT 1 FROM price_watch_targets t WHERE t.id=b.target_id AND t.user_id=b.owner_user_id)))`, [owner]);
        return safeNumber(Number(targets[0].used) + Number(boosts[0].used));
    }
    async function get(actor, owner) {
        admin(actor); userId(owner);
        const { row, profile } = await readManual(db.queryDatabase, owner), instant = now();
        const square = (await squareSummaries(db.queryDatabase, [owner])).get(owner);
        const grant = await getSquareDonationGrant(db.queryDatabase, owner, instant, squareScope);
        const plan = await inspectPlan(db.queryDatabase, owner, instant, squareScope), usedSlots = await usage(db.queryDatabase, owner);
        const payments = await history(actor, owner);
        return { ...itemDto(owner, row, profile, square), version: { updatedAtMs: profile ? Number(profile.updated_at_ms) : null, legacyIsDonor: Number(row?.is_donor || 0), legacyExtraSlots: Number(row?.additional_auto_extract_slots || 0) },
            square: { ...square, active: grant.active, grant, history: payments.items, historyNextCursor: payments.nextCursor }, entitlement: { ...plan, usedSlots, remainingSlots: Math.max(0, plan.slotLimit - usedSlots), overLimit: usedSlots > plan.slotLimit } };
    }
    async function save(actor, owner, input) {
        const actorId = admin(actor); userId(owner);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !EDIT_FIELDS.has(key)) || typeof input.isDonor !== 'boolean') fail('DONOR_INVALID_INPUT', '手動の支援者設定を確認してください。');
        const updated = { isDonor: input.isDonor, extraSlots: integer(input.extraSlots, 0, 10000, '追加枠数'), paymentCount: integer(input.paymentCount, 0, 1000000, '手動の支援回数'), purchaseUnits: integer(input.purchaseUnits, 0, 1000000, '手動の購入口数'), displayName: text(input.displayName, 120, '管理用表示名'), note: text(input.note, 2000, '管理者メモ', true) };
        const reason = text(input.reason, 500, '変更理由', true, true), expected = input.expectedUpdatedAtMs;
        if (expected !== null) integer(expected, 1, Number.MAX_SAFE_INTEGER, '設定の更新時刻');
        integer(input.expectedLegacyIsDonor, -128, 127, '以前の支援者設定'); integer(input.expectedLegacyExtraSlots, -2147483648, 2147483647, '以前の追加枠数');
        await db.withDatabaseTransaction(async query => {
            await lockOwner(query, owner);
            const row = (await query('SELECT user_id,is_donor,additional_auto_extract_slots FROM users WHERE user_id=? FOR UPDATE', [owner]))[0];
            const profile = (await query('SELECT * FROM automation_donor_profiles WHERE owner_user_id=? FOR UPDATE', [owner]))[0];
            const previous = profile ? Number(profile.updated_at_ms) : null;
            if (previous !== expected || Number(row.is_donor) !== input.expectedLegacyIsDonor || Number(row.additional_auto_extract_slots) !== input.expectedLegacyExtraSlots) fail('DONOR_EDIT_CONFLICT', '支援者設定が別の操作で更新されています。最新の設定を読み直してください。', 409);
            const before = { ...manualDto(row, profile), legacyIsDonor: Number(row.is_donor), legacyExtraSlots: Number(row.additional_auto_extract_slots) };
            const updatedAtMs = Math.max(now(), (previous || 0) + 1), after = { ...updated, updatedAtMs, legacyIsDonor: updated.isDonor ? 1 : 0, legacyExtraSlots: updated.extraSlots };
            await query('UPDATE users SET is_donor=?,additional_auto_extract_slots=? WHERE user_id=?', [after.legacyIsDonor, after.legacyExtraSlots, owner]);
            await query(`INSERT INTO automation_donor_profiles (owner_user_id,display_name,admin_note,manual_payment_count,manual_purchase_units,updated_at_ms,actor_user_id)
                VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),admin_note=VALUES(admin_note),manual_payment_count=VALUES(manual_payment_count),manual_purchase_units=VALUES(manual_purchase_units),updated_at_ms=VALUES(updated_at_ms),actor_user_id=VALUES(actor_user_id)`, [owner, updated.displayName, updated.note, updated.paymentCount, updated.purchaseUnits, updatedAtMs, actorId]);
            await query('INSERT INTO automation_donor_audit (id,owner_user_id,actor_user_id,reason,before_json,after_json,created_at_ms) VALUES (?,?,?,?,?,?,?)', [randomUUID(), owner, actorId, reason, JSON.stringify(before), JSON.stringify(after), updatedAtMs]);
        });
        return get(actor, owner);
    }
    async function audit(actor, owner, input = {}) {
        admin(actor); userId(owner);
        const size = pageSize(input.pageSize), filter = fingerprint(['audit', owner]), cursor = readCursor(input.cursor, filter, true);
        const rows = await db.queryDatabase(`SELECT * FROM automation_donor_audit WHERE owner_user_id=? ${cursor ? 'AND (created_at_ms<? OR (created_at_ms=? AND id<?))' : ''} ORDER BY created_at_ms DESC,id DESC LIMIT ?`, [owner, ...(cursor ? [cursor.at, cursor.at, cursor.id] : []), size + 1]);
        const more = rows.length > size; if (more) rows.pop();
        const items = rows.map(row => ({ id: row.id, userId: row.owner_user_id, actorUserId: row.actor_user_id, reason: row.reason, before: JSON.parse(row.before_json), after: JSON.parse(row.after_json), createdAtMs: Number(row.created_at_ms) }));
        return { items, pageSize: size, nextCursor: more ? encodeCursor({ at: Number(rows.at(-1).created_at_ms), id: rows.at(-1).id, filter }) : null };
    }
    return { list, get, save, history, audit };
}
module.exports = { createDonorAdmin };

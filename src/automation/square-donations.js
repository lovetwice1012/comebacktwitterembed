'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { lockOwner } = require('./entitlements');
const { createSquareClient, getSquareScope, isValidReceiptEmail } = require('./square-billing');
const ID = /^[A-Za-z0-9:_-]{1,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NONCE = /^cnon:[A-Za-z0-9:_-]{1,490}$/;
const QUOTE_MS = 15 * 60000, LEASE_MS = 5 * 60000, DAY_MS = 86400000;
const REFRESH_MS = 30000, COMPLETED_BATCH = 4, PENDING_BATCH = 2, REFRESH_READ_LIMIT = 32;
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELED']);
function fail(code, message, status = 422) { return Object.assign(new Error(message), { name: 'AutomationError', code, status }); }
function user(actor) { const value = String(actor?.userId || ''); if (!/^\d{1,32}$/.test(value)) throw fail('AUTOMATION_AUTH_REQUIRED', 'ログインしてください。', 401); return value; }
function admin(actor) { const value = user(actor); if (actor.isAdmin !== true) throw fail('AUTOMATION_FORBIDDEN', '寄付の設定には管理者権限が必要です。', 403); return value; }
function amount(value, optional = false) {
    if (optional && (value === null || value === undefined)) return null;
    if (!Number.isSafeInteger(value) || value <= 0 || value > 1000000000) throw fail('SQUARE_DONATION_POLICY_INVALID', '金額は通貨の最小単位で1〜1,000,000,000の整数を指定してください。');
    return value;
}
function minorDigits(currency) { return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits; }
function policyDto(row) {
    return { enabled: Number(row?.enabled) === 1, currency: row?.currency || null, minimumAmount: row?.minimum_amount == null ? null : Number(row.minimum_amount),
        maximumAmount: row?.maximum_amount == null ? null : Number(row.maximum_amount), supporterThreshold: row?.supporter_threshold == null ? null : Number(row.supporter_threshold),
        validityDays: row?.validity_days == null ? null : Number(row.validity_days), unitAmount: row?.unit_amount == null ? null : Number(row.unit_amount),
        slotsPerUnit: row?.slots_per_unit == null ? null : Number(row.slots_per_unit), updatedAtMs: row ? Number(row.updated_at_ms) : null };
}
function quoteDto(row) { return { attemptId: row.id, expiresAtMs: Number(row.expires_at_ms), amount: Number(row.amount), currency: row.currency, minorUnitDigits: minorDigits(row.currency), email: row.email, name: row.name }; }
function historyDto(row) { return { attemptId: row.id, state: row.state, amount: Number(row.amount), currency: row.currency, refundedAmount: Number(row.refunded_amount),
    netAmount: row.state === 'COMPLETED' && Number(row.verified) === 1 ? Number(row.amount) - Number(row.refunded_amount) : 0,
    verified: Number(row.verified) === 1, createdAtMs: Number(row.created_at_ms), completedAtMs: row.completed_at_ms == null ? null : Number(row.completed_at_ms) }; }

async function donationPolicy(query, scope, locked = false) {
    return (await query(`SELECT p.*,u.unit_amount,u.slots_per_unit FROM automation_square_donation_policy p
        LEFT JOIN automation_square_donation_units_policy u ON u.environment=p.environment AND u.merchant_id=p.merchant_id AND u.policy_updated_at_ms=p.updated_at_ms
        WHERE p.environment=? AND p.merchant_id=?${locked ? ' FOR UPDATE' : ''}`, scope))[0];
}
async function donationGrant(query, owner, current, scope, now) {
    const p = policyDto(current);
    const rows = current && p.currency ? await query(`SELECT amount,refunded_amount,completed_at_ms FROM automation_square_donation_attempts
        WHERE owner_user_id=? AND environment=? AND merchant_id=? AND currency=? AND state='COMPLETED' AND verified=1 AND completed_at_ms IS NOT NULL
            AND (? IS NULL OR completed_at_ms>?) ORDER BY completed_at_ms`, [owner, ...scope, p.currency, p.validityDays, now - (p.validityDays || 0) * DAY_MS]) : [];
    const contributions = rows.map(row => ({ net: Math.max(0, Number(row.amount) - Number(row.refunded_amount)), expiry: p.validityDays == null ? null : Number(row.completed_at_ms) + p.validityDays * DAY_MS }))
        .filter(row => Number.isSafeInteger(row.net) && row.net > 0);
    const total = contributions.reduce((sum, row) => sum + BigInt(row.net), 0n);
    const netAmount = Number(total);
    if (!Number.isSafeInteger(netAmount)) throw fail('SQUARE_DONATION_GRANT_INVALID', '寄付の累積金額を確認できません。管理者にお問い合わせください。', 503);
    const unitsEnabled = Number.isSafeInteger(p.unitAmount) && p.unitAmount > 0 && Number.isSafeInteger(p.slotsPerUnit) && p.slotsPerUnit > 0 && p.slotsPerUnit <= 10000;
    const unitsFor = amount => unitsEnabled ? Number(amount / BigInt(p.unitAmount) > 10000n ? 10000n : amount / BigInt(p.unitAmount)) : 0;
    const purchaseUnits = unitsFor(total), extraSlots = Math.min(10000, purchaseUnits * (p.slotsPerUnit || 0));
    const required = [p.supporterThreshold, unitsEnabled ? p.unitAmount : null].filter(value => Number.isSafeInteger(value) && value > 0);
    const cutoff = required.length ? BigInt(Math.min(...required)) : null, active = cutoff !== null && total >= cutoff;
    let validUntilAtMs = null, unitsValidUntilAtMs = null, remaining = total;
    if (p.validityDays != null) for (const row of contributions) {
        remaining -= BigInt(row.net);
        if (unitsValidUntilAtMs === null && purchaseUnits > 0 && unitsFor(remaining) < purchaseUnits) unitsValidUntilAtMs = row.expiry;
        if (active && validUntilAtMs === null && remaining < cutoff) validUntilAtMs = row.expiry;
    }
    return { active, netAmount, threshold: p.supporterThreshold, validityDays: p.validityDays, validUntilAtMs,
        unitAmount: p.unitAmount, slotsPerUnit: p.slotsPerUnit, purchaseUnits, extraSlots, paymentCount: contributions.length, unitsValidUntilAtMs };
}
// Read only the verified local ledger. Recalculate after every expiry so a
// falling unit count retains all remaining units without requiring a status GET.
async function getSquareDonationGrant(query, owner, now = Date.now(), scope = getSquareScope()) {
    if (!scope.configured) return donationGrant(query, owner, null, [], now);
    const scoped = [scope.environment, scope.merchantId];
    return donationGrant(query, owner, await donationPolicy(query, scoped), scoped, now);
}
async function isSquareDonationSupporter(query, owner, now = Date.now(), scope = getSquareScope()) {
    return (await getSquareDonationGrant(query, owner, now, scope)).active;
}

/** Trusted server options only; raw card data, client principals and prices are never accepted. */
function createSquareDonations(db, options = {}) {
    const { config: c, now, scope, requireConfigured, request, location } = createSquareClient(options);
    async function readPolicy(query = db.queryDatabase, locked = false) { return donationPolicy(query, scope, locked); }
    async function recomputeSupporter(query, owner, policy) {
        const current = policy || await readPolicy(query, true), p = policyDto(current);
        const grant = await donationGrant(query, owner, current, scope, now());
        if (current) await query(`INSERT INTO automation_square_donation_supporters (owner_user_id,environment,merchant_id,active,net_amount,valid_until_at_ms,policy_updated_at_ms,updated_at_ms)
            VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE active=VALUES(active),net_amount=VALUES(net_amount),valid_until_at_ms=VALUES(valid_until_at_ms),policy_updated_at_ms=VALUES(policy_updated_at_ms),updated_at_ms=VALUES(updated_at_ms)`,
        [owner, ...scope, grant.active ? 1 : 0, grant.netAmount, grant.validUntilAtMs, p.updatedAtMs, now()]);
        if (current) await query(`INSERT INTO automation_square_donation_unit_grants (owner_user_id,environment,merchant_id,purchase_units,extra_slots,payment_count,units_valid_until_at_ms,policy_updated_at_ms,updated_at_ms)
            VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE purchase_units=VALUES(purchase_units),extra_slots=VALUES(extra_slots),payment_count=VALUES(payment_count),units_valid_until_at_ms=VALUES(units_valid_until_at_ms),policy_updated_at_ms=VALUES(policy_updated_at_ms),updated_at_ms=VALUES(updated_at_ms)`,
        [owner, ...scope, grant.purchaseUnits, grant.extraSlots, grant.paymentCount, grant.unitsValidUntilAtMs, p.updatedAtMs, now()]);
        return grant;
    }
    async function getAdmin(actor) {
        admin(actor);
        if (!c.configured) return { configured: false, environment: c.environment, missing: c.missing, policy: policyDto(null), minorUnitDigits: null };
        const found = await location(), policy = policyDto(await readPolicy());
        return { configured: true, environment: c.environment, missing: [], policy, locationCurrency: found.currency || null, minorUnitDigits: found.currency ? minorDigits(found.currency) : null };
    }
    async function savePolicy(actor, input) {
        const actorId = admin(actor); requireConfigured();
        if (typeof input?.enabled !== 'boolean' || (input.currency !== null && !/^[A-Z]{3}$/.test(input.currency || ''))) throw fail('SQUARE_DONATION_POLICY_INVALID', '寄付の受付状態と通貨を確認してください。');
        const minimum = amount(input.minimumAmount, true), maximum = amount(input.maximumAmount, true), threshold = amount(input.supporterThreshold, true), days = input.validityDays ?? null;
        if (days !== null && (!Number.isSafeInteger(days) || days < 1 || days > 36500)) throw fail('SQUARE_DONATION_POLICY_INVALID', '対象期間は1〜36,500日、または無期限を指定してください。');
        if (input.enabled && (!input.currency || !minimum || !maximum) || minimum && maximum && minimum > maximum || threshold && !input.currency) throw fail('SQUARE_DONATION_POLICY_INVALID', '受付には通貨と金額の下限・上限が必要です。支援者の条件も通貨と合わせて指定してください。');
        const found = await location();
        if (input.currency && input.currency !== found.currency) throw fail('SQUARE_DONATION_CURRENCY_MISMATCH', 'Squareの店舗と同じ通貨を指定してください。');
        return db.withDatabaseTransaction(async query => {
            // The scoped singleton row serializes first creation and every CAS.
            await query(`INSERT INTO automation_square_donation_policy (environment,merchant_id,updated_at_ms,actor_user_id) VALUES (?,?,0,?) ON DUPLICATE KEY UPDATE merchant_id=VALUES(merchant_id)`, [...scope, actorId]);
            const current = await readPolicy(query, true), previous = Number(current.updated_at_ms);
            if ((input.expectedUpdatedAtMs ?? null) !== (previous || null)) throw fail('SQUARE_DONATION_POLICY_CONFLICT', '設定が別の操作で更新されています。最新の設定を読み直してください。', 409);
            const unitAmount = input.unitAmount === undefined ? current.unit_amount == null ? null : Number(current.unit_amount) : amount(input.unitAmount, true);
            const slotsPerUnit = input.slotsPerUnit === undefined ? current.slots_per_unit == null ? null : Number(current.slots_per_unit) : input.slotsPerUnit;
            if ((unitAmount === null) !== (slotsPerUnit === null) || slotsPerUnit !== null && (!Number.isSafeInteger(slotsPerUnit) || slotsPerUnit < 1 || slotsPerUnit > 10000)
                || unitAmount !== null && !input.currency) throw fail('SQUARE_DONATION_POLICY_INVALID', '1口の金額と1口あたりの追加枠を合わせて設定してください。追加枠は1〜10,000の整数です。');
            const updated = Math.max(now(), previous + 1);
            await query(`UPDATE automation_square_donation_policy SET enabled=?,currency=?,minimum_amount=?,maximum_amount=?,supporter_threshold=?,validity_days=?,updated_at_ms=?,actor_user_id=? WHERE environment=? AND merchant_id=?`,
            [input.enabled ? 1 : 0, input.currency, minimum, maximum, threshold, days, updated, actorId, ...scope]);
            await query(`INSERT INTO automation_square_donation_units_policy (environment,merchant_id,unit_amount,slots_per_unit,policy_updated_at_ms)
                VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE unit_amount=VALUES(unit_amount),slots_per_unit=VALUES(slots_per_unit),policy_updated_at_ms=VALUES(policy_updated_at_ms)`, [...scope, unitAmount, slotsPerUnit, updated]);
            const policy = await readPolicy(query), owners = await query('SELECT DISTINCT owner_user_id FROM automation_square_donation_attempts WHERE environment=? AND merchant_id=? ORDER BY owner_user_id', scope);
            for (const { owner_user_id: owner } of owners) await recomputeSupporter(query, owner, policy);
            return policyDto(policy);
        });
    }
    async function getOptions(actor) {
        user(actor);
        const policy = c.configured ? policyDto(await readPolicy()) : policyDto(null);
        return { configured: c.configured, environment: c.environment, ...(c.configured ? { applicationId: c.applicationId, locationId: c.locationId } : {}),
            ...policy, minorUnitDigits: policy.currency ? minorDigits(policy.currency) : null,
            slotGrantPolicy: { currency: 'JPY', unitAmount: 500, slotsPerUnit: 1, permanent: true } };
    }
    async function loadAttempt(attemptId, owner, query = db.queryDatabase) {
        if (!UUID.test(attemptId || '')) throw fail('SQUARE_DONATION_NOT_FOUND', '寄付の申し込み内容が見つかりません。', 404);
        const row = (await query('SELECT * FROM automation_square_donation_attempts WHERE id=? AND owner_user_id=? AND environment=? AND merchant_id=?', [attemptId, owner, ...scope]))[0];
        if (!row) throw fail('SQUARE_DONATION_NOT_FOUND', '寄付の申し込み内容が見つかりません。', 404); return row;
    }
    async function createQuote(actor, input) {
        const owner = user(actor); requireConfigured();
        const chosen = amount(input?.amount), email = String(input?.email || '').trim(), name = String(input?.name || '').trim();
        if (!isValidReceiptEmail(email)) throw fail('SQUARE_EMAIL_REQUIRED', '領収書を受け取るメールアドレスを入力してください。');
        if (!name || name.length > 120 || [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw fail('SQUARE_NAME_REQUIRED', '領収書の宛名を1〜120文字で入力してください。');
        const found = await location();
        return db.withDatabaseTransaction(async query => {
            await lockOwner(query, owner);
            const p = policyDto(await readPolicy(query, true));
            if (!p.enabled || !p.currency || !p.minimumAmount || !p.maximumAmount || p.currency !== found.currency) throw fail('SQUARE_DONATION_UNAVAILABLE', '現在、Squareでの寄付は受け付けていません。', 409);
            if (chosen < p.minimumAmount || chosen > p.maximumAmount) throw fail('SQUARE_DONATION_AMOUNT_INVALID', '寄付額は表示された受付範囲内で指定してください。');
            const pending = await query(`SELECT id FROM automation_square_donation_attempts WHERE owner_user_id=? AND environment=? AND merchant_id=? AND state IN ('SUBMITTING','UNKNOWN','APPROVED','PENDING') LIMIT 1`, [owner, ...scope]);
            if (pending.length) throw fail('SQUARE_DONATION_PENDING', '前回の寄付の決済結果を確認してから、次の寄付を行ってください。', 409);
            const attemptId = randomUUID();
            await query(`INSERT INTO automation_square_donation_attempts (id,owner_user_id,environment,merchant_id,location_id,application_id,amount,currency,email,name,policy_updated_at_ms,expires_at_ms,created_at_ms,updated_at_ms)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [attemptId, owner, ...scope, c.locationId, c.applicationId, chosen, p.currency, email, name, p.updatedAtMs, now() + QUOTE_MS, now(), now()]);
            return quoteDto(await loadAttempt(attemptId, owner, query));
        });
    }
    function mismatch() { return fail('SQUARE_DONATION_PAYMENT_MISMATCH', 'Squareの決済と申し込み内容が一致していません。管理者にお問い合わせください。', 503); }
    async function observePayment(row, payment, read = request) {
        if (!payment || !ID.test(payment.id || '') || row.payment_id && row.payment_id !== payment.id || payment.location_id !== row.location_id
            || payment.application_details?.application_id !== row.application_id || payment.reference_id !== row.id || payment.source_type !== 'CARD'
            || Number(payment.amount_money?.amount) !== Number(row.amount) || payment.amount_money?.currency !== row.currency
            || payment.status === 'COMPLETED' && payment.card_details?.status !== 'CAPTURED'
            || payment.total_money && (Number(payment.total_money.amount) !== Number(row.amount) || payment.total_money.currency !== row.currency)
            || !['COMPLETED', 'APPROVED', 'PENDING', 'FAILED', 'CANCELED'].includes(payment.status)
            || payment.status === 'COMPLETED' && (!ID.test(payment.order_id || '') || !payment.total_money)
            || payment.order_id && !ID.test(payment.order_id) || row.order_id && row.order_id !== payment.order_id) throw mismatch();
        if (payment.order_id) {
            const { order } = await read('GET', `/v2/orders/${encodeURIComponent(payment.order_id)}`);
            if (!order || order.id !== payment.order_id || order.location_id !== row.location_id || Number(order.total_money?.amount) !== Number(row.amount)
                || order.total_money?.currency !== row.currency || !order.tenders?.some(tender => tender.payment_id === payment.id)) throw mismatch();
        }
        const updated = Date.parse(payment.updated_at), completed = row.completed_at_ms == null ? Date.parse(payment.card_details?.card_payment_timeline?.captured_at || payment.created_at) : Number(row.completed_at_ms);
        if (!Number.isSafeInteger(updated) || payment.status === 'COMPLETED' && !Number.isSafeInteger(completed)) throw mismatch();
        let refunded = 0;
        const refunds = [];
        if (payment.refund_ids !== undefined && (!Array.isArray(payment.refund_ids) || payment.refund_ids.length > 100 || new Set(payment.refund_ids).size !== payment.refund_ids.length)) throw mismatch();
        for (const refundId of payment.refund_ids || []) {
            if (!ID.test(refundId)) throw mismatch();
            const { refund } = await read('GET', `/v2/refunds/${encodeURIComponent(refundId)}`), refundAmount = Number(refund?.amount_money?.amount);
            if (!refund || refund.id !== refundId || refund.payment_id !== payment.id || refund.location_id !== row.location_id || refund.amount_money?.currency !== row.currency
                || !Number.isSafeInteger(refundAmount) || refundAmount <= 0 || !['COMPLETED', 'PENDING', 'REJECTED', 'FAILED'].includes(refund.status)) throw mismatch();
            if (refund.status === 'COMPLETED') refunded += refundAmount;
            refunds.push(refund);
        }
        if (refunded > Number(row.amount) || Number(payment.refunded_money?.amount || 0) !== refunded || payment.refunded_money && payment.refunded_money.currency !== row.currency) throw mismatch();
        return { payment, updated, completed, refunded, refunds };
    }
    async function applyObservation(query, row, observation) {
        const { payment, updated, completed, refunded, refunds } = observation;
        // A fresh observation may race a webhook. Re-read the bound ledger row
        // under the owner lock and preserve confirmed refunds at equal versions.
        if (row.payment_id && row.payment_id !== payment.id || row.order_id && row.order_id !== payment.order_id) throw mismatch();
        if (row.square_updated_at_ms != null && updated < Number(row.square_updated_at_ms)) return;
        // Admin policy edits lock policy before updating the rolling unit ledger.
        // Match that order before the support ledger's current-read unit locks.
        await readPolicy(query, true);
        // Freeze old granted COUNTS before this observation changes the rolling
        // aggregate. The current unverified attempt belongs to the new scheme;
        // verified historical attempts remain classified legacy on webhook replay.
        const support = require('./push-support-grants');
        const grantOptions = { now: now(), scope: { configured: c.configured, environment: c.environment, merchantId: c.merchantId } };
        await support.migrateLegacyGrants(query, row.owner_user_id, { ...grantOptions, ...(Number(row.verified) === 1 ? {} : { excludeAttemptId: row.id }) });
        const confirmedRefund = Math.max(Number(row.refunded_amount), refunded);
        for (const refund of refunds) await query(`INSERT INTO automation_square_donation_refunds (environment,merchant_id,refund_id,attempt_id,payment_id,amount,currency,state,observed_at_ms)
            VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE state=IF(state='COMPLETED','COMPLETED',VALUES(state)),observed_at_ms=VALUES(observed_at_ms)`,
        [...scope, refund.id, row.id, payment.id, Number(refund.amount_money.amount), row.currency, refund.status, now()]);
        await query(`UPDATE automation_square_donation_attempts SET state=?,payment_id=?,order_id=?,refunded_amount=?,verified=1,completed_at_ms=?,square_updated_at_ms=?,updated_at_ms=? WHERE id=?`,
        [payment.status, payment.id, payment.order_id || null, confirmedRefund, payment.status === 'COMPLETED' ? row.completed_at_ms == null ? completed : Number(row.completed_at_ms) : null, updated, now(), row.id]);
        if (payment.status === 'COMPLETED') await support.applyVerifiedDonationGrant(query, row.id, grantOptions);
        await recomputeSupporter(query, row.owner_user_id);
    }
    async function paymentFor(row, read = request) {
        if (row.payment_id) return (await read('GET', `/v2/payments/${encodeURIComponent(row.payment_id)}`)).payment;
        if (!['SUBMITTING', 'UNKNOWN'].includes(row.state)) return null;
        let cursor;
        // Never conclude that an unknown write failed just because a bounded
        // recovery search has no match. It remains blocked until reconciled.
        for (let page = 0; page < 20; page++) {
            const params = new URLSearchParams({ location_id: row.location_id, begin_time: new Date(Number(row.created_at_ms) - 60000).toISOString(), sort_order: 'ASC', limit: '100', ...(cursor ? { cursor } : {}) });
            const data = await read('GET', `/v2/payments?${params}`), matches = (data.payments || []).filter(payment => payment.reference_id === row.id);
            if (matches.length > 1) throw mismatch();
            if (matches[0]) return (await read('GET', `/v2/payments/${encodeURIComponent(matches[0].id)}`)).payment;
            cursor = data.cursor; if (!cursor) break;
        }
        return null;
    }
    async function reconcileOwner(owner) {
        const claim = await db.withDatabaseTransaction(async query => {
            await query(`INSERT INTO automation_square_donation_reconciliation (owner_user_id,environment,merchant_id) VALUES (?,?,?) ON DUPLICATE KEY UPDATE owner_user_id=VALUES(owner_user_id)`, [owner, ...scope]);
            const current = (await query('SELECT * FROM automation_square_donation_reconciliation WHERE owner_user_id=? AND environment=? AND merchant_id=? FOR UPDATE', [owner, ...scope]))[0];
            if (current.lease_token && Number(current.lease_until_at_ms) > now()) return { state: 'busy', retryAtMs: Number(current.lease_until_at_ms) };
            if (Number(current.next_allowed_at_ms) > now()) return { state: 'cooldown', retryAtMs: Number(current.next_allowed_at_ms) };
            const token = randomUUID();
            await query('UPDATE automation_square_donation_reconciliation SET lease_token=?,lease_until_at_ms=? WHERE owner_user_id=? AND environment=? AND merchant_id=?', [token, now() + LEASE_MS, owner, ...scope]);
            return { state: 'claimed', token, cursorAt: current.completed_cursor_at_ms == null ? null : Number(current.completed_cursor_at_ms), cursorId: current.completed_cursor_id };
        });
        if (claim.state !== 'claimed') return { state: claim.state, retryAtMs: claim.retryAtMs };
        let cursorAt = claim.cursorAt, cursorId = claim.cursorId, failed = false, reads = 0;
        const deadline = Date.now() + 20000;
        const read = async (method, path) => {
            if (++reads > REFRESH_READ_LIMIT || Date.now() >= deadline) throw fail('SQUARE_DONATION_REFRESH_BUDGET', '決済状況の確認を順次進めています。', 503);
            return request(method, path);
        };
        const persist = async (row, observation) => db.withDatabaseTransaction(async query => {
            const lease = (await query('SELECT lease_token,lease_until_at_ms FROM automation_square_donation_reconciliation WHERE owner_user_id=? AND environment=? AND merchant_id=? FOR UPDATE', [owner, ...scope]))[0];
            if (lease.lease_token !== claim.token || Number(lease.lease_until_at_ms) <= now()) return false;
            await lockOwner(query, owner); await applyObservation(query, await loadAttempt(row.id, owner, query), observation); return true;
        });
        try {
            const pending = await db.queryDatabase(`SELECT * FROM automation_square_donation_attempts WHERE owner_user_id=? AND environment=? AND merchant_id=? AND state IN ('SUBMITTING','UNKNOWN','APPROVED','PENDING') ORDER BY created_at_ms,id LIMIT ${PENDING_BATCH}`, [owner, ...scope]);
            let completed = await db.queryDatabase(`SELECT * FROM automation_square_donation_attempts WHERE owner_user_id=? AND environment=? AND merchant_id=? AND state='COMPLETED' AND (? IS NULL OR created_at_ms>? OR (created_at_ms=? AND id>?)) ORDER BY created_at_ms,id LIMIT ${COMPLETED_BATCH}`, [owner, ...scope, cursorAt, cursorAt, cursorAt, cursorId]);
            if (!completed.length && cursorAt !== null) {
                cursorAt = null; cursorId = null;
                completed = await db.queryDatabase(`SELECT * FROM automation_square_donation_attempts WHERE owner_user_id=? AND environment=? AND merchant_id=? AND state='COMPLETED' ORDER BY created_at_ms,id LIMIT ${COMPLETED_BATCH}`, [owner, ...scope]);
            }
            for (const row of [...pending, ...completed]) {
                try {
                    const payment = await paymentFor(row, read);
                    if (payment && !await persist(row, await observePayment(row, payment, read))) { failed = true; break; }
                } catch { failed = true; }
                if (row.state === 'COMPLETED') { cursorAt = Number(row.created_at_ms); cursorId = row.id; }
                if (reads >= REFRESH_READ_LIMIT || Date.now() >= deadline) break;
            }
        } catch { failed = true; }
        finally {
            await db.queryDatabase(`UPDATE automation_square_donation_reconciliation SET lease_token=NULL,lease_until_at_ms=NULL,next_allowed_at_ms=?,completed_cursor_at_ms=?,completed_cursor_id=? WHERE owner_user_id=? AND environment=? AND merchant_id=? AND lease_token=?`,
            [now() + REFRESH_MS, cursorAt, cursorId, owner, ...scope, claim.token]);
        }
        return { state: failed ? 'failed' : 'checked', retryAtMs: now() + REFRESH_MS };
    }
    async function getHistory(actor, after = '') {
        const owner = user(actor);
        let boundary = null;
        if (after) {
            try {
                if (typeof after !== 'string' || after.length > 180 || !/^[A-Za-z0-9_-]+$/.test(after)) throw new Error('CURSOR');
                boundary = JSON.parse(Buffer.from(after, 'base64url').toString('utf8'));
                if (!Array.isArray(boundary) || boundary.length !== 2 || !Number.isSafeInteger(boundary[0]) || boundary[0] < 0 || !UUID.test(boundary[1])) throw new Error('CURSOR');
            } catch { throw fail('SQUARE_DONATION_HISTORY_CURSOR', '寄付履歴を再読み込みしてください。', 400); }
        }
        if (!c.configured) return { items: [], nextCursor: null };
        // This cursor is exclusively for owner-scoped display. It never drives
        // payment reconciliation or changes grant/payment state.
        const rows = await db.queryDatabase(`SELECT * FROM automation_square_donation_attempts WHERE owner_user_id=? AND environment=? AND merchant_id=?
            ${boundary ? 'AND (created_at_ms<? OR (created_at_ms=? AND id<?))' : ''} ORDER BY created_at_ms DESC,id DESC LIMIT 101`,
        [owner, ...scope, ...(boundary ? [boundary[0], boundary[0], boundary[1]] : [])]);
        const page = rows.slice(0, 100), last = page.at(-1);
        return { items: page.map(historyDto), nextCursor: rows.length > 100 ? Buffer.from(JSON.stringify([Number(last.created_at_ms), last.id])).toString('base64url') : null };
    }
    async function getStatus(actor) {
        const owner = user(actor);
        const permanent = async () => {
            // Preserve the standalone unconfigured financial API contract.
            // Without a database, omit unknown holdings rather than invent 0.
            if(typeof db.queryDatabase!=='function') return undefined;
            const held=await require('./push-support-grants').getSupporterHolding(db.queryDatabase,owner,now(),{configured:c.configured,environment:c.environment,merchantId:c.merchantId});
            return { totalSupporterSlots:held.totalSupporterSlots,legacySlots:held.legacySlots,newPaidSlots:held.newPaidSlots,isSupporter:held.isSupporter };
        };
        if (!c.configured) return { configured: false, environment: c.environment, history: [], historyNextCursor: null, pending: null,
            supporter: { ...await donationGrant(db.queryDatabase, owner, null, [], now()), manualActive: false }, permanentSupport:await permanent() };
        const refresh = await reconcileOwner(owner);
        const supporter = await db.withDatabaseTransaction(async query => { await lockOwner(query, owner); return recomputeSupporter(query, owner); });
        const history = await getHistory(actor);
        const pending = (await db.queryDatabase(`SELECT * FROM automation_square_donation_attempts WHERE owner_user_id=? AND environment=? AND merchant_id=? AND state IN ('SUBMITTING','UNKNOWN','APPROVED','PENDING') ORDER BY created_at_ms,id LIMIT 1`, [owner, ...scope]))[0];
        const manual = (await db.queryDatabase('SELECT is_donor FROM users WHERE user_id=?', [owner]))[0];
        return { configured: true, environment: c.environment, history: history.items, historyNextCursor: history.nextCursor, pending: pending ? { ...quoteDto(pending), state: pending.state, retryable: false } : null,
            supporter: { ...supporter, manualActive: Number(manual?.is_donor) === 1 }, permanentSupport:await permanent(), refresh };
    }
    async function getAttempt(actor, attemptId) {
        const owner = user(actor); requireConfigured(); await loadAttempt(attemptId, owner); await reconcileOwner(owner);
        const row = await loadAttempt(attemptId, owner); return { ...historyDto(row), quote: quoteDto(row) };
    }
    async function donate(actor, input) {
        const owner = user(actor); requireConfigured();
        if (input?.consent !== true) throw fail('SQUARE_CONSENT_REQUIRED', '表示された金額の寄付に同意してください。');
        if (!NONCE.test(input?.sourceId || '')) throw fail('SQUARE_DONATION_SOURCE_INVALID', 'Squareのカード入力から決済情報を作成してください。');
        let row = await loadAttempt(input.attemptId, owner);
        if (TERMINAL.has(row.state)) return getStatus(actor);
        const token = randomUUID(), sourceDigest = createHash('sha256').update(input.sourceId).digest('hex');
        await location();
        await db.withDatabaseTransaction(async query => {
            await lockOwner(query, owner); row = await loadAttempt(input.attemptId, owner, query);
            if (TERMINAL.has(row.state)) return;
            if (row.lease_token && Number(row.lease_until_at_ms) > now()) throw fail('SQUARE_DONATION_BUSY', '寄付を処理しています。決済状況を再確認してください。', 409);
            if (row.state !== 'QUOTED') throw fail('SQUARE_DONATION_PENDING', '前回の決済結果を確認してください。再送信による重複決済は行いません。', 409);
            if (Number(row.expires_at_ms) <= now()) throw fail('SQUARE_DONATION_QUOTE_EXPIRED', '申し込み内容の有効期限が切れました。内容を再確認してください。', 409);
            const p = policyDto(await readPolicy(query, true));
            if (!p.enabled || p.updatedAtMs !== Number(row.policy_updated_at_ms) || p.currency !== row.currency) throw fail('SQUARE_DONATION_QUOTE_CHANGED', '寄付の設定が変更されました。申し込み内容を再確認してください。', 409);
            const other = await query(`SELECT id FROM automation_square_donation_attempts WHERE owner_user_id=? AND environment=? AND merchant_id=? AND id<>? AND state IN ('SUBMITTING','UNKNOWN','APPROVED','PENDING') LIMIT 1`, [owner, ...scope, row.id]);
            if (other.length) throw fail('SQUARE_DONATION_PENDING', '前回の寄付の決済結果を先に確認してください。', 409);
            await query(`UPDATE automation_square_donation_attempts SET state='SUBMITTING',source_digest=?,lease_token=?,lease_until_at_ms=?,updated_at_ms=? WHERE id=?`, [sourceDigest, token, now() + LEASE_MS, now(), row.id]);
        });
        if (TERMINAL.has(row.state)) return getStatus(actor);
        let paymentAcknowledged = false;
        try {
            const data = await request('POST', '/v2/payments', { idempotency_key: row.id, source_id: input.sourceId, amount_money: { amount: Number(row.amount), currency: row.currency },
                location_id: row.location_id, autocomplete: true, reference_id: row.id, buyer_email_address: row.email, note: 'ComebackTwitterEmbed voluntary support' });
            paymentAcknowledged = true;
            // The returned ID helps recovery, but only a subsequent REST read
            // with every bound field verified can count toward supporter status.
            if (!ID.test(data.payment?.id || '')) throw mismatch();
            await db.queryDatabase('UPDATE automation_square_donation_attempts SET payment_id=?,updated_at_ms=? WHERE id=? AND lease_token=?', [data.payment.id, now(), row.id, token]);
            const payment = (await request('GET', `/v2/payments/${encodeURIComponent(data.payment.id)}`)).payment;
            const observation = await observePayment(row, payment);
            await db.withDatabaseTransaction(async query => { await lockOwner(query, owner); await applyObservation(query, await loadAttempt(row.id, owner, query), observation); });
        } catch (error) {
            // Any failure after a possible wire write is unresolved. A later
            // attempt is blocked, even after restart, until REST/webhook recovery.
            const knownRejected = !paymentAcknowledged && error.code === 'SQUARE_REQUEST_FAILED' && !error.uncertain;
            await db.queryDatabase(`UPDATE automation_square_donation_attempts SET state=?,updated_at_ms=? WHERE id=? AND lease_token=? AND state='SUBMITTING'`, [knownRejected ? 'FAILED' : 'UNKNOWN', now(), row.id, token]);
            throw error;
        } finally { await db.queryDatabase('UPDATE automation_square_donation_attempts SET lease_token=NULL,lease_until_at_ms=NULL WHERE id=? AND lease_token=?', [row.id, token]); }
        return getStatus(actor);
    }
    // Internal method: the sole raw Webhook endpoint authenticates the exact
    // bytes and dedicated app URL before calling this inside its event ledger.
    async function handleVerifiedWebhook(event, query) {
        let paymentId;
        if (event.type.startsWith('payment.')) paymentId = event.data?.object?.payment?.id || event.data?.id;
        else if (event.type.startsWith('refund.')) {
            const refundId = event.data?.object?.refund?.id || event.data?.id;
            if (!ID.test(refundId || '')) throw fail('SQUARE_WEBHOOK_INVALID', '返金の通知を確認できません。', 400);
            const { refund } = await request('GET', `/v2/refunds/${encodeURIComponent(refundId)}`);
            if (!refund || refund.id !== refundId) throw mismatch();
            if (refund.location_id !== c.locationId) return;
            paymentId = refund.payment_id;
        }
        if (!ID.test(paymentId || '')) throw fail('SQUARE_WEBHOOK_INVALID', '決済の通知を確認できません。', 400);
        const { payment } = await request('GET', `/v2/payments/${encodeURIComponent(paymentId)}`);
        // Unrelated subscription payments or another project's payments are
        // acknowledged without importing them into this donation ledger.
        if (!payment || !UUID.test(payment.reference_id || '')) return;
        const row = (await query('SELECT * FROM automation_square_donation_attempts WHERE id=? AND environment=? AND merchant_id=?', [payment.reference_id, ...scope]))[0];
        if (!row) return;
        await lockOwner(query, row.owner_user_id); const current = await loadAttempt(row.id, row.owner_user_id, query);
        if (current.state === 'QUOTED') throw mismatch();
        await applyObservation(query, current, await observePayment(current, payment));
    }
    return { getOptions, getStatus, getHistory, getAdmin, savePolicy, createQuote, donate, getAttempt, handleVerifiedWebhook };
}

module.exports = { createSquareDonations, isSquareDonationSupporter, getSquareDonationGrant };

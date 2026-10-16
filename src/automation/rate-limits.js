'use strict';

const { createHash, randomUUID } = require('node:crypto');
const WINDOWS = { minute: 60000, hour: 3600000, day: 86400000 };
const DEFAULT_POLICY = Object.freeze({
    version: 2,
    notifications: { slot: { minute: 5, day: 24 }, dayZone: 'Asia/Tokyo', unit: 'message' },
    operations: { write: { minute: 30, hour: 240 }, monitor: { minute: 10, hour: 120 }, publication: { minute: 2, hour: 5 }, validate: { minute: 120, hour: 3600 }, simulate: { minute: 12, hour: 240 } },
});
const LABELS = { slot: 'この通知登録', write: 'ルールの編集', monitor: '通知の登録・変更', publication: '公開・申請', validate: 'ルールの検証', simulate: 'ルールの試行' };
const validId = value => typeof value === 'string' && /^\d{1,32}$/.test(value);

class AutomationRateError extends Error {
    constructor(code, message, status, details = {}) {
        super(message); this.name = 'AutomationError'; this.code = code; this.status = status;
        Object.assign(this, details);
    }
}
function unavailable() {
    return new AutomationRateError('AUTOMATION_RATE_LIMIT_UNAVAILABLE', '利用制限を確認できませんでした。少し待ってから再度お試しください。', 503, { retryAfterMs: 60000 });
}
function getPolicy(overrides = {}) {
    const policy = structuredClone(DEFAULT_POLICY);
    for (const scope of Object.keys(policy.operations)) {
        for (const window of ['minute', 'hour']) {
            const value = overrides.operations?.[scope]?.[window];
            if (value === undefined) continue;
            if (!Number.isInteger(value) || value < 1 || value > 100000) throw new TypeError('Invalid server automation rate policy');
            policy.operations[scope][window] = value;
        }
    }
    return policy;
}
function createRateLimiter(db, options = {}) {
    const clock = options.clock || Date.now, policy = getPolicy(options.policy);
    let nextSweep = 0;
    function specs(category, scope, id) {
        return Object.entries(policy[category][scope]).map(([window, limit]) => ({
            key: createHash('sha256').update(`automation:rate:v1:${category}:${scope}:${id}:${window}`).digest('hex'),
            scope, window, windowMs: WINDOWS[window], limit,
        }));
    }
    async function consume(budgets, count, path, principal = null, job = null) {
        if (!Number.isInteger(count) || count < 1 || count > 128) throw new AutomationRateError('AUTOMATION_DELIVERY_SIZE_LIMIT', '通知に含まれるメッセージ数が不正です。', 400, { issues: [{ path, code: 'notification_batch_limit', message: '通知のメッセージ数を減らしてください。' }] });
        const tooLarge = budgets.find(budget => (budget.cost ?? count) > budget.limit);
        if (tooLarge) {
            const message = `1つの通知登録からの通知は1回に最大${tooLarge.limit}通です。内容を短くするか、まとめて通知してください。`;
            throw new AutomationRateError('AUTOMATION_DELIVERY_SIZE_LIMIT', message, 400, { limit: tooLarge.limit, windowMs: tooLarge.windowMs, issues: [{ path, code: 'notification_batch_limit', message }] });
        }
        if (typeof db?.withDatabaseTransaction !== 'function') throw unavailable();
        try {
            if (principal && typeof db.queryDatabase === 'function' && clock() >= nextSweep) {
                await db.queryDatabase('DELETE FROM automation_rate_reservations WHERE expires_at_ms<=? LIMIT 100', [clock()]);
                nextSweep = clock() + 60000;
            }
            return await db.withDatabaseTransaction(async query => {
                const locked = [];
                // Keys do not contain a workflow, destination UUID, revision or
                // window start. Locks always use the same order across workers.
                for (const budget of [...budgets].sort((a, b) => a.key.localeCompare(b.key))) {
                    // A no-op upsert takes the exclusive lock directly. INSERT
                    // IGNORE would take a shared duplicate lock and concurrent
                    // SELECT FOR UPDATE upgrades could deadlock unnecessarily.
                    await query('INSERT INTO automation_counters (counter_key,used_count,expires_at_ms) VALUES (?,0,0) ON DUPLICATE KEY UPDATE counter_key=VALUES(counter_key)', [budget.key]);
                    const rows = await query('SELECT used_count,expires_at_ms FROM automation_counters WHERE counter_key=? FOR UPDATE', [budget.key]);
                    if (rows.length !== 1 || !Number.isSafeInteger(Number(rows[0].used_count)) || !Number.isSafeInteger(Number(rows[0].expires_at_ms))) throw unavailable();
                    locked.push({ ...budget, used: Number(rows[0].used_count), expiresAtMs: Number(rows[0].expires_at_ms) });
                }
                const now = clock();
                if (!Number.isSafeInteger(now) || now < 0) throw unavailable();
                const denied = locked.filter(budget => budget.expiresAtMs > now && budget.used + (budget.cost ?? count) > budget.limit);
                if (denied.length) {
                    const budget = denied.reduce((latest, item) => item.expiresAtMs > latest.expiresAtMs ? item : latest);
                    const retryAfterMs = Math.max(1, budget.expiresAtMs - now);
                    const period = budget.window === 'minute' ? '1分' : budget.window === 'day' ? '1日（日本時間0時更新）' : '1時間';
                    const message = `${LABELS[budget.scope]}は${period}に${budget.limit}${principal ? '通' : '件'}までです。${Math.ceil(retryAfterMs / 1000)}秒後に再度お試しください。`;
                    // Throwing rolls back every insertion/update. A minute
                    // rejection must not spend any daily allowance.
                    throw new AutomationRateError('AUTOMATION_RATE_LIMITED', message, 429, {
                        retryAfterMs, limit: budget.limit, windowMs: budget.windowMs, scope: budget.scope,
                        issues: [{ path, code: 'rate_limit', message }],
                    });
                }
                let expiresAtMs = Infinity;
                const counters = [];
                for (const budget of locked) {
                    const expired = budget.expiresAtMs <= now;
                    const until = expired ? budget.window === 'day' ? (Math.floor((now + 9 * 3600000) / WINDOWS.day) + 1) * WINDOWS.day - 9 * 3600000 : now + budget.windowMs : budget.expiresAtMs;
                    const charge = budget.cost ?? count;
                    await query('UPDATE automation_counters SET used_count=?,expires_at_ms=? WHERE counter_key=?', [expired ? charge : budget.used + charge, until, budget.key]);
                    expiresAtMs = Math.min(expiresAtMs, until);
                    counters.push({ key: budget.key, expiresAtMs: until, slotId: budget.slotId });
                }
                if (!principal) return { count, createdAtMs: now, expiresAtMs };
                if (job) {
                    if (!/^[a-f0-9-]{36}$/.test(job.id || '') || !/^[a-f0-9-]{36}$/.test(job.lease_token || '')) throw unavailable();
                    // All reservation/recovery paths lock counters before the
                    // attempt's job and reservation rows. Old workers cannot
                    // reserve against a replacement lease after restart.
                    const current = (await query('SELECT state,lease_token,lease_until_ms FROM automation_jobs WHERE id=? FOR UPDATE', [job.id]))[0];
                    if (!current || current.lease_token !== job.lease_token || !['leased', 'sending'].includes(current.state) || Number(current.lease_until_ms) <= now) throw unavailable();
                }
                const principals = Array.isArray(principal) ? principal : [principal];
                const reservations = [];
                // Counter increments hold capacity, not successful-send usage.
                // Each ACK commits one held part; known unsent parts refund it.
                for (const member of principals) {
                    const id = randomUUID(), memberCounters = counters.filter(counter => counter.slotId === member.slotId);
                    const parts = Array.from({ length: count }, (_part, index) => member.partIndices.includes(index) ? 'reserved' : 'unused');
                    await query('INSERT INTO automation_rate_reservations (id,owner_user_id,slot_id,job_id,lease_token,counters_json,parts_json,created_at_ms,expires_at_ms) VALUES (?,?,?,?,?,?,?,?,?)',
                        [id, member.ownerUserId, member.slotId, job?.id || null, job?.lease_token || null, JSON.stringify(memberCounters), JSON.stringify(parts), now, Math.max(...memberCounters.map(counter => counter.expiresAtMs)) + WINDOWS.day]);
                    reservations.push({ id, slotId: member.slotId, count, expiresAtMs: Math.min(...memberCounters.map(counter => counter.expiresAtMs)) });
                }
                return { id: reservations[0].id, reservations, count, createdAtMs: now, expiresAtMs };
            });
        } catch (error) {
            if (error instanceof AutomationRateError) throw error;
            // Never expose SQL errors, connection details or resource IDs.
            throw unavailable();
        }
    }
    async function settle(reservation, index, outcome) {
        if (!reservation?.id || !/^[a-f0-9-]{36}$/.test(reservation.id) || index != null && (!Number.isInteger(index) || index < 0 || index >= reservation.count)) throw unavailable();
        try {
            return await db.withDatabaseTransaction(async query => {
                const identities = reservation.reservations || [{ id: reservation.id }];
                const snapshots = [];
                for (const identity of identities) {
                    const row = (await query('SELECT counters_json FROM automation_rate_reservations WHERE id=?', [identity.id]))[0];
                    if (!row) throw unavailable();
                    snapshots.push({ id: identity.id, counters: JSON.parse(row.counters_json) });
                }
                const counters = [...new Map(snapshots.flatMap(snapshot => snapshot.counters).map(counter => [counter.key, counter])).values()];
                const locked = new Map();
                // Lock counters before the reservation, matching reservation
                // creation and every other settlement's ordering.
                for (const counter of counters.sort((a, b) => a.key.localeCompare(b.key))) {
                    const row = (await query('SELECT used_count,expires_at_ms FROM automation_counters WHERE counter_key=? FOR UPDATE', [counter.key]))[0];
                    if (!row) throw unavailable();
                    locked.set(counter.key, row);
                }
                for (const snapshot of snapshots.sort((a, b) => a.id.localeCompare(b.id))) {
                    const row = (await query('SELECT parts_json FROM automation_rate_reservations WHERE id=? FOR UPDATE', [snapshot.id]))[0];
                    if (!row) throw unavailable();
                    const parts = JSON.parse(row.parts_json);
                    if (index != null && parts[index] === 'unused') continue;
                    if (outcome === 'submitting' && parts[index] !== 'reserved') throw unavailable();
                    const indices = index == null ? parts.map((_part, item) => item) : [index];
                    let refund = 0;
                    for (const item of indices) {
                        if (parts[item] !== 'reserved' && !(index != null && parts[item] === 'submitting')) continue;
                        parts[item] = outcome;
                        if (outcome === 'released') refund++;
                    }
                    if (refund) for (const counter of snapshot.counters) {
                        const current = locked.get(counter.key);
                        // Never subtract from a new minute/day after rollover.
                        if (Number(current.expires_at_ms) === counter.expiresAtMs) await query('UPDATE automation_counters SET used_count=GREATEST(0,used_count-?) WHERE counter_key=?', [refund, counter.key]);
                    }
                    await query('UPDATE automation_rate_reservations SET parts_json=? WHERE id=?', [JSON.stringify(parts), snapshot.id]);
                }
            });
        } catch (error) { if (error instanceof AutomationRateError) throw error; throw unavailable(); }
    }
    function notificationPrincipal(principal) {
        if (!validId(principal?.ownerUserId) || principal.slotId !== `${principal.ownerUserId}:${principal.slotIndex}` || !Number.isInteger(principal.slotIndex) || principal.slotIndex < 1 || !Number.isInteger(principal.minuteLimit) || principal.minuteLimit < 1 || !Number.isInteger(principal.dayLimit) || principal.dayLimit < 1) throw unavailable();
        return principal;
    }
    function reserveNotificationBatch(principals, count, payloadSlots = null, job = null) {
        if (!Number.isInteger(count) || count < 1 || count > 128) return consume([], count, 'notification.messages');
        if (!Array.isArray(principals) || !principals.length || principals.length > 10000) throw unavailable();
        const supplied = [...new Map(principals.map(principal => { notificationPrincipal(principal); return [principal.slotId, principal]; })).values()];
        const known = new Set(supplied.map(principal => principal.slotId));
        if (payloadSlots && (!Array.isArray(payloadSlots) || payloadSlots.length !== count || payloadSlots.some(ids => !Array.isArray(ids) || !ids.length || ids.some(id => !known.has(id))))) throw unavailable();
        const unique = supplied.map(principal => ({ ...principal, partIndices: Array.from({ length: count }, (_part, index) => index).filter(index => !payloadSlots || payloadSlots[index].includes(principal.slotId)) })).filter(principal => principal.partIndices.length);
        if (!unique.length) throw unavailable();
        const budgets = unique.flatMap(principal => [['minute', principal.minuteLimit], ['day', principal.dayLimit]].map(([window, limit]) => ({
            key: createHash('sha256').update(`automation:rate:v2:slot:${principal.slotId}:${window}`).digest('hex'),
            slotId: principal.slotId, scope: 'slot', window, windowMs: WINDOWS[window], limit, cost: principal.partIndices.length,
        })));
        return consume(budgets, count, 'notification.messages', unique, job);
    }
    async function recoverOrphanedReservations() {
        try {
            const now = clock();
            const candidates = await db.queryDatabase(`SELECT r.id,r.job_id,r.counters_json FROM automation_rate_reservations r
                LEFT JOIN automation_jobs j ON j.id=r.job_id WHERE r.job_id IS NOT NULL AND r.lease_token IS NOT NULL
                AND r.expires_at_ms>? AND r.parts_json LIKE '%reserved%'
                AND (j.id IS NULL OR j.lease_token IS NULL OR j.lease_token<>r.lease_token OR j.state NOT IN ('leased','sending') OR j.lease_until_ms<=?)
                ORDER BY r.created_at_ms,r.id LIMIT 100`, [now, now]);
            for (const candidate of candidates) await db.withDatabaseTransaction(async query => {
                const counters = JSON.parse(candidate.counters_json).sort((a, b) => a.key.localeCompare(b.key));
                const locked = new Map();
                for (const counter of counters) locked.set(counter.key, (await query('SELECT used_count,expires_at_ms FROM automation_counters WHERE counter_key=? FOR UPDATE', [counter.key]))[0]);
                const job = (await query('SELECT state,lease_token,lease_until_ms FROM automation_jobs WHERE id=? FOR UPDATE', [candidate.job_id]))[0];
                const row = (await query('SELECT lease_token,parts_json FROM automation_rate_reservations WHERE id=? FOR UPDATE', [candidate.id]))[0];
                if (!row || job && job.lease_token === row.lease_token && ['leased', 'sending'].includes(job.state) && Number(job.lease_until_ms) > clock()) return;
                const parts = JSON.parse(row.parts_json), refund = parts.filter(part => part === 'reserved').length;
                // submitting may have reached Discord. It and committed/unknown
                // parts remain charged, even if no local ACK survived.
                if (!refund) return;
                for (const counter of counters) if (Number(locked.get(counter.key)?.expires_at_ms) === counter.expiresAtMs) await query('UPDATE automation_counters SET used_count=GREATEST(0,used_count-?) WHERE counter_key=?', [refund, counter.key]);
                await query('UPDATE automation_rate_reservations SET parts_json=? WHERE id=?', [JSON.stringify(parts.map(part => part === 'reserved' ? 'released' : part)), candidate.id]);
            });
            return candidates.length;
        } catch (error) { if (error instanceof AutomationRateError) throw error; throw unavailable(); }
    }
    return {
        recoverOrphanedReservations,
        getPolicy: () => structuredClone(policy),
        consumeOperation(actor, group = 'write') {
            if (!validId(actor?.userId)) throw new AutomationRateError('AUTH_REQUIRED', 'ログインが必要です。', 401);
            if (!Object.hasOwn(policy.operations, group)) throw new TypeError('Unknown server automation operation group');
            return consume(specs('operations', group, actor.userId), 1, 'request');
        },
        reserveNotifications(principal, count, job = null) {
            return reserveNotificationBatch([principal], count, null, job);
        },
        reserveNotificationBatch,
        commitNotification: (reservation, index) => settle(reservation, index, 'committed'),
        beginNotification: (reservation, index) => settle(reservation, index, 'submitting'),
        retainUnknownNotification: (reservation, index) => settle(reservation, index, 'unknown'),
        releaseNotifications: (reservation, index = null) => settle(reservation, index, 'released'),
        async getSlotUsage(slotId, quota = {}) {
            if (!/^\d{1,32}:\d{1,6}$/.test(slotId || '')) throw unavailable();
            const now = clock(), key = createHash('sha256').update(`automation:rate:v2:slot:${slotId}:day`).digest('hex');
            try {
                return await db.withDatabaseTransaction(async query => {
                    const row = (await query('SELECT used_count,expires_at_ms FROM automation_counters WHERE counter_key=?', [key]))[0];
                    const resetAtMs = row && Number(row.expires_at_ms) > now ? Number(row.expires_at_ms) : (Math.floor((now + 9 * 3600000) / WINDOWS.day) + 1) * WINDOWS.day - 9 * 3600000;
                    const used = row && Number(row.expires_at_ms) > now ? Number(row.used_count) : 0;
                    const holds = await query('SELECT counters_json,parts_json FROM automation_rate_reservations WHERE slot_id=? AND expires_at_ms>?', [slotId, now]);
                    let todayReserved = 0;
                    for (const hold of holds) {
                        if (!JSON.parse(hold.counters_json).some(counter => counter.key === key && counter.expiresAtMs === resetAtMs)) continue;
                        todayReserved += JSON.parse(hold.parts_json).filter(part => ['reserved', 'submitting', 'unknown'].includes(part)).length;
                    }
                    return { slotId, todayUsed: Math.max(0, used - todayReserved), todayReserved, dayLimit: quota.dayLimit || 24, minuteLimit: quota.minuteLimit || 5, resetAtMs };
                });
            } catch (error) { if (error instanceof AutomationRateError) throw error; throw unavailable(); }
        },
    };
}

module.exports = { createRateLimiter, getPolicy, AutomationRateError };

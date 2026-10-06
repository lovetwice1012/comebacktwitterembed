'use strict';
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 10080;
const MINUTE = 60000;
function invalid(message) { return Object.assign(new Error(message), { code: 'AUTO_WATCH_INVALID_INTERVAL', status: 400 }); }
function userId(value) {
    if (typeof value !== 'string' || !/^\d{1,32}$/.test(value)) throw invalid('利用者IDを文字列で指定してください。');
    return value;
}
function intervalMinutes(value) {
    if (value === null) return null;
    if (!Number.isSafeInteger(value) || value < MIN_INTERVAL_MINUTES || value > MAX_INTERVAL_MINUTES) {
        throw invalid(`間隔は${MIN_INTERVAL_MINUTES}〜${MAX_INTERVAL_MINUTES}分の整数、または通常値へのリセットを指定してください。`);
    }
    return value;
}
async function bringSourceForward(query, id, sourceId, now) {
    await query(`UPDATE auto_watch_sources s SET next_check_at_ms=LEAST(next_check_at_ms,
        IF(last_checked_at_ms>0,last_checked_at_ms,?)+(SELECT COALESCE(auto_watch_interval_minutes*60000,s.poll_interval_ms) FROM users WHERE user_id=?)) WHERE s.id=?`,
    [now, id, sourceId]);
}
function createPolicy(db = require('../../db')) {
    async function get(id) {
        id = userId(id);
        const rows = await db.queryDatabase('SELECT auto_watch_interval_minutes FROM users WHERE user_id=?', [id]);
        const configured = rows[0]?.auto_watch_interval_minutes == null ? null : Number(rows[0].auto_watch_interval_minutes);
        return { userId: id, intervalMinutes: configured, minimumMinutes: MIN_INTERVAL_MINUTES,
            providers: Object.values(require('./index').PROVIDERS).map(provider => ({ providerId: provider.id,
                defaultMinutes: provider.defaultPollMs / MINUTE, intervalMinutes: configured ?? provider.defaultPollMs / MINUTE })) };
    }
    async function set(id, minutes, actorId, now = Date.now()) {
        id = userId(id); actorId = userId(actorId); minutes = intervalMinutes(minutes);
        await db.withDatabaseTransaction(async query => {
            await query('INSERT INTO users (user_id,registered_at_ms) VALUES (?,?) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id)', [id, now]);
            const before = (await query('SELECT auto_watch_interval_minutes FROM users WHERE user_id=? FOR UPDATE', [id]))[0];
            await query('UPDATE users SET auto_watch_interval_minutes=? WHERE user_id=?', [minutes, id]);
            const sources = await query('SELECT DISTINCT source_id FROM auto_watch_targets WHERE user_id=? AND enabled=1 ORDER BY source_id', [id]);
            for (const source of sources) await query('SELECT id FROM auto_watch_sources WHERE id=? FOR UPDATE', [source.source_id]);
            await query(`UPDATE auto_watch_targets t JOIN auto_watch_sources s ON s.id=t.source_id
                SET t.next_poll_at_ms=COALESCE(t.last_polled_at_ms,NULLIF(s.last_checked_at_ms,0),?)+COALESCE(?*60000,s.poll_interval_ms)
                WHERE t.user_id=? AND t.enabled=1`, [now, minutes, id]);
            await query(`UPDATE auto_watch_deliveries d JOIN auto_watch_targets t ON t.id=d.target_id
                JOIN auto_watch_items i ON i.id=d.item_id JOIN auto_watch_sources s ON s.id=t.source_id
                SET d.next_attempt_at_ms=GREATEST(i.discovered_at_ms,COALESCE(t.next_poll_at_ms,?),
                    COALESCE(t.last_notification_window_at_ms,0)+COALESCE(?*60000,s.poll_interval_ms))
                WHERE t.user_id=? AND t.enabled=1 AND d.status='pending' AND d.attempt_count=0 AND d.lease_expires_at_ms<=?`, [now, minutes, id, now]);
            // Lowering a user's interval brings its sources forward. Raising it
            // is picked up by the next shared check without postponing peers.
            await query(`UPDATE auto_watch_sources s JOIN auto_watch_targets t ON t.source_id=s.id
                SET s.next_check_at_ms=LEAST(s.next_check_at_ms,COALESCE(t.next_poll_at_ms,?))
                WHERE t.user_id=? AND t.enabled=1`, [now, id]);
            await query('INSERT INTO auto_watch_user_interval_audits (user_id,actor_user_id,before_minutes,after_minutes,changed_at_ms) VALUES (?,?,?,?,?)',
                [id, actorId, before.auto_watch_interval_minutes, minutes, now]);
        });
        return get(id);
    }
    return { get, set };
}
module.exports = { MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES, intervalMinutes, createPolicy, bringSourceForward };

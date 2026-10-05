'use strict';
const model = require('./model');
const ACTIVE = "'watching','pending','preparing','sending'";
const LEASE_MS = 120000;

function createStore(db = require('../db')) {
    let lastCleanup = 0;
    async function owner(query, userId) {
        if (!/^\d{16,22}$/.test(String(userId))) throw model.error('INVALID_OWNER');
        await query('INSERT IGNORE INTO bot_personal_link_users (user_id) VALUES (?)', [userId]);
        await query('SELECT user_id FROM bot_personal_link_users WHERE user_id=? FOR UPDATE', [userId]);
    }
    async function save(userId, entry, details = {}) {
        const tagList = model.tags(details.tags);
        if (String(details.note || '').length > 1000) throw model.error('NOTE_TOO_LONG');
        return db.withDatabaseTransaction(async query => {
            await owner(query, userId);
            const existing = await query('SELECT * FROM bot_saved_links WHERE user_id=? AND content_key=?', [userId, entry.contentKey]);
            if (existing[0]) {
                // A quick save can win the lock before a simultaneous save with
                // notes/tags. Apply only explicitly supplied details; a repeated
                // button click must never erase the owner's existing metadata.
                const hasTags = details.tags !== undefined && details.tags !== null;
                const hasNote = details.note !== undefined && details.note !== null;
                if (hasTags || hasNote) {
                    await query(`UPDATE bot_saved_links SET tags_json=IF(?,?,tags_json),note=IF(?,?,note),updated_at_ms=?
                        WHERE user_id=? AND id=?`, [hasTags, JSON.stringify(tagList), hasNote, details.note || '', Date.now(), userId, existing[0].id]);
                    const updated = await query('SELECT * FROM bot_saved_links WHERE user_id=? AND id=?', [userId, existing[0].id]);
                    return { ...updated[0], already: true };
                }
                return { ...existing[0], already: true };
            }
            const [count] = await query('SELECT COUNT(*) AS total FROM bot_saved_links WHERE user_id=?', [userId]);
            if (Number(count.total) >= 1000) throw model.error('SAVED_LIMIT');
            const id = model.id(), now = Date.now();
            await query(`INSERT INTO bot_saved_links (id,user_id,content_key,provider_id,url,title,tags_json,note,created_at_ms,updated_at_ms)
                VALUES (?,?,?,?,?,?,?,?,?,?)`, [id, userId, entry.contentKey, entry.providerId, entry.url, entry.title, JSON.stringify(tagList), details.note || '', now, now]);
            return { id, url: entry.url, title: entry.title };
        });
    }
    async function getSaved(userId, id) { return (await db.queryDatabase('SELECT * FROM bot_saved_links WHERE user_id=? AND id=?', [userId, id]))[0] || null; }
    async function editSaved(userId, id, tags, note, options = {}) {
        if (String(note || '').length > 1000) throw model.error('NOTE_TOO_LONG');
        return db.withDatabaseTransaction(async query => {
            const rows = await query('SELECT * FROM bot_saved_links WHERE user_id=? AND id=? FOR UPDATE', [userId, id]);
            if (!rows[0]) throw model.error('NOT_FOUND');
            if (options.expectedUpdatedAt !== undefined && Number(rows[0].updated_at_ms) !== options.expectedUpdatedAt) throw model.error('EDIT_CONFLICT');
            const updated = Math.max(Date.now(), Number(rows[0].updated_at_ms) + 1);
            await query('UPDATE bot_saved_links SET title=?,tags_json=?,note=?,updated_at_ms=? WHERE user_id=? AND id=?',
                [options.title === undefined ? rows[0].title : String(options.title).slice(0, 512), JSON.stringify(model.tags(tags)), note || '', updated, userId, id]);
        });
    }
    async function listSaved(userId, { query = '', tag = '', page = 1, limit = 10 } = {}) {
        return db.queryDatabase(`SELECT * FROM bot_saved_links WHERE user_id=?
            AND (?='' OR LOCATE(LOWER(?),LOWER(CONCAT(title,' ',url,' ',note)))>0)
            AND (?='' OR JSON_CONTAINS(tags_json,?)) ORDER BY updated_at_ms DESC,id LIMIT ? OFFSET ?`,
        [userId, query, query, tag, JSON.stringify(tag), Math.min(11, Math.max(1, limit)), (Math.max(1, Math.min(100, Number(page) || 1)) - 1) * 10]);
    }
    async function deleteSaved(userId, id) {
        const result = await db.queryDatabase('DELETE FROM bot_saved_links WHERE user_id=? AND id=?', [userId, id]);
        if (!result.affectedRows) throw model.error('NOT_FOUND');
    }
    async function createNotification(userId, entry, options) {
        const now = Date.now();
        if (!options.requestKey || options.requestKey.length > 100) throw model.error('INVALID_REQUEST');
        const item = options.kind === 'restock' ? model.boothItem(entry.url) : null;
        const variant = String(options.variationId || '*');
        if (!/^(\*|\d{1,20})$/.test(variant)) throw model.error('INVALID_VARIATION');
        if (!item && (!Number.isSafeInteger(options.dueAtMs) || options.dueAtMs < now + 50000 || options.dueAtMs > now + 366 * 86400000)) throw model.error('TIME_OUT_OF_RANGE');
        return db.withDatabaseTransaction(async query => {
            await owner(query, userId);
            const request = await query('SELECT * FROM bot_link_notifications WHERE user_id=? AND request_key=?', [userId, options.requestKey]);
            if (request[0]) return { ...request[0], already: true };
            if (item) {
                const existing = await query(`SELECT * FROM bot_link_notifications WHERE user_id=? AND kind='restock' AND item_id=? AND variation_id=? AND status IN (${ACTIVE}) LIMIT 1`, [userId, item.itemId, variant]);
                if (existing[0]) return { ...existing[0], already: true };
            }
            const [count] = await query(`SELECT COUNT(*) AS total FROM bot_link_notifications WHERE user_id=? AND status IN (${ACTIVE})`, [userId]);
            if (Number(count.total) >= 100) throw model.error('NOTIFICATION_LIMIT');
            if (item) await query(`INSERT INTO bot_restock_sources (item_id,url,next_check_at_ms) VALUES (?,?,?)
                ON DUPLICATE KEY UPDATE next_check_at_ms=LEAST(next_check_at_ms,VALUES(next_check_at_ms))`, [item.itemId, item.url, now]);
            const id = model.id();
            const status = item ? 'watching' : 'pending';
            await query(`INSERT INTO bot_link_notifications
                (id,user_id,request_key,kind,url,title,locale,time_zone,due_at_ms,item_id,variation_id,variation_name,status,created_at_ms,updated_at_ms)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, userId, options.requestKey, item ? 'restock' : 'reminder', item?.url || entry.url,
                entry.title.slice(0, 512), String(options.locale || 'ja').slice(0, 16), String(options.timeZone || 'Asia/Tokyo').slice(0, 64),
                item ? 0 : options.dueAtMs, item?.itemId || null, variant, String(options.variationName || '').slice(0, 100), status, now, now]);
            return { id, status, due_at_ms: item ? 0 : options.dueAtMs };
        });
    }
    async function listNotifications(userId, kind, page = 1, limit = 10) {
        return db.queryDatabase('SELECT * FROM bot_link_notifications WHERE user_id=? AND kind=? ORDER BY created_at_ms DESC,id LIMIT ? OFFSET ?',
            [userId, kind, Math.min(11, Math.max(1, limit)), (Math.max(1, Math.min(1000, Number(page) || 1)) - 1) * 10]);
    }
    async function getNotification(userId, id, kind) {
        return (await db.queryDatabase('SELECT * FROM bot_link_notifications WHERE user_id=? AND id=? AND kind=? LIMIT 1', [userId, id, kind]))[0] || null;
    }
    async function updateNotification(userId, id, kind, changes, expectedUpdatedAt) {
        const now = Date.now(), entry = model.link(changes.url, changes.title);
        const item = kind === 'restock' ? model.boothItem(entry.url) : null;
        const variant = String(changes.variationId || '*');
        if (!/^(\*|\d{1,20})$/.test(variant)) throw model.error('INVALID_VARIATION');
        if (!item && (!Number.isSafeInteger(changes.dueAtMs) || changes.dueAtMs < now + 50000 || changes.dueAtMs > now + 366 * 86400000)) throw model.error('TIME_OUT_OF_RANGE');
        return db.withDatabaseTransaction(async query => {
            await owner(query, userId);
            const [current] = await query('SELECT * FROM bot_link_notifications WHERE user_id=? AND id=? AND kind=? FOR UPDATE', [userId, id, kind]);
            if (!current) throw model.error('NOT_FOUND');
            if (!['watching', 'pending', 'preparing'].includes(current.status)) throw model.error('NOT_EDITABLE');
            if (Number(current.updated_at_ms) !== expectedUpdatedAt) throw model.error('EDIT_CONFLICT');
            const changedTarget = item && (item.itemId !== current.item_id || variant !== current.variation_id);
            if (item) {
                const other = await query(`SELECT id FROM bot_link_notifications WHERE user_id=? AND item_id=? AND variation_id=? AND id<>? AND status IN (${ACTIVE}) LIMIT 1`, [userId, item.itemId, variant, id]);
                if (other.length) throw model.error('DUPLICATE_WATCH');
                await query(`INSERT INTO bot_restock_sources (item_id,url,next_check_at_ms) VALUES (?,?,?)
                    ON DUPLICATE KEY UPDATE next_check_at_ms=LEAST(next_check_at_ms,VALUES(next_check_at_ms))`, [item.itemId, item.url, now]);
            }
            await query(`UPDATE bot_link_notifications SET url=?,title=?,time_zone=?,due_at_ms=?,next_attempt_at_ms=0,item_id=?,variation_id=?,
                variation_name=?,last_stock_state=?,status=?,lease_token=NULL,lease_until_ms=0,attempts=0,last_error=NULL,updated_at_ms=? WHERE user_id=? AND id=?`,
            [item?.url || entry.url, entry.title, changes.timeZone || 'Asia/Tokyo', item ? changedTarget ? 0 : current.due_at_ms : changes.dueAtMs,
                item?.itemId || null, variant, changes.variationName || (changedTarget ? '' : current.variation_name), changedTarget ? null : current.last_stock_state,
                item && (changedTarget || current.status === 'watching') ? 'watching' : 'pending', Math.max(now, Number(current.updated_at_ms) + 1), userId, id]);
        });
    }
    async function cancel(userId, id, kind) {
        return db.withDatabaseTransaction(async query => {
            const rows = await query('SELECT status FROM bot_link_notifications WHERE id=? AND user_id=? AND kind=? FOR UPDATE', [id, userId, kind]);
            if (!rows[0]) throw model.error('NOT_FOUND');
            if (rows[0].status === 'sending') throw model.error('ALREADY_SENDING');
            if (['sent', 'unknown'].includes(rows[0].status)) throw model.error('ALREADY_FINISHED');
            await query("UPDATE bot_link_notifications SET status='cancelled',lease_token=NULL,lease_until_ms=0,updated_at_ms=? WHERE id=? AND user_id=?", [Date.now(), id, userId]);
        });
    }
    async function claim(now) {
        await db.queryDatabase("UPDATE bot_link_notifications SET status='unknown',last_error='DELIVERY_UNKNOWN',lease_token=NULL,lease_until_ms=0,updated_at_ms=? WHERE status='sending' AND lease_until_ms<=? LIMIT 100", [now, now]);
        await db.queryDatabase("UPDATE bot_link_notifications SET status='pending',lease_token=NULL,lease_until_ms=0 WHERE status='preparing' AND lease_until_ms<=? LIMIT 100", [now]);
        const rows = await db.queryDatabase("SELECT * FROM bot_link_notifications WHERE status='pending' AND due_at_ms<=? AND next_attempt_at_ms<=? ORDER BY due_at_ms,id LIMIT 1", [now, now]);
        if (!rows[0]) return null;
        const row = rows[0], token = model.id();
        const result = await db.queryDatabase("UPDATE bot_link_notifications SET status='preparing',lease_token=?,lease_until_ms=? WHERE id=? AND status='pending'", [token, now + LEASE_MS, row.id]);
        return result.affectedRows ? { ...row, lease_token: token } : null;
    }
    async function beginSend(job, now) {
        const result = await db.queryDatabase("UPDATE bot_link_notifications SET status='sending',lease_until_ms=?,updated_at_ms=? WHERE id=? AND status='preparing' AND lease_token=? AND lease_until_ms>?",
            [now + LEASE_MS, now, job.id, job.lease_token, now]);
        return result.affectedRows === 1;
    }
    async function finish(job, status, { code = null, next = 0, messageId = null } = {}) {
        await db.queryDatabase(`UPDATE bot_link_notifications SET status=?,last_error=?,next_attempt_at_ms=?,delivered_message_id=?,
            attempts=attempts+1,lease_token=NULL,lease_until_ms=0,updated_at_ms=? WHERE id=? AND lease_token=?`,
        [status, code, next, messageId, Date.now(), job.id, job.lease_token]);
    }
    async function claimSource(now) {
        const rows = await db.queryDatabase(`SELECT s.* FROM bot_restock_sources s WHERE next_check_at_ms<=? AND lease_until_ms<=?
            AND EXISTS (SELECT 1 FROM bot_link_notifications n WHERE n.item_id=s.item_id AND n.kind='restock' AND n.status='watching') ORDER BY next_check_at_ms,item_id LIMIT 1`, [now, now]);
        if (!rows[0]) return null;
        const source = rows[0], token = model.id();
        const result = await db.queryDatabase('UPDATE bot_restock_sources SET lease_token=?,lease_until_ms=? WHERE item_id=? AND lease_until_ms<=?', [token, now + LEASE_MS, source.item_id, now]);
        return result.affectedRows ? { ...source, lease_token: token } : null;
    }
    async function observe(source, stock, now) {
        return db.withDatabaseTransaction(async query => {
            const rows = await query('SELECT item_id FROM bot_restock_sources WHERE item_id=? AND lease_token=? AND lease_until_ms>? FOR UPDATE', [source.item_id, source.lease_token, now]);
            if (!rows[0]) return false;
            for (const variant of [{ id: '*', state: stock.state }, ...stock.variations]) {
                if (variant.state === 'unknown') continue;
                await query(`UPDATE bot_link_notifications SET
                    due_at_ms=IF(last_stock_state='sold_out' AND ?='available',?,due_at_ms),
                    status=IF(last_stock_state='sold_out' AND ?='available','pending',status),
                    last_stock_state=?,variation_name=COALESCE(NULLIF(?,''),variation_name),updated_at_ms=? WHERE kind='restock' AND item_id=? AND variation_id=? AND status='watching'`,
                [variant.state, now, variant.state, variant.state, variant.name || '', now, source.item_id, variant.id]);
            }
            await query('UPDATE bot_restock_sources SET state_json=?,next_check_at_ms=?,checked_at_ms=?,failure_count=0,last_error=NULL,lease_token=NULL,lease_until_ms=0 WHERE item_id=? AND lease_token=?',
                [JSON.stringify(stock), now + 30 * 60000, now, source.item_id, source.lease_token]);
            return true;
        });
    }
    async function postponeSource(source, next, code = null) {
        await db.queryDatabase('UPDATE bot_restock_sources SET next_check_at_ms=?,failure_count=failure_count+?,last_error=?,lease_token=NULL,lease_until_ms=0 WHERE item_id=? AND lease_token=?',
            [next, code ? 1 : 0, code, source.item_id, source.lease_token]);
    }
    async function saveCard(card, message) {
        await db.queryDatabase('INSERT INTO bot_link_cards (id,guild_id,channel_id,payload_json,expires_at_ms) VALUES (?,?,?,?,?)',
            [card.id, message.guildId || message.guild.id, message.channelId || message.channel.id, JSON.stringify(card), Date.now() + 30 * 86400000]);
        if (Date.now() - lastCleanup > 60000) {
            lastCleanup = Date.now();
            await db.queryDatabase('DELETE FROM bot_link_cards WHERE expires_at_ms<? LIMIT 500', [Date.now()]);
        }
    }
    async function bindCard(id, messageId) { await db.queryDatabase('UPDATE bot_link_cards SET message_id=? WHERE id=?', [messageId, id]); }
    async function getCard(id, guildId, channelId) {
        const rows = await db.queryDatabase('SELECT * FROM bot_link_cards WHERE id=? AND guild_id=? AND channel_id=? AND expires_at_ms>?', [id, guildId, channelId, Date.now()]);
        return rows[0] ? { ...JSON.parse(rows[0].payload_json), messageId: rows[0].message_id } : null;
    }
    return { save, getSaved, editSaved, listSaved, deleteSaved, createNotification, listNotifications, getNotification, updateNotification, cancel, claim, beginSend, finish,
        claimSource, observe, postponeSource, saveCard, bindCard, getCard };
}
let instance;
module.exports = { createStore, getStore: () => (instance ||= createStore()) };

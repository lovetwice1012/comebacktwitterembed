'use strict';

// Reconcile only a fully planned delete whose exact messages are all confirmed
// absent. This job never sends, edits, or deletes a Discord message.
const cards = require('./twitterGridCards');
const INTERVAL_MS = 5 * 60 * 1000, MIN_AGE_MS = 5 * 60 * 1000, PAGE_SIZE = 20, RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
let timer = null, initial = null, running = false, cursor = null;
function candidate(payload, journal) {
    const intent = journal?.payload;
    if (payload?.kind !== 'twitter-image-grid-v1' || intent?.version !== 1 || (intent.kind && intent.kind !== 'twitter-grid-legacy') || intent.action !== 'delete'
        || intent.galleryId !== payload.id || intent.lockId !== payload.lockId || intent.operationId !== journal.operationId
        || !Array.isArray(payload.messageIds) || !Array.isArray(payload.partSignatures)
        || !Number.isInteger(payload.totalParts) || payload.totalParts < 1 || payload.totalParts > 20
        || payload.completedParts !== payload.totalParts || payload.partsState && payload.partsState !== 'complete'
        || payload.messageIds.length !== payload.totalParts || payload.partSignatures.length !== payload.totalParts
        || new Set(payload.messageIds).size !== payload.totalParts || !Array.isArray(intent.steps) || !intent.steps.length || intent.steps.length > 20)
        return false;
    const covered = new Set();
    for (const step of intent.steps) {
        if (step.type !== 'delete' || !Number.isInteger(step.index) || step.index < 0 || step.index >= payload.totalParts
            || step.id !== payload.messageIds[step.index] || !/^[a-f0-9]{64}$/.test(step.before || '')
            || step.before !== payload.partSignatures[step.index] && !(step.index === 0 && payload.replacePhase === 'done')) return false;
        covered.add(step.index);
    }
    // A completed public replacement already removed its continuation
    // messages; reconciliation still verifies every original ID is absent.
    return (covered.size === payload.totalParts || payload.replacePhase === 'done')
        && covered.has(0) && intent.steps.at(-1).index === 0;
}
async function reconcile(entry, client, db = require('./db')) {
    if (!client?.guilds?.cache?.has?.(entry.guild_id)) return false;
    let channel;
    try { channel = await client.channels.fetch(entry.channel_id, { force: true }); } catch { return false; }
    if (!channel || String(channel.guildId || '') !== String(entry.guild_id) || !channel.messages?.fetch) return false;
    const scope = { galleryId: entry.gallery_id, guildId: entry.guild_id, channelId: entry.channel_id, messageId: entry.message_id };
    const confirmed = await cards.withGalleryLock(scope, async ({ query, payload, journal, lockId }) => {
        if (!candidate(payload, journal) || journal.operationId !== entry.operation_id || String(payload.messageIds[0]) !== String(scope.messageId)) return null;
        for (const id of payload.messageIds) {
            try { await channel.messages.fetch({ message: id, force: true }); return null; }
            catch (error) { if (Number(error?.code) !== 10008) return null; }
        }
        const rows = await query('SELECT gallery_id FROM bot_media_galleries FORCE INDEX (idx_media_galleries_locator) WHERE guild_id=? AND channel_id=? AND message_id=? AND provider_id=?',
            [scope.guildId, scope.channelId, scope.messageId, 'twitter']);
        if (rows.length > 25) return null;
        for (const id of rows.map(row => row.gallery_id).sort()) {
            const items = await query('SELECT provider_id,message_id,payload_json FROM bot_media_galleries WHERE gallery_id=? AND guild_id=? AND channel_id=? FOR UPDATE',
                [id, scope.guildId, scope.channelId]);
            if (!items[0] || items[0].provider_id !== 'twitter' || String(items[0].message_id) !== String(scope.messageId)) return null;
            let related; try { related = JSON.parse(items[0].payload_json); } catch { return null; }
            if (related.lockId !== lockId) continue;
            await query('UPDATE bot_media_galleries SET expires_at_ms=? WHERE gallery_id=?', [Date.now() + RETENTION_MS, id]);
        }
        return { lockId, operationId: journal.operationId };
    }, db);
    if (!confirmed) return false;
    await db.queryDatabaseIndependent('DELETE FROM bot_twitter_grid_action_intents WHERE gallery_id=? AND operation_id=?',
        [confirmed.lockId, confirmed.operationId]);
    return true;
}
async function sweep(client, db = require('./db'), now = Date.now()) {
    if (running) return 0;
    running = true;
    try {
        const params = [now - MIN_AGE_MS], position = cursor;
        let where = 'i.updated_at_ms<?';
        if (position) { where += ' AND (i.updated_at_ms>? OR (i.updated_at_ms=? AND i.gallery_id>?))'; params.push(position.time, position.time, position.id); }
        const rows = await db.queryDatabase(`SELECT i.gallery_id,i.guild_id,i.channel_id,i.message_id,i.operation_id,i.updated_at_ms
            FROM bot_twitter_grid_action_intents i WHERE ${where} ORDER BY i.updated_at_ms,i.gallery_id LIMIT ${PAGE_SIZE}`, params);
        if (!rows.length) { cursor = null; return 0; }
        const last = rows.at(-1); cursor = { time: Number(last.updated_at_ms), id: last.gallery_id };
        let count = 0;
        for (const row of rows) {
            try { if (await reconcile(row, client, db)) count++; }
            catch (error) { require('./errorTracking').recordError(error, { source: 'twitterGridDeletedCleanup' }); }
        }
        return count;
    } finally { running = false; }
}
function start(client) {
    if (timer) return;
    const run = () => { void sweep(client).catch(error => require('./errorTracking').recordError(error, { source: 'twitterGridDeletedCleanup' })); };
    initial = setTimeout(run, 30000); initial.unref?.();
    timer = setInterval(run, INTERVAL_MS); timer.unref?.();
}
function stop() { clearTimeout(initial); clearInterval(timer); initial = null; timer = null; cursor = null; }
module.exports = { start, stop, _internal: { candidate, reconcile, sweep } };

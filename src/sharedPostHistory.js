'use strict';

const { createHash } = require('node:crypto');
const { urlIdentity } = require('./providers/_url_identity');
const RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const pending = new Map();

function contentKey(providerId, steps, url) {
    // Provider canonical URLs resolve shortened links and preserve resource IDs
    // encoded in query parameters (for example YouTube's v=).
    const canonical = steps.find(step => step.analytics?.content?.contentUrl)?.analytics.content.contentUrl || url;
    if (!canonical || !providerId) return null;
    return createHash('sha256').update(urlIdentity(providerId, canonical)).digest('hex');
}

function addNotice(steps, link, language) {
    const text = String(language || 'ja').startsWith('ja')
        ? `-# このチャンネルで以前にも共有されています · [前の投稿を見る](${link})`
        : `-# Previously shared in this channel · [View earlier post](${link})`;
    const output = steps.map(step => ({ ...step }));
    const first = output.find(step => step.outputRole !== 'failure_notice' && (step.content || step.embeds?.length || step.files?.length));
    if (!first) return output;
    const content = [first.content, text].filter(Boolean).join('\n');
    if (content.length <= 2000) first.content = content;
    else output.push({ content: text, allowedMentions: { parse: [], repliedUser: false } });
    return output;
}

function createHistory(db = require('./db')) {
    let lastCleanup = 0;
    async function previous(message, key) {
        const guildId = message.guildId || message.guild?.id;
        const channelId = message.channelId || message.channel?.id;
        const rows = await db.queryDatabase(
            `SELECT source_message_id, link_message_id, response_message_id FROM bot_shared_posts
             WHERE guild_id=? AND channel_id=? AND content_key=? AND shared_at_ms>=?
             AND CAST(source_message_id AS UNSIGNED)<CAST(? AS UNSIGNED) LIMIT 1`,
            [guildId, channelId, key, Date.now() - RETENTION_MS, message.id]);
        const row = rows[0];
        if (!row || typeof message.channel?.messages?.fetch !== 'function') return null;
        // Do not advertise deleted messages. The bot reply remains useful when
        // the provider was configured to delete the original link-only post.
        for (const id of new Set([row.link_message_id, row.response_message_id])) {
            try {
                const found = await message.channel.messages.fetch({ message: id, force: true });
                if (found && String(found.channelId || found.channel?.id) === String(channelId)) {
                    return `https://discord.com/channels/${guildId}/${channelId}/${id}`;
                }
            } catch (error) {
                if (Number(error.code) !== 10008) return null;
            }
        }
        return null;
    }

    async function remember(message, key, result, contentStep) {
        const sent = result?.sent?.find(item => item.stepIndex === contentStep);
        if (!sent?.messageId) return;
        const deleted = result.postprocess?.some(item => item.operation === 'delete_source' && item.success === true);
        await db.queryDatabase(
            `INSERT INTO bot_shared_posts
             (guild_id,channel_id,content_key,source_message_id,link_message_id,response_message_id,shared_at_ms)
             VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE
             link_message_id=IF(CAST(VALUES(source_message_id) AS UNSIGNED)>CAST(source_message_id AS UNSIGNED),VALUES(link_message_id),link_message_id),
             response_message_id=IF(CAST(VALUES(source_message_id) AS UNSIGNED)>CAST(source_message_id AS UNSIGNED),VALUES(response_message_id),response_message_id),
             shared_at_ms=IF(CAST(VALUES(source_message_id) AS UNSIGNED)>CAST(source_message_id AS UNSIGNED),VALUES(shared_at_ms),shared_at_ms),
             source_message_id=IF(CAST(VALUES(source_message_id) AS UNSIGNED)>CAST(source_message_id AS UNSIGNED),VALUES(source_message_id),source_message_id)`,
            [message.guildId || message.guild.id, message.channelId || message.channel.id, key, message.id,
                deleted ? sent.messageId : message.id, sent.messageId, Date.now()]);
        if (Date.now() - lastCleanup > 60000) {
            lastCleanup = Date.now();
            await db.queryDatabase('DELETE FROM bot_shared_posts WHERE shared_at_ms<? LIMIT 500', [Date.now() - RETENTION_MS]);
        }
    }

    async function run(message, steps, context, send) {
        if (!context.sharedHistory || context.presentationSettings?.show_previous_shares === false || !message.id || !(message.guildId || message.guild?.id)
            || steps.some(step => step.outputRole === 'failure_notice')) return send(steps);
        const index = steps.findIndex(step => step.content || step.embeds?.length || step.files?.length);
        const key = contentKey(context.providerId, steps, context.url);
        if (index < 0 || !key) return send(steps);
        const lockKey = `${message.guildId || message.guild.id}:${message.channelId || message.channel.id}:${key}`;
        const prior = pending.get(lockKey) || Promise.resolve();
        let unlock = () => {};
        /** @type {Promise<void>} */
        const tail = new Promise(resolve => { unlock = resolve; });
        pending.set(lockKey, tail);
        await prior;
        try {
            let prepared = steps;
            try {
                const link = await previous(message, key);
                if (link) prepared = addNotice(steps, link, context.presentationSettings?.defaultLanguage);
            } catch (error) { report(error); }
            const result = await send(prepared);
            try { await remember(message, key, result, index); } catch (error) { report(error); }
            return result;
        } finally {
            unlock();
            if (pending.get(lockKey) === tail) pending.delete(lockKey);
        }
    }
    return { run, previous, remember };
}

function report(error) {
    require('./errorTracking').recordError(error, { source: 'sharedPostHistory', fallbackType: 'shared_post_history_failed' });
}

let instance;
module.exports = { contentKey, addNotice, createHistory, run: (...args) => (instance ||= createHistory()).run(...args) };

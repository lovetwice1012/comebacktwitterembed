'use strict';

const crypto = require('crypto');
const telemetry = require('./telemetry');
const fetchImpl = require('../providerFetch').withDeadline(require('node-fetch'), 20000);
function id(value, name = 'ID') {
    if (typeof value !== 'string' || !/^\d{16,22}$/.test(value)) throw Object.assign(new Error(`${name} must be a Discord snowflake string.`), { code: 'INVALID_ID' });
    return value;
}
function token() {
    let config = {};
    try { config = require('../../config.json'); } catch {}
    const value = process.env.DISCORD_BOT_TOKEN || process.env.BOT_TOKEN || config.token;
    if (!value) throw Object.assign(new Error('Discord bot token is not configured.'), { code: 'DISCORD_TOKEN_MISSING' });
    return value;
}
async function rest(route, options = {}) {
    const headers = { Authorization: `Bot ${token()}`, 'User-Agent': 'DiscordBot (https://sprink.cloud, 1.0)' };
    const init = { method: options.method || 'GET', headers, timeout: 20000, size: 8 * 1024 * 1024 };
    if (options.form) { init.body = options.form.body; headers['Content-Type'] = options.form.contentType; }
    else if (options.body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(options.body); }
    const response = await fetchImpl(`https://discord.com/api/v10${route}`, init);
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; } catch {
        throw Object.assign(new Error('Discord response body could not be decoded; send outcome may be unknown.'), { code: 'DELIVERY_UNKNOWN', status: response.status, responseBody: raw });
    }
    if (!response.ok) throw Object.assign(new Error(data?.message || `Discord HTTP ${response.status}`), {
        code: data?.code || 'DISCORD_HTTP_ERROR', status: response.status, rawError: data,
    });
    return { status: response.status, headers: telemetry.serializable(Object.fromEntries(response.headers.entries())), data };
}
async function resolve(input) {
    const guildId = id(input.guildId, 'guildId');
    const channelId = id(input.channelId, 'channelId');
    const [guild, channel] = await Promise.all([rest(`/guilds/${guildId}`), rest(`/channels/${channelId}`)]);
    if (channel.data?.guild_id !== guildId) throw Object.assign(new Error('The channel does not belong to the specified server.'), { code: 'GUILD_CHANNEL_MISMATCH' });
    if (![0, 5, 10, 11, 12].includes(channel.data.type)) throw Object.assign(new Error(`Channel type ${channel.data.type} does not support this message operation.`), { code: 'UNSENDABLE_CHANNEL_TYPE' });
    if (channel.data.thread_metadata?.archived || channel.data.thread_metadata?.locked) throw Object.assign(new Error('The thread is archived or locked; it will not be reopened implicitly.'), { code: 'THREAD_NOT_ACTIVE' });
    const reply = input.replyTo ? await rest(`/channels/${channelId}/messages/${id(input.replyTo, 'replyTo')}`) : null;
    return { guild: guild.data, channel: channel.data, reply: reply?.data, checkedAt: new Date().toISOString(),
        permissionStatus: 'Discord REST checks access; individual effective permission bits have not been computed.' };
}
function payloadFromStep(step, input) {
    const payload = {};
    for (const key of ['content', 'embeds', 'components', 'tts', 'flags']) if (step[key] !== undefined) payload[key] = telemetry.serializable(step[key]);
    const mentions = step.allowedMentions || step.allowed_mentions || input.allowedMentions;
    payload.allowed_mentions = mentions ? {
        parse: mentions.parse || [], users: mentions.users || [], roles: mentions.roles || [],
        replied_user: mentions.repliedUser === true || mentions.replied_user === true,
    } : { parse: [], replied_user: false };
    if (!payload.content && !payload.embeds?.length && !step.files?.length && !step.attachments?.length) throw Object.assign(new Error('No message content, embed or attachment was supplied.'), { code: 'EMPTY_MESSAGE' });
    if ((payload.content || '').length > 2000 || (payload.embeds?.length || 0) > 10) throw Object.assign(new Error('Discord content or embed count limit exceeded.'), { code: 'PAYLOAD_LIMIT' });
    return payload;
}
async function attachmentBuffer(file) {
    const value = typeof file === 'string' ? { url: file } : file;
    if (!value || typeof value !== 'object') throw new Error('Invalid attachment.');
    let buffer;
    let name = value.name || value.filename;
    if (value.base64) {
        if (value.base64.length > 34 * 1024 * 1024) throw new Error('Attachment exceeds 25 MiB.');
        buffer = Buffer.from(value.base64, 'base64');
    } else if (Buffer.isBuffer(value.attachment)) buffer = value.attachment;
    else if (value.attachment?.type === 'Buffer') buffer = Buffer.from(value.attachment.data);
    else {
        const source = value.url || value.attachment;
        const parsed = new URL(source);
        if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Attachments require an HTTP(S) URL or base64 data; local paths are not accepted.');
        const response = await fetchImpl(parsed.toString(), { timeout: 20000, size: 25 * 1024 * 1024 });
        if (!response.ok) throw Object.assign(new Error(`Attachment HTTP ${response.status}`), { status: response.status });
        buffer = await response.buffer();
        name ||= decodeURIComponent(parsed.pathname.split('/').pop() || 'attachment');
    }
    if (buffer.length > 25 * 1024 * 1024) throw new Error('Attachment exceeds 25 MiB.');
    return { buffer, name: String(name || 'attachment.bin').replace(/[\\/\r\n]/g, '_') };
}
async function send(input, actionId, steps) {
    const destination = await resolve(input);
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20) throw new Error('Send requires 1 to 20 message steps.');
    const results = [];
    let previousId = null;
    for (let index = 0; index < steps.length; index++) {
        const step = steps[index];
        const started = performance.now();
        let payload;
        let postStarted = false;
        try {
            payload = payloadFromStep(step, input);
            const replyId = step.send === 'reply-previous' ? previousId : index === 0 ? input.replyTo : null;
            if (step.send === 'reply-previous' && !replyId) throw new Error('Previous step has no confirmed message ID; reply step was not sent.');
            if (replyId) payload.message_reference = { message_id: replyId, channel_id: input.channelId, fail_if_not_exists: true };
            // Discord nonce is a short-window secondary guard. Persistent action
            // ownership and unknown-outcome handling belong to the daemon.
            payload.nonce = crypto.createHash('sha256').update(`${actionId}:${index}`).digest('hex').slice(0, 24);
            payload.enforce_nonce = true;
            const files = step.files || step.attachments || [];
            let response;
            if (files.length) {
                if (files.length > 10) throw new Error('Discord accepts at most 10 attachments per message.');
                const prepared = await Promise.all(files.map(attachmentBuffer));
                if (prepared.reduce((sum, file) => sum + file.buffer.length, 0) > 25 * 1024 * 1024) throw new Error('Combined attachments exceed the support operation limit of 25 MiB.');
                payload.attachments = prepared.map((file, i) => ({ id: i, filename: file.name }));
                const boundary = `cbte-${crypto.randomUUID()}`;
                const chunks = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n`)];
                prepared.forEach((file, i) => chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files[${i}]"; filename="${file.name.replace(/"/g, '_')}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file.buffer, Buffer.from('\r\n')));
                chunks.push(Buffer.from(`--${boundary}--\r\n`));
                const form = { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
                postStarted = true;
                response = await rest(`/channels/${input.channelId}/messages`, { method: 'POST', form });
            } else {
                postStarted = true;
                response = await rest(`/channels/${input.channelId}/messages`, { method: 'POST', body: payload });
            }
            if (!/^\d{16,22}$/.test(response.data?.id || '') || response.data?.channel_id !== input.channelId) {
                throw Object.assign(new Error('Discord accepted the request but returned no verifiable message ID and channel. Delivery must be reconciled.'), { code: 'DELIVERY_UNKNOWN' });
            }
            previousId = response.data.id;
            results.push({ index, outcome: 'confirmed', messageId: previousId,
                url: `https://discord.com/channels/${input.guildId}/${input.channelId}/${previousId}`,
                status: response.status, response: response.data, payload, durationMs: performance.now() - started });
        } catch (error) {
            const unknown = postStarted && (error.code === 'DELIVERY_UNKNOWN' || Number(error.status) >= 500 || (!error.status && /ECONN|ETIMEDOUT|Abort|FetchError/.test(`${error.code} ${error.name}`)));
            results.push({ index, outcome: unknown ? 'delivery_unknown' : 'failed', error: telemetry.errorData(error), payload, durationMs: performance.now() - started });
            // A partially accepted request cannot be safely retried automatically.
            break;
        }
    }
    const success = results.filter(row => row.outcome === 'confirmed').length;
    return { destination, steps: results, sentCount: success, plannedCount: steps.length,
        outcome: success === steps.length ? 'full_success' : results.some(row => row.outcome === 'delivery_unknown') ? 'delivery_unknown' : success ? 'partial_success' : 'failed' };
}
module.exports = { id, rest, resolve, send, payloadFromStep, attachmentBuffer };

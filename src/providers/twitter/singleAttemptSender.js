'use strict';

const { REST, Routes, Message, MessagePayload, DefaultRestOptions } = require('discord.js');

// An HTTP 413 proves non-delivery only if the SDK did not silently retry a
// previous POST whose acknowledgement was lost. Keep a dedicated manager for
// these X attachment sends; never mutate the shared Discord client settings.
function createSingleAttemptSender({ restFactory = options => new REST(options) } = {}) {
    const managers = new WeakMap();
    function forMessage(source, mode, previous) {
        const channel = source?.channel, client = source?.client || channel?.client;
        const messages = channel?.messages;
        const request = client?.rest?.options?.makeRequest;
        if (!channel?.id || !client || typeof client.token !== 'string' || !client.token
            || !client.options || !messages || typeof messages._add !== 'function' || typeof messages.resolveId !== 'function'
            || typeof request !== 'function'
            || request !== DefaultRestOptions.makeRequest && request[Symbol.for('cbte.discord.singleAttemptFetch')] !== true) return null;
        const reference = mode === 'reply-source' ? source : mode === 'reply-previous' ? previous || source : null;
        if (reference && !reference.id) return null;
        return { send: async payload => {
            let entry = managers.get(client);
            if (!entry || entry.request !== request) {
                const rest = restFactory({ ...client.rest.options, retries: 0, rejectOnRateLimit: () => true });
                entry = { request, rest };
                managers.set(client, entry);
            }
            const { rest } = entry;
            rest.setToken(client.token);
            const reply = reference ? { reply: { messageReference: reference,
                failIfNotExists: payload.failIfNotExists ?? client.options.failIfNotExists } } : {};
            const resolved = MessagePayload.create(channel, payload, reply).resolveBody();
            const { body, files } = await resolved.resolveFiles();
            const raw = await rest.post(Routes.channelMessages(channel.id), { body, files });
            if (!/^\d{16,22}$/.test(String(raw?.id || '')) || String(raw.channel_id) !== String(channel.id))
                throw Object.assign(new Error('Discord did not return a verifiable message.'), { code: 'DISCORD_SEND_RESULT_UNKNOWN' });
            // Gateway delivery can populate the cache before this POST's
            // complete response arrives. Do not bind a gallery to that
            // potentially partial object. Conversely, patching the shared
            // cache with this older receipt could overwrite a later Gateway
            // edit. Keep the authoritative POST receipt as a separate Message
            // snapshot when a cached object already exists.
            const cached = messages.cache?.get?.(raw.id);
            // Discord.js exposes the runtime Message constructor but marks it
            // private in its declarations; the SDK itself constructs it from
            // the same API response shape in its message manager.
            const ReceiptMessage = /** @type {any} */ (Message);
            return cached ? new ReceiptMessage(client, raw) : messages._add(raw);
        } };
    }
    return { forMessage };
}

const singleton = createSingleAttemptSender();
module.exports = { forMessage: singleton.forMessage, _internal: { createSingleAttemptSender } };

'use strict';

const { REST, Routes, MessagePayload, DefaultRestOptions } = require('discord.js');

// Reuploading attachments is not safely repeatable after an unknown PATCH
// response. Use a separate REST manager without implicit retries.
function createSingleAttemptEditor({ restFactory = options => new REST(options) } = {}) {
    const managers = new WeakMap();
    function forMessage(message) {
        const channel = message?.channel, client = message?.client || channel?.client;
        const messages = channel?.messages, request = client?.rest?.options?.makeRequest;
        if (!/^\d{16,22}$/.test(String(message?.id || '')) || !/^\d{16,22}$/.test(String(channel?.id || ''))
            || !client || typeof client.token !== 'string' || !client.token || !client.options
            || message.author?.id !== client.user?.id || !client.user?.id
            || !messages || typeof messages._add !== 'function' || typeof request !== 'function'
            || request !== DefaultRestOptions.makeRequest && request[Symbol.for('cbte.discord.singleAttemptFetch')] !== true) return null;
        return { edit: async payload => {
            let entry = managers.get(client);
            if (!entry || entry.request !== request) {
                entry = { request, rest: restFactory({ ...client.rest.options, retries: 0, rejectOnRateLimit: () => true }) };
                managers.set(client, entry);
            }
            entry.rest.setToken(client.token);
            const resolved = MessagePayload.create(channel, payload).resolveBody();
            const { body, files } = await resolved.resolveFiles();
            const raw = await entry.rest.patch(Routes.channelMessage(channel.id, message.id), { body, files });
            if (String(raw?.id || '') !== String(message.id) || String(raw?.channel_id || '') !== String(channel.id))
                throw Object.assign(new Error('Discord did not return a verifiable edited message.'), { code: 'DISCORD_EDIT_RESULT_UNKNOWN' });
            return messages._add(raw);
        } };
    }
    return { forMessage };
}

const singleton = createSingleAttemptEditor();
module.exports = { forMessage: singleton.forMessage, _internal: { createSingleAttemptEditor } };

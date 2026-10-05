'use strict';

// Gateway delivery can precede the webhook HTTP response. Hold only a matching
// in-flight webhook event until its receipt is known, never all webhook traffic.
// This is transport correlation, not a content-review queue or a user override.
const { createHash } = require('node:crypto');
const textValue = value => String(value || '').replace(/\r\n?/g, '\n');
function fingerprint(webhookId, channelId, value) {
    const embeds = (value.embeds || []).map(embed => {
        const data = typeof embed.toJSON === 'function' ? embed.toJSON() : embed;
        return { title: textValue(data.title), description: textValue(data.description), url: data.url || '',
            fields: (data.fields || []).map(field => ({ name: textValue(field.name), value: textValue(field.value), inline: !!field.inline })),
            author: textValue(data.author?.name), footer: textValue(data.footer?.text) };
    });
    // Discord enriches media URLs/proxy fields, so do not compare those fields.
    return createHash('sha256').update(JSON.stringify([webhookId, channelId, textValue(value.content), embeds])).digest('hex');
}
function createOutboundGuard(options = {}) {
    const now = options.now || Date.now, timeoutMs = options.timeoutMs || 25000;
    const pending = new Map(), known = new Map(), uncertainMessages = new Map();
    function prune() {
        for (const [id, expires] of known) if (expires <= now()) known.delete(id);
        for (const [key, expires] of uncertainMessages) if (expires <= now()) uncertainMessages.delete(key);
    }
    function begin(webhookId, channelId, body) {
        prune();
        if ([...pending.values()].reduce((n, entries) => n + entries.size, 0) >= 256) throw new Error('AUTOMATION_OUTBOUND_CAPACITY');
        const key = fingerprint(webhookId, channelId, body);
        let resolve, settled = false, timer;
        const promise = new Promise(done => { resolve = done; });
        const ticket = { promise };
        const entries = pending.get(key) || new Set(); entries.add(ticket); pending.set(key, entries);
        const finish = (id, uncertain = false) => {
            if (settled) return; settled = true; clearTimeout(timer);
            entries.delete(ticket); if (!entries.size) pending.delete(key);
            if (id) {
                if (known.size >= 10000) known.delete(known.keys().next().value);
                known.set(id, now() + 300000);
            }
            if (uncertain) {
                if (uncertainMessages.size >= 10000) uncertainMessages.delete(uncertainMessages.keys().next().value);
                uncertainMessages.set(key, now() + 300000);
            }
            resolve({ id, uncertain });
        };
        timer = setTimeout(() => finish(null, true), timeoutMs); timer.unref?.();
        return { sent: id => finish(id), failed: uncertain => finish(null, uncertain) };
    }
    async function shouldIgnore(message) {
        if (!message.webhookId) return false;
        prune(); if (known.has(message.id)) return true;
        const key = fingerprint(message.webhookId, message.channelId || message.channel?.id, message);
        if (uncertainMessages.has(key)) return true;
        const entries = pending.get(key);
        if (!entries?.size) return false;
        const receipts = await Promise.all([...entries].map(ticket => ticket.promise));
        return receipts.some(receipt => receipt.id === message.id || receipt.uncertain);
    }
    return { begin, shouldIgnore };
}
module.exports = { ...createOutboundGuard(), createOutboundGuard, fingerprint };

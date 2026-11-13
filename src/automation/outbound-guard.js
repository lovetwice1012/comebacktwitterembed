'use strict';

// Gateway delivery can precede the webhook HTTP response. Hold only a matching
// in-flight webhook event until its receipt is known, never all webhook traffic.
// Direct output is suppressed; normal notifications are released to the usual
// Bot expansion handler. The decision belongs to the prepared transport step.
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
function ownerFingerprint(webhookId, channelId, value) {
    // Discord may add link-preview embeds independently after submission.
    // Ownership is bound to the exact submitted content and Discord IDs; the
    // preview is not a trustworthy authorization input.
    return createHash('sha256').update(JSON.stringify([webhookId, channelId, textValue(value.content)])).digest('hex');
}
function createOutboundGuard(options = {}) {
    const now = options.now || Date.now, timeoutMs = options.timeoutMs || 25000;
    const pending = new Map(), ownerPending = new Map(), known = new Map(), uncertainMessages = new Map();
    function prune() {
        for (const [id, receipt] of known) if (receipt.expires <= now()) known.delete(id);
        for (const [key, expires] of uncertainMessages) if (expires <= now()) uncertainMessages.delete(key);
    }
    function begin(webhookId, channelId, body, { normalExpansion = false, ownerUserId = null } = {}) {
        prune();
        if ([...pending.values()].reduce((n, entries) => n + entries.size, 0) >= 256) throw new Error('AUTOMATION_OUTBOUND_CAPACITY');
        const key = fingerprint(webhookId, channelId, body);
        const ownerKey = ownerFingerprint(webhookId, channelId, body);
        // This owner is supplied only by the trusted prepared notification,
        // never by the message body or a webhook sender's own fields.
        const owner = normalExpansion && /^\d{16,22}$/.test(String(ownerUserId || '')) ? String(ownerUserId) : null;
        let resolve, settled = false, timer;
        const promise = new Promise(done => { resolve = done; });
        const ticket = { promise };
        const entries = pending.get(key) || new Set(); entries.add(ticket); pending.set(key, entries);
        const ownerEntries = owner ? (ownerPending.get(ownerKey) || new Set()) : null;
        if (ownerEntries) { ownerEntries.add(ticket); ownerPending.set(ownerKey, ownerEntries); }
        const finish = (id, uncertain = false) => {
            if (settled) return; settled = true; clearTimeout(timer);
            entries.delete(ticket); if (!entries.size) pending.delete(key);
            if (ownerEntries) { ownerEntries.delete(ticket); if (!ownerEntries.size) ownerPending.delete(ownerKey); }
            if (id) {
                if (known.size >= 10000) known.delete(known.keys().next().value);
                known.set(id, { expires: now() + 300000, ignore: !normalExpansion,
                    webhookId: String(webhookId), channelId: String(channelId), ownerUserId: owner, ownerFingerprint: ownerKey });
            }
            if (uncertain && !normalExpansion) {
                if (uncertainMessages.size >= 10000) uncertainMessages.delete(uncertainMessages.keys().next().value);
                uncertainMessages.set(key, now() + 300000);
            }
            resolve({ id, uncertain, ignore: !normalExpansion, ownerUserId: id ? owner : null });
        };
        timer = setTimeout(() => finish(null, true), timeoutMs); timer.unref?.();
        return { sent: id => finish(id), failed: uncertain => finish(null, uncertain) };
    }
    async function classify(message) {
        if (!message.webhookId) return { ignore: false };
        const channelId = message.channelId || message.channel?.id;
        prune();
        const key = fingerprint(message.webhookId, channelId, message);
        const ownerKey = ownerFingerprint(message.webhookId, channelId, message);
        const knownReceipt = known.get(message.id);
        if (knownReceipt && knownReceipt.webhookId === String(message.webhookId) && knownReceipt.channelId === String(channelId))
            return { ignore: knownReceipt.ignore, ownerUserId: knownReceipt.ownerFingerprint === ownerKey ? knownReceipt.ownerUserId : null };
        const entries = pending.get(key);
        const ownerEntries = ownerPending.get(ownerKey);
        if (!entries?.size && !ownerEntries?.size) return { ignore: uncertainMessages.has(key) };
        const tickets = new Set([...(entries || []), ...(ownerEntries || [])]);
        const receipts = await Promise.all([...tickets].map(ticket => ticket.promise));
        const matched = receipts.find(receipt => receipt.id === message.id);
        if (matched) return { ignore: matched.ignore, ownerUserId: matched.ownerUserId };
        // An uncertain normal submission has no direct media output to duplicate.
        // If Discord delivered it, let the ordinary handler process that message.
        return { ignore: uncertainMessages.has(key) || receipts.some(receipt => receipt.uncertain && receipt.ignore) };
    }
    async function shouldIgnore(message) { return (await classify(message)).ignore; }
    return { begin, classify, shouldIgnore };
}
module.exports = { ...createOutboundGuard(), createOutboundGuard, fingerprint };

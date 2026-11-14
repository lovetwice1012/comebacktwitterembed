'use strict';

// Only Discord's own attachment URL for this exact message attachment is
// eligible. Never infer ownership merely from a similar URL pathname.
const HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const SIGNATURE_KEYS = new Set(['ex', 'is', 'hm']);

function safeName(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\\/]/.test(value)
        && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

function signedQueryOnly(url) {
    const seen = new Set();
    for (const [key, value] of url.searchParams) {
        if (!SIGNATURE_KEYS.has(key) || seen.has(key) || !/^[0-9a-f]+$/i.test(value)) return false;
        seen.add(key);
    }
    return true;
}

function matchesReference(value, file, channelId, options = {}) {
    if (typeof value !== 'string' || !/^\d{1,25}$/.test(String(channelId || ''))
        || !/^\d{1,25}$/.test(String(file?.id || '')) || !safeName(file?.name)) return false;
    if (options.allowAttachmentScheme === true && value === `attachment://${file.name}`) return true;
    try {
        const url = new URL(value), pieces = url.pathname.split('/');
        return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
            && !(value.includes('?') && !url.search)
            && HOSTS.has(url.hostname) && pieces.length === 5 && pieces[1] === 'attachments'
            && pieces[2] === String(channelId) && pieces[3] === String(file.id)
            && decodeURIComponent(pieces[4]) === file.name && signedQueryOnly(url);
    } catch { return false; }
}

// The attachment scheme contains only a name. It is an identity only when
// exactly one actual attachment in the message has that name and a valid ID.
function matchesUniqueReference(value, file, attachments, channelId) {
    if (!Array.isArray(attachments) || !matchesReference(value, file, channelId, { allowAttachmentScheme: true })) return false;
    const matches = attachments.filter(item => matchesReference(value, item, channelId, { allowAttachmentScheme: true }));
    if (matches.length !== 1 || String(matches[0].id) !== String(file.id) || matches[0].name !== file.name) return false;
    // A scheme URL has no channel or attachment ID of its own. Its resolved
    // attachment must also have a valid Discord URL for this same channel.
    return !value.startsWith('attachment://') || matchesReference(matches[0].url, matches[0], channelId);
}

// Discord may omit an uploaded attachment from `attachments` when an Embed
// references it. Its CDN path still identifies the immutable attachment in
// this channel. Do not infer a file from foreign hosts or transformed URLs.
function embeddedImage(value, channelId) {
    if (typeof value !== 'string' || !/^\d{1,25}$/.test(String(channelId || ''))) return null;
    try {
        const url = new URL(value), pieces = url.pathname.split('/');
        if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
            || !HOSTS.has(url.hostname) || pieces.length !== 5 || pieces[1] !== 'attachments'
            || pieces[2] !== String(channelId) || !/^\d{1,25}$/.test(pieces[3])
            || (value.includes('?') && !url.search) || !signedQueryOnly(url)) return null;
        const name = decodeURIComponent(pieces[4]);
        const match = /\.(jpe?g|png|webp|avif)$/i.exec(name);
        if (!safeName(name) || !match || /^SPOILER_/i.test(name)) return null;
        const format = match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase();
        return { id: pieces[3], name, url: value, contentType: `image/${format}` };
    } catch { return null; }
}

// Callers must also verify the Bot author and the saved message fingerprint;
// these descriptors alone never authorize a mutation or deletion.
function logicalAttachments(message) {
    const channelId = message?.channelId || message?.channel?.id;
    const input = message?.attachments;
    const visible = !input ? [] : typeof input.values === 'function' ? [...input.values()] : Array.isArray(input) ? input : [];
    const result = [...visible], byId = new Map(), names = new Set();
    for (const file of visible) {
        const id = String(file?.id || ''), name = file?.name;
        if (!/^\d{1,25}$/.test(id) || !safeName(name) || byId.has(id) || names.has(name)) return null;
        byId.set(id, file); names.add(name);
    }
    const embeddedIds = new Set();
    for (const embed of message?.embeds || []) {
        const data = typeof embed?.toJSON === 'function' ? embed.toJSON() : embed;
        const file = embeddedImage(data?.image?.url, channelId);
        if (!file) continue;
        if (embeddedIds.has(file.id)) return null;
        embeddedIds.add(file.id);
        const existing = byId.get(file.id);
        if (existing) { if (existing.name !== file.name) return null; continue; }
        if (names.has(file.name)) return null;
        byId.set(file.id, file); names.add(file.name); result.push(file);
    }
    return result;
}

function canonicalUrl(value, message, options = {}) {
    if (typeof value !== 'string') return value;
    const channelId = message?.channelId || message?.channel?.id;
    const input = message?.attachments;
    const files = !input ? [] : typeof input.values === 'function' ? [...input.values()] : Array.isArray(input) ? input : [];
    const matching = files.filter(file => matchesReference(value, file, channelId, { allowAttachmentScheme: true }));
    if (matching.length !== 1) {
        // The fingerprint still contains the exact message, attachment ID,
        // filename and every non-signature query. Removing only Discord's
        // rotating signature does not change the underlying attachment.
        if (options.allowHidden === true && matching.length === 0 && embeddedImage(value, channelId)) return value.split('?')[0];
        return value;
    }
    // Compare attachment:// to the same verified attachment's CDN form, not
    // merely to another file with the same name or a URL from another channel.
    const candidate = value.startsWith('attachment://') ? matching[0].url : value;
    if (!matchesReference(candidate, matching[0], channelId)) return value;
    const query = candidate.indexOf('?');
    return query < 0 ? candidate : candidate.slice(0, query);
}

module.exports = { matchesReference, matchesUniqueReference, canonicalUrl, embeddedImage, logicalAttachments };

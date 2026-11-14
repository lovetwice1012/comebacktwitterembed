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

function canonicalUrl(value, message) {
    if (typeof value !== 'string') return value;
    const channelId = message?.channelId || message?.channel?.id;
    const input = message?.attachments;
    const files = !input ? [] : typeof input.values === 'function' ? [...input.values()] : Array.isArray(input) ? input : [];
    const matching = files.filter(file => matchesReference(value, file, channelId, { allowAttachmentScheme: true }));
    if (matching.length !== 1) return value;
    // Compare attachment:// to the same verified attachment's CDN form, not
    // merely to another file with the same name or a URL from another channel.
    const candidate = value.startsWith('attachment://') ? matching[0].url : value;
    if (!matchesReference(candidate, matching[0], channelId)) return value;
    const query = candidate.indexOf('?');
    return query < 0 ? candidate : candidate.slice(0, query);
}

module.exports = { matchesReference, matchesUniqueReference, canonicalUrl };

'use strict';

// An embedded upload may be absent from message.attachments. Its full Discord
// CDN URL can still identify the attachment on this exact channel/message;
// callers must additionally verify Bot authorship and the scoped DB record.
const { matchesReference, matchesUniqueReference } = require('./discordAttachmentIdentity');
const MARKER = /^tg-([a-f0-9]{32})\.(jpg|png|webp)$/;
const MIME = /^image\/(?:jpeg|png|webp)$/i;

function attachments(message) {
    const values = message?.attachments;
    return !values ? [] : typeof values.values === 'function' ? [...values.values()] : Array.isArray(values) ? values : [];
}
function embedImage(embed) {
    const raw = embed?.toJSON ? embed.toJSON() : embed;
    return raw?.image?.url;
}
function embeddedCandidate(value, files, channelId) {
    if (typeof value !== 'string') return undefined;
    if (value.startsWith('attachment://')) {
        const name = value.slice('attachment://'.length), match = MARKER.exec(name);
        if (!match) return undefined;
        const found = files.filter(file => file.name === name && MIME.test(String(file.contentType || ''))
            && matchesUniqueReference(value, file, files, channelId));
        return found.length === 1 ? { galleryId: match[1], id: String(found[0].id), name, url: found[0].url } : null;
    }
    let parsed, name;
    try { parsed = new URL(value); name = decodeURIComponent(parsed.pathname.split('/').at(-1) || ''); }
    catch { return undefined; }
    const match = MARKER.exec(name);
    if (!match) return undefined;
    const pieces = parsed.pathname.split('/'), file = { id: pieces[3], name };
    return matchesReference(value, file, channelId) ? { galleryId: match[1], id: String(file.id), name, url: value } : null;
}

function collect(message) {
    const channelId = String(message?.channelId || message?.channel?.id || ''), files = attachments(message), markers = new Map(), ownersById = new Map();
    if (!/^\d{1,25}$/.test(channelId)) return null;
    for (const file of files) {
        const match = MARKER.exec(String(file.name || ''));
        if (!match) continue;
        if (!/^\d{1,25}$/.test(String(file.id || '')) || !MIME.test(String(file.contentType || '')) || markers.has(match[1])
            || ownersById.has(String(file.id))) return null;
        markers.set(match[1], { id: String(file.id), name: file.name, url: file.url, attached: true, embedIndices: [] });
        ownersById.set(String(file.id), match[1]);
    }
    for (const [index, embed] of (message?.embeds || []).entries()) {
        const candidate = embeddedCandidate(embedImage(embed), files, channelId);
        if (candidate === undefined) continue;
        if (!candidate) return null;
        if (ownersById.has(candidate.id) && ownersById.get(candidate.id) !== candidate.galleryId) return null;
        let item = markers.get(candidate.galleryId);
        if (!item) {
            item = { id: candidate.id, name: candidate.name, url: candidate.url, attached: false, embedIndices: [] };
            markers.set(candidate.galleryId, item);
            ownersById.set(candidate.id, candidate.galleryId);
        }
        if (item.id !== candidate.id || item.name !== candidate.name || item.embedIndices.length) return null;
        item.embedIndices.push(index);
    }
    return markers;
}

function get(message, galleryId) {
    if (!/^[a-f0-9]{32}$/.test(String(galleryId || ''))) return null;
    return collect(message)?.get(galleryId) || null;
}

// Used only for comparing two freshly fetched versions of the same Bot
// message during one guarded operation. A marker's identity is stable whether
// Discord exposes it in attachments or only in the embed; all other content,
// components, embeds and attachment IDs remain part of the comparison.
function stableFingerprint(message) {
    const markers = collect(message);
    if (!markers) return null;
    const cards = require('./twitterGridCards'), { createHash } = require('node:crypto');
    const markerIds = new Set([...markers.values()].map(item => item.id));
    const byEmbed = new Map();
    for (const [galleryId, item] of markers) for (const index of item.embedIndices) byEmbed.set(index, `grid-marker:${galleryId}:${item.id}:${item.name}`);
    const embeds = (message?.embeds || []).map((embed, index) => {
        const value = cards.cleanEmbed(embed);
        if (byEmbed.has(index) && value.image?.url) value.image.url = byEmbed.get(index);
        for (const key of ['image', 'thumbnail']) if (value[key]?.url && !(key === 'image' && byEmbed.has(index)))
            value[key].url = require('./discordAttachmentIdentity').canonicalUrl(value[key].url, message, { allowHidden: true });
        return value;
    });
    const plain = item => item?.toJSON ? item.toJSON() : JSON.parse(JSON.stringify(item || {}));
    const value = { content: message?.content || '', embeds, components: (message?.components || []).map(plain),
        attachments: attachments(message).filter(file => !markerIds.has(String(file.id))).map(file => ({ id: String(file.id || ''), name: file.name || '' })),
        markers: [...markers.entries()].map(([galleryId, item]) => ({ galleryId, id: item.id, name: item.name })).sort((a, b) => a.galleryId.localeCompare(b.galleryId)) };
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

module.exports = { collect, get, stableFingerprint };

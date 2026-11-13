'use strict';

const { randomBytes, createHash } = require('node:crypto');
const gallery = require('./mediaGallery');
const { isNsfwChannel } = require('./providers/_sensitive_controls');

// Grid preferences may change independently of content safety. Every other
// provider setting remains part of the original policy snapshot.
function safetyHash(settings) {
    const filtered = Object.fromEntries(Object.entries(settings || {}).filter(([key]) => !key.startsWith('twitter_grid_')));
    return gallery.settingsHash(filtered);
}
function validPart(part) {
    return part && Number.isInteger(part.sequence) && Number.isInteger(part.totalParts)
        && part.sequence >= 0 && part.totalParts >= 1 && part.totalParts <= 20 && part.sequence < part.totalParts
        && Array.isArray(part.imageUrls) && (part.imageUrls.length > 0 || part.totalParts > 1) && part.imageUrls.length <= 10
        // Local saved URLs are never fetched here. `references` only maps
        // them to verified Discord attachments for the same saved post.
        && part.imageUrls.every(url => typeof url === 'string' && /^(?:https:\/\/|http:\/\/localhost:3088\/)/i.test(url));
}
function savedMedia(url, source) {
    try {
        const media = new URL(url), origin = new URL(source);
        const savedOrigin = origin.protocol === 'https:' && origin.hostname === 'twidata.sprink.cloud' && !origin.port
            || origin.protocol === 'http:' && origin.hostname === 'localhost' && origin.port === '3088';
        const start = /^\/data\/(\d{16,22})\/(\d{1,22})\/data\.json$/.exec(origin.pathname);
        const item = /^\/data\/(\d{16,22})\/(\d{1,22})\/(media-\d+-[^/]+)$/.exec(media.pathname);
        const validHost = media.protocol === 'https:' && media.hostname === 'twidata.sprink.cloud' && !media.port
            || media.protocol === 'http:' && media.hostname === 'localhost' && media.port === '3088';
        if (!savedOrigin || !validHost || !start || !item || start[1] !== item[1] || start[2] !== item[2]
            || origin.username || origin.password || media.username || media.password || origin.search || origin.hash || media.search || media.hash) return false;
        const name = decodeURIComponent(item[3]);
        return !/[\\/]/.test(name) && !Array.from(name).some(char => char.charCodeAt(0) < 32) && !name.startsWith('SPOILER_');
    } catch { return false; }
}
function references(part, step, context) {
    if (!validPart(part)) return null;
    const files = Array.isArray(step?.files) ? step.files : [], used = new Set();
    const expectedNames = files.map(file => {
        const raw = typeof file === 'string' ? file : file?.attachment;
        return typeof file === 'object' && typeof file?.name === 'string' ? file.name : typeof raw === 'string' ? require('node:path').posix.basename(raw) : '';
    });
    const output = [];
    for (const url of part.imageUrls) {
        try {
            const parsed = require('./components/twitter-image-grid')._internal.validateUrl(url);
            const format = (parsed.searchParams.get('format') || parsed.pathname.match(/\.(\w+)(?::\w+)?$/)?.[1] || '').toLowerCase();
            if (format === 'gif') return null;
            output.push({ type: 'url', url }); continue;
        } catch { /* A confirmed saved attachment may be mapped to Discord CDN. */ }
        if (!savedMedia(url, context.url)) return null;
        const index = files.findIndex((file, i) => !used.has(i) && (typeof file === 'string' ? file : file?.attachment) === url);
        if (index < 0) return null;
        const name = expectedNames[index];
        if (!name || name.startsWith('SPOILER_') || expectedNames.filter(value => value === name).length !== 1) return null;
        used.add(index); output.push({ type: 'attachment', name });
    }
    return output;
}
function resolveReferences(refs, message, allowFallback = false) {
    const attachments = attachmentList(message);
    return refs.map(ref => {
        if (ref.type === 'url') return ref.url;
        if (ref.type !== 'attachment' || typeof ref.name !== 'string') throw new Error('GRID_REFERENCE_INVALID');
        const matches = attachments.filter(file => file.name === ref.name);
        const value = matches.length === 1 && /^image\/(jpeg|png|webp|avif)$/i.test(matches[0].contentType || '') ? matches[0].url : allowFallback ? ref.initialUrl : null;
        require('./components/twitter-image-grid')._internal.validateUrl(value);
        return value;
    });
}
function gridButton(id, language, quote) {
    const ja = String(language || 'ja').startsWith('ja');
    return { type: 2, style: 2, label: quote ? (ja ? `引用${quote}の画像をまとめる` : `Combine quote ${quote}`) : (ja ? '画像をまとめる' : 'Combine images'), custom_id: `tg:${id}:0:open` };
}
function attachmentList(message) {
    const items = message?.attachments;
    if (!items) return [];
    return typeof items.values === 'function' ? [...items.values()] : Array.isArray(items) ? items : [];
}
function plain(item) { return item?.toJSON ? item.toJSON() : JSON.parse(JSON.stringify(item || {})); }
function cleanEmbed(item) {
    const src = plain(item), out = {};
    for (const key of ['title', 'description', 'url', 'color', 'timestamp', 'fields']) if (src[key] !== undefined) out[key] = src[key];
    for (const key of ['image', 'thumbnail']) if (src[key]?.url) out[key] = { url: src[key].url };
    for (const [key, allowed] of Object.entries({ author: ['name', 'url', 'icon_url'], footer: ['text', 'icon_url'] })) {
        if (src[key]) out[key] = Object.fromEntries(allowed.filter(name => src[key][name] !== undefined).map(name => [name, src[key][name]]));
    }
    return out;
}
function embedFingerprint(item) { return createHash('sha256').update(JSON.stringify(cleanEmbed(item))).digest('hex'); }
function embedWitness(grid, message, part) {
    const embeds = message?.embeds || [], start = grid.embedStart, end = grid.embedEnd;
    if (!grid.sharedInline || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > embeds.length) return null;
    const entries = embeds.slice(start, end), urls = entries.map(item => cleanEmbed(item).image?.url).filter(Boolean);
    if (!part.imageUrls?.length) return null;
    const embedded = urls.length === part.imageUrls.length && JSON.stringify([...urls].sort()) === JSON.stringify([...part.imageUrls].sort());
    const attachments = attachmentList(message);
    const attached = grid.isPrimary && start === 0 && urls.length === 0 && part.containsNonImage !== true
        && attachments.length === part.imageUrls.length && attachments.every(file => /^\d{1,25}$/.test(String(file.id || '')) && String(file.contentType || '').startsWith('image/'));
    if (!embedded && !attached) return null;
    return { hashes: entries.map(embedFingerprint), attachments: attached ? attachments.map(file => ({ id: String(file.id), name: String(file.name || '') })) : [] };
}
function fingerprint(message, omitImages = false) {
    const embeds = (message?.embeds || []).map(cleanEmbed).map(embed => {
        if (!omitImages) return embed;
        delete embed.image;
        return embed;
    }).filter(embed => !omitImages || Object.keys(embed).some(key => !['url', 'type', 'color'].includes(key)));
    const value = { content: message?.content || '', embeds, components: (message?.components || []).map(plain) };
    if (!omitImages) value.attachments = attachmentList(message).map(file => ({ id: String(file.id || ''), name: file.name || '' }));
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
async function prepare(step, message, context, storage, nextStep) {
    const meta = step?.twitterGrid, guildId = message.guildId || message.guild?.id;
    if (context.providerId !== 'twitter' || !guildId) return { step };
    const settings = context.presentationSettings || {};
    if (settings.button_invisible?.all || settings.button_invisible?.tg || (step.components || []).length >= 5) return { step };
    storage ||= gallery.store();
    const candidates = [meta, ...(Array.isArray(step.twitterGridInline) ? step.twitterGridInline : [])];
    const grids = [], buttons = [];
    let lockId = null;
    const maxButtons = (5 - (step.components || []).length) * 5;
    for (const [index, part] of candidates.entries()) {
        if (buttons.length >= maxButtons || !validPart(part) || part.sequence !== 0 || part.totalParts === 1 && part.imageUrls.length < 2) continue;
        const firstRefs = references(part, step, context);
        const following = Array.isArray(nextStep) ? nextStep : nextStep ? [nextStep] : [];
        const otherParts = [];
        if (part.totalParts > 1) {
            if (index !== 0 || following.length < part.totalParts - 1) continue;
            for (let sequence = 1; sequence < part.totalParts; sequence++) {
                const continuation = following[sequence - 1], metadata = continuation?.twitterGrid;
                if (!metadata || metadata.sequence !== sequence || metadata.totalParts !== part.totalParts) break;
                const refs = references(metadata, continuation, context);
                if (!refs) break;
                otherParts.push({ metadata, refs });
            }
            if (otherParts.length !== part.totalParts - 1) continue;
        }
        if (!firstRefs) continue;
        // Saved-post URLs must be mapped to the actual Discord attachment IDs
        // after every part succeeds. Do not expose a control until that can be
        // published without racing existing message actions.
        if ([...firstRefs, ...otherParts.flatMap(item => item.refs)].some(ref => ref.type === 'attachment')) continue;
        const id = randomBytes(16).toString('hex');
        const expectedImageUrls = [...part.imageUrls, ...otherParts.flatMap(item => item.metadata.imageUrls)];
        if (expectedImageUrls.length < 2 || expectedImageUrls.length > 20) continue;
        const payload = { id, kind: 'twitter-image-grid-v1', imageUrls: [], expectedImageUrls,
            expectedRefs: [...firstRefs, ...otherParts.flatMap(item => item.refs)], initialImageUrls: [...part.imageUrls],
            isPrimary: index === 0, totalParts: part.totalParts, completedParts: 0, messageIds: [], partSizes: [],
            partContainsNonImage: [], partSignatures: [], firstStaticSignature: null,
            partsState: 'pending', pendingAtMs: null,
            sharedInline: step.twitterGridSharedInline === true || Array.isArray(step.twitterGridInline) && step.twitterGridInline.length > 0,
            embedStart: Number.isInteger(part.embedStart) ? part.embedStart : null,
            embedEnd: Number.isInteger(part.embedEnd) ? part.embedEnd : null,
            lockId: lockId || id,
            partRefs: [],
            requesterId: /^\d{16,22}$/.test(String(context.gridRequesterId || '')) ? String(context.gridRequesterId) : String(message.author?.id || message.user?.id || ''),
            nsfw: isNsfwChannel(message), nsfwContextVersion: 1, settingsHash: safetyHash(settings) };
        try { await storage.save(payload, message, 'twitter'); lockId ||= id; grids.push(payload); buttons.push(gridButton(id, settings.defaultLanguage, index)); }
        catch (error) { gallery.report(error); }
    }
    if (!buttons.length) return { step };
    const rows = [...(step.components || [])];
    for (let i = 0; i < buttons.length; i += 5) rows.push({ type: 1, components: buttons.slice(i, i + 5) });
    return { step: { ...step, components: rows }, grids };
}
function physicalPart(part) {
    return part && Array.isArray(part.imageUrls) && part.imageUrls.length <= 10
        && part.imageUrls.every(url => typeof url === 'string' && /^https:\/\//i.test(url))
        && (part.containsNonImage === undefined || typeof part.containsNonImage === 'boolean');
}
function expectedNext(grid, part) {
    const start = grid.imageUrls.length, count = part.imageUrls.length;
    return Array.isArray(grid.expectedImageUrls) && Array.isArray(grid.expectedRefs)
        && start + count <= grid.expectedImageUrls.length
        && part.imageUrls.every((url, index) => url === grid.expectedImageUrls[start + index]);
}
async function bind(grid, sent, storage = gallery.store(), db = require('./db'), actualFirstPart) {
    if (!grid || !sent?.id) return false;
    const part = actualFirstPart || { imageUrls: grid.initialImageUrls };
    if (!physicalPart(part) || !expectedNext(grid, part) || grid.completedParts !== 0 || grid.messageIds.length !== 0) return false;
    const refs = grid.expectedRefs.slice(0, part.imageUrls.length);
    let urls;
    try { urls = resolveReferences(refs, sent); } catch { return false; }
    await storage.bind(grid.id, sent.id);
    const actualRefs = refs.map((ref, n) => ref.type === 'attachment' ? { ...ref, initialUrl: urls[n] } : ref);
    const next = { ...grid, imageUrls: [...part.imageUrls], partRefs: [actualRefs], completedParts: 1,
        partSizes: [part.imageUrls.length], partContainsNonImage: [part.containsNonImage === true],
        messageIds: [String(sent.id)], partSignatures: [fingerprint(sent)], firstStaticSignature: fingerprint(sent, true),
        embedWitness: embedWitness(grid, sent, part), pendingAtMs: Date.now() };
    const result = await db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=? AND message_id=? AND BINARY payload_json=BINARY ?',
        [JSON.stringify(next), grid.id, String(sent.id), JSON.stringify(grid)]);
    if (Number(result?.affectedRows) !== 1) return false;
    Object.assign(grid, next);
    return true;
}
async function append(grid, part, sent, db = require('./db')) {
    if (!grid || !sent?.id || !physicalPart(part) || part.imageUrls.length === 0 || !expectedNext(grid, part)
        || grid.partsState !== 'pending' || grid.completedParts >= 20 || grid.messageIds.length !== grid.completedParts
        || grid.messageIds.includes(String(sent.id))) return false;
    const refs = grid.expectedRefs.slice(grid.imageUrls.length, grid.imageUrls.length + part.imageUrls.length);
    let urls;
    try { urls = resolveReferences(refs, sent); } catch { return false; }
    const actualRefs = refs.map((ref, n) => ref.type === 'attachment' ? { ...ref, initialUrl: urls[n] } : ref);
    const completed = grid.completedParts + 1;
    const next = { ...grid, partRefs: [...grid.partRefs, actualRefs], imageUrls: [...grid.imageUrls, ...part.imageUrls], completedParts: completed,
        totalParts: Math.max(grid.totalParts, completed + 1),
        messageIds: [...grid.messageIds, String(sent.id)], partSizes: [...grid.partSizes, part.imageUrls.length],
        partContainsNonImage: [...grid.partContainsNonImage, part.containsNonImage === true],
        partSignatures: [...grid.partSignatures, fingerprint(sent)] };
    const result = await db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=? AND message_id=? AND BINARY payload_json=BINARY ?',
        [JSON.stringify(next), grid.id, grid.messageIds[0], JSON.stringify(grid)]);
    if (Number(result?.affectedRows) !== 1) return false;
    Object.assign(grid, next); return true;
}
async function finish(grid, db = require('./db')) {
    if (!grid || grid.partsState !== 'pending' || !Array.isArray(grid.expectedImageUrls) || grid.expectedImageUrls.length < 2
        || grid.expectedImageUrls.length > 20 || !Array.isArray(grid.imageUrls) || grid.imageUrls.length > grid.expectedImageUrls.length
        || grid.imageUrls.some((url, index) => url !== grid.expectedImageUrls[index])
        || grid.completedParts < 1 || grid.completedParts > 20 || grid.messageIds.length !== grid.completedParts
        || new Set(grid.messageIds).size !== grid.messageIds.length || grid.partRefs.length !== grid.completedParts
        || grid.partSizes.length !== grid.completedParts || grid.partContainsNonImage.length !== grid.completedParts
        || grid.partSignatures.length !== grid.completedParts || grid.partSizes.reduce((sum, count) => sum + count, 0) !== grid.imageUrls.length)
        throw new Error('GRID_MANIFEST_INVALID');
    if (grid.imageUrls.length < grid.expectedImageUrls.length) return { state: 'pending' };
    const next = { ...grid, totalParts: grid.completedParts, partsState: 'complete' };
    const result = await db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=? AND message_id=? AND BINARY payload_json=BINARY ?',
        [JSON.stringify(next), grid.id, grid.messageIds[0], JSON.stringify(grid)]);
    if (Number(result?.affectedRows) !== 1) throw new Error('GRID_RECORD_CONFLICT');
    Object.assign(grid, next); return { state: 'complete' };
}
async function markIncomplete(grid, state, db = require('./db')) {
    if (!grid || !['failed', 'delivery_unknown', 'record_unknown'].includes(state) || grid.partsState !== 'pending'
        || !Array.isArray(grid.messageIds) || grid.messageIds.length < 1 || grid.messageIds.length !== grid.completedParts) return false;
    const next = { ...grid, partsState: state };
    // The completed state always wins: in particular, an UPDATE whose
    // acknowledgement was lost must not overwrite a successful append.
    const result = await db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=? AND message_id=? AND BINARY payload_json=BINARY ?',
        [JSON.stringify(next), grid.id, grid.messageIds[0], JSON.stringify(grid)]);
    if (Number(result?.affectedRows) !== 1) return false;
    Object.assign(grid, next); return true;
}
async function discardUnbound(grids, db = require('./db')) {
    if (!Array.isArray(grids)) return 0;
    let removed = 0;
    for (const grid of grids) {
        if (!grid || grid.kind !== 'twitter-image-grid-v1' || !/^[a-f0-9]{32}$/.test(grid.id || '')) continue;
        // The ID and exact initially-created payload must both match, and a
        // message must never have been bound. A concurrent bind always wins.
        const result = await db.queryDatabase(`DELETE FROM bot_media_galleries
            WHERE gallery_id=? AND provider_id='twitter' AND message_id IS NULL AND BINARY payload_json=BINARY ?`,
        [grid.id, JSON.stringify(grid)]);
        removed += Number(result?.affectedRows || 0);
    }
    return removed;
}
function gridIdFromMessage(message) {
    for (const row of message?.components || []) for (const component of row.components || []) {
        const value = component.customId || component.custom_id || component.data?.custom_id;
        const match = /^tg:([a-f0-9]{32}):0:open$/.exec(value || '');
        if (match) return match[1];
    }
    return null;
}
async function withMessageLock(interaction, work, db = require('./db'), confirmation = null) {
    const id = gridIdFromMessage(interaction.message);
    if (!id || !interaction.guildId || !interaction.channelId) return work();
    const messageId = String(interaction.message.id || ''), before = fingerprint(interaction.message);
    return db.withDatabaseTransaction(async query => {
        const rows = await query('SELECT message_id,payload_json FROM bot_media_galleries WHERE gallery_id=? AND guild_id=? AND channel_id=? LIMIT 1',
            [id, interaction.guildId, interaction.channelId]);
        if (!rows[0]) throw new Error('GRID_LOCK_UNAVAILABLE');
        const payload = JSON.parse(rows[0].payload_json);
        if (payload.kind !== 'twitter-image-grid-v1' || !/^[a-f0-9]{32}$/.test(payload.lockId || '') || String(rows[0].message_id || '') !== messageId) throw new Error('GRID_LOCK_UNAVAILABLE');
        const locks = await query('SELECT message_id FROM bot_media_galleries WHERE gallery_id=? AND guild_id=? AND channel_id=? FOR UPDATE',
            [payload.lockId, interaction.guildId, interaction.channelId]);
        if (!locks[0]) throw new Error('GRID_LOCK_UNAVAILABLE');
        if (String(locks[0].message_id || '') !== messageId) throw new Error('GRID_LOCK_UNAVAILABLE');
        // Until the group-wide controls are available, never run a legacy
        // action that can edit or delete only one message of a split post.
        const latest = await query('SELECT message_id,payload_json FROM bot_media_galleries WHERE gallery_id=? AND guild_id=? AND channel_id=? AND expires_at_ms>? FOR UPDATE',
            [id, interaction.guildId, interaction.channelId, Date.now()]);
        if (!latest[0] || String(latest[0].message_id || '') !== messageId) throw new Error('GRID_LOCK_UNAVAILABLE');
        const saved = JSON.parse(latest[0].payload_json);
        if (saved.id !== id || saved.kind !== 'twitter-image-grid-v1' || saved.lockId !== payload.lockId
            || !Number.isInteger(saved.totalParts) || saved.totalParts < 1 || saved.totalParts > 20) throw new Error('GRID_LOCK_UNAVAILABLE');
        const action = String(confirmation?.actionId || interaction.customId || '').split(':')[0];
        if (saved.totalParts > 1 && ['delete', 'showMediaAsAttachments', 'showAttachmentsAsEmbedsImage'].includes(action))
            throw new Error('GRID_SPLIT_ACTION_PAUSED');
        if (confirmation) {
            if (id !== confirmation.galleryId
                || saved.partsState && saved.partsState !== 'complete' || saved.replacePhase && saved.replacePhase !== 'done'
                || saved.completedParts !== saved.totalParts || !Array.isArray(saved.messageIds)
                || saved.messageIds[0] !== messageId || saved.messageIds.length !== saved.totalParts
                || new Set(saved.messageIds).size !== saved.messageIds.length) throw new Error('GRID_LOCK_UNAVAILABLE');
        }
        if (confirmation?.revalidate) await confirmation.revalidate();
        const current = await (confirmation?.channel || interaction.channel).messages.fetch({ message: messageId, force: true });
        if (current?.author?.id !== interaction.client?.user?.id || String(current.id || '') !== messageId) throw new Error('GRID_SOURCE_CHANGED');
        if (fingerprint(current) !== before) throw Object.assign(new Error('GRID_SOURCE_CHANGED'), { code: 'GRID_SNAPSHOT_MISMATCH' });
        if (confirmation && (fingerprint(current) !== confirmation.expectedFingerprint || gridIdFromMessage(current) !== id
            || !require('./components/twitterGridConfirm')._internal.buttonExists(current, confirmation.actionId))) throw new Error('GRID_SOURCE_CHANGED');
        if (confirmation?.deadlineCheck && !confirmation.deadlineCheck()) throw new Error('GRID_SOURCE_CHANGED');
        interaction.message = current;
        const policy = {};
        if (action === 'delete') policy.verifiedRequesterId = saved.requesterId || null;
        if (saved.totalParts > 1 && action === 'translate') policy.previewOnlyTranslation = true;
        return work(Object.keys(policy).length ? policy : undefined);
    });
}
module.exports = { safetyHash, validPart, references, resolveReferences, prepare, bind, append, finish, markIncomplete, discardUnbound, gridButton, fingerprint, embedFingerprint, attachmentList, cleanEmbed, gridIdFromMessage, withMessageLock };

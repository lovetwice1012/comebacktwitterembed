'use strict';

const { randomBytes, createHash } = require('node:crypto');
const gallery = require('./mediaGallery');
const { isNsfwChannel } = require('./providers/_sensitive_controls');

// Keep the original hash for existing records and older Bot releases.
function safetyHash(settings) {
    const filtered = Object.fromEntries(Object.entries(settings || {}).filter(([key]) => !key.startsWith('twitter_grid_')));
    return gallery.settingsHash(filtered);
}

// These four settings affect labels, notification delivery, or translation
// presentation; none can add images to the policy-filtered gallery. All
// other settings, including unknown future settings, remain protected.
const PRESENTATION_ONLY = Object.freeze(['defaultLanguage', 'silent_expansion', 'show_previous_shares', 'editOriginalIfTranslate']);
const LEGACY_LANGUAGES = Object.freeze([...new Set([
    ...require('./discordLocales').DISCORD_LOCALE_OPTIONS.map(option => option.value), 'en', 'jp', 'ko-KR', undefined, null,
])]);
const LEGACY_BOOLEAN_VALUES = Object.freeze([true, false, undefined, null]);
const LEGACY_CACHE_LIMIT = 256, MAX_POLICY_INPUT_BYTES = 1024 * 1024, MAX_LEGACY_SEARCH_BYTES = 32 * 1024;
const legacyPolicyCache = new Map();

function safetyPolicyHash(settings) {
    const filtered = Object.fromEntries(Object.entries(settings || {}).filter(([key]) =>
        !key.startsWith('twitter_grid_') && !PRESENTATION_ONLY.includes(key)));
    return gallery.settingsHash(filtered);
}

function matchesSafetyPolicy(settings, payload) {
    try {
        if (!settings || typeof settings !== 'object' || !payload || typeof payload !== 'object') return false;
        const inputBytes = Buffer.byteLength(JSON.stringify(settings), 'utf8');
        if (inputBytes > MAX_POLICY_INPUT_BYTES) return false;
        if (Object.hasOwn(payload, 'settingsPolicyHash')) {
            return typeof payload.settingsPolicyHash === 'string' && /^[a-f0-9]{64}$/.test(payload.settingsPolicyHash)
                && safetyPolicyHash(settings) === payload.settingsPolicyHash;
        }
        const expected = payload.settingsHash;
        if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) return false;
        if (safetyHash(settings) === expected) return true;
        // Bound the work for legacy inputs with very large settings. They can
        // still be used unchanged, but cannot be guessed after other edits.
        if (inputBytes > MAX_LEGACY_SEARCH_BYTES) return false;

        // A legacy record stored only the hash of *all* settings. Prove
        // compatibility by reconstructing bounded legal values of the four
        // presentation-only fields; never infer or rewrite a security field.
        const cacheKey = `${expected}:${safetyPolicyHash(settings)}`;
        if (legacyPolicyCache.has(cacheKey)) return legacyPolicyCache.get(cacheKey);
        const values = (key, legal) => legal.includes(settings[key]) ? [settings[key], ...legal.filter(value => value !== settings[key])] : [...legal];
        const langs = values('defaultLanguage', LEGACY_LANGUAGES);
        const silent = values('silent_expansion', LEGACY_BOOLEAN_VALUES);
        const shares = values('show_previous_shares', LEGACY_BOOLEAN_VALUES);
        const translate = values('editOriginalIfTranslate', LEGACY_BOOLEAN_VALUES);
        const candidate = { ...settings };
        let matched = false;
        search: for (const language of langs) for (const s of silent) for (const p of shares) for (const t of translate) {
            candidate.defaultLanguage = language; candidate.silent_expansion = s;
            candidate.show_previous_shares = p; candidate.editOriginalIfTranslate = t;
            if (safetyHash(candidate) === expected) { matched = true; break search; }
        }
        if (legacyPolicyCache.size >= LEGACY_CACHE_LIMIT) legacyPolicyCache.delete(legacyPolicyCache.keys().next().value);
        legacyPolicyCache.set(cacheKey, matched);
        return matched;
    } catch { return false; }
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
        const parsed = require('./components/twitter-image-grid')._internal.validateUrl(value);
        // A Discord attachment must refer to the same ID in the message and
        // in its CDN path. Never map a same-named image from another message.
        if (!['cdn.discordapp.com', 'media.discordapp.net'].includes(parsed.hostname)
            || matches.length === 1 && parsed.pathname.split('/')[3] !== String(matches[0].id || '')) throw new Error('GRID_REFERENCE_INVALID');
        return value;
    });
}
function gridButton(id, language, quote) {
    const ja = String(language || 'ja').startsWith('ja');
    return { type: 2, style: 2, label: quote ? (ja ? `引用${quote}の画像をまとめる` : `Combine quote ${quote}`) : (ja ? '画像をまとめる' : 'Combine images'), custom_id: `tg:${id}:0:open` };
}
const LOCATOR_ACTIONS = new Set(['delete', 'translate', 'showMediaAsAttachments', 'showAttachmentsAsEmbedsImage']);
function locatorIdFromAction(value) {
    if (typeof value !== 'string') return null;
    const match = /^(delete|translate|showMediaAsAttachments|showAttachmentsAsEmbedsImage):sl1:([a-f0-9]{32})$/.exec(value);
    return match ? match[2] : null;
}
function attachActionLocator(step, galleryId) {
    if (!Array.isArray(step.components) || !step.components.length) return step;
    let changed = false;
    const components = step.components.map(row => {
        const value = plain(row);
        return { ...value, components: (value.components || []).map(component => {
            const id = component.custom_id || component.customId;
            if (!LOCATOR_ACTIONS.has(id)) return component;
            changed = true;
            const next = { ...component, custom_id: `${id}:sl1:${galleryId}` };
            delete next.customId;
            return next;
        }) };
    });
    return changed ? { ...step, components } : step;
}
function withoutUnlinkedActions(step) {
    if (!Array.isArray(step.components)) return step;
    let changed = false;
    const components = step.components.map(row => {
        const value = plain(row);
        return { ...value, components: (value.components || []).filter(component => {
            const id = component.custom_id || component.customId || '';
            if (!LOCATOR_ACTIONS.has(String(id).split(':')[0])) return true;
            changed = true; return false;
        }) };
    }).filter(row => row.components.length);
    return changed ? { ...step, components } : step;
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
function embedFingerprint(item, message, options = {}) {
    const embed = cleanEmbed(item);
    if (message && typeof message === 'object') for (const key of ['image', 'thumbnail']) {
        if (embed[key]?.url) embed[key].url = require('./discordAttachmentIdentity').canonicalUrl(embed[key].url, message, { allowHidden: options.allowHidden !== false });
    }
    return createHash('sha256').update(JSON.stringify(embed)).digest('hex');
}
function matchesEmbedFingerprint(item, message, expected) {
    return typeof expected === 'string' && (embedFingerprint(item, message) === expected
        || embedFingerprint(item, message, { allowHidden: false }) === expected || embedFingerprint(item) === expected);
}
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
    return { hashes: entries.map(entry => embedFingerprint(entry, message)), attachments: attached ? attachments.map(file => ({ id: String(file.id), name: String(file.name || '') })) : [] };
}
function fingerprintValue(message, omitImages = false, legacy = false, allowHidden = true) {
    const embeds = (message?.embeds || []).map(cleanEmbed).map(embed => {
        if (omitImages) delete embed.image;
        if (!legacy) for (const key of ['image', 'thumbnail']) {
            if (embed[key]?.url) embed[key].url = require('./discordAttachmentIdentity').canonicalUrl(embed[key].url, message, { allowHidden });
        }
        return embed;
    }).filter(embed => !omitImages || Object.keys(embed).some(key => !['url', 'type', 'color'].includes(key)));
    const value = { content: message?.content || '', embeds, components: (message?.components || []).map(plain) };
    if (!omitImages) value.attachments = attachmentList(message).map(file => ({ id: String(file.id || ''), name: file.name || '' }));
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function fingerprint(message, omitImages = false) { return fingerprintValue(message, omitImages); }
function legacyFingerprint(message, omitImages = false) { return fingerprintValue(message, omitImages, true); }
function matchesFingerprint(message, expected, omitImages = false) {
    return typeof expected === 'string' && (fingerprint(message, omitImages) === expected
        || fingerprintValue(message, omitImages, false, false) === expected || legacyFingerprint(message, omitImages) === expected);
}
async function prepare(step, message, context, storage, nextStep) {
    const meta = step?.twitterGrid, guildId = message.guildId || message.guild?.id;
    if (context.providerId !== 'twitter' || !guildId) return { step };
    const settings = context.presentationSettings || {};
    const buttonEnabled = !settings.button_invisible?.all && !settings.button_invisible?.tg && (step.components || []).length < 5;
    storage ||= gallery.store();
    const candidates = [meta, ...(Array.isArray(step.twitterGridInline) ? step.twitterGridInline : [])];
    const grids = [], buttons = [];
    let lockId = null, persistentGroup = false;
    const maxButtons = buttonEnabled ? (5 - (step.components || []).length) * 5 : 0;
    for (const [index, part] of candidates.entries()) {
        if (index > 0 && meta?.totalParts > 1 && !lockId) continue;
        if (!validPart(part) || part.sequence !== 0 || part.totalParts === 1 && part.imageUrls.length < 2) continue;
        // The primary multipart group also needs a record when the combine
        // control is hidden or no component row is available. Existing card
        // actions must not treat its continuation as an unrelated message.
        const canRecordHeadless = index === 0 && part.totalParts > 1;
        if (buttons.length >= maxButtons && !canRecordHeadless) continue;
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
        // Saved-post attachments may be mapped after delivery for a headless
        // record, but a visible combine control must not race that binding.
        const hasSavedAttachments = [...firstRefs, ...otherParts.flatMap(item => item.refs)].some(ref => ref.type === 'attachment');
        const expectedImageUrls = [...part.imageUrls, ...otherParts.flatMap(item => item.metadata.imageUrls)];
        const showButton = buttons.length < maxButtons && !hasSavedAttachments && expectedImageUrls.length >= 2;
        if (!showButton && !canRecordHeadless) continue;
        const id = randomBytes(16).toString('hex');
        if (expectedImageUrls.length > 20) continue;
        const sourceEmbed = (step.embeds || [])[Number.isInteger(part.embedStart) ? part.embedStart : 0];
        const sourceStatusId = require('./providers/twitter/twitterSourceParser/fxTwitter')._internal.statusIdentity(sourceEmbed?.url);
        const payload = { id, kind: 'twitter-image-grid-v1', ...(sourceStatusId ? { sourceStatusId } : {}), imageUrls: [], expectedImageUrls,
            expectedRefs: [...firstRefs, ...otherParts.flatMap(item => item.refs)], initialImageUrls: [...part.imageUrls],
            isPrimary: index === 0, ...(showButton ? {} : { headless: true }), ...(canRecordHeadless || persistentGroup ? { persistentParts: true } : {}),
            totalParts: part.totalParts, completedParts: 0, messageIds: [], partSizes: [],
            partContainsNonImage: [], partSignatures: [], firstStaticSignature: null,
            partsState: 'pending', pendingAtMs: null,
            sharedInline: step.twitterGridSharedInline === true || Array.isArray(step.twitterGridInline) && step.twitterGridInline.length > 0,
            embedStart: Number.isInteger(part.embedStart) ? part.embedStart : null,
            embedEnd: Number.isInteger(part.embedEnd) ? part.embedEnd : null,
            lockId: lockId || id,
            partRefs: [],
            requesterId: /^\d{16,22}$/.test(String(context.gridRequesterId || '')) ? String(context.gridRequesterId) : String(message.author?.id || message.user?.id || ''),
            nsfw: isNsfwChannel(message), nsfwContextVersion: 1, settingsHash: safetyHash(settings), settingsPolicyHash: safetyPolicyHash(settings) };
        try {
            await storage.save(payload, message, 'twitter');
            lockId ||= id;
            if (canRecordHeadless) persistentGroup = true;
            grids.push(payload);
            if (showButton) buttons.push(gridButton(id, settings.defaultLanguage, index));
        }
        catch (error) { gallery.report(error); }
    }
    const primary = grids.find(grid => grid.isPrimary && grid.persistentParts);
    const located = primary ? attachActionLocator(step, primary.id) : meta?.totalParts > 1 ? withoutUnlinkedActions(step) : step;
    if (!buttons.length) return grids.length ? { step: located, grids } : { step: located };
    const rows = [...(located.components || [])];
    for (let i = 0; i < buttons.length; i += 5) rows.push({ type: 1, components: buttons.slice(i, i + 5) });
    return { step: { ...located, components: rows }, grids };
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
    if (!physicalPart(part) || !expectedNext(grid, part) || Number.isInteger(part.sequence) && part.sequence !== 0
        || grid.completedParts !== 0 || grid.messageIds.length !== 0) return false;
    const refs = grid.expectedRefs.slice(0, part.imageUrls.length);
    let urls;
    try { urls = resolveReferences(refs, sent); } catch { return false; }
    await storage.bind(grid.id, sent.id, grid.persistentParts === true);
    const actualRefs = refs.map((ref, n) => ref.type === 'attachment' ? { ...ref, initialUrl: urls[n] } : ref);
    const next = { ...grid, imageUrls: [...part.imageUrls], partRefs: [actualRefs], completedParts: 1,
        totalParts: Math.max(grid.totalParts, Number.isInteger(part.totalParts) ? part.totalParts : 1),
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
    if (!grid || !sent?.id || !physicalPart(part) || !expectedNext(grid, part)
        || Number.isInteger(part.sequence) && part.sequence !== grid.completedParts
        || grid.partsState !== 'pending' || grid.completedParts >= 20 || grid.messageIds.length !== grid.completedParts
        || grid.messageIds.includes(String(sent.id))) return false;
    const refs = grid.expectedRefs.slice(grid.imageUrls.length, grid.imageUrls.length + part.imageUrls.length);
    let urls;
    try { urls = resolveReferences(refs, sent); } catch { return false; }
    const actualRefs = refs.map((ref, n) => ref.type === 'attachment' ? { ...ref, initialUrl: urls[n] } : ref);
    const completed = grid.completedParts + 1;
    const next = { ...grid, partRefs: [...grid.partRefs, actualRefs], imageUrls: [...grid.imageUrls, ...part.imageUrls], completedParts: completed,
        totalParts: Math.max(grid.totalParts, Number.isInteger(part.totalParts) ? part.totalParts : completed,
            completed + Number(grid.imageUrls.length + part.imageUrls.length < grid.expectedImageUrls.length)),
        messageIds: [...grid.messageIds, String(sent.id)], partSizes: [...grid.partSizes, part.imageUrls.length],
        partContainsNonImage: [...grid.partContainsNonImage, part.containsNonImage === true],
        partSignatures: [...grid.partSignatures, fingerprint(sent)] };
    const result = await db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=? AND message_id=? AND BINARY payload_json=BINARY ?',
        [JSON.stringify(next), grid.id, grid.messageIds[0], JSON.stringify(grid)]);
    if (Number(result?.affectedRows) !== 1) return false;
    Object.assign(grid, next); return true;
}
async function finish(grid, db = require('./db')) {
    if (!grid || grid.partsState !== 'pending' || !Array.isArray(grid.expectedImageUrls) || grid.expectedImageUrls.length < (grid.headless ? 0 : 2)
        || grid.expectedImageUrls.length > 20 || !Array.isArray(grid.imageUrls) || grid.imageUrls.length > grid.expectedImageUrls.length
        || grid.imageUrls.some((url, index) => url !== grid.expectedImageUrls[index])
        || grid.completedParts < 1 || grid.completedParts > 20 || grid.messageIds.length !== grid.completedParts
        || new Set(grid.messageIds).size !== grid.messageIds.length || grid.partRefs.length !== grid.completedParts
        || grid.partSizes.length !== grid.completedParts || grid.partContainsNonImage.length !== grid.completedParts
        || grid.partSignatures.length !== grid.completedParts || grid.partSizes.reduce((sum, count) => sum + count, 0) !== grid.imageUrls.length)
        throw new Error('GRID_MANIFEST_INVALID');
    if (grid.imageUrls.length < grid.expectedImageUrls.length || grid.completedParts < grid.totalParts) return { state: 'pending' };
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
function sourceProvider(message) {
    return require('./providerIdentity').detectProviderIdFromMessage(message);
}
const localLocks = new Map();
async function withLocalLock(key, work) {
    let state = localLocks.get(key);
    if (!state) { state = { tail: Promise.resolve(), count: 0 }; localLocks.set(key, state); }
    if (state.count >= 8) throw new Error('GRID_LOCK_UNAVAILABLE');
    const previous = state.tail;
    let release = () => {}, timer;
    const turn = new Promise(resolve => { release = () => resolve(undefined); });
    state.tail = previous.then(() => turn);
    state.count++;
    try {
        await Promise.race([previous, new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('GRID_LOCK_UNAVAILABLE')), 20000);
            timer.unref?.();
        })]);
        return await work();
    } finally {
        clearTimeout(timer); release(); state.count--;
        if (!state.count && localLocks.get(key) === state) localLocks.delete(key);
    }
}
// Shared exclusion for restoration and legacy controls. Callers must still
// validate current Discord messages and permissions, and persist any intent
// on an independent connection before making an external change.
async function withGalleryLock(scope, work, db = require('./db')) {
    const { galleryId, guildId, channelId, messageId } = scope || {};
    if (!/^[a-f0-9]{32}$/.test(galleryId || '')
        || ![guildId, channelId, messageId].every(value => /^\d{1,25}$/.test(String(value || ''))))
        throw new Error('GRID_LOCK_UNAVAILABLE');
    return withLocalLock(`${guildId}:${channelId}:${messageId}`, () => db.withDatabaseTransaction(async query => {
        const initial = await query('SELECT message_id,payload_json,provider_id FROM bot_media_galleries WHERE gallery_id=? AND guild_id=? AND channel_id=? AND expires_at_ms>? LIMIT 1',
            [galleryId, guildId, channelId, Date.now()]);
        if (!initial[0] || initial[0].provider_id !== 'twitter' || String(initial[0].message_id) !== String(messageId)) throw new Error('GRID_LOCK_UNAVAILABLE');
        let first; try { first = JSON.parse(initial[0].payload_json); } catch { throw new Error('GRID_LOCK_UNAVAILABLE'); }
        if (first.kind !== 'twitter-image-grid-v1' || first.id !== galleryId || !/^[a-f0-9]{32}$/.test(first.lockId || ''))
            throw new Error('GRID_LOCK_UNAVAILABLE');
        const roots = await query('SELECT message_id,provider_id FROM bot_media_galleries WHERE gallery_id=? AND guild_id=? AND channel_id=? AND expires_at_ms>? FOR UPDATE',
            [first.lockId, guildId, channelId, Date.now()]);
        if (!roots[0] || roots[0].provider_id !== 'twitter' || String(roots[0].message_id) !== String(messageId)) throw new Error('GRID_LOCK_UNAVAILABLE');
        const rows = await query('SELECT * FROM bot_media_galleries WHERE gallery_id=? AND guild_id=? AND channel_id=? AND expires_at_ms>? FOR UPDATE',
            [galleryId, guildId, channelId, Date.now()]);
        if (!rows[0] || rows[0].provider_id !== 'twitter' || String(rows[0].message_id) !== String(messageId)) throw new Error('GRID_LOCK_UNAVAILABLE');
        let payload; try { payload = JSON.parse(rows[0].payload_json); } catch { throw new Error('GRID_LOCK_UNAVAILABLE'); }
        if (payload.kind !== 'twitter-image-grid-v1' || payload.id !== galleryId || payload.lockId !== first.lockId)
            throw new Error('GRID_LOCK_UNAVAILABLE');
        if (typeof db.queryDatabaseIndependent !== 'function') throw new Error('GRID_LOCK_UNAVAILABLE');
        const journals = await db.queryDatabaseIndependent('SELECT operation_id,payload_json,guild_id,channel_id,message_id FROM bot_twitter_grid_action_intents WHERE gallery_id=? LIMIT 1', [payload.lockId]);
        let journal = null;
        if (journals[0]) {
            try { journal = { operationId: journals[0].operation_id, payload: JSON.parse(journals[0].payload_json),
                guildId: String(journals[0].guild_id), channelId: String(journals[0].channel_id), messageId: String(journals[0].message_id) }; }
            catch { throw new Error('GRID_LOCK_UNAVAILABLE'); }
        }
        return work({ query, db, row: rows[0], payload, journal, scope: { galleryId, guildId, channelId, messageId }, lockId: payload.lockId });
    }));
}
async function withMessageLock(interaction, work, db = require('./db'), options = {}) {
    const visibleId = gridIdFromMessage(interaction.message);
    const locatorId = locatorIdFromAction(interaction.customId);
    if (typeof interaction.customId === 'string' && interaction.customId.includes(':sl1:') && !locatorId)
        throw new Error('GRID_LOCK_UNAVAILABLE');
    if (!interaction.guildId || !interaction.channelId || !visibleId && !locatorId && !options.action) return work();
    const messageId = String(interaction.message.id || ''), before = fingerprint(interaction.message);
    if (!visibleId && !locatorId) {
        let provider = sourceProvider(interaction.message);
        if (!provider) {
            if (!interaction.channel?.messages?.fetch) throw new Error('GRID_LOCK_UNAVAILABLE');
            try {
                const latest = await interaction.channel.messages.fetch({ message: messageId, force: true });
                if (latest?.author?.id === interaction.client?.user?.id) provider = sourceProvider(latest);
            } catch { throw new Error('GRID_LOCK_UNAVAILABLE'); }
            if (!provider) throw new Error('GRID_LOCK_UNAVAILABLE');
        }
        if (provider !== 'twitter') return work();
    }
    const result = await withLocalLock(`${interaction.guildId}:${interaction.channelId}:${messageId}`, async () => {
    let headlessId;
    if (!visibleId && !locatorId) {
        let candidates;
        try {
            candidates = await db.queryDatabase('SELECT gallery_id,payload_json FROM bot_media_galleries FORCE INDEX (idx_media_galleries_locator) WHERE guild_id=? AND channel_id=? AND message_id=? AND provider_id=? AND expires_at_ms>?',
                [interaction.guildId, interaction.channelId, messageId, 'twitter', Date.now()]);
        } catch { throw new Error('GRID_LOCK_UNAVAILABLE'); }
        const matching = [];
        for (const candidate of candidates) {
            let data; try { data = JSON.parse(candidate.payload_json); } catch { throw new Error('GRID_LOCK_UNAVAILABLE'); }
            // Gateway snapshots may omit the grid button even for a visible
            // gallery. The bound message ID, scope and primary row identify
            // it without guessing at neighboring posts.
            if (data.kind === 'twitter-image-grid-v1' && data.isPrimary === true) matching.push(candidate.gallery_id);
        }
        if (!matching.length) return work();
        if (matching.length !== 1) throw new Error('GRID_LOCK_UNAVAILABLE');
        [headlessId] = matching;
    }
    return db.withDatabaseTransaction(async query => {
        let id = locatorId || visibleId || headlessId;
        const rows = await query('SELECT message_id,payload_json,provider_id FROM bot_media_galleries WHERE gallery_id=? AND guild_id=? AND channel_id=? LIMIT 1',
            [id, interaction.guildId, interaction.channelId]);
        // If all saved metadata is already gone, no grid edit can begin.
        if (!rows[0] || rows[0].provider_id !== 'twitter') throw new Error('GRID_LOCK_UNAVAILABLE');
        let payload = JSON.parse(rows[0].payload_json);
        if (payload.kind !== 'twitter-image-grid-v1' || !/^[a-f0-9]{32}$/.test(payload.lockId || '') || String(rows[0].message_id || '') !== messageId) throw new Error('GRID_LOCK_UNAVAILABLE');
        const locks = await query('SELECT message_id,payload_json,provider_id FROM bot_media_galleries WHERE gallery_id=? AND guild_id=? AND channel_id=? FOR UPDATE',
            [payload.lockId, interaction.guildId, interaction.channelId]);
        if (!locks[0] || locks[0].provider_id !== 'twitter') throw new Error('GRID_LOCK_UNAVAILABLE');
        if (String(locks[0].message_id || '') !== messageId) throw new Error('GRID_LOCK_UNAVAILABLE');
        const lockId = payload.lockId;
        // A quoted image group can have the only visible grid button while
        // the actual split parent is recorded headlessly. Legacy actions
        // operate on the shared post, so resolve its primary group first.
        if (options.action && locks[0].payload_json) {
            const root = JSON.parse(locks[0].payload_json);
            if (root.kind === 'twitter-image-grid-v1' && root.id === lockId && root.isPrimary === true) id = lockId;
        }
        const refreshed = await query('SELECT message_id,payload_json,provider_id FROM bot_media_galleries WHERE gallery_id=? AND guild_id=? AND channel_id=? FOR UPDATE',
            [id, interaction.guildId, interaction.channelId]);
        if (!refreshed[0] || refreshed[0].provider_id !== 'twitter' || String(refreshed[0].message_id || '') !== messageId) throw new Error('GRID_LOCK_UNAVAILABLE');
        payload = JSON.parse(refreshed[0].payload_json);
        if (payload.kind !== 'twitter-image-grid-v1' || payload.id !== id || payload.lockId !== lockId) throw new Error('GRID_LOCK_UNAVAILABLE');
        const legacy = require('./twitterGridLegacyActions');
        const recovered = options.action ? await legacy.recover({ interaction, payload, query, db }) : null;
        if (options.revalidate) await options.revalidate();
        const current = await (options.channel || interaction.channel).messages.fetch({ message: messageId, force: true });
        if (current?.author?.id !== interaction.client?.user?.id || visibleId && gridIdFromMessage(current) !== visibleId) throw new Error('GRID_SOURCE_CHANGED');
        if (!options.action && fingerprint(current) !== before) throw new Error('GRID_SOURCE_CHANGED');
        if (recovered && recovered.action !== options.action) return { error: new Error('GRID_OPERATION_RECOVERED'), intent: recovered, safeClear: true };
        if (recovered && recovered.action === options.action && recovered.steps.some(step => step.type === 'edit' && step.index === 0)) {
            await interaction.editReply({ content: String(interaction.locale || '').startsWith('ja') ? '投稿の表示を更新しました。' : 'The post display was updated.', ephemeral: true });
            return { intent: recovered };
        }
        const actionId = options.actionId || interaction.customId || options.action;
        if (options.action && !require('./components/twitterGridConfirm')._internal.buttonExists(current, actionId)) throw new Error('GRID_SOURCE_CHANGED');
        const currentSignature = fingerprint(current);
        let isOriginal = matchesFingerprint(current, payload.partSignatures?.[0]);
        // The marker may be visible only through the verified embed URL.
        // The author, scoped gallery row and static fingerprint are checked
        // around this evidence before an existing action is allowed.
        const marker = !!require('./discordGridMarkers').get(current, id);
        let isReplaced = marker && matchesFingerprint(current, payload.firstStaticSignature, true);
        if (!isOriginal && !isReplaced && payload.sharedInline) {
            const reconciled = await require('./components/twitterGrid')._internal.reconcileSibling(interaction,
                { ...refreshed[0], payload }, { db, freshAccess: options.freshAccess, getSettings: options.getSettings });
            if (reconciled) {
                payload = reconciled.payload;
                isOriginal = matchesFingerprint(current, payload.partSignatures?.[0]);
                isReplaced = marker && matchesFingerprint(current, payload.firstStaticSignature, true);
            }
        }
        if (!isOriginal && !isReplaced) throw new Error('GRID_SOURCE_CHANGED');
        if (options.expectedFingerprint) {
            if (options.galleryId !== id || currentSignature !== options.expectedFingerprint) throw new Error('GRID_SOURCE_CHANGED');
        } else if (before !== currentSignature) {
            throw Object.assign(new Error('GRID_SOURCE_CHANGED'), { code: 'GRID_SNAPSHOT_MISMATCH', galleryId: id });
        }
        // A gateway interaction can contain a partial/stale representation of
        // the message. All following operations use the verified REST copy.
        interaction.message = current;
        if (options.expiresAt && (options.now || Date.now)() >= options.expiresAt) throw new Error('GRID_SOURCE_CHANGED');
        if (options.getButtons) options.buttons = options.getButtons();
        const action = options.action;
        if (action && ['delete', 'showMediaAsAttachments', 'showAttachmentsAsEmbedsImage', 'translate'].includes(action)) {
            return legacy.run({ interaction, current, payload, query, work, options, db, recovered });
        }
        return { value: await work() };
    });
    });
    if ((!result?.error || result.safeClear) && result?.intent && typeof db.queryDatabaseIndependent === 'function') {
        await db.queryDatabaseIndependent('DELETE FROM bot_twitter_grid_action_intents WHERE gallery_id=? AND operation_id=?',
            [result.intent.lockId, result.intent.operationId]);
    }
    if (result?.error) throw result.error;
    return result?.value;
}
module.exports = { safetyHash, safetyPolicyHash, matchesSafetyPolicy, validPart, references, resolveReferences, prepare, bind, append, finish, markIncomplete, discardUnbound, gridButton, fingerprint, legacyFingerprint, matchesFingerprint, embedFingerprint, matchesEmbedFingerprint, attachmentList, cleanEmbed, gridIdFromMessage, locatorIdFromAction, withMessageLock, withGalleryLock };

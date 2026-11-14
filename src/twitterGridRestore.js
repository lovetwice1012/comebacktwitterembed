'use strict';

// Helpers for restoring a publicly combined X image group. A CDN image alone
// is never proof that the original post is still public.
const { validateTwitterMediaUrl } = require('./providers/twitter/twitterSourceParser/mediaUrlPolicy');
const { statusIdentity } = require('./providers/twitter/twitterSourceParser/fxTwitter')._internal;
const { createHash } = require('node:crypto');
const { DiscordAPIError, RateLimitError } = require('discord.js');
const NOT_SUBMITTED = Symbol('restore-not-submitted');
function notSubmitted() { return Object.assign(new Error('GRID_RESTORE_NOT_SUBMITTED'), { [NOT_SUBMITTED]: true }); }
const cards = require('./twitterGridCards');
const gridMarkers = require('./discordGridMarkers');
const { logicalAttachments } = require('./discordAttachmentIdentity');

function photoIdentity(value) {
    try {
        const { url } = validateTwitterMediaUrl(value, 'photo');
        const match = /^\/media\/([A-Za-z0-9_-]+)(?:\.(?:jpe?g|png|webp|avif))?(?::(?:orig|large|medium|small|thumb))?$/i.exec(url.pathname);
        return match?.[1] || null;
    } catch { return null; }
}

// The public post, not untrusted caller input, supplies the candidate status.
// Existing records are accepted only when exactly one image embed points at
// this group's verified composite marker and has an ordinary X status URL.
function statusFromCombined(payload, message) {
    if (!payload || !/^[a-f0-9]{32}$/.test(payload.id || '') || payload.replacePhase !== 'done') return null;
    // Discord omits uploads referenced by an embed from message.attachments.
    // The scoped marker collector validates the CDN channel/id/name and
    // requires one unambiguous embedded image for this gallery.
    const marker = gridMarkers.get(message, payload.id);
    if (!marker || marker.embedIndices.length !== 1) return null;
    const source = cards.cleanEmbed(message.embeds[marker.embedIndices[0]]).url;
    const id = statusIdentity(source);
    if (!id || payload.sourceStatusId && payload.sourceStatusId !== id) return null;
    return { id, url: `https://x.com/i/web/status/${id}` };
}

function statusFromPartial(payload, message) {
    const archive = payload?.restoreArchive, continuation = payload?.restoreContinuation;
    const next = continuation?.nextIndex, target = continuation?.targetCount ?? archive?.imageUrls?.length;
    if (!archive || !continuation || !Number.isInteger(next) || !Number.isInteger(target) || next < 1 || next >= target
        || !/^\d{1,22}$/.test(archive.sourceStatusId || '')
        || continuation.sourceStatusId !== archive.sourceStatusId || payload.sourceStatusId !== archive.sourceStatusId
        || !Array.isArray(archive.imageUrls) || archive.imageUrls.length > 20 || target > archive.imageUrls.length
        || !Array.isArray(payload.imageUrls) || payload.imageUrls.length !== next
        || payload.imageUrls.some((url, i) => url !== archive.imageUrls[i])
        || !Array.isArray(payload.partRefs) || !Array.isArray(payload.messageIds) || !payload.messageIds.length
        || payload.messageIds.some(id => !/^\d{1,25}$/.test(String(id || ''))) || new Set(payload.messageIds).size !== payload.messageIds.length
        || payload.partRefs.length !== payload.messageIds.length || payload.partRefs.some(refs => !Array.isArray(refs))
        || !Array.isArray(payload.partSizes) || payload.partSizes.length !== payload.messageIds.length
        || payload.partSizes.some((size, index) => !Number.isInteger(size) || size < 1 || size > 10 || size !== payload.partRefs[index].length)
        || !Array.isArray(payload.partContainsNonImage) || payload.partContainsNonImage.length !== payload.messageIds.length
        || payload.partContainsNonImage.some(value => typeof value !== 'boolean')
        || payload.partRefs.flat().length !== next || payload.partRefs.flat().some((ref, i) => ref?.type !== 'url' || ref.url !== payload.imageUrls[i])
        || String(message?.id || '') !== payload.messageIds[0]
        || !Array.isArray(payload.partSignatures) || payload.partSignatures.length !== payload.messageIds.length
        || payload.partSignatures.some(value => !/^[a-f0-9]{64}$/.test(value || '')) || !cards.matchesFingerprint(message, payload.partSignatures[0])) return null;
    return { id: archive.sourceStatusId, url: `https://x.com/i/web/status/${archive.sourceStatusId}` };
}

function validArchive(payload, statusId) {
    const archive = payload?.restoreArchive;
    if (!archive) return true;
    return archive.sourceStatusId === statusId && Array.isArray(archive.imageUrls) && archive.imageUrls.length <= 20
        && Array.isArray(payload.imageUrls) && payload.imageUrls.length <= archive.imageUrls.length
        && payload.imageUrls.every((url, index) => url === archive.imageUrls[index]) && archive.imageUrls.every(photoIdentity);
}

function explicitlyFalse(value) { return value === false || value === 0 || value === 'false'; }
function sensitive(value) {
    return value === true || typeof value === 'number' && value > 0
        || typeof value === 'string' && /^(?:true|yes|1|sensitive|nsfw|adult)$/i.test(value.trim());
}

function explicitlyRestricted(tweet) {
    const keys = ['possibly_sensitive', 'possiblySensitive', 'sensitive', 'is_sensitive', 'isSensitive', 'nsfw', 'adult_content', 'adultContent'];
    return sensitive(tweet?.author?.protected) || sensitive(tweet?.user?.protected) || sensitive(tweet?.protected) || sensitive(tweet?.user_protected)
        || keys.some(key => sensitive(tweet?.[key])) || sensitive(tweet?.community?.is_nsfw)
        || (Array.isArray(tweet?.media_extended) && tweet.media_extended.some(media => keys.some(key => sensitive(media?.[key]))));
}

// A successful, identity-matched upstream response must explicitly establish
// that the post is public and not sensitive. We restore only images which were
// already present in the stored, policy-filtered gallery, in their old order.
function verifySource(status, payload, tweet) {
    if (!status || !/^\d{1,22}$/.test(status.id || '') || !tweet || typeof tweet !== 'object'
        || statusIdentity(tweet.tweetURL || tweet.url) !== status.id
        || String(tweet.tweetID || tweet.id || '') !== status.id) return null;
    const author = tweet.author || tweet.user;
    const protectedFlag = author?.protected ?? tweet.user_protected ?? tweet.protected;
    const sensitivityFlag = tweet.possibly_sensitive ?? tweet.possiblySensitive;
    const media = Array.isArray(tweet.media_extended) ? tweet.media_extended : [];
    const sensitiveKeys = ['possibly_sensitive', 'possiblySensitive', 'sensitive', 'is_sensitive', 'isSensitive', 'nsfw', 'adult_content', 'adultContent'];
    if (!explicitlyFalse(protectedFlag) || !explicitlyFalse(sensitivityFlag)
        || sensitiveKeys.some(k => sensitive(tweet[k])) || media.some(item => sensitiveKeys.some(k => sensitive(item?.[k])))
        || sensitive(tweet.community?.is_nsfw)) return null;
    if (!Array.isArray(payload?.imageUrls) || payload.imageUrls.length < 2 || payload.imageUrls.length > 20
        || !Array.isArray(tweet.mediaURLs)) return null;
    const upstream = tweet.mediaURLs.map(photoIdentity);
    const expected = payload.imageUrls.map(photoIdentity);
    if (expected.some(id => !id) || new Set(expected).size !== expected.length) return null;
    let cursor = 0;
    for (const id of expected) {
        const next = upstream.indexOf(id, cursor);
        if (next < 0) return null;
        cursor = next + 1;
    }
    return [...payload.imageUrls];
}

async function fetchVerifiedSource(status, payload, dependencies = {}) {
    if (!status || !/^\d{1,22}$/.test(status.id || '') || status.url !== `https://x.com/i/web/status/${status.id}`)
        throw new Error('GRID_RESTORE_SOURCE');
    const getPlan = dependencies.resolvePlan || require('./adminSupport/providerSources').resolvePlan;
    const fetch = dependencies.fetch || require('./providerFetch').withDeadline(require('node-fetch'));
    const parser = require('./providers/twitter/twitterSourceParser');
    const plan = await getPlan('twitter');
    for (const source of plan.sources || []) {
        // Only endpoints registered in the existing provider policy may be
        // used. No caller-controlled URL, redirect or unbounded body.
        if (!require('./adminSupport/providerSources').REGISTRY.twitter.sources.some(registered => registered.id === source.id && registered.origin === source.origin)) continue;
        let response;
        try {
            const remaining = Number.isSafeInteger(dependencies.deadlineAtMs) ? dependencies.deadlineAtMs - Date.now() : 15000;
            if (remaining < 1) throw new Error('GRID_RESTORE_TIMEOUT');
            response = await fetch(`${source.origin}/i/status/${status.id}`, { timeout: Math.min(15000, remaining), size: 4 * 1024 * 1024, redirect: 'manual' });
            if ([401, 403, 404, 410].includes(Number(response.status))) throw Object.assign(new Error('GRID_RESTORE_SOURCE'), { code: 'GRID_RESTORE_DENIED' });
            if (!response.ok) continue;
            const tweet = parser.parseTweetApiResponse(await response.text(), status.url);
            const returnedId = String(tweet?.tweetID || tweet?.id || '');
            if (explicitlyRestricted(tweet) || returnedId && returnedId !== status.id)
                throw Object.assign(new Error('GRID_RESTORE_SOURCE'), { code: 'GRID_RESTORE_DENIED' });
            const images = verifySource(status, payload, tweet);
            if (images) return images;
        } catch (error) {
            // An upstream denial is not permission to try a less restrictive
            // source. A transient error or absent metadata may try the next
            // endpoint selected by the existing policy.
            if (error?.code === 'GRID_RESTORE_DENIED' || parser.isExpectedNonExpandableTweetError(error)) throw new Error('GRID_RESTORE_SOURCE');
        } finally { response?.body?.destroy?.(); }
    }
    throw new Error('GRID_RESTORE_SOURCE');
}

function restoreChoices(imageCount, isLast, locale, rootCapacity = 10) {
    if (!Number.isInteger(imageCount) || imageCount < 1 || imageCount > 20) throw new Error('GRID_RESTORE_COUNT');
    const ja = String(locale || '').startsWith('ja');
    if (isLast || imageCount < 10 && rootCapacity >= imageCount) return [{ value: 'here', label: ja ? '元の画像に戻す' : 'Restore original images' }];
    if (imageCount <= 10) return [
        rootCapacity >= imageCount
            ? { value: 'here', label: ja ? '元の画像に戻す' : 'Restore original images' }
            : { value: 'rest', label: ja ? '元に戻し、残りを新しく投稿' : 'Restore here and post the rest' },
        { value: 'new', label: ja ? 'すべて新しく展開' : 'Expand all in new messages' },
    ];
    return [
        { value: 'first', label: ja ? '最初の10枚を戻す' : 'Restore the first 10 images' },
        { value: 'rest', label: ja ? '10枚を戻し、残りを新しく投稿' : 'Restore 10 and post the rest' },
        { value: 'new', label: ja ? 'すべて新しく展開' : 'Expand all in new messages' },
    ];
}

function planRestore(urls, mode, isLast, continuation) {
    if (!Array.isArray(urls) || urls.length < 1 || urls.length > 20 || urls.some(value => !photoIdentity(value))) throw new Error('GRID_RESTORE_COUNT');
    if (mode === 'resume') {
        const start = continuation?.nextIndex ?? 10, end = continuation?.targetCount ?? urls.length;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || start >= end || end > urls.length) throw new Error('GRID_RESTORE_MODE');
        const sends = []; for (let i = start; i < end; i += 10) sends.push(urls.slice(i, Math.min(end, i + 10)));
        return { edit: [], sends };
    }
    if (mode === 'new') return { edit: [], sends: [urls.slice(0, 10), urls.slice(10)].filter(group => group.length) };
    // A limited shared message may need a continuation even for ten or
    // fewer images. The private menu explicitly offers this destination.
    if (mode === 'rest' && !isLast && urls.length <= 10) return { edit: urls, sends: [] };
    if (!restoreChoices(urls.length, isLast, 'en').some(choice => choice.value === mode)) throw new Error('GRID_RESTORE_MODE');
    if (mode === 'first') return { edit: urls.slice(0, 10), sends: [] };
    return { edit: urls.slice(0, 10), sends: urls.length > 10 ? [urls.slice(10)] : [] };
}

function splitRestorePlan(urls, mode, isLast, measurements, maxBytes = 80 * 1024 * 1024, continuation, maxFirst = 10) {
    const base = planRestore(urls, mode, isLast, continuation), selected = [base.edit, ...base.sends].flat();
    if (!Number.isInteger(maxFirst) || maxFirst < 1 || maxFirst > 10 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 80 * 1024 * 1024 || !Array.isArray(measurements)
        || measurements.length !== selected.length || measurements.some((item, index) => item?.source !== selected[index]
            || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 25 * 1024 * 1024 || item.size > maxBytes
            || !/^[a-f0-9]{64}$/.test(item.sha256 || '') || !['jpeg', 'png', 'webp', 'avif'].includes(item.format))) throw new Error('GRID_RESTORE_SIZE');
    const groups = [], sizes = new Map(measurements.map(item => [item.source, item.size]));
    if (sizes.size !== selected.length) throw new Error('GRID_RESTORE_FORMAT');
    for (const original of [base.edit, ...base.sends]) {
        let batch = [], bytes = 0;
        for (const url of original) {
            const size = sizes.get(url);
            if (!size) throw new Error('GRID_RESTORE_FORMAT');
            const maxCount = base.edit.length && groups.length === 0 ? maxFirst : 10;
            if (batch.length && (batch.length === maxCount || bytes + size > maxBytes)) { groups.push(batch); batch = []; bytes = 0; }
            batch.push(url); bytes += size;
        }
        if (batch.length) groups.push(batch);
    }
    if (!groups.length || groups.length > 20) throw new Error('GRID_RESTORE_SIZE');
    return base.edit.length ? { edit: groups[0], sends: groups.slice(1) } : { edit: [], sends: groups };
}

function validateRestorePlan(urls, mode, isLast, plan, continuation) {
    let base; try { base = planRestore(urls, mode, isLast, continuation); } catch { return false; }
    if (!plan || !Array.isArray(plan.edit) || !Array.isArray(plan.sends) || plan.sends.length > 20
        || plan.edit.length > 10 || !!plan.edit.length !== !!base.edit.length
        || plan.sends.some(group => !Array.isArray(group) || !group.length || group.length > 10)) return false;
    const groups = [...(plan.edit.length ? [plan.edit] : []), ...plan.sends];
    if (!groups.length || groups.length > 20 || plan.edit.length > base.edit.length) return false;
    return JSON.stringify(groups.flat()) === JSON.stringify([base.edit, ...base.sends].flat());
}

function planFromSizes(urls, mode, sizes, continuation) {
    if (!Array.isArray(sizes) || !sizes.length || sizes.length > 20 || sizes.some(size => !Number.isInteger(size) || size < 1 || size > 10)) throw new Error('GRID_RESTORE_MODE');
    const base = planRestore(urls, mode, mode === 'here', continuation), selected = [base.edit, ...base.sends].flat(), groups = [];
    let offset = 0;
    for (const size of sizes) { groups.push(selected.slice(offset, offset + size)); offset += size; }
    if (offset !== selected.length || groups.some((group, index) => group.length !== sizes[index])) throw new Error('GRID_RESTORE_MODE');
    const plan = base.edit.length ? { edit: groups[0], sends: groups.slice(1) } : { edit: [], sends: groups };
    if (!validateRestorePlan(urls, mode, mode === 'here', plan, continuation)) throw new Error('GRID_RESTORE_MODE');
    return plan;
}

async function measureRestoreImages(urls, limits = {}, dependencies = {}) {
    const media = require('./providers/twitter/safeMedia');
    if (!Array.isArray(urls) || !urls.length || urls.length > 20 || urls.some(url => !photoIdentity(url)) || new Set(urls).size !== urls.length)
        throw new Error('GRID_RESTORE_FORMAT');
    const maxFile = limits.maxPerFileBytes ?? media.MAX_MEDIA_BYTES;
    if (!Number.isSafeInteger(maxFile) || maxFile < 1 || maxFile > media.MAX_MEDIA_BYTES) throw new Error('GRID_RESTORE_SIZE_LIMIT');
    const fetch = dependencies.fetchTwitterMedia || media.fetchTwitterMedia, measurements = [];
    for (const source of urls) {
        const remaining = Number.isSafeInteger(limits.deadlineAtMs) ? limits.deadlineAtMs - Date.now() : 15000;
        if (remaining < 1) throw new Error('GRID_RESTORE_TIMEOUT');
        const item = await fetch(source, { kind: 'photo', maxBytes: maxFile, timeoutMs: Math.min(15000, remaining) });
        if (Buffer.isBuffer(item?.data) && item.data.length > maxFile) throw Object.assign(new Error('GRID_RESTORE_SIZE'), { code: 'TWITTER_MEDIA_TOO_LARGE' });
        if (!Buffer.isBuffer(item?.data) || !item.data.length
            || !['jpeg', 'png', 'webp', 'avif'].includes(item.format) || media.detectTwitterMediaFormat(item.data, 'photo') !== item.format)
            throw new Error('GRID_RESTORE_FORMAT');
        measurements.push({ source, size: item.data.length, format: item.format, sha256: createHash('sha256').update(item.data).digest('hex') });
    }
    return measurements;
}

function restoreView(id, owner, packedState, count, isLast, locale, separateOnly = false, rootCapacity = 10) {
    if (!/^[a-f0-9]{32}$/.test(id || '') || !/^\d{16,22}$/.test(owner || '') || !/^[0-9a-z.]{1,32}$/.test(packedState || ''))
        throw new Error('GRID_RESTORE_MODE');
    const ja = String(locale || '').startsWith('ja');
    const choices = separateOnly ? [{ value: 'new', label: ja ? 'すべて新しく展開' : 'Expand all in new messages' }] : restoreChoices(count, isLast, locale, rootCapacity);
    const action = { here: 'rh', first: 'rf', rest: 'rr', new: 'rn' };
    const limited = Number.isInteger(rootCapacity) && rootCapacity > 0 && rootCapacity < Math.min(10, count);
    return { content: separateOnly ? (ja ? '新しい投稿ですべての画像を戻します。' : 'Restore all images in new messages.')
        : limited ? (ja ? `元の投稿には最大${rootCapacity}枚を戻し、残りは新しい投稿に分けます。` : `Restore up to ${rootCapacity} images in the original message and post the rest separately.`)
            : (ja ? '画像を戻す方法を選んでください。' : 'Choose how to restore the images.'),
        components: [{ type: 1, components: choices.map(choice => ({ type: 2, style: 2, label: choice.label,
            custom_id: `tg:${id}:${owner}:${action[choice.value]}:${packedState}` })) }], allowedMentions: { parse: [] } };
}

async function latestMessageId(channel, scope = null) {
    if (!/^\d{1,25}$/.test(String(channel?.id || '')) || typeof channel?.messages?.fetch !== 'function') throw new Error('GRID_RESTORE_UNAVAILABLE');
    const messages = await channel.messages.fetch({ limit: 1, cache: false });
    const current = typeof messages?.first === 'function' ? messages.first()
        : typeof messages?.values === 'function' ? messages.values().next().value : null;
    if (!current || !/^\d{1,25}$/.test(String(current.id || ''))
        || String(current.channelId || current.channel?.id || '') !== String(channel.id)
        || scope && (channel.id !== scope.channelId || !require('./discordMessageIdentity').isLocated(current, scope))) throw new Error('GRID_RESTORE_UNAVAILABLE');
    return String(current.id);
}

async function adjacency(channel, firstId, secondId, scope = null) {
    if (!/^\d{1,25}$/.test(String(channel?.id || '')) || !/^\d{1,25}$/.test(String(firstId || ''))
        || !/^\d{1,25}$/.test(String(secondId || '')) || BigInt(firstId) >= BigInt(secondId)) return 'unavailable';
    let collection;
    try { collection = await channel.messages.fetch({ around: String(secondId), limit: 100, cache: false }); } catch { return 'unavailable'; }
    const messages = typeof collection?.values === 'function' ? [...collection.values()] : [];
    const ids = messages.map(item => String(item?.id || ''));
    if (ids.some(id => !/^\d{1,25}$/.test(id)) || new Set(ids).size !== ids.length
        || messages.some(item => String(item.channelId || item.channel?.id || '') !== String(channel.id)
            || scope && (channel.id !== scope.channelId || !require('./discordMessageIdentity').isLocated(item, scope)))
        || !ids.includes(String(firstId)) || !ids.includes(String(secondId))) return 'unavailable';
    return ids.some(id => BigInt(id) > BigInt(firstId) && BigInt(id) < BigInt(secondId)) ? 'separated' : 'adjacent';
}

async function prepareRestoredImages(urls, limits = {}, dependencies = {}) {
    const media = require('./providers/twitter/safeMedia');
    const maxTotal = limits.maxTotalBytes ?? 80 * 1024 * 1024;
    const maxFile = limits.maxPerFileBytes ?? media.MAX_MEDIA_BYTES;
    if (!Array.isArray(urls) || !urls.length || urls.length > 10 || urls.some(url => !photoIdentity(url))
        || !Number.isSafeInteger(maxTotal) || maxTotal < 1 || maxTotal > 80 * 1024 * 1024
        || !Number.isSafeInteger(maxFile) || maxFile < 1 || maxFile > media.MAX_MEDIA_BYTES) throw new Error('GRID_RESTORE_FORMAT');
    const fetch = dependencies.fetchTwitterMedia || media.fetchTwitterMedia;
    const result = [];
    let total = 0;
    // A sequential stream reserves the remaining budget before each fetch,
    // rather than allowing concurrent fetches to oversubscribe memory.
    for (const source of urls) {
        const remaining = maxTotal - total;
        if (remaining <= 0) throw new Error('GRID_RESTORE_SIZE');
        const remainingTime = Number.isSafeInteger(limits.deadlineAtMs) ? limits.deadlineAtMs - Date.now() : 15000;
        if (remainingTime < 1) throw new Error('GRID_RESTORE_TIMEOUT');
        const file = await fetch(source, { kind: 'photo', maxBytes: Math.min(maxFile, remaining), timeoutMs: Math.min(15000, remainingTime) });
        if (!Buffer.isBuffer(file?.data) || !file.data.length || file.data.length > remaining || file.data.length > maxFile
            || !['jpeg', 'png', 'webp', 'avif'].includes(file.format)) throw new Error('GRID_RESTORE_FORMAT');
        if (media.detectTwitterMediaFormat(file.data, 'photo') !== file.format) throw new Error('GRID_RESTORE_FORMAT');
        total += file.data.length;
        result.push({ source, data: file.data, format: file.format });
    }
    return result;
}

// A Discord response is a receipt only if every uploaded attachment belongs
// to this exact Bot message and channel. Other attachments may survive only
// when their IDs were explicitly snapshotted before the edit.
function verifyRestoredAttachments(message, scope, files, retainedIds = []) {
    const channelId = String(scope?.channelId || ''), botId = String(scope?.botId || '');
    if (!/^\d{1,25}$/.test(channelId) || !/^\d{1,25}$/.test(botId) || !/^\d{1,25}$/.test(String(message?.id || ''))
        || String(message?.channelId || message?.channel?.id || '') !== channelId || String(message?.author?.id || '') !== botId
        || !Array.isArray(files) || !files.length || files.length > 10 || !Array.isArray(retainedIds)
        || files.some(file => typeof file?.name !== 'string' || !/^restore-[a-f0-9]{32}-\d{1,2}\.(jpg|png|webp|avif)$/.test(file.name))
        || new Set(files.map(file => file.name)).size !== files.length
        || retainedIds.some(id => !/^\d{1,25}$/.test(String(id || '')))) return false;
    const actual = logicalAttachments(message);
    if (!actual) return false;
    const ids = actual.map(file => String(file.id || ''));
    if (ids.some(id => !/^\d{1,25}$/.test(id)) || new Set(ids).size !== ids.length || actual.length !== files.length + retainedIds.length
        || retainedIds.some(id => !ids.includes(String(id))) || new Set(retainedIds.map(String)).size !== retainedIds.length) return false;
    for (const file of files) {
        const matches = actual.filter(item => item.name === file.name);
        if (matches.length !== 1 || retainedIds.map(String).includes(String(matches[0].id || ''))
            || !/^image\/(jpeg|png|webp|avif)$/i.test(matches[0].contentType || '')) return false;
        try {
            const url = new URL(matches[0].url), path = url.pathname.split('/');
            if (url.protocol !== 'https:' || url.username || url.password || url.port
                || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) || path[1] !== 'attachments'
                || path.length !== 5 || path[2] !== channelId || path[3] !== String(matches[0].id || '') || decodeURIComponent(path[4] || '') !== file.name) return false;
        } catch { return false; }
    }
    return true;
}

// Called only after every Discord edit/send and the receipt have been
// independently confirmed. The visible gallery must describe exactly the
// restored files; the full original list stays separate for a later restore.
// A caller handling shared inline quotes must also update every sibling's
// fingerprint and embed witness in the same database transaction.
function restoredManifest(payload, operationId, mode, messages, urls, statusId, groupSizes, allowPartial = false) {
    if (!payload || !/^[a-f0-9]{32}$/.test(payload.id || '') || !/^[a-f0-9]{32}$/.test(operationId || '')
        || !['here', 'first', 'rest'].includes(mode) || !Array.isArray(urls) || !Array.isArray(messages)
        || !/^\d{1,22}$/.test(statusId || '') || payload.sourceStatusId && payload.sourceStatusId !== statusId) throw new Error('GRID_RESTORE_RECORD');
    const visible = payload.imageUrls, archived = payload.restoreArchive?.imageUrls;
    const equal = (a, b) => Array.isArray(a) && a.length === b.length && a.every((value, index) => value === b[index]);
    if (!equal(visible, urls) && !equal(archived, urls)) throw new Error('GRID_RESTORE_RECORD');
    if (archived && (!Array.isArray(visible) || visible.length > archived.length || visible.some((value, index) => value !== archived[index])
        || payload.restoreArchive.sourceStatusId !== statusId)) throw new Error('GRID_RESTORE_RECORD');
    const plan = groupSizes ? planFromSizes(urls, mode, groupSizes) : planRestore(urls, mode, mode === 'here');
    const plannedGroups = [plan.edit, ...plan.sends], groups = plannedGroups.slice(0, messages.length);
    if (!messages.length || messages.length > plannedGroups.length || !allowPartial && messages.length !== plannedGroups.length
        || String(messages[0]?.id || '') !== String(payload.messageIds?.[0] || '')
        || new Set(messages.map(message => String(message?.id || ''))).size !== messages.length) throw new Error('GRID_RESTORE_RECORD');
    let offset = 0;
    for (let part = 0; part < groups.length; part++) {
        const files = logicalAttachments(messages[part]);
        if (!files) throw new Error('GRID_RESTORE_RECORD');
        for (let i = 0; i < groups[part].length; i++) {
            const expected = new RegExp(`^restore-${operationId}-${offset + i}\\.(jpg|png|webp|avif)$`);
            const matching = files.filter(file => expected.test(file.name || '') && /^\d{1,25}$/.test(String(file.id || ''))
                && /^image\/(jpeg|png|webp|avif)$/i.test(file.contentType || ''));
            if (matching.length !== 1) throw new Error('GRID_RESTORE_RECORD');
        }
        offset += groups[part].length;
    }
    const displayed = groups.flat();
    const { replacePhase, ...unchanged } = payload;
    void replacePhase;
    const targetCount = plannedGroups.flat().length, partial = groups.length < plannedGroups.length;
    const sourceImages = archived || urls, laterAvailable = !partial && mode === 'first' && displayed.length < sourceImages.length;
    return { ...unchanged, imageUrls: displayed, expectedImageUrls: displayed, partRefs: groups.map(group => group.map(url => ({ type: 'url', url }))),
        partSizes: groups.map(group => group.length), completedParts: groups.length, totalParts: groups.length, partsState: 'complete',
        messageIds: messages.map(message => String(message.id)), partSignatures: messages.map(message => cards.fingerprint(message)),
        firstStaticSignature: cards.fingerprint(messages[0], true),
        partContainsNonImage: messages.map(message => cards.attachmentList(message).some(file => !String(file.contentType || '').startsWith('image/'))),
        sourceStatusId: statusId, restoreArchive: { sourceStatusId: statusId, imageUrls: [...sourceImages] },
        ...(partial || laterAvailable ? { restoreContinuation: { sourceStatusId: statusId, nextIndex: displayed.length,
            targetCount: partial ? targetCount : sourceImages.length } } : {}) };
}

function resumedManifest(payload, operationId, first, continuation, allowPartial = false) {
    const existing = Array.isArray(first) ? first : [first], added = Array.isArray(continuation) ? continuation : [continuation];
    if (!statusFromPartial(payload, existing[0]) || !/^[a-f0-9]{32}$/.test(operationId || '') || existing.length !== payload.messageIds.length
        || existing.some((message, index) => String(message?.id || '') !== payload.messageIds[index] || !cards.matchesFingerprint(message, payload.partSignatures[index]))
        || !added.length || added.some(message => !/^\d{1,25}$/.test(String(message?.id || '')))
        || new Set([...existing, ...added].map(message => String(message.id))).size !== existing.length + added.length) throw new Error('GRID_RESTORE_RECORD');
    const start = payload.restoreContinuation.nextIndex, target = payload.restoreContinuation.targetCount ?? payload.restoreArchive.imageUrls.length;
    const remaining = payload.restoreArchive.imageUrls.slice(start, target), addedRefs = [], addedSizes = [];
    let offset = start;
    for (const message of added) {
        const files = cards.attachmentList(message);
        if (!files.length || files.length > 10 || message.content || (message.embeds || []).length || (message.components || []).length) throw new Error('GRID_RESTORE_RECORD');
        for (let i = 0; i < files.length; i++) {
            const pattern = new RegExp(`^restore-${operationId}-${offset + i}\\.(jpg|png|webp|avif)$`);
            if (files.filter(file => pattern.test(file.name || '') && /^\d{1,25}$/.test(String(file.id || ''))
                && /^image\/(jpeg|png|webp|avif)$/i.test(file.contentType || '')).length !== 1) throw new Error('GRID_RESTORE_RECORD');
        }
        addedSizes.push(files.length); addedRefs.push(payload.restoreArchive.imageUrls.slice(offset, offset + files.length).map(url => ({ type: 'url', url })));
        offset += files.length;
    }
    if (offset > target || !allowPartial && offset !== target || addedRefs.flat().length > remaining.length) throw new Error('GRID_RESTORE_RECORD');
    const { restoreContinuation, ...unchanged } = payload;
    void restoreContinuation;
    // Finishing an interrupted "first ten" operation must not discard the
    // separately archived remaining images: expose them for a later explicit
    // continuation, without submitting another message automatically.
    const nextTarget = offset < target ? target : payload.restoreArchive.imageUrls.length;
    return { ...unchanged, imageUrls: payload.restoreArchive.imageUrls.slice(0, offset), expectedImageUrls: payload.restoreArchive.imageUrls.slice(0, offset),
        partRefs: [...payload.partRefs, ...addedRefs], partSizes: [...payload.partSizes, ...addedSizes],
        completedParts: existing.length + added.length, totalParts: existing.length + added.length, partsState: 'complete',
        messageIds: [...existing, ...added].map(message => String(message.id)), partSignatures: [...existing, ...added].map(message => cards.fingerprint(message)),
        firstStaticSignature: cards.fingerprint(existing[0], true), partContainsNonImage: [...payload.partContainsNonImage, ...added.map(() => false)],
        ...(offset < nextTarget ? { restoreContinuation: { sourceStatusId: payload.sourceStatusId, nextIndex: offset, targetCount: nextTarget } } : {}) };
}

// This protocol intentionally requires durable adapters. A plan must commit
// before every Discord call; after an ambiguous response no later action or
// automatic retry is allowed. Adapters must acquire the same shared gallery
// lock used by replacement, re-check permissions and validate Bot authorship.
// The shared action journal records message creation receipts so an
// interrupted restore can be reconciled without submitting a duplicate.
let activeRestorations = 0;
async function withRestorationSlot(work) {
    if (activeRestorations >= 2) return { status: 'busy' };
    activeRestorations++;
    try { return await work(); } finally { activeRestorations--; }
}
async function executeRestore(request, adapters) {
    const required = ['withLock', 'authorize', 'latestMessageId', 'adjacency', 'verifyLiveSource', 'fileLimit', 'measureImages', 'prepareImages', 'preflight', 'begin', 'cancel', 'plan', 'reject', 'confirm', 'finish', 'markUnknown', 'editOnce', 'sendOnce', 'verifyResult'];
    if (!adapters || required.some(name => typeof adapters[name] !== 'function')) throw new Error('GRID_RESTORE_UNAVAILABLE');
    return withRestorationSlot(async () => {
    const now = typeof adapters.now === 'function' ? adapters.now : Date.now;
    const deadlineAtMs = now() + 90000;
    return adapters.withLock(request, async snapshot => {
        if (!snapshot || !snapshot.payload || !snapshot.first || snapshot.first.id !== snapshot.payload.messageIds?.[0]
            || request.id && request.id !== snapshot.payload.id
            || request.owner && request.owner !== String(request.interaction?.user?.id || '')
            || !await adapters.authorize(request, snapshot)) return { status: 'denied' };
        const source = request.mode === 'resume' ? statusFromPartial(snapshot.payload, snapshot.first) : statusFromCombined(snapshot.payload, snapshot.first);
        if (!source || !validArchive(snapshot.payload, source.id)) return { status: 'source_unavailable' };
        const sourcePayload = request.mode === 'resume' ? { ...snapshot.payload, imageUrls: snapshot.payload.restoreArchive.imageUrls } : snapshot.payload;
        const urls = await adapters.verifyLiveSource(source, sourcePayload, deadlineAtMs);
        if (!Array.isArray(urls) || urls.length !== sourcePayload.imageUrls.length
            || urls.some((url, index) => url !== sourcePayload.imageUrls[index])) return { status: 'source_unavailable' };
        const last = await adapters.latestMessageId(snapshot);
        if (!last) return { status: 'unavailable' };
        const fileLimit = await adapters.fileLimit(request, snapshot);
        if (!Number.isSafeInteger(fileLimit) || fileLimit < 1 || fileLimit > require('./providers/twitter/safeMedia').MAX_MEDIA_BYTES) return { status: 'size_limit_unavailable' };
        let plan, measurements, base, maxFirst;
        try { base = planRestore(urls, request.mode, last === snapshot.first.id, snapshot.payload.restoreContinuation); }
        catch { return { status: 'choice_changed' }; }
        try {
            measurements = await adapters.measureImages([base.edit, ...base.sends].flat(), { deadlineAtMs, maxPerFileBytes: fileLimit });
            if (Array.isArray(measurements) && measurements.some(item => Number.isSafeInteger(item?.size) && item.size > fileLimit))
                return { status: 'image_too_large', fileLimit };
            maxFirst = base.edit.length && typeof adapters.rootCapacity === 'function' ? await adapters.rootCapacity(request, snapshot) : 10;
            plan = splitRestorePlan(urls, request.mode, last === snapshot.first.id, measurements, 80 * 1024 * 1024, snapshot.payload.restoreContinuation, maxFirst);
            const confirmationMode = request.mode === 'first' || request.mode === 'resume' && snapshot.payload.restoreContinuation?.targetCount <= 10;
            if (confirmationMode && request.confirmedSizes) {
                const selected = planFromSizes(urls, request.mode, request.confirmedSizes, snapshot.payload.restoreContinuation);
                const sizesByUrl = new Map(measurements.map(item => [item.source, item.size]));
                if (selected.edit.length > maxFirst || [selected.edit, ...selected.sends].some(group =>
                    group.reduce((sum, url) => sum + (sizesByUrl.get(url) || Infinity), 0) > 80 * 1024 * 1024)) return { status: 'choice_changed' };
                plan = selected;
            }
        }
        catch (error) {
            if (error?.code === 'TWITTER_MEDIA_TOO_LARGE' || error?.message === 'GRID_RESTORE_SIZE') return { status: 'image_too_large', fileLimit };
            return { status: 'unavailable' };
        }
        const sizes = [plan.edit.length, ...plan.sends.map(group => group.length)].filter(Boolean);
        const digestFor = groupSizes => createHash('sha256').update(JSON.stringify({ mode: request.mode, sizes: groupSizes,
            images: measurements.map(({ source, size, format, sha256 }) => ({ source, size, format, sha256 })) })).digest('hex');
        const planDigest = digestFor(sizes);
        const confirmationMode = request.mode === 'first' || request.mode === 'resume' && snapshot.payload.restoreContinuation?.targetCount <= 10;
        const extraPosts = request.mode === 'first' ? plan.sends.length : confirmationMode ? Math.max(0, plan.sends.length - 1) : 0;
        if (extraPosts && request.confirmedPlan !== planDigest)
            return { status: 'confirm_split', mode: request.mode, sizes, planDigest };
        if (request.mode === 'first' && plan.sends.length) request = { ...request, splitConfirmed: true };
        if (!await adapters.preflight(request, snapshot, plan)) return { status: 'unavailable' };
        const groups = [];
        if (plan.edit.length) groups.push({ type: 'edit', start: 0, count: plan.edit.length });
        let offset = request.mode === 'resume' ? snapshot.payload.restoreContinuation.nextIndex : plan.edit.length;
        for (const urlsForMessage of plan.sends) {
            groups.push({ type: 'send', start: offset, count: urlsForMessage.length });
            offset += urlsForMessage.length;
        }
        const media = require('./providers/twitter/safeMedia');
        async function prepare(group) {
            const selected = urls.slice(group.start, group.start + group.count);
            if (now() >= deadlineAtMs) throw new Error('GRID_RESTORE_TIMEOUT');
            const files = await adapters.prepareImages(selected, { maxTotalBytes: 80 * 1024 * 1024, maxPerFileBytes: fileLimit, concurrency: 2, deadlineAtMs });
            if (!Array.isArray(files) || files.length !== selected.length
                || files.reduce((total, file) => total + (Buffer.isBuffer(file?.data) ? file.data.length : 0), 0) > 80 * 1024 * 1024) throw new Error('GRID_RESTORE_SIZE');
            // Verify the exact source-to-bytes mapping before a Discord call.
            if (files.some((file, index) => {
                if (!file || file.source !== selected[index] || !Buffer.isBuffer(file.data) || !file.data.length || file.data.length > fileLimit) return true;
                const measured = measurements.find(item => item.source === file.source);
                try { return media.detectTwitterMediaFormat(file.data, 'photo') !== file.format || !measured || measured.size !== file.data.length
                    || measured.format !== file.format || measured.sha256 !== createHash('sha256').update(file.data).digest('hex'); } catch { return true; }
            })) throw new Error('GRID_RESTORE_FORMAT');
            return files;
        }
        let firstFiles;
        try { firstFiles = await prepare(groups[0]); } catch { return { status: 'unavailable' }; }
        const operation = await adapters.begin(request, snapshot, plan, source);
        if (!operation || !/^[a-f0-9]{32}$/.test(operation.id || '')) return { status: 'unavailable' };
        let requireAdjacent = request.mode === 'here' && groups.length > 1;
        let completed = 0, previousId = snapshot.first.id;
        const stop = async status => {
            // With no request planned, cancellation is safe. Once any change
            // has been confirmed, preserve the journal for reconciliation.
            if (!completed) await adapters.cancel(operation);
            return { status: completed ? 'partial' : status, completed };
        };
        for (let index = 0; index < groups.length; index++) {
            const group = groups[index];
            if (now() >= deadlineAtMs) return stop('unavailable');
            if (!await adapters.authorize(request, snapshot)) return stop('denied');
            if (requireAdjacent && await adapters.latestMessageId(snapshot) !== previousId)
                return stop('choice_changed');
            let prepared;
            try { prepared = index === 0 && firstFiles ? firstFiles : await prepare(group); firstFiles = null; }
            catch { return stop('unavailable'); }
            if (!await adapters.authorize(request, snapshot)) return stop('denied');
            if (requireAdjacent && await adapters.latestMessageId(snapshot) !== previousId)
                return stop('choice_changed');
            let verified;
            try { verified = await adapters.verifyLiveSource(source, sourcePayload, deadlineAtMs); }
            catch { return stop('source_unavailable'); }
            if (!Array.isArray(verified) || verified.length !== urls.length || verified.some((url, position) => url !== urls[position]))
                return stop('source_unavailable');
            const files = prepared.map((file, position) => {
                const extension = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif' }[file.format];
                if (!extension) throw new Error('GRID_RESTORE_FORMAT');
                return { ...file, name: `restore-${operation.id}-${group.start + position}.${extension}` };
            });
            const proofs = files.map(file => ({ name: file.name, sha256: createHash('sha256').update(file.data).digest('hex') }));
            const evidence = typeof adapters.prepareIntent === 'function' ? await adapters.prepareIntent(request, snapshot, group, files, operation) : null;
            // No network mutation may occur until this durable plan commits.
            await adapters.plan(operation, { index, type: group.type, start: group.start, count: group.count, previousId, proofs, evidence });
            // The journal write may wait on the database. Re-check the source,
            // authorization, current post and channel tail after that wait,
            // immediately before allowing any Discord submission.
            let rejection = null;
            try {
                const currentSource = await adapters.verifyLiveSource(source, sourcePayload, deadlineAtMs);
                if (!Array.isArray(currentSource) || currentSource.length !== urls.length || currentSource.some((url, position) => url !== urls[position])) rejection = 'source_unavailable';
                else if (!await adapters.authorize(request, snapshot)) rejection = 'denied';
                else if (requireAdjacent && await adapters.latestMessageId(snapshot) !== previousId) rejection = 'choice_changed';
                else if (now() >= deadlineAtMs) rejection = 'unavailable';
            } catch { rejection = 'unavailable'; }
            if (rejection) { await adapters.reject(operation, index); return stop(rejection); }
            let result, submissionReturned = false;
            try {
                result = group.type === 'edit' ? await adapters.editOnce(request, snapshot, files, operation)
                    : await adapters.sendOnce(request, snapshot, files, operation, index);
                submissionReturned = true;
                if (!await adapters.verifyResult(request, snapshot, group, files, result, operation)) throw new Error('GRID_RESTORE_RESULT_UNKNOWN');
                await adapters.confirm(operation, { index, type: group.type, messageId: result.id });
            } catch (error) {
                if (!submissionReturned && error instanceof DiscordAPIError && error.status === 413) {
                    // Persist proof of a definitive rejection before changing the
                    // plan. A lost database acknowledgement must never lead to
                    // an automatic re-submission of this group.
                    try { await adapters.markRejected413(operation, index); }
                    catch { await adapters.markUnknown(operation, { index, completed }).catch(() => {}); return { status: 'unknown', completed }; }
                    if (group.count === 1) {
                        try { await adapters.reject(operation, index); return stop('discord_upload_too_large'); }
                        catch { await adapters.markUnknown(operation, { index, completed }).catch(() => {}); return { status: 'unknown', completed }; }
                    }
                    const left = Math.ceil(group.count / 2), replacement = [left, group.count - left];
                    if (confirmationMode) {
                        try {
                            await adapters.reject(operation, index);
                            if (completed) return stop('choice_changed');
                            await adapters.cancel(operation);
                            const nextSizes = [...sizes]; nextSizes.splice(index, 1, ...replacement);
                            return { status: 'confirm_split', mode: request.mode, sizes: nextSizes, planDigest: digestFor(nextSizes) };
                        } catch { await adapters.markUnknown(operation, { index, completed }).catch(() => {}); return { status: 'unknown', completed }; }
                    }
                    if (typeof adapters.repartition !== 'function') { await adapters.markUnknown(operation, { index, completed }).catch(() => {}); return { status: 'unknown', completed }; }
                    try { await adapters.repartition(operation, index, replacement); }
                    catch { await adapters.markUnknown(operation, { index, completed }).catch(() => {}); return { status: 'unknown', completed }; }
                    groups.splice(index, 1, { ...group, count: replacement[0] },
                        { type: 'send', start: group.start + replacement[0], count: replacement[1] });
                    plan = planFromSizes(urls, request.mode, groups.map(value => value.count), snapshot.payload.restoreContinuation);
                    if (request.mode === 'here') requireAdjacent = true;
                    index--; continue;
                }
                // A verified Discord 4xx response is a definitive rejection
                // from our single-attempt client. Network and parse failures
                // remain unknown even if they carry a misleading status.
                if (!submissionReturned && (error?.[NOT_SUBMITTED] === true || error instanceof RateLimitError
                    || error instanceof DiscordAPIError && Number.isInteger(error.status) && error.status >= 400 && error.status < 500)) {
                    try { await adapters.reject(operation, index); return stop('rejected'); }
                    catch { /* A failed journal write is itself uncertain. */ }
                }
                // Do not repeat or guess an edit/send whose acknowledgement or
                // durable receipt may have been lost.
                await adapters.markUnknown(operation, { index, completed }).catch(() => {});
                return { status: 'unknown', completed };
            }
            const priorId = previousId;
            previousId = result.id;
            completed++;
            if (requireAdjacent && group.type === 'send') {
                const order = await adapters.adjacency(snapshot, priorId, previousId);
                if (order !== 'adjacent') return { status: order === 'separated' ? 'separated' : 'order_unverified', completed };
            }
        }
        await adapters.finish(operation, request, snapshot, plan);
        return { status: 'done', completed };
    });
    });
}

module.exports = { photoIdentity, statusFromCombined, statusFromPartial, validArchive, verifySource, fetchVerifiedSource, restoreChoices, planRestore, splitRestorePlan, validateRestorePlan, planFromSizes, measureRestoreImages, restoreView, latestMessageId, adjacency, prepareRestoredImages, verifyRestoredAttachments, restoredManifest, resumedManifest, notSubmitted, withRestorationSlot, executeRestore };

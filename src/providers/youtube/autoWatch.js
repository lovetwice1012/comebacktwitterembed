'use strict';

const {
    HOUR,
    MINUTE,
    conditionalHeaders,
    dateMs,
    dedupeItems,
    monitorError,
    requestText,
    sourceError,
    urlFromInput,
} = require('../autoWatch/_shared');
const { xmlValue, parseFeedEntries, channelIdFromHtml, parseUploadsPlaylist } = require('./youtubeSourceParser');

function normalizeSource(input) {
    const raw = String(input || '').trim();
    if (!raw) throw sourceError('YouTube requires a channel ID, handle, or channel URL.');
    let key;
    if (/^UC[A-Za-z0-9_-]{20,}$/i.test(raw)) key = `channel:${raw}`;
    else if (/^@[A-Za-z0-9._-]{3,}$/i.test(raw)) key = `handle:${raw.slice(1).toLowerCase()}`;
    else {
        const url = urlFromInput(raw);
        if (!url || !/(^|\.)youtube\.com$/i.test(url.hostname)) throw sourceError('YouTube source must be a youtube.com channel URL.');
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts[0] === 'channel' && /^UC[A-Za-z0-9_-]{20,}$/i.test(parts[1] || '')) key = `channel:${parts[1]}`;
        else if (/^@[A-Za-z0-9._-]{3,}$/i.test(parts[0] || '')) key = `handle:${parts[0].slice(1).toLowerCase()}`;
        else throw sourceError('Use a YouTube channel ID (/channel/UC...) or @handle URL.');
    }
    const [kind, value] = key.split(':', 2);
    return { sourceKey: key, sourceUrl: kind === 'channel' ? `https://www.youtube.com/channel/${value}` : `https://www.youtube.com/@${value}` };
}

function feedItems(xml) {
    return dedupeItems(parseFeedEntries(xml).map(entry => {
        const videoId = entry.videoId;
        return {
            contentId: videoId,
            url: videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` : null,
            publishedAtMs: dateMs(entry.published),
            title: entry.title,
        };
    }));
}

async function resolveChannelId(source, context) {
    if (/^UC[A-Za-z0-9_-]{20,}$/i.test(source.state?.channelId || '')) return source.state.channelId;
    const [kind, value] = String(source.source_key).split(':', 2);
    if (kind === 'channel') return value;
    if (kind !== 'handle') throw sourceError('Invalid saved YouTube source key.');
    const response = await requestText(context, `https://www.youtube.com/@${encodeURIComponent(value)}`, {
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Mozilla/5.0 (compatible; ComebackTwitterEmbed/1.0)' },
    });
    const channelId = channelIdFromHtml(response.body);
    if (!channelId) throw monitorError('AUTO_WATCH_SOURCE_NOT_FOUND', 'YouTube handle could not be resolved to a public channel.', { retryAfterMs: 6 * HOUR });
    return channelId;
}

async function fetch(source, context) {
    const channelId = await resolveChannelId(source, context);
    const excluded = new Set(Array.isArray(source.state?.fallbackExcludedIds) ? source.state.fallbackExcludedIds : []);
    const rssSource = source.state?.fetchMode === 'uploads' ? { ...source, etag: null, last_modified: null } : source;
    let response;
    try {
        response = await requestText(context, `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, {
            headers: conditionalHeaders(rssSource, { Accept: 'application/atom+xml,application/xml,text/xml', 'User-Agent': 'Mozilla/5.0 (compatible; ComebackTwitterEmbed/1.0)' }),
        });
        if (!response.notModified && (!/<feed\b/i.test(response.body) || xmlValue(response.body, 'yt:channelId') && xmlValue(response.body, 'yt:channelId') !== channelId)) {
            throw monitorError('AUTO_WATCH_INVALID_RESPONSE', 'YouTube did not return the requested channel feed.');
        }
    } catch (error) {
        if (error.code === 'AUTO_WATCH_RATE_LIMITED' || !([404, 500, 502, 503, 504].includes(error.status) || error.code === 'AUTO_WATCH_INVALID_RESPONSE')) throw error;
        return await fetchUploads(source, context, channelId, excluded);
    }
    const state = { ...(source.state || {}), channelId };
    if (response.notModified) return { notModified: true, state, etag: response.etag, lastModified: response.lastModified, rateLimit: response.rateLimit };
    state.fetchMode = 'rss';
    return { items: feedItems(response.body).filter(item => !excluded.has(item.contentId)), state, etag: response.etag, lastModified: response.lastModified, rateLimit: response.rateLimit };
}

async function fetchUploads(source, context, channelId, excluded) {
    if (!context.config.enableGuestCrawls) throw monitorError('AUTO_WATCH_GUEST_CRAWL_DISABLED', 'Public uploads fallback is disabled.');
    const response = await requestText(context, `https://www.youtube.com/playlist?list=UU${encodeURIComponent(channelId.slice(2))}&hl=en`, {
        headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    const uploads = parseUploadsPlaylist(response.body, channelId);
    if (!uploads) throw monitorError('AUTO_WATCH_INVALID_RESPONSE', 'YouTube uploads could not be verified for this channel.');
    let items = dedupeItems(uploads.map(item => ({ contentId: item.videoId, title: item.title,
        url: `https://www.youtube.com/watch?v=${item.videoId}`, publishedAtMs: null })));
    if (source.initialized_at_ms) {
        let cursor;
        try { cursor = typeof source.cursor_json === 'string' ? JSON.parse(source.cursor_json) : source.cursor_json; } catch { cursor = null; }
        const known = new Set([...(cursor?.seenContentIds || []), ...excluded]);
        const pending = new Set((cursor?.deferredObservations || []).map(entry => entry[0]));
        const anchor = items.findIndex(item => known.has(item.contentId));
        // Different representations expose different history windows. Only
        // items ahead of a known upload are new. An unanchored first fallback
        // becomes a quiet baseline, including when RSS recovers later.
        const older = anchor < 0 ? items : items.slice(anchor + 1);
        for (const item of older) if (!pending.has(item.contentId)) excluded.add(item.contentId);
        items = items.filter((item, index) => anchor >= 0 && index <= anchor || pending.has(item.contentId));
    }
    return { items: items.filter(item => !excluded.has(item.contentId)),
        state: { ...(source.state || {}), channelId, fetchMode: 'uploads', fallbackExcludedIds: [...excluded].slice(-5000) },
        etag: null, lastModified: null, rateLimit: response.rateLimit };
}

module.exports = {
    id: 'youtube',
    label: 'YouTube',
    guestOnly: true,
    minPollMs: 15 * MINUTE,
    defaultPollMs: 30 * MINUTE,
    globalSpacingMs: 5000,
    requestCost: 3,
    normalizeSource,
    fetch,
    _internal: { feedItems, normalizeSource, resolveChannelId, xmlValue },
};

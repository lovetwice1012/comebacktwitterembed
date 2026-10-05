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
const { xmlValue, parseFeedEntries, channelIdFromHtml } = require('./youtubeSourceParser');

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
    const response = await requestText(context, `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, {
        headers: conditionalHeaders(source, { Accept: 'application/atom+xml,application/xml,text/xml', 'User-Agent': 'Mozilla/5.0 (compatible; ComebackTwitterEmbed/1.0)' }),
    });
    const state = { ...(source.state || {}), channelId };
    if (response.notModified) return { notModified: true, state, etag: response.etag, lastModified: response.lastModified, rateLimit: response.rateLimit };
    return { items: feedItems(response.body), state, etag: response.etag, lastModified: response.lastModified, rateLimit: response.rateLimit };
}

module.exports = {
    id: 'youtube',
    label: 'YouTube',
    guestOnly: true,
    minPollMs: 15 * MINUTE,
    defaultPollMs: 30 * MINUTE,
    globalSpacingMs: 5000,
    requestCost: 1,
    normalizeSource,
    fetch,
    _internal: { feedItems, normalizeSource, resolveChannelId, xmlValue },
};

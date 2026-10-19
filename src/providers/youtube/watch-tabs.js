'use strict';

const { requestText, monitorError, dedupeItems } = require('../autoWatch/_shared');
const { readHtmlProjection } = require('../autoWatch/streaming');
const { parseInitialData } = require('./youtubeSourceParser');
const CONTENT = ['contents', 'twoColumnBrowseResultsRenderer', 'tabs', '*', 'tabRenderer', 'content', '**'];
const PATHS = [
    ['metadata', 'channelMetadataRenderer', 'externalId'],
    ['contents', 'twoColumnBrowseResultsRenderer', 'tabs', '*', 'tabRenderer', 'selected'],
    ['contents', 'twoColumnBrowseResultsRenderer', 'tabs', '*', 'tabRenderer', 'endpoint', 'commandMetadata', 'webCommandMetadata', 'url'],
    ...[['playlistId'], ['videoCount'], ['title', 'simpleText'], ['title', 'runs', '*', 'text'],
        ['navigationEndpoint', 'watchEndpoint', 'videoId'], ['videos', '*', 'childVideoRenderer', 'videoId']]
        .map(path => [...CONTENT, 'playlistRenderer', ...path]),
    ...[['contentId'], ['contentType'], ['metadata', 'lockupMetadataViewModel', 'title', 'content'],
        ['rendererContext', 'commandContext', 'onTap', 'innertubeCommand', 'watchPlaylistEndpoint', 'playlistId']]
        .map(path => [...CONTENT, 'lockupViewModel', ...path]),
    ...[['postId'], ['authorEndpoint', 'browseEndpoint', 'browseId'], ['contentText', 'runs', '*', 'text'], ['contentText', 'simpleText']]
        .map(path => [...CONTENT, 'backstagePostRenderer', ...path]),
    [...CONTENT, 'messageRenderer', 'text', 'runs', '*', 'text'],
];
const textOf = value => String(value?.simpleText || value?.runs?.map(run => run.text || '').join('') || '');
const invalid = () => monitorError('AUTO_WATCH_INVALID_RESPONSE', 'YouTube channel tab could not be verified.');

function parseTab(html, channelId, lane) {
    let data;
    try { data = parseInitialData(html); } catch { throw invalid(); }
    if (data?.metadata?.channelMetadataRenderer?.externalId !== channelId) throw invalid();
    const tabs = (data?.contents?.twoColumnBrowseResultsRenderer?.tabs || []).map(tab => tab.tabRenderer).filter(Boolean);
    const suffix = lane === 'releases' ? /\/releases(?:\?|$)/ : /\/(?:posts|community)(?:\?|$)/;
    const tab = tabs.find(tab => suffix.test(tab.endpoint?.commandMetadata?.webCommandMetadata?.url || ''));
    // Ordinary channels need not have either optional tab. A redirected or
    // consent page cannot masquerade as a successful empty observation.
    if (!tab) {
        if (!tabs.some(tab => tab.selected === true)) throw invalid();
        return [];
    }
    if (tab.selected !== true || !tab.content) throw invalid();
    const items = [];
    let recognized = false;
    function visit(node) {
        if (!node || typeof node !== 'object') return;
        if (node.messageRenderer && textOf(node.messageRenderer.text)) recognized = true;
        if (lane === 'community' && node.backstagePostRenderer) {
            const post = node.backstagePostRenderer;
            recognized = true;
            if (!/^Ug[A-Za-z0-9_-]{10,200}$/.test(post.postId || '')) throw invalid();
            if (post.authorEndpoint?.browseEndpoint?.browseId !== channelId) return;
            const body = textOf(post.contentText).slice(0, 65536);
            items.push({ contentId: `post:${post.postId}`, url: `https://www.youtube.com/post/${post.postId}`,
                title: body.slice(0, 1024) || 'コミュニティ投稿', body, publishedAtMs: null, youtubeContentKind: 'community' });
            return;
        }
        if (lane === 'releases' && (node.playlistRenderer || node.lockupViewModel)) {
            const card = node.playlistRenderer || node.lockupViewModel;
            if (node.lockupViewModel && card.contentType !== 'LOCKUP_CONTENT_TYPE_PLAYLIST') return;
            recognized = true;
            const playlistId = card.playlistId || card.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchPlaylistEndpoint?.playlistId || card.contentId;
            if (!/^[A-Za-z0-9_-]{18,200}$/.test(playlistId || '')) throw invalid();
            const videoId = card.navigationEndpoint?.watchEndpoint?.videoId || card.videos?.[0]?.childVideoRenderer?.videoId;
            const title = textOf(card.title) || card.metadata?.lockupMetadataViewModel?.title?.content || '新しいリリース';
            const singleVideo = String(card.videoCount) === '1' && /^[\w-]{11}$/.test(videoId || '');
            // Singles retain the regular video expansion. Albums notify once
            // using their complete playlist rather than just their lead track.
            items.push({ contentId: singleVideo ? videoId : `release:${playlistId}`,
                url: singleVideo ? `https://www.youtube.com/watch?v=${videoId}` : `https://www.youtube.com/playlist?list=${playlistId}`, title: String(title).slice(0, 1024),
                publishedAtMs: null, youtubeContentKind: 'release', youtubePlaylistId: playlistId });
            return;
        }
        for (const child of Object.values(node)) visit(child);
    }
    visit(tab.content);
    if (!recognized) throw invalid();
    return dedupeItems(items);
}

async function fetchTabs(source, context, base) {
    const channelId = base.state.channelId, state = { ...base.state, youtubeTabs: { ...base.state.youtubeTabs } };
    const items = [...(base.items || [])], baselineItems = [], videoIds = new Set(items.map(item => item.contentId));
    const lanes = { releases: source.youtube_fetch_releases == null || Number(source.youtube_fetch_releases) === 1,
        community: Number(source.youtube_fetch_community || 0) === 1 };
    for (const [lane, enabled] of Object.entries(lanes)) {
        if (!enabled) { state.youtubeTabs[lane] = { initialized: false }; continue; }
        if (!context.config.enableGuestCrawls) {
            // The existing crawl kill switch must not interrupt working RSS
            // notifications. Re-enable tabs with a quiet baseline afterwards.
            state.youtubeTabs[lane] = { initialized: false };
            continue;
        }
        const response = await requestText(context, `https://www.youtube.com/channel/${channelId}/${lane === 'community' ? 'posts' : 'releases'}?hl=en`, {
            headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' },
            readBody: response => readHtmlProjection(response, { markers: ['ytInitialData'], paths: PATHS }),
        });
        const discovered = parseTab(response.body, channelId, lane);
        if (!source.state?.youtubeTabs?.[lane]?.initialized) baselineItems.push(...discovered.filter(item => !videoIds.has(item.contentId)));
        items.push(...discovered);
        state.youtubeTabs[lane] = { initialized: true };
    }
    // Even RSS 304 must not skip tab discovery or its quiet initial baseline.
    return { ...base, notModified: !!base.notModified && !items.length && !baselineItems.length, items: dedupeItems(items), baselineItems: dedupeItems(baselineItems), state,
        etag: base.etag ?? (base.notModified ? source.etag : null),
        lastModified: base.lastModified ?? (base.notModified ? source.last_modified : null) };
}

module.exports = { fetchTabs, parseTab, PATHS };

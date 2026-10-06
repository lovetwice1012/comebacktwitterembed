'use strict';

function xmlValue(fragment, name) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(fragment || '').match(new RegExp(`<${escaped}>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
    return match ? match[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'").replace(/&quot;/g, '"') : null;
}

function parseFeedEntries(xml) {
    const entries = String(xml || '').match(/<entry>[\s\S]*?<\/entry>/gi) || [];
    return entries.map(entry => ({
        videoId: xmlValue(entry, 'yt:videoId'),
        published: xmlValue(entry, 'published'),
        title: xmlValue(entry, 'title'),
    }));
}

function channelIdFromHtml(html) {
    return html.match(/"channelId":"(UC[A-Za-z0-9_-]{20,})"/)?.[1] || null;
}

module.exports = { xmlValue, parseFeedEntries, channelIdFromHtml };

function parseUploadsPlaylist(html, channelId) {
    let data;
    try { data = require('./pageData').parseInitialData(html); } catch { return null; }
    if (!data) return null;
    let visits = 0;
    function find(value, key, depth = 0) {
        if (!value || typeof value !== 'object' || depth > 50 || ++visits > 50000) return null;
        if (value[key]) return value[key];
        for (const child of Object.values(value)) { const result = find(child, key, depth + 1); if (result) return result; }
        return null;
    }
    const header = find(data, 'playlistHeaderRenderer');
    if (!header?.ownerText?.runs?.some(run => run.navigationEndpoint?.browseEndpoint?.browseId === channelId)) return null;
    const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs;
    const content = tabs?.find(tab => tab.tabRenderer?.selected)?.tabRenderer?.content;
    if (!content) return null;
    const items = []; visits = 0;
    function collect(value, depth = 0) {
        if (!value || typeof value !== 'object' || depth > 50 || ++visits > 50000) return;
        const legacy = value.playlistVideoRenderer;
        const modern = value.lockupViewModel;
        const id = legacy?.videoId || (modern?.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' ? modern.contentId : null);
        if (/^[A-Za-z0-9_-]{11}$/.test(id || '')) {
            const title = legacy?.title?.simpleText || legacy?.title?.runs?.map(run => run.text || '').join('')
                || modern?.metadata?.lockupMetadataViewModel?.title?.content || '';
            items.push({ videoId: id, title });
            return;
        }
        for (const child of Object.values(value)) collect(child, depth + 1);
    }
    collect(content);
    // Do not treat a consent/error page or unknown renderer as an empty baseline.
    return items.length && visits <= 50000 ? items : null;
}

module.exports.parseUploadsPlaylist = parseUploadsPlaylist;

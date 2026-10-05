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

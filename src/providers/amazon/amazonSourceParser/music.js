'use strict';

const {
    cleanText,
    absoluteUrl,
    readMetaContent,
    truncate,
    extractAttr,
    readTitleTag,
    escapeRegExp,
    firstCleanText,
} = require('./html');
const { findJsonLdByType, thingName, DEFAULT_DESCRIPTION_MAX_LENGTH, imageFromValue, thingNames } = require('./metadata');
const { srcSetCandidates, sourceTypePriority, widthFromImageUrl } = require('./images');

const AMAZON_MUSIC_ROUTE_LABELS = {
    albums: 'Album',
    tracks: 'Track',
    artists: 'Artist',
    playlists: 'Playlist',
    podcasts: 'Podcast',
    'podcast-episodes': 'Podcast episode',
    'live/events': 'Live event',
    stations: 'Station',
};

function cleanAmazonMusicTitle(value) {
    return cleanText(value)
        .replace(/^Amazon Music\s*-\s*(?:Track|Album|Playlist|Artist|Podcast)\s+/i, '')
        .replace(/\s+on Amazon Music(?: Unlimited)?$/i, '')
        .replace(/\s*-\s*Amazon Music.*$/i, '')
        .trim();
}

function musicTypeLabel(route) {
    return AMAZON_MUSIC_ROUTE_LABELS[route] || 'Music';
}

function isGenericAmazonMusicDescription(value) {
    const text = cleanText(value).toLowerCase();
    return !text
        || text === 'on amazon music'
        || text.startsWith('amazon music embed widget')
        || text === 'stream music and podcasts free on amazon music. no credit card required.';
}

function meaningfulAmazonMusicDescription(...values) {
    for (const value of values) {
        const text = cleanText(value);
        if (text && !isGenericAmazonMusicDescription(text)) return text;
    }
    return '';
}

function splitAmazonMusicTitleAndArtist(value) {
    const text = cleanAmazonMusicTitle(value);
    const parts = text.split(/\s+[–—]\s+/).map(part => part.trim()).filter(Boolean);
    if (parts.length < 2) return { title: text, artist: '' };
    return {
        title: parts[0],
        artist: parts.slice(1).join(' - '),
    };
}

function amazonMusicSeoTitleInfo(value) {
    const text = cleanAmazonMusicTitle(value);
    const match = text.match(/^(.+?)\s+(?:song|track)\s+by\s+(.+?)(?:\s+from\s+(.+?))?\s+on Amazon Music$/i)
        || text.match(/^(.+?)\s+album\s+by\s+(.+?)\s+on Amazon Music$/i);
    if (!match) return {};
    return {
        title: cleanText(match[1]),
        artist: cleanText(match[2]),
        album: cleanText(match[3] || ''),
    };
}

function readInputValueById(html, id) {
    const attr = escapeRegExp(id);
    const tag = html.match(new RegExp(`<input\\b(?=[^>]*\\bid=["']${attr}["'])[^>]*>`, 'i'))?.[0];
    return tag ? cleanText(extractAttr(tag, 'value')) : '';
}

function readAriaLabelValue(html, prefixes) {
    for (const prefix of prefixes) {
        const attr = escapeRegExp(prefix);
        const tag = html.match(new RegExp(`<([a-zA-Z0-9:-]+)\\b(?=[^>]*\\baria-label=["']${attr}\\s*,\\s*([^"']+)["'])[^>]*>([\\s\\S]*?)<\\/\\1>`, 'i'));
        if (!tag) continue;
        const label = cleanText(tag[2]);
        const body = cleanText(tag[3]);
        if (body && body.length <= Math.max(label.length + 20, 80)) return body;
        if (label) return label;
    }
    return '';
}

function readImageSrcByAlt(html, alt) {
    const attr = escapeRegExp(alt);
    const tag = html.match(new RegExp(`<img\\b(?=[^>]*\\balt=["']${attr}["'])[^>]*>`, 'i'))?.[0];
    return tag ? extractAttr(tag, 'src') : '';
}

function amazonMusicPictureBlocks(html) {
    const blocks = html.match(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi) || [];
    const preferred = blocks.filter(block => /\bclass\s*=\s*["'][^"']*\bimageWrapper\b/i.test(block));
    return preferred.length > 0 ? preferred : blocks;
}

function readAmazonMusicDetailImage(html, baseUrl) {
    const candidates = [];
    let order = 0;
    for (const block of amazonMusicPictureBlocks(html)) {
        const imgTag = block.match(/<img\b[^>]*>/i)?.[0] || '';
        const dataSrc = absoluteUrl(extractAttr(imgTag, 'data-src'), baseUrl);
        if (dataSrc) return dataSrc;

        const sourceTags = block.match(/<source\b[^>]*>/gi) || [];
        for (const tag of sourceTags) {
            candidates.push(...srcSetCandidates(
                extractAttr(tag, 'srcset'),
                baseUrl,
                sourceTypePriority(extractAttr(tag, 'type')),
                order
            ));
            order += 100;
        }

        candidates.push(...srcSetCandidates(
            extractAttr(imgTag, 'srcset'),
            baseUrl,
            sourceTypePriority(''),
            order
        ));
        order += 100;

        const imgSrc = absoluteUrl(extractAttr(imgTag, 'src'), baseUrl);
        if (imgSrc) {
            candidates.push({
                url: imgSrc,
                width: widthFromImageUrl(imgSrc),
                density: 1,
                priority: sourceTypePriority(''),
                order,
            });
            order += 100;
        }
    }

    candidates.sort((a, b) => (
        a.priority - b.priority
        || b.width - a.width
        || b.density - a.density
        || a.order - b.order
    ));
    return candidates[0]?.url || '';
}

function formatSecondsDuration(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = Math.floor(seconds % 60);
    const parts = [];
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (rest || parts.length === 0) parts.push(`${rest}s`);
    return parts.join(' ');
}

function formatVerboseDuration(value) {
    const match = cleanText(value).match(/\b(?:(\d+)\s+HOURS?\s+)?(?:(\d+)\s+MINUTES?\s+)?(?:(\d+)\s+SECONDS?)\b/i);
    if (!match) return '';
    const seconds = (Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0);
    return formatSecondsDuration(seconds);
}

function readAmazonMusicVisibleMeta(html) {
    const text = cleanText(html);
    const match = text.match(/\b((?:(?:\d+)\s+HOURS?\s+)?(?:(?:\d+)\s+MINUTES?\s+)?(?:(?:\d+)\s+SECONDS?))(?:\s*[•|]\s*([A-Z]{3}\s+\d{1,2}\s+\d{4}|\d{4}))?/i);
    if (!match) return { duration: '', date: '' };
    return {
        duration: formatVerboseDuration(match[1]),
        date: cleanText(match[2] || ''),
    };
}

function extractAmazonMusicHtmlInfo(html, parsed) {
    const ogTitle = readMetaContent(html, 'og:title') || readMetaContent(html, 'twitter:title');
    const splitTitle = splitAmazonMusicTitleAndArtist(ogTitle);
    const seoTitle = amazonMusicSeoTitleInfo(readTitleTag(html));
    const visibleMeta = readAmazonMusicVisibleMeta(html);
    const oembedTitle = cleanAmazonMusicTitle(readTitleTag(html).replace(/^Amazon Music\s*-\s*/i, ''));

    return {
        title: firstCleanText(
            readAriaLabelValue(html, ['song', 'track', musicTypeLabel(parsed.route).toLowerCase()]),
            seoTitle.title,
            splitTitle.title,
            oembedTitle
        ),
        description: meaningfulAmazonMusicDescription(
            readMetaContent(html, 'og:description'),
            readMetaContent(html, 'twitter:description'),
            readMetaContent(html, 'description')
        ),
        imageUrl: absoluteUrl(
            readAmazonMusicDetailImage(html, parsed.canonicalUrl)
            || readImageSrcByAlt(html, 'Cover Art')
            || readMetaContent(html, 'og:image')
            || readMetaContent(html, 'twitter:image'),
            parsed.canonicalUrl
        ),
        artist: firstCleanText(
            readAriaLabelValue(html, ['artist']),
            seoTitle.artist,
            splitTitle.artist
        ),
        album: firstCleanText(
            readInputValueById(html, 'ALBUM_TITLE'),
            readAriaLabelValue(html, ['album']),
            seoTitle.album
        ),
        date: visibleMeta.date,
        duration: formatSecondsDuration(readMetaContent(html, 'music:duration')) || visibleMeta.duration,
    };
}

function extractAmazonMusicInfo(html, parsed, descriptionMaxLength = DEFAULT_DESCRIPTION_MAX_LENGTH, supplement = {}) {
    const music = findJsonLdByType(
        html,
        ['MusicAlbum', 'MusicRecording', 'MusicGroup', 'PodcastSeries', 'PodcastEpisode', 'Playlist', 'Event', 'CreativeWork'],
        node => node.name && (node.image || node.byArtist || node.author)
    ) || {};
    const htmlInfo = extractAmazonMusicHtmlInfo(html, parsed);
    const oembed = supplement.oembed || {};

    const oembedTitle = cleanAmazonMusicTitle(oembed.title || '');
    const title = firstCleanText(
        music.name,
        htmlInfo.title,
        oembedTitle
    );
    const artist = firstCleanText(
        htmlInfo.artist,
        thingNames(music.byArtist || music.artist || music.author || music.creator).join(', ')
    );
    const album = firstCleanText(
        htmlInfo.album,
        thingName(music.inAlbum || music.album || music.partOfAlbum)
    );
    const description = truncate(
        meaningfulAmazonMusicDescription(
            music.description,
            htmlInfo.description,
            oembed.description
        ),
        descriptionMaxLength
    );
    const imageUrl = absoluteUrl(
        imageFromValue(music.image)
        || htmlInfo.imageUrl
        || oembed.thumbnail_url
        || readMetaContent(html, 'og:image')
        || readMetaContent(html, 'twitter:image'),
        parsed.canonicalUrl
    );

    return {
        title,
        description,
        imageUrl,
        musicType: musicTypeLabel(parsed.route),
        artist,
        album,
        date: firstCleanText(music.datePublished, music.releaseDate, htmlInfo.date),
        duration: htmlInfo.duration,
    };
}

module.exports = {
    AMAZON_MUSIC_ROUTE_LABELS,
    extractAmazonMusicInfo,
};

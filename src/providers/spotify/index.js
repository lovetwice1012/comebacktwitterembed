'use strict';

const fetch = require('node-fetch');
const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { recordProviderError } = require('../../errorTracking');

const SPOTIFY_COLOR = 0x1DB954;
const DESCRIPTION_MAX_LENGTH = 350;
const TOP_TRACKS_MAX_COUNT = 5;
const SPOTIFY_URL_PATTERN =
    /https?:\/\/open\.spotify\.com\/(?:intl-[a-zA-Z-]+\/)?(?:track|album|artist)\/[A-Za-z0-9]+(?:\?[^\s<>|]*)?/g;

const STR = {
    openButton: { ja: 'Open in Spotify', en: 'Open in Spotify' },
    showMediaAsAttachmentsButton: { ja: 'Show cover as attachment', en: 'Show cover as attachment' },
    deleteButton: { ja: 'Delete', en: 'Delete' },
    artistField: { ja: 'Artist', en: 'Artist' },
    tracksField: { ja: 'Tracks', en: 'Tracks' },
    topTracksField: { ja: 'Top tracks', en: 'Top tracks' },
    durationField: { ja: 'Duration', en: 'Duration' },
    releaseDateField: { ja: 'Release date', en: 'Release date' },
    previewField: { ja: 'Preview', en: 'Preview' },
    previewAttached: { ja: 'Attached below', en: 'Attached below' },
    requesterPrefix: { ja: 'Requested by ', en: 'Requested by ' },
    anonRequester: { ja: 'Anonymous requester', en: 'Anonymous requester' },
    fallbackTitle: { ja: 'Spotify track #', en: 'Spotify track #' },
    fallbackAlbumTitle: { ja: 'Spotify album #', en: 'Spotify album #' },
    fallbackArtistTitle: { ja: 'Spotify artist #', en: 'Spotify artist #' },
};

function tr(spec, lang) {
    if (typeof spec === 'string') return spec;
    return spec[lang] ?? spec.en ?? '';
}

function parseSpotifyUrl(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch { return null; }
    if (u.hostname !== 'open.spotify.com') return null;

    const parts = u.pathname.split('/').filter(Boolean);
    let idx = 0;
    if (parts[0] && /^intl-[a-zA-Z-]+$/.test(parts[0])) idx = 1;
    const type = parts[idx];
    if (!['track', 'album', 'artist'].includes(type) || !parts[idx + 1]) return null;

    const id = parts[idx + 1];
    if (!/^[A-Za-z0-9]+$/.test(id)) return null;
    return { type, id };
}

const parseSpotifyTrackUrl = parseSpotifyUrl;

function extractNextData(html) {
    const startTag = '<script id="__NEXT_DATA__" type="application/json">';
    const start = html.indexOf(startTag);
    if (start === -1) return null;
    const from = start + startTag.length;
    const end = html.indexOf('</script>', from);
    if (end === -1) return null;
    return JSON.parse(html.slice(from, end));
}

async function fetchText(url, headers) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`spotify fetch ${res.status} for ${url}`);
    return await res.text();
}

async function fetchJson(url, headers) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`spotify fetch ${res.status} for ${url}`);
    return await res.json();
}

function spotifyHeaders() {
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };
}

function pickLargestImage(images) {
    if (!Array.isArray(images) || images.length === 0) return null;
    const sorted = images
        .filter(img => img && typeof img.url === 'string' && img.url)
        .sort((a, b) => (b.maxWidth || b.width || 0) - (a.maxWidth || a.width || 0));
    return sorted[0] || null;
}

function artistIdFromUri(uri) {
    if (typeof uri !== 'string') return null;
    const parts = uri.split(':');
    return parts[0] === 'spotify' && parts[1] === 'artist' ? parts[2] : null;
}

function trackIdFromUri(uri) {
    if (typeof uri !== 'string') return null;
    const parts = uri.split(':');
    return parts[0] === 'spotify' && parts[1] === 'track' ? parts[2] : null;
}

function normalizeTrackList(trackList) {
    if (!Array.isArray(trackList)) return [];
    return trackList
        .map(track => ({
            id: trackIdFromUri(track?.uri),
            title: track?.title || track?.name,
            subtitle: track?.subtitle,
            durationMs: typeof track?.duration === 'number' ? track.duration : null,
        }))
        .filter(track => track.title);
}

function normalizeSpotifyInfo(type, id, entity, fallback = {}) {
    const artists = Array.isArray(entity?.artists)
        ? entity.artists.map(a => ({ name: a?.name, uri: a?.uri })).filter(a => a.name)
        : [];
    const largestImage = pickLargestImage(entity?.visualIdentity?.image)
        || (fallback.thumbnail_url ? { url: fallback.thumbnail_url, maxWidth: fallback.thumbnail_width, maxHeight: fallback.thumbnail_height } : null);
    const trackList = normalizeTrackList(entity?.trackList);

    return {
        type,
        id: entity?.id || id,
        name: entity?.name || entity?.title || fallback.title || null,
        subtitle: entity?.subtitle || null,
        artists,
        previewUrl: type === 'track' ? (entity?.audioPreview?.url || null) : null,
        image: largestImage,
        releaseDate: entity?.releaseDate?.isoString || null,
        durationMs: typeof entity?.duration === 'number' ? entity.duration : null,
        trackList,
        canonicalUrl: `https://open.spotify.com/${type}/${id}`,
    };
}

async function fetchSpotifyInfo(type, id) {
    const headers = spotifyHeaders();
    const embedUrl = `https://open.spotify.com/embed/${type}/${id}?utm_source=comebacktwitterembed`;
    const html = await fetchText(embedUrl, headers);
    const nextData = extractNextData(html);
    const pageProps = nextData?.props?.pageProps || {};
    if (pageProps.status === 404 || pageProps.status === 500) {
        throw new Error(`spotify ${type} not found: ${id}`);
    }

    const entity = pageProps.state?.data?.entity;
    if (entity) return normalizeSpotifyInfo(type, id, entity);

    const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/${type}/${id}`)}`;
    const fallback = await fetchJson(oembedUrl, { 'User-Agent': headers['User-Agent'] });
    return normalizeSpotifyInfo(type, id, null, fallback);
}

function truncate(s, max) {
    if (!s) return '';
    if (s.length <= max) return s;
    return s.slice(0, max - 3) + '...';
}

function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
}

function formatReleaseDate(isoString) {
    if (typeof isoString !== 'string' || !isoString) return '';
    return isoString.split('T')[0];
}

function buildPreviewFileName(trackName, fallbackId) {
    const baseName = String(trackName || fallbackId || 'track')
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[<>:"/\\|?*]/g, '_')
        .split('')
        .map(ch => ch.charCodeAt(0) < 32 ? '_' : ch)
        .join('');
    return `spotify-preview-${baseName || fallbackId || 'track'}.mp3`;
}

function buildPreviewAttachment(previewUrl, trackId, trackName) {
    if (!previewUrl) return null;
    return {
        attachment: previewUrl,
        name: buildPreviewFileName(trackName, trackId),
    };
}

function getFallbackTitleKey(type) {
    if (type === 'album') return STR.fallbackAlbumTitle;
    if (type === 'artist') return STR.fallbackArtistTitle;
    return STR.fallbackTitle;
}

function buildDescription(item, artistsText) {
    if (item.type === 'track' && artistsText) return `Song by ${artistsText}`;
    if (item.type === 'album' && item.subtitle) return `Album by ${item.subtitle}`;
    if (item.type === 'artist' && item.subtitle) return item.subtitle;
    return '';
}

function formatTopTracks(trackList) {
    if (!Array.isArray(trackList) || trackList.length === 0) return '';
    return trackList
        .slice(0, TOP_TRACKS_MAX_COUNT)
        .map((track, index) => `${index + 1}. ${track.title}`)
        .join('\n');
}

function buildButtons(lang, canonicalUrl, hasImage) {
    const rows = [];

    const openButton = new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel(tr(STR.openButton, lang))
        .setURL(canonicalUrl);

    if (hasImage) {
        const showMediaAsAttachmentsButton = new ButtonBuilder()
            .setStyle(ButtonStyle.Primary)
            .setLabel(tr(STR.showMediaAsAttachmentsButton, lang))
            .setCustomId('showMediaAsAttachments');
        rows.push({ type: ComponentType.ActionRow, components: [openButton, showMediaAsAttachmentsButton] });
    } else {
        rows.push({ type: ComponentType.ActionRow, components: [openButton] });
    }

    const deleteButton = new ButtonBuilder()
        .setStyle(ButtonStyle.Danger)
        .setLabel(tr(STR.deleteButton, lang))
        .setCustomId('delete:spotify');
    rows.push({ type: ComponentType.ActionRow, components: [deleteButton] });
    return rows;
}

/** @type {import('../_types').Extractor} */
async function extract(message, url, s) {
    s = s || {};
    const parsed = parseSpotifyUrl(url);
    if (!parsed) return null;

    const guildLang = s.defaultLanguage ?? 'en';
    const lang = guildLang === 'ja' ? 'ja' : 'en';

    let item;
    try {
        item = await fetchSpotifyInfo(parsed.type, parsed.id);
    } catch (err) {
        recordProviderError('spotify', err, message, url, { endpointKey: 'spotify/embed-or-oembed' });
        console.log(err);
        return null;
    }

    const artistsText = item.artists.map(a => a.name).join(', ');
    const firstArtistId = artistIdFromUri(item.artists[0]?.uri);
    const requesterName = s.anonymous_expand === true
        ? tr(STR.anonRequester, lang)
        : `${message.author?.username ?? message.user?.username}(id:${message.author?.id ?? message.user?.id})`;

    const fields = [];
    const artistFieldValue = artistsText || (item.type === 'album' ? item.subtitle : '');
    if (artistFieldValue && item.type !== 'artist') fields.push({ name: tr(STR.artistField, lang), value: truncate(artistFieldValue, 256), inline: true });
    if (item.type !== 'track' && item.trackList.length > 0) {
        fields.push({ name: tr(STR.tracksField, lang), value: String(item.trackList.length), inline: true });
    }
    const duration = formatDuration(item.durationMs);
    if (item.type === 'track' && duration) fields.push({ name: tr(STR.durationField, lang), value: duration, inline: true });
    const releaseDate = formatReleaseDate(item.releaseDate);
    if (releaseDate) fields.push({ name: tr(STR.releaseDateField, lang), value: releaseDate, inline: true });
    if (item.previewUrl) fields.push({ name: tr(STR.previewField, lang), value: tr(STR.previewAttached, lang), inline: true });
    const topTracks = item.type !== 'track' ? formatTopTracks(item.trackList) : '';
    if (topTracks) fields.push({ name: tr(STR.topTracksField, lang), value: truncate(topTracks, 1024), inline: false });

    const description = buildDescription(item, artistsText);

    const embed = {
        title: item.name || `${tr(getFallbackTitleKey(item.type), lang)}${parsed.id}`,
        url: item.canonicalUrl,
        description: description ? truncate(description, DESCRIPTION_MAX_LENGTH) : undefined,
        color: SPOTIFY_COLOR,
        footer: { text: `${tr(STR.requesterPrefix, lang)}${requesterName} - Spotify` },
    };
    if (item.type === 'track' && artistsText) {
        embed.author = {
            name: artistsText,
            url: firstArtistId ? `https://open.spotify.com/artist/${firstArtistId}` : undefined,
        };
    } else if (item.type !== 'track') {
        embed.author = {
            name: item.type === 'album' ? 'Spotify album' : 'Spotify artist',
            url: item.canonicalUrl,
        };
    }
    if (item.image?.url) embed.image = { url: item.image.url };
    if (fields.length > 0) embed.fields = fields;

    const files = [];
    const previewAttachment = buildPreviewAttachment(item.previewUrl, parsed.id, item.name);
    if (previewAttachment) files.push(previewAttachment);

    /** @type {import('../_types').SendStep} */
    const step = {
        embeds: [embed],
        files,
        components: buildButtons(lang, item.canonicalUrl, !!item.image?.url),
        allowedMentions: { repliedUser: false },
        send: s.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel',
    };

    if (s.deletemessageifonlypostedtweetlink === true && message.content.trim() === url) {
        step.deleteSource = true;
    } else if (s.legacy_mode === true) {
        step.suppressSourceEmbeds = true;
    }

    return [step];
}

/** @type {import('../_types').Provider} */
const spotifyProvider = {
    id: 'spotify',
    enabledByDefault: false,
    urlPattern: SPOTIFY_URL_PATTERN,
    extract,
};

module.exports = spotifyProvider;
module.exports._internal = {
    parseSpotifyTrackUrl,
    parseSpotifyUrl,
    extractNextData,
    normalizeTrackInfo: (trackId, entity, fallback) => normalizeSpotifyInfo('track', trackId, entity, fallback),
    normalizeSpotifyInfo,
    buildPreviewFileName,
    formatDuration,
    formatReleaseDate,
};

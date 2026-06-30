'use strict';

const fetch = require('node-fetch');
const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { settings } = require('../../settings');

const SPOTIFY_COLOR = 0x1DB954;
const DESCRIPTION_MAX_LENGTH = 350;
const SPOTIFY_URL_PATTERN =
    /https?:\/\/open\.spotify\.com\/(?:intl-[a-zA-Z-]+\/)?track\/[A-Za-z0-9]+(?:\?[^\s<>|]*)?/g;

const STR = {
    openButton: { ja: 'Open in Spotify', en: 'Open in Spotify' },
    showMediaAsAttachmentsButton: { ja: 'Show cover as attachment', en: 'Show cover as attachment' },
    deleteButton: { ja: 'Delete', en: 'Delete' },
    artistField: { ja: 'Artist', en: 'Artist' },
    durationField: { ja: 'Duration', en: 'Duration' },
    releaseDateField: { ja: 'Release date', en: 'Release date' },
    previewField: { ja: 'Preview', en: 'Preview' },
    previewAttached: { ja: 'Attached below', en: 'Attached below' },
    requesterPrefix: { ja: 'Requested by ', en: 'Requested by ' },
    anonRequester: { ja: 'Anonymous requester', en: 'Anonymous requester' },
    fallbackTitle: { ja: 'Spotify track #', en: 'Spotify track #' },
};

function tr(spec, lang) {
    if (typeof spec === 'string') return spec;
    return spec[lang] ?? spec.en ?? '';
}

function parseSpotifyTrackUrl(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch { return null; }
    if (u.hostname !== 'open.spotify.com') return null;

    const parts = u.pathname.split('/').filter(Boolean);
    let idx = 0;
    if (parts[0] && /^intl-[a-zA-Z-]+$/.test(parts[0])) idx = 1;
    if (parts[idx] !== 'track' || !parts[idx + 1]) return null;

    const id = parts[idx + 1];
    if (!/^[A-Za-z0-9]+$/.test(id)) return null;
    return { id };
}

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

function normalizeTrackInfo(trackId, entity, fallback = {}) {
    const artists = Array.isArray(entity?.artists)
        ? entity.artists.map(a => ({ name: a?.name, uri: a?.uri })).filter(a => a.name)
        : [];
    const largestImage = pickLargestImage(entity?.visualIdentity?.image)
        || (fallback.thumbnail_url ? { url: fallback.thumbnail_url, maxWidth: fallback.thumbnail_width, maxHeight: fallback.thumbnail_height } : null);

    return {
        id: entity?.id || trackId,
        name: entity?.name || fallback.title || null,
        artists,
        previewUrl: entity?.audioPreview?.url || null,
        image: largestImage,
        releaseDate: entity?.releaseDate?.isoString || null,
        durationMs: typeof entity?.duration === 'number' ? entity.duration : null,
        canonicalUrl: `https://open.spotify.com/track/${trackId}`,
    };
}

async function fetchTrackInfo(trackId) {
    const headers = spotifyHeaders();
    const embedUrl = `https://open.spotify.com/embed/track/${trackId}?utm_source=comebacktwitterembed`;
    const html = await fetchText(embedUrl, headers);
    const nextData = extractNextData(html);
    const pageProps = nextData?.props?.pageProps || {};
    if (pageProps.status === 404 || pageProps.status === 500) {
        throw new Error(`spotify track not found: ${trackId}`);
    }

    const entity = pageProps.state?.data?.entity;
    if (entity) return normalizeTrackInfo(trackId, entity);

    const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/track/${trackId}`)}`;
    const fallback = await fetchJson(oembedUrl, { 'User-Agent': headers['User-Agent'] });
    return normalizeTrackInfo(trackId, null, fallback);
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

function buildPreviewAttachment(previewUrl, trackId) {
    if (!previewUrl) return null;
    return {
        attachment: previewUrl,
        name: `spotify-preview-${trackId}.mp3`,
    };
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
    const parsed = parseSpotifyTrackUrl(url);
    if (!parsed) return null;

    const guildId = message.guild.id;
    const guildLang = s.defaultLanguage ?? settings.defaultLanguage[guildId] ?? 'en';
    const lang = guildLang === 'ja' ? 'ja' : 'en';

    let track;
    try {
        track = await fetchTrackInfo(parsed.id);
    } catch (err) {
        console.log(err);
        return null;
    }

    const artistsText = track.artists.map(a => a.name).join(', ');
    const firstArtistId = artistIdFromUri(track.artists[0]?.uri);
    const requesterName = s.anonymous_expand === true
        ? tr(STR.anonRequester, lang)
        : `${message.author?.username ?? message.user?.username}(id:${message.author?.id ?? message.user?.id})`;

    const fields = [];
    if (artistsText) fields.push({ name: tr(STR.artistField, lang), value: truncate(artistsText, 256), inline: true });
    const duration = formatDuration(track.durationMs);
    if (duration) fields.push({ name: tr(STR.durationField, lang), value: duration, inline: true });
    const releaseDate = formatReleaseDate(track.releaseDate);
    if (releaseDate) fields.push({ name: tr(STR.releaseDateField, lang), value: releaseDate, inline: true });
    if (track.previewUrl) fields.push({ name: tr(STR.previewField, lang), value: tr(STR.previewAttached, lang), inline: true });

    const embed = {
        title: track.name || `${tr(STR.fallbackTitle, lang)}${parsed.id}`,
        url: track.canonicalUrl,
        description: artistsText ? truncate(`Song by ${artistsText}`, DESCRIPTION_MAX_LENGTH) : undefined,
        color: SPOTIFY_COLOR,
        footer: { text: `${tr(STR.requesterPrefix, lang)}${requesterName} - Spotify` },
    };
    if (artistsText) {
        embed.author = {
            name: artistsText,
            url: firstArtistId ? `https://open.spotify.com/artist/${firstArtistId}` : undefined,
        };
    }
    if (track.image?.url) embed.image = { url: track.image.url };
    if (fields.length > 0) embed.fields = fields;

    const files = [];
    const previewAttachment = buildPreviewAttachment(track.previewUrl, parsed.id);
    if (previewAttachment) files.push(previewAttachment);

    /** @type {import('../_types').SendStep} */
    const step = {
        embeds: [embed],
        files,
        components: buildButtons(lang, track.canonicalUrl, !!track.image?.url),
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
    extractNextData,
    normalizeTrackInfo,
    formatDuration,
    formatReleaseDate,
};

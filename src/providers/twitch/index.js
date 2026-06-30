'use strict';

const fetch = require('node-fetch');
const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { recordProviderError } = require('../../errorTracking');

const TWITCH_COLOR = 0x9146FF;
const TWITCH_GQL_ENDPOINT = 'https://gql.twitch.tv/gql';
const TWITCH_TOKEN_ENDPOINT = 'https://id.twitch.tv/oauth2/token';
const TWITCH_WEB_CLIENT_ID = process.env.TWITCH_GQL_CLIENT_ID || 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const DESCRIPTION_MAX_LENGTH = 1500;
const DEFAULT_CLIP_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

const VIDEO_ACCESS_TOKEN_HASH = '6fd3af2b22989506269b9ac02dd87eb4a6688392d67d94e41a6886f1e9f5c00f';

const CHANNEL_METADATA_QUERY = `
query ChannelMetadataFallback($login: String!) {
  user(login: $login) {
    id
    login
    displayName
    description
    profileImageURL(width: 300)
    bannerImageURL
    stream {
      id
      title
      type
      viewersCount
      createdAt
      previewImageURL(width: 1280, height: 720)
      game {
        id
        name
        displayName
      }
    }
  }
}`;

const CLIP_METADATA_QUERY = `
query ClipMetadataFallback($slug: ID!) {
  clip(slug: $slug) {
    id
    slug
    title
    viewCount
    createdAt
    durationSeconds
    url
    thumbnailURL
    broadcaster {
      id
      login
      displayName
      profileImageURL(width: 300)
    }
    curator {
      id
      login
      displayName
    }
    game {
      id
      name
      displayName
    }
  }
}`;

const STR = {
    viewOnTwitch: 'View on Twitch',
    statusField: 'Status',
    liveStatus: 'Live',
    offlineStatus: 'Offline',
    viewsField: 'Views',
    viewersField: 'Viewers',
    gameField: 'Game',
    startedField: 'Started',
    durationField: 'Duration',
    clippedByField: 'Clipped by',
    requesterPrefix: 'Requested by ',
    anonRequester: 'Anonymous requester',
    translateButton: 'Translate',
    deleteButton: 'Delete',
    fallbackTitle: 'Twitch clip',
};

const RESERVED_CHANNEL_PATHS = new Set([
    'videos',
    'directory',
    'downloads',
    'jobs',
    'p',
    'settings',
    'subscriptions',
    'turbo',
    'wallet',
    'popout',
    'team',
    'communities',
    'moderator',
    'creatorcamp',
]);

const TWITCH_URL_PATTERN =
    /https?:\/\/(?:(?:www|m)\.)?(?:(?:clips\.twitch\.tv\/[A-Za-z0-9_-]+\/?)|(?:twitch\.tv\/(?!(?:videos|directory|downloads|jobs|p|settings|subscriptions|turbo|wallet|popout|team|communities|moderator|creatorcamp)(?:[/?#]|$))[A-Za-z0-9_]{3,25}(?:\/clip\/[A-Za-z0-9_-]+\/?|\/?)))(?=$|[\s<>|?#])(?:[?#][^\s<>|]*)?/g;

let cachedAppToken = null;

function truncate(value, maxLength) {
    const text = String(value ?? '');
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + '...';
}

function formatNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    return n.toLocaleString('en-US');
}

function formatDuration(seconds) {
    const total = Number(seconds);
    if (!Number.isFinite(total) || total <= 0) return '';
    const rounded = Math.round(total);
    const h = Math.floor(rounded / 3600);
    const m = Math.floor((rounded % 3600) / 60);
    const s = rounded % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function appendQueryParams(url, params) {
    const separator = url.includes('?') ? '&' : '?';
    return url + separator + new URLSearchParams(params).toString();
}

function parseTwitchClipUrl(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch { return null; }

    const host = u.hostname.replace(/^(?:www|m)\./, '').toLowerCase();
    let slug = null;
    let channel = null;

    if (host === 'clips.twitch.tv') {
        slug = u.pathname.split('/').filter(Boolean)[0] || null;
    } else if (host === 'twitch.tv') {
        const match = u.pathname.match(/^\/([^/]+)\/clip\/([^/]+)/);
        if (match) {
            channel = match[1];
            slug = match[2];
        }
    }

    if (!slug || !/^[A-Za-z0-9_-]+$/.test(slug)) return null;
    return { kind: 'clip', slug, channel };
}

function parseTwitchChannelUrl(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch { return null; }

    const host = u.hostname.replace(/^(?:www|m)\./, '').toLowerCase();
    if (host !== 'twitch.tv') return null;

    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length !== 1) return null;

    const login = parts[0].toLowerCase();
    if (RESERVED_CHANNEL_PATHS.has(login) || !/^[a-z0-9_]{3,25}$/.test(login)) return null;
    return { kind: 'channel', login };
}

function parseTwitchUrl(rawUrl) {
    return parseTwitchClipUrl(rawUrl) || parseTwitchChannelUrl(rawUrl);
}

async function fetchTwitchAppToken() {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const clientSecret = process.env.TWITCH_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;

    if (cachedAppToken && cachedAppToken.expiresAt > Date.now() + 60000) {
        return cachedAppToken.value;
    }

    const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
    });
    const res = await fetch(`${TWITCH_TOKEN_ENDPOINT}?${params.toString()}`, { method: 'POST' });
    if (!res.ok) throw new Error(`twitch oauth ${res.status}`);

    const data = await res.json();
    const expiresIn = Number(data.expires_in) || 3600;
    cachedAppToken = {
        value: data.access_token,
        expiresAt: Date.now() + expiresIn * 1000,
    };
    return cachedAppToken.value;
}

async function buildGqlHeaders() {
    const headers = {
        'Client-ID': TWITCH_WEB_CLIENT_ID,
        'Content-Type': 'application/json',
    };

    try {
        const token = await fetchTwitchAppToken();
        if (token) headers.Authorization = `Bearer ${token}`;
    } catch (err) {
        console.log(err);
    }

    return headers;
}

function pickBestVideoQuality(videoQualities) {
    if (!Array.isArray(videoQualities) || videoQualities.length === 0) return null;
    return [...videoQualities]
        .filter(q => q && typeof q.sourceURL === 'string' && q.sourceURL)
        .sort((a, b) => (Number(b.quality) || 0) - (Number(a.quality) || 0))[0] || null;
}

function buildVideoUrl(accessClip) {
    const quality = pickBestVideoQuality(accessClip?.videoQualities);
    const token = accessClip?.playbackAccessToken;
    if (!quality || !token?.signature || !token?.value) return null;
    return appendQueryParams(quality.sourceURL, {
        sig: token.signature,
        token: token.value,
    });
}

async function fetchClipInfo(slug) {
    const payload = [
        {
            operationName: 'ClipMetadataFallback',
            variables: { slug },
            query: CLIP_METADATA_QUERY,
        },
        {
            operationName: 'VideoAccessToken_Clip',
            variables: { platform: 'web', slug },
            extensions: {
                persistedQuery: {
                    version: 1,
                    sha256Hash: VIDEO_ACCESS_TOKEN_HASH,
                },
            },
        },
    ];

    const res = await fetch(TWITCH_GQL_ENDPOINT, {
        method: 'POST',
        headers: await buildGqlHeaders(),
        body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`twitch gql ${res.status}`);

    const data = await res.json();
    const metadataClip = data?.[0]?.data?.clip;
    const accessClip = data?.[1]?.data?.clip;
    if (!metadataClip) {
        const firstError = data?.[0]?.errors?.[0]?.message || 'missing clip metadata';
        throw new Error(`twitch gql: ${firstError}`);
    }

    return {
        ...metadataClip,
        videoUrl: buildVideoUrl(accessClip),
    };
}

async function fetchChannelInfo(login) {
    const payload = {
        operationName: 'ChannelMetadataFallback',
        variables: { login },
        query: CHANNEL_METADATA_QUERY,
    };

    const res = await fetch(TWITCH_GQL_ENDPOINT, {
        method: 'POST',
        headers: await buildGqlHeaders(),
        body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`twitch gql ${res.status}`);

    const data = await res.json();
    const user = data?.data?.user;
    if (!user) {
        const firstError = data?.errors?.[0]?.message || 'missing channel metadata';
        throw new Error(`twitch gql: ${firstError}`);
    }
    return user;
}

function clipUploadMaxBytes() {
    const configured = Number(process.env.TWITCH_CLIP_UPLOAD_MAX_BYTES);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CLIP_UPLOAD_MAX_BYTES;
}

async function readResponseBufferWithLimit(res, maxBytes) {
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > maxBytes) {
            if (typeof res.body.destroy === 'function') res.body.destroy();
            return null;
        }
        chunks.push(buf);
    }
    return Buffer.concat(chunks, total);
}

async function downloadClipVideo(videoUrl, slug, maxBytes = clipUploadMaxBytes()) {
    if (!videoUrl) return null;
    const res = await fetch(videoUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; comebacktwitterembed/1.0)',
        },
    });
    if (!res.ok || !res.body) throw new Error(`twitch clip video ${res.status}`);

    const length = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(length) && length > maxBytes) return null;

    const buffer = await readResponseBufferWithLimit(res, maxBytes);
    if (!buffer) return null;

    return {
        attachment: buffer,
        name: `twitch-${slug}.mp4`,
    };
}

function buildButtons() {
    return [
        new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(STR.translateButton).setCustomId('translate'),
        new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel(STR.deleteButton).setCustomId('delete:twitch'),
    ];
}

function buildEmbed(info, parsed, requesterName) {
    const canonicalUrl = info.url || (parsed.channel
        ? `https://www.twitch.tv/${parsed.channel}/clip/${parsed.slug}`
        : `https://clips.twitch.tv/${parsed.slug}`);
    const broadcaster = info.broadcaster || {};
    const broadcasterName = broadcaster.displayName || broadcaster.login || 'Twitch';
    const title = info.title || `${STR.fallbackTitle}: ${parsed.slug}`;
    const description = truncate(`${title}\n\n[${STR.viewOnTwitch}](${canonicalUrl})`, DESCRIPTION_MAX_LENGTH);

    const fields = [];
    const views = formatNumber(info.viewCount);
    if (views) fields.push({ name: STR.viewsField, value: views, inline: true });
    const duration = formatDuration(info.durationSeconds);
    if (duration) fields.push({ name: STR.durationField, value: duration, inline: true });
    const game = info.game?.displayName || info.game?.name;
    if (game) fields.push({ name: STR.gameField, value: game, inline: true });
    const curator = info.curator?.displayName || info.curator?.login;
    if (curator) fields.push({ name: STR.clippedByField, value: curator, inline: true });

    const embed = {
        title: broadcasterName,
        url: canonicalUrl,
        description,
        color: TWITCH_COLOR,
        author: {
            name: broadcasterName,
            url: broadcaster.login ? `https://www.twitch.tv/${broadcaster.login}` : canonicalUrl,
            icon_url: broadcaster.profileImageURL || undefined,
        },
        footer: { text: `${STR.requesterPrefix}${requesterName} | Twitch` },
        timestamp: info.createdAt ? new Date(info.createdAt) : undefined,
    };
    if (info.thumbnailURL) embed.image = { url: info.thumbnailURL };
    if (fields.length > 0) embed.fields = fields;
    return embed;
}

function buildChannelEmbed(info, parsed, requesterName) {
    const login = info.login || parsed.login;
    const canonicalUrl = `https://www.twitch.tv/${login}`;
    const displayName = info.displayName || login;
    const stream = info.stream || null;
    const isLive = !!stream;
    const descriptionText = isLive
        ? (stream.title || `${displayName} is live on Twitch.`)
        : (info.description || `${displayName} on Twitch`);
    const description = truncate(`${descriptionText}\n\n[${STR.viewOnTwitch}](${canonicalUrl})`, DESCRIPTION_MAX_LENGTH);

    const fields = [
        { name: STR.statusField, value: isLive ? STR.liveStatus : STR.offlineStatus, inline: true },
    ];
    if (isLive) {
        const viewers = formatNumber(stream.viewersCount);
        if (viewers) fields.push({ name: STR.viewersField, value: viewers, inline: true });
        const game = stream.game?.displayName || stream.game?.name;
        if (game) fields.push({ name: STR.gameField, value: game, inline: true });
        if (stream.createdAt) {
            const unix = Math.floor(new Date(stream.createdAt).getTime() / 1000);
            if (Number.isFinite(unix)) fields.push({ name: STR.startedField, value: `<t:${unix}:R>`, inline: true });
        }
    }

    const embed = {
        title: isLive ? `${displayName} is live` : displayName,
        url: canonicalUrl,
        description,
        color: TWITCH_COLOR,
        author: {
            name: displayName,
            url: canonicalUrl,
            icon_url: info.profileImageURL || undefined,
        },
        footer: { text: `${STR.requesterPrefix}${requesterName} | Twitch` },
        fields,
        timestamp: stream?.createdAt ? new Date(stream.createdAt) : undefined,
    };
    if (stream?.previewImageURL) embed.image = { url: stream.previewImageURL };
    else if (info.bannerImageURL) embed.image = { url: info.bannerImageURL };
    else if (info.profileImageURL) embed.thumbnail = { url: info.profileImageURL };
    return embed;
}

/** @type {import('../_types').Extractor} */
async function extract(message, url, s) {
    s = s || {};
    const parsed = parseTwitchUrl(url);
    if (!parsed) return null;

    const guildLang = s.defaultLanguage ?? 'en';
    void guildLang;

    let info;
    try {
        info = parsed.kind === 'clip'
            ? await fetchClipInfo(parsed.slug)
            : await fetchChannelInfo(parsed.login);
    } catch (err) {
        recordProviderError('twitch', err, message, url, { endpointKey: 'twitch/gql' });
        console.log(err);
        return null;
    }

    const requesterName = s.anonymous_expand === true
        ? STR.anonRequester
        : `${message.author?.username ?? message.user?.username}(id:${message.author?.id ?? message.user?.id})`;

    const embed = parsed.kind === 'clip'
        ? buildEmbed(info, parsed, requesterName)
        : buildChannelEmbed(info, parsed, requesterName);
    const components = [
        { type: ComponentType.ActionRow, components: buildButtons() },
    ];

    /** @type {import('../_types').SendStep} */
    const step = {
        embeds: [embed],
        components,
        allowedMentions: { repliedUser: false },
        send: s.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel',
    };
    if (parsed.kind === 'clip' && info.videoUrl) {
        try {
            const file = await downloadClipVideo(info.videoUrl, parsed.slug);
            if (file) step.files = [file];
            else step.content = `[動画URL](${info.videoUrl})`;
        } catch (err) {
            recordProviderError('twitch', err, message, url, { endpointKey: 'twitch/video' });
            console.log(err);
            step.content = `[動画URL](${info.videoUrl})`;
        }
    }

    if (s.deletemessageifonlypostedtweetlink === true && message.content.trim() === url) {
        step.deleteSource = true;
    } else if (s.legacy_mode === true) {
        step.suppressSourceEmbeds = true;
    }

    return [step];
}

/** @type {import('../_types').Provider} */
const twitchProvider = {
    id: 'twitch',
    enabledByDefault: false,
    urlPattern: TWITCH_URL_PATTERN,
    extract,
};

module.exports = twitchProvider;
module.exports._internal = {
    parseTwitchChannelUrl,
    parseTwitchClipUrl,
    parseTwitchUrl,
    buildVideoUrl,
    downloadClipVideo,
    formatDuration,
};

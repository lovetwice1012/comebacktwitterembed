'use strict';

// HTTP retrieval and ordered Invidious/page/oEmbed fallbacks; fetch is supplied by the entry point.
const { channelPageUrl } = require('./youtubeSourceParser');
const {
    parseInitialPlayerResponse,
    parseInitialData,
    normalizePlayerResponse,
    normalizePlaylistFromInitialData,
    normalizeChannelFromInitialData,
} = require('./youtubeSourceParser');

const INVIDIOUS_INSTANCES = [
    'https://iteroni.com',
    'https://invidious.einfachzocken.eu',
    'https://iv.nboeck.de',
];

const REQUEST_HEADERS = {
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (compatible; ComebackTwitterEmbed/1.0; +https://github.com/iGerman00/koutube-logic-port)',
};

function getInstances() {
    const configured = process.env.YOUTUBE_INVIDIOUS_INSTANCES;
    if (!configured) return INVIDIOUS_INSTANCES;
    const values = configured.split(',').map(v => v.trim()).filter(Boolean);
    return values.length > 0 ? values : INVIDIOUS_INSTANCES;
}

function isTransientInvidiousError(errorText) {
    if (!errorText) return false;
    return /please sign in|community|temporarily|429|rate limit|extract/i.test(String(errorText));
}

function matchingOptionalId(value, expected) {
    return value == null || typeof value === 'string' && value === expected;
}

function youtubeFinalUrl(raw) {
    if (!raw) return null;
    let url;
    try { url = new URL(raw); } catch { throw new Error('YouTube returned an invalid redirect'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port
        || !(url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com'))) throw new Error('YouTube redirected outside its service');
    return url;
}

function createYouTubeClient(fetch) {
    async function fetchJsonFromInstances(path, valid = value => value && typeof value === 'object' && !Array.isArray(value)) {
        let lastError = null;
        for (const baseUrl of getInstances()) {
            try {
                const res = await fetch(baseUrl + path, { headers: REQUEST_HEADERS });
                if (!res.ok) {
                    lastError = new Error(`Invidious ${res.status} for ${path}`);
                    continue;
                }
                const json = await res.json();
                if (json?.error && isTransientInvidiousError(json.error)) {
                    lastError = new Error(json.error);
                    continue;
                }
                if (!json?.error && !valid(json)) {
                    lastError = new Error('Invidious response did not contain usable metadata');
                    continue;
                }
                return { json, baseUrl };
            } catch (err) {
                lastError = err;
            }
        }
        throw lastError || new Error(`Invidious request failed: ${path}`);
    }

    async function fetchVideoInfoFromYouTubePage(videoId) {
        const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`, {
            headers: REQUEST_HEADERS,
        });
        if (!res.ok) throw new Error(`YouTube page ${res.status} for ${videoId}`);
        const final = youtubeFinalUrl(res.url);
        if (final && !(final.pathname === '/watch' && final.searchParams.get('v') === videoId
            || [`/shorts/${videoId}`, `/live/${videoId}`].includes(final.pathname.replace(/\/+$/, ''))))
            throw new Error('YouTube redirected to a different video');

        const html = await res.text();
        const player = parseInitialPlayerResponse(html);
        if (player?.videoDetails?.videoId !== videoId) throw new Error('YouTube page returned a different video');
        const normalized = normalizePlayerResponse(player);
        if (!normalized) throw new Error(`YouTube page did not contain player metadata for ${videoId}`);

        return { json: normalized, baseUrl: 'https://www.youtube.com' };
    }

    async function fetchVideoInfoFromOEmbed(videoId) {
        const target = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
        const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(target)}&format=json`, {
            headers: REQUEST_HEADERS,
        });
        if (!res.ok) throw new Error(`YouTube oEmbed ${res.status} for ${videoId}`);

        const info = await res.json();
        return {
            json: {
                title: info.title,
                videoThumbnails: [{ url: info.thumbnail_url, width: info.thumbnail_width, height: info.thumbnail_height }],
                description: '',
                publishedText: '',
                viewCount: undefined,
                likeCount: undefined,
                author: info.author_name,
                authorUrl: info.author_url,
                authorId: undefined,
                authorThumbnails: [],
                subCountText: '',
                liveNow: false,
                formatStreams: [],
            },
            baseUrl: 'https://www.youtube.com',
        };
    }

    async function fetchVideoInfo(videoId) {
        const path = `/api/v1/videos/${encodeURIComponent(videoId)}?hl=en`;
        return fetchJsonFromInstances(path, json => typeof json?.title === 'string' && !!json.title.trim()
            && matchingOptionalId(json.videoId, videoId));
    }

    async function fetchVideoInfoWithFallback(videoId) {
        try {
            const result = await fetchVideoInfo(videoId);
            if (result?.json?.error) throw new Error(result.json.error);
            return result;
        } catch (invidiousError) {
            try {
                return await fetchVideoInfoFromYouTubePage(videoId);
            } catch {
                try {
                    return await fetchVideoInfoFromOEmbed(videoId);
                } catch {
                    throw invidiousError;
                }
            }
        }
    }

    async function fetchPlaylistInfo(playlistId) {
        const path = `/api/v1/playlists/${encodeURIComponent(playlistId)}?hl=en`;
        return fetchJsonFromInstances(path, json => typeof json?.title === 'string' && !!json.title.trim()
            && matchingOptionalId(json.playlistId, playlistId));
    }

    async function fetchYouTubeInitialDataPage(pageUrl, context) {
        const target = new URL(pageUrl);
        if (!target.searchParams.has('hl')) target.searchParams.set('hl', 'en');

        const res = await fetch(target.toString(), { headers: REQUEST_HEADERS });
        if (!res.ok) throw new Error(`YouTube page ${res.status} for ${context}`);

        const html = await res.text();
        const data = parseInitialData(html);
        if (!data) throw new Error(`YouTube page did not contain initial data for ${context}`);

        return { data, html, baseUrl: 'https://www.youtube.com', finalUrl: youtubeFinalUrl(res.url) };
    }

    async function fetchPlaylistInfoFromYouTubePage(playlistId) {
        const pageUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
        const { data, html, baseUrl, finalUrl } = await fetchYouTubeInitialDataPage(pageUrl, `playlist ${playlistId}`);
        if (finalUrl && finalUrl.searchParams.get('list') !== playlistId) throw new Error('YouTube redirected to a different playlist');
        const json = normalizePlaylistFromInitialData(data, html, playlistId);
        if (!json) throw new Error(`YouTube page did not contain playlist metadata for ${playlistId}`);
        return { json, baseUrl };
    }

    async function fetchPlaylistInfoWithFallback(playlistId) {
        try {
            const result = await fetchPlaylistInfo(playlistId);
            if (result?.json?.error) throw new Error(result.json.error);
            return result;
        } catch (invidiousError) {
            try {
                return await fetchPlaylistInfoFromYouTubePage(playlistId);
            } catch {
                throw invidiousError;
            }
        }
    }

    async function resolveChannelUrl(channelUrl) {
        const path = `/api/v1/resolveurl?url=${encodeURIComponent(channelUrl)}`;
        const { json } = await fetchJsonFromInstances(path, json => typeof json?.ucid === 'string' && !!json.ucid.trim());
        return json?.ucid || null;
    }

    async function fetchChannelInfo(channelIdOrUrl, alreadyResolved) {
        const channelId = alreadyResolved ? channelIdOrUrl : await resolveChannelUrl(channelIdOrUrl);
        if (!channelId) return null;
        const path = `/api/v1/channels/${encodeURIComponent(channelId)}?hl=en`;
        const result = await fetchJsonFromInstances(path, json => typeof json?.author === 'string' && !!json.author.trim()
            && matchingOptionalId(json.authorId, channelId));
        return { ...result, channelId };
    }

    async function fetchChannelInfoFromYouTubePage(channelIdOrUrl, alreadyResolved) {
        const pageUrl = channelPageUrl(channelIdOrUrl, alreadyResolved);
        const { data, html, baseUrl, finalUrl } = await fetchYouTubeInitialDataPage(pageUrl, `channel ${channelIdOrUrl}`);
        const json = normalizeChannelFromInitialData(data, html, channelIdOrUrl, alreadyResolved);
        if (!json) throw new Error(`YouTube page did not contain channel metadata for ${channelIdOrUrl}`);
        if (alreadyResolved && json.authorId && json.authorId !== channelIdOrUrl) throw new Error('YouTube page returned a different channel');
        if (finalUrl) {
            const requestedPath = new URL(pageUrl).pathname.replace(/\/+$/, '');
            const finalPath = finalUrl.pathname.replace(/\/+$/, '');
            const explicitId = data?.metadata?.channelMetadataRenderer?.externalId || data?.header?.c4TabbedHeaderRenderer?.channelId;
            const samePath = finalPath.toLowerCase() === requestedPath.toLowerCase();
            const sameDirectChannel = explicitId && finalPath === `/channel/${explicitId}` && json.authorId === explicitId;
            const sameResolvedChannel = alreadyResolved && explicitId === channelIdOrUrl && json.authorId === channelIdOrUrl;
            if (!samePath && !sameDirectChannel && !sameResolvedChannel) throw new Error('YouTube redirected to a different channel');
        }
        return { json, baseUrl, channelId: json.authorId || channelIdOrUrl };
    }

    async function fetchChannelInfoWithFallback(channelIdOrUrl, alreadyResolved) {
        try {
            const result = await fetchChannelInfo(channelIdOrUrl, alreadyResolved);
            if (result?.json?.error) throw new Error(result.json.error);
            if (result) return result;
        } catch (invidiousError) {
            try {
                return await fetchChannelInfoFromYouTubePage(channelIdOrUrl, alreadyResolved);
            } catch {
                throw invidiousError;
            }
        }

        return fetchChannelInfoFromYouTubePage(channelIdOrUrl, alreadyResolved);
    }

    return {
        fetchVideoInfoWithFallback,
        fetchPlaylistInfoWithFallback,
        fetchChannelInfoWithFallback,
        fetchVideoInfoFromYouTubePage,
        fetchVideoInfoFromOEmbed,
        fetchPlaylistInfoFromYouTubePage,
        fetchChannelInfoFromYouTubePage,
    };
}

module.exports = {
    createYouTubeClient,
};

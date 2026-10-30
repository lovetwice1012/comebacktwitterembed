'use strict';

const { CACHE_TTL_MS, PROFILE_API_RATE_LIMIT_BACKOFF_MS } = require('./constants');
const { parseInstagramUrl, buildCanonicalUrl } = require('./urls');
const {
    parseInstagramHtmlSource,
    parseInstagramGraphqlSource,
    parseInstagramOEmbed,
    normalizeProfileData,
    normalizeProfileHtmlData,
    tryParseJson,
} = require('./instagramSourceParser');

const REQUEST_HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
};
const MOBILE_USER_AGENT = 'Instagram 337.0.0.35.102 Android (30/11; 420dpi; 1080x1920; Google; Pixel 5; redfin; redfin; en_US; 540986477)';
const CRAWLER_USER_AGENT = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
const MEDIA_CRAWLER_USER_AGENT = 'facebookexternalhit/1.1';
const MEDIA_REQUEST_HEADERS = {
    ...REQUEST_HEADERS,
    'User-Agent': MEDIA_CRAWLER_USER_AGENT,
};

const GRAPHQL_DOC_ID = '25531498899829322';
const CACHE_MAX_ENTRIES = 1024;
const GRAPHQL_HEADERS = {
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Origin': 'https://www.instagram.com',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': REQUEST_HEADERS['User-Agent'],
    'X-Asbd-Id': '129477',
    'X-Fb-Friendly-Name': 'PolarisPostActionLoadPostQueryQuery',
    'X-Ig-App-Id': '936619743392459',
};

// Each provider instance owns its transport, cache, and rate-limit backoff.
function createInstagramClient(fetch) {
    const dataCache = new Map();
    let nextCacheExpiryAt = Infinity;
    let profileApiBackoffUntil = 0;
    let mediaBackoffUntil = 0;

    function mediaRateLimited(response) {
        const header = response?.headers?.get?.('retry-after');
        const seconds = header == null || header === '' ? NaN : Number(header);
        const date = typeof header === 'string' ? Date.parse(header) : NaN;
        const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000
            : Number.isFinite(date) ? date - Date.now() : 60 * 1000;
        mediaBackoffUntil = Math.max(mediaBackoffUntil, Date.now() + Math.max(1000, Math.min(10 * 60 * 1000, delay)));
        return Object.assign(new Error('instagram media is rate limited'), { code: 'INSTAGRAM_RATE_LIMITED', status: 429, retryAfterMs: mediaBackoffUntil - Date.now() });
    }

    function pruneExpiredCache(now) {
        if (now < nextCacheExpiryAt) return;
        nextCacheExpiryAt = Infinity;
        // LRU order differs from expiry order. Scan only when an expiry is due;
        // the per-client cap bounds each sweep, including on cache hits.
        for (const [key, entry] of dataCache) {
            if (entry.expiresAt <= now) dataCache.delete(key);
            else nextCacheExpiryAt = Math.min(nextCacheExpiryAt, entry.expiresAt);
        }
    }

    function getCachedData(key) {
        pruneExpiredCache(Date.now());
        const cached = dataCache.get(key);
        if (!cached) return null;
        // Promote without extending the original TTL or altering parsed data.
        dataCache.delete(key);
        dataCache.set(key, cached);
        return cached.data;
    }

    function cacheData(key, data, ttlMs = CACHE_TTL_MS) {
        const now = Date.now();
        pruneExpiredCache(now);
        const expiresAt = now + ttlMs;
        dataCache.delete(key);
        dataCache.set(key, { data, expiresAt });
        nextCacheExpiryAt = Math.min(nextCacheExpiryAt, expiresAt);
        while (dataCache.size > CACHE_MAX_ENTRIES) {
            dataCache.delete(dataCache.keys().next().value);
        }
    }

    async function resolveShareUrl(parsed) {
        const candidates = [];
        if (parsed.shareRoute === 'reel') {
            candidates.push(`https://www.instagram.com/share/reel/${parsed.shareCode}/`);
        }
        candidates.push(
            `https://www.instagram.com/share/reel/${parsed.shareCode}/`,
            `https://www.instagram.com/share/${parsed.shareCode}/`
        );

        for (const candidate of [...new Set(candidates)]) {
            try {
                const res = await fetch(candidate, {
                    method: 'HEAD',
                    redirect: 'manual',
                    headers: REQUEST_HEADERS,
                });
                const location = res.headers?.get?.('location');
                const target = location ? new URL(location, candidate).toString() : res.url;
                const resolved = parseInstagramUrl(target);
                if (resolved && resolved.kind === 'media') {
                    resolved.mediaIndex = parsed.mediaIndex;
                    return resolved;
                }
            } catch {
                // Try the next share URL shape.
            }
        }

        return null;
    }

    async function resolveParsedUrl(parsed) {
        if (!parsed) return null;
        if (parsed.kind !== 'share') return parsed;
        return await resolveShareUrl(parsed);
    }

    async function fetchOEmbedData(parsed) {
        const params = new URLSearchParams({ url: buildCanonicalUrl(parsed) });
        const apiUrl = `https://www.instagram.com/api/v1/oembed/?${params.toString()}`;
        const res = await fetch(apiUrl, {
            headers: {
                ...REQUEST_HEADERS,
                Accept: 'application/json,text/plain,*/*',
            },
        });
        if (res.status === 429) throw mediaRateLimited(res);
        if (!res.ok) return null;
        return parseInstagramOEmbed(await res.text());
    }

    function profileApiCandidates(username) {
        const params = new URLSearchParams({ username });
        const query = params.toString();
        const referer = `https://www.instagram.com/${username}/`;
        const jsonHeaders = {
            ...REQUEST_HEADERS,
            Accept: 'application/json,text/plain,*/*',
            Referer: referer,
            'X-IG-App-ID': '936619743392459',
            'X-Requested-With': 'XMLHttpRequest',
        };
        const mobileHeaders = {
            ...jsonHeaders,
            'User-Agent': MOBILE_USER_AGENT,
        };

        return [
            { url: `https://www.instagram.com/api/v1/users/web_profile_info/?${query}`, headers: jsonHeaders },
            { url: `https://i.instagram.com/api/v1/users/web_profile_info/?${query}`, headers: jsonHeaders },
            { url: `https://www.instagram.com/api/v1/users/web_profile_info/?${query}`, headers: mobileHeaders },
            { url: `https://i.instagram.com/api/v1/users/web_profile_info/?${query}`, headers: mobileHeaders },
        ];
    }

    async function fetchProfileCandidate(candidate) {
        const res = await fetch(candidate.url, { headers: candidate.headers });
        const text = await res.text();
        if (!res.ok) {
            /** @type {Error & {status?: number}} */
            const err = new Error(`instagram profile ${res.status}`);
            err.status = res.status;
            throw err;
        }

        const parsed = tryParseJson(text);
        if (!parsed) {
            /** @type {Error & {status?: number}} */
            const err = new Error(`instagram profile non-json ${res.status}`);
            err.status = res.status;
            throw err;
        }

        const profile = normalizeProfileData(parsed);
        if (!profile) {
            /** @type {Error & {status?: number}} */
            const err = new Error(`instagram profile missing user ${res.status}`);
            err.status = res.status;
            throw err;
        }

        return profile;
    }

    async function fetchProfileFromApi(username) {
        let lastError = null;
        for (const candidate of profileApiCandidates(username)) {
            try {
                return await fetchProfileCandidate(candidate);
            } catch (err) {
                lastError = err;
                if (err?.status === 429) {
                    profileApiBackoffUntil = Date.now() + PROFILE_API_RATE_LIMIT_BACKOFF_MS;
                    throw err;
                }
            }
        }
        throw lastError || new Error('instagram profile data not found');
    }

    async function fetchProfileFromHtml(username) {
        const res = await fetch(`https://www.instagram.com/${username}/`, {
            headers: {
                ...REQUEST_HEADERS,
                Accept: 'text/html,*/*',
                'User-Agent': CRAWLER_USER_AGENT,
            },
        });
        const text = await res.text();
        if (!res.ok) {
            /** @type {Error & {status?: number}} */
            const err = new Error(`instagram profile html ${res.status}`);
            err.status = res.status;
            throw err;
        }

        const profile = normalizeProfileHtmlData(username, text);
        if (!profile) {
            /** @type {Error & {status?: number}} */
            const err = new Error(`instagram profile html missing user ${res.status}`);
            err.status = res.status;
            throw err;
        }
        return profile;
    }

    async function fetchProfileData(username) {
        const cacheKey = `profile:${username.toLowerCase()}`;
        const cached = getCachedData(cacheKey);
        if (cached) return cached;

        let lastError = null;
        try {
            const profile = await fetchProfileFromHtml(username);
            cacheData(cacheKey, profile);
            return profile;
        } catch (err) {
            lastError = err;
        }

        if (Date.now() >= profileApiBackoffUntil) {
            try {
                const profile = await fetchProfileFromApi(username);
                cacheData(cacheKey, profile);
                return profile;
            } catch (err) {
                if (err?.status === 429) {
                    /** @type {Error & {status?: number}} */
                    const combined = new Error(`instagram profile api rate limited after HTML fallback failed: ${lastError?.message || lastError}`);
                    combined.status = err.status;
                    throw combined;
                }
                throw err;
            }
        }

        throw lastError || new Error('instagram profile data not found');
    }

    function buildGraphqlBody(shortcode) {
        return new URLSearchParams({
            av: '0',
            __d: 'www',
            __user: '0',
            __a: '1',
            __req: 'k',
            __comet_req: '7',
            lsd: 'AVoPBTXMX0Y',
            jazoest: '2882',
            fb_api_caller_class: 'RelayModern',
            fb_api_req_friendly_name: 'PolarisPostActionLoadPostQueryQuery',
            variables: JSON.stringify({
                shortcode,
                fetch_comment_count: 40,
                parent_comment_count: 24,
                child_comment_count: 3,
                fetch_like_count: 10,
                fetch_tagged_user_count: null,
                fetch_preview_comment_count: 2,
                has_threaded_comments: true,
                hoisted_comment_id: null,
                hoisted_reply_id: null,
            }),
            server_timestamps: 'true',
            doc_id: GRAPHQL_DOC_ID,
        });
    }

    async function fetchGraphqlData(shortcode) {
        const res = await fetch('https://www.instagram.com/graphql/query/', {
            method: 'POST',
            headers: GRAPHQL_HEADERS,
            body: buildGraphqlBody(shortcode).toString(),
        });
        if (!res.ok) {
            if (res.status === 429) throw mediaRateLimited(res);
            if (res.status === 401 || res.status === 403) return null;
            /** @type {Error & {status?: number}} */
            const err = new Error(`instagram graphql ${res.status}`);
            err.status = res.status;
            throw err;
        }
        const text = await res.text();
        return parseInstagramGraphqlSource(text, shortcode);
    }

    function mediaUrlCandidates(parsed) {
        const routes = [parsed.route, 'p', 'reel', 'tv'].filter(Boolean);
        return [...new Set([
            buildCanonicalUrl(parsed),
            ...routes.map(route => `https://www.instagram.com/${route}/${parsed.shortcode}/embed/captioned/`),
        ])];
    }

    const inflight = new Map();

    function hasDirectInstagramVideo(data) {
        return Boolean(data?.medias?.some(media => {
            try {
                return media.verifiedVideoSource === true || /\.(mp4|mov|webm|m4v|mkv|avi)$/i.test(new URL(media.url).pathname);
            } catch {
                return false;
            }
        }));
    }

    function hasIncompleteMedia(data) {
        return data?.incompleteMedia === true || (data?.medias || []).some(media => /Video/i.test(String(media.typeName || '')) && !hasDirectInstagramVideo({ medias: [media] }));
    }

    async function fetchInstagramDataUncached(parsed) {
        const preferVideo = parsed.route === 'reel' || parsed.route === 'tv';
        const failureKey = `unavailable:${preferVideo ? 'video' : 'post'}:${parsed.shortcode}`;
        const cached = getCachedData(parsed.shortcode);
        if (cached && !hasIncompleteMedia(cached) && (!preferVideo || hasDirectInstagramVideo(cached))) return cached;
        if (mediaBackoffUntil > Date.now()) throw Object.assign(new Error('instagram media is rate limited'), { code: 'INSTAGRAM_RATE_LIMITED', status: 429, retryAfterMs: mediaBackoffUntil - Date.now() });
        if (getCachedData(failureKey)) throw Object.assign(new Error('instagram media is temporarily unavailable'), { code: 'INSTAGRAM_MEDIA_UNAVAILABLE' });

        function remember(data) {
            cacheData(parsed.shortcode, data);
            return data;
        }

        let lastError = null;
        let preview = cached || null;
        let incomplete = hasIncompleteMedia(preview);
        let expectedCount = 0;
        const expectedVideos = new Set();
        function observe(data) {
            if (!hasIncompleteMedia(data)) return;
            incomplete = true;
            expectedCount = Math.max(expectedCount, Number(data.expectedMediaCount) || data.medias?.length || 0);
            const positions = data.expectedVideoPositions || (data.medias || []).flatMap((media, i) => /Video/i.test(String(media.typeName || '')) ? [i] : []);
            for (const position of positions) expectedVideos.add(position);
        }
        function complete(data) {
            return !hasIncompleteMedia(data) && (data.medias?.length || 0) >= expectedCount
                && [...expectedVideos].every(index => /Video/i.test(String(data.medias?.[index]?.typeName || '')) && hasDirectInstagramVideo({ medias: [data.medias[index]] }));
        }
        observe(preview);
        for (const mediaUrl of mediaUrlCandidates(parsed)) {
            try {
                const res = await fetch(mediaUrl, { headers: MEDIA_REQUEST_HEADERS });
                if (!res.ok) {
                    if (res.status === 429) throw mediaRateLimited(res);
                    lastError = new Error(`instagram media page ${res.status}`);
                    continue;
                }
                const html = await res.text();
                const { data, previewOnly, ...sourceState } = parseInstagramHtmlSource(html, parsed.shortcode);
                if (sourceState.incompleteMedia) observe(sourceState);
                if (data) {
                    observe(data);
                    if (complete(data) && ((!preferVideo && !previewOnly) || hasDirectInstagramVideo(data))) return remember(data);
                    preview ||= data;
                }
            } catch (err) {
                if (err?.status === 429) throw err;
                lastError = err;
            }
        }

        // OG and oEmbed images can be cropped previews even for /p/ photos.
        // Exhaust actual post sources before accepting a preview as output.
        const graphqlSource = await fetchGraphqlData(parsed.shortcode).catch(err => {
            if (err?.status === 429) throw err;
            lastError = err;
            return null;
        });
        if (graphqlSource?.incompleteMedia) observe(graphqlSource);
        const graphqlData = graphqlSource?.data;
        if (graphqlData) observe(graphqlData);
        if (graphqlData && complete(graphqlData) && (!preferVideo || hasDirectInstagramVideo(graphqlData))) return remember(graphqlData);
        preview ||= graphqlData;

        const oembedData = await fetchOEmbedData(parsed).catch(err => {
            if (err?.status === 429) throw err;
            lastError = err;
            return null;
        });
        if (oembedData) {
            preview ||= oembedData;
        }

        if (preferVideo || incomplete) {
            // Keep a short negative cache so unavailable videos do not cause a
            // request storm while still allowing recovery after transient faults.
            cacheData(failureKey, true, 60 * 1000);
            throw Object.assign(new Error('instagram media is temporarily unavailable'), { code: 'INSTAGRAM_MEDIA_UNAVAILABLE' });
        }
        if (preview) {
            // A checked photo preview can be reused on repeated expansion.
            return remember(preview);
        }

        throw lastError || new Error('instagram data not found');
    }

    async function fetchInstagramData(parsed) {
        const key = `${parsed.route === 'reel' || parsed.route === 'tv' ? 'video' : 'post'}:${parsed.shortcode}`;
        if (inflight.has(key)) return inflight.get(key);
        const request = fetchInstagramDataUncached(parsed);
        inflight.set(key, request);
        try { return await request; } finally { if (inflight.get(key) === request) inflight.delete(key); }
    }

    return {
        resolveShareUrl,
        resolveParsedUrl,
        fetchProfileData,
        fetchInstagramData,
        // A read-only snapshot: diagnostics do not promote entries or prune them.
        getCacheStats() {
            return { size: dataCache.size, maxEntries: CACHE_MAX_ENTRIES, ttlMs: CACHE_TTL_MS };
        },
        clearCache() {
            dataCache.clear();
            nextCacheExpiryAt = Infinity;
            profileApiBackoffUntil = 0;
            mediaBackoffUntil = 0;
        },
    };
}

module.exports = {
    createInstagramClient,
};

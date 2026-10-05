'use strict';

const { CACHE_TTL_MS, PROFILE_API_RATE_LIMIT_BACKOFF_MS } = require('./constants');
const { parseInstagramUrl, buildCanonicalUrl } = require('./urls');
const {
    parseInstagramHtml,
    parseInstagramGraphql,
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

    function cacheData(key, data) {
        const now = Date.now();
        pruneExpiredCache(now);
        const expiresAt = now + CACHE_TTL_MS;
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
            if (res.status === 401 || res.status === 403 || res.status === 429) return null;
            /** @type {Error & {status?: number}} */
            const err = new Error(`instagram graphql ${res.status}`);
            err.status = res.status;
            throw err;
        }
        const text = await res.text();
        return parseInstagramGraphql(text, shortcode);
    }

    function mediaUrlCandidates(parsed) {
        const routes = [parsed.route, 'p', 'reel', 'tv'].filter(Boolean);
        return [...new Set([
            buildCanonicalUrl(parsed),
            ...routes.map(route => `https://www.instagram.com/${route}/${parsed.shortcode}/embed/captioned/`),
        ])];
    }

    async function fetchInstagramData(parsed) {
        const cached = getCachedData(parsed.shortcode);
        if (cached) return cached;

        let lastError = null;
        for (const mediaUrl of mediaUrlCandidates(parsed)) {
            try {
                const res = await fetch(mediaUrl, { headers: MEDIA_REQUEST_HEADERS });
                if (!res.ok) {
                    lastError = new Error(`instagram media page ${res.status}`);
                    continue;
                }
                const html = await res.text();
                const data = parseInstagramHtml(html, parsed.shortcode);
                if (data) {
                    cacheData(parsed.shortcode, data);
                    return data;
                }
            } catch (err) {
                lastError = err;
            }
        }

        const oembedData = await fetchOEmbedData(parsed).catch(err => {
            lastError = err;
            return null;
        });
        if (oembedData) {
            cacheData(parsed.shortcode, oembedData);
            return oembedData;
        }

        const graphqlData = await fetchGraphqlData(parsed.shortcode).catch(err => {
            lastError = err;
            return null;
        });
        if (graphqlData) {
            cacheData(parsed.shortcode, graphqlData);
            return graphqlData;
        }

        throw lastError || new Error('instagram data not found');
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
        },
    };
}

module.exports = {
    createInstagramClient,
};

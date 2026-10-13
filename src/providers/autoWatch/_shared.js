'use strict';

// Shared guest-only auto-watch helpers for optional provider adapters.

const fetchDefault = require('../../providerFetch').withDeadline(require('node-fetch'));
const publicAgent = new (require('node:https').Agent)({ lookup: require('./publicDns').lookup });

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function configuredAutoWatch() {
    try {
        const config = /** @type {any} */ (require('../../../config.json'));
        const section = config?.autoWatch || config?.auto_watch || {};
        return section && typeof section === 'object' ? section : {};
    } catch {
        return {};
    }
}

function integer(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
    return parsed;
}

function bool(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    return /^(1|true|yes|on)$/i.test(String(value));
}

function monitorConfig(overrides = {}) {
    const configured = configuredAutoWatch();
    return {
        timeoutMs: integer(overrides.timeoutMs ?? process.env.AUTO_WATCH_HTTP_TIMEOUT_MS ?? configured.httpTimeoutMs, 20000, 1000, 120000),
        // Every adapter must remain within guest-visible data. This switch is
        // only a kill switch for public crawl adapters, not an auth setting.
        enableGuestCrawls: bool(overrides.enableGuestCrawls ?? process.env.AUTO_WATCH_ENABLE_GUEST_CRAWLS ?? configured.enableGuestCrawls, true),
    };
}

function monitorError(code, message, properties = {}) {
    return Object.assign(new Error(message), { code, ...properties });
}

function sourceError(message) {
    return monitorError('AUTO_WATCH_INVALID_SOURCE', message);
}

function configurationError(providerId, message) {
    return monitorError('AUTO_WATCH_CONFIGURATION_REQUIRED', message, { providerId, retryAfterMs: 6 * HOUR });
}

function headerValue(headers, name) {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(name);
    return headers[name] || headers[String(name).toLowerCase()] || null;
}

function responseRateLimit(response) {
    const limitHeader = headerValue(response?.headers, 'x-ratelimit-limit') ?? headerValue(response?.headers, 'ratelimit-limit');
    const remainingHeader = headerValue(response?.headers, 'x-ratelimit-remaining') ?? headerValue(response?.headers, 'ratelimit-remaining');
    if (limitHeader == null || remainingHeader == null) return null;
    const limit = Number(limitHeader);
    const remaining = Number(remainingHeader);
    const resetSeconds = Number(headerValue(response?.headers, 'x-ratelimit-reset') || headerValue(response?.headers, 'ratelimit-reset'));
    if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return null;
    return { limit, remaining, resetAtMs: Number.isFinite(resetSeconds) ? resetSeconds * 1000 : null };
}

function retryAfterMs(response, payload) {
    const raw = headerValue(response?.headers, 'retry-after');
    if (raw) {
        const seconds = Number(raw);
        if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
        const at = Date.parse(raw);
        if (Number.isFinite(at)) return Math.max(0, at - Date.now());
    }
    const value = Number(payload?.retry_after ?? payload?.retryAfter ?? payload?.parameters?.retry_after);
    if (Number.isFinite(value) && value >= 0) return Math.ceil(value);
    return 15 * MINUTE;
}

function isRateLimited(response, payload) {
    if (response?.status === 429) return true;
    if (response?.status === 403 && responseRateLimit(response)?.remaining === 0) return true;
    const text = String(payload?.message || payload?.error?.message || '').toLowerCase();
    return (response?.status === 403 || response?.status === 429) && /rate limit|quota.*exceed|too many request/.test(text);
}

async function request(context, url, options = {}, parser = 'json') {
    const timeout = options.timeout ?? context.config.timeoutMs;
    const signal = AbortSignal.timeout(timeout);
    const initial = allowedGuestUrl(url);
    let target = initial, response;
    let method = options.method || 'GET', bodyOption = options.body;
    for (let hop = 0; hop <= 5; hop++) {
        response = await (context.fetch || fetchDefault)(target.toString(), {
            method, headers: options.headers, body: bodyOption, timeout, signal, redirect: 'manual',
            ...(!context.fetch ? { agent: publicAgent } : {}),
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        response.body?.destroy?.();
        const location = headerValue(response.headers, 'location');
        if (!location || hop === 5) throw monitorError('AUTO_WATCH_INVALID_REDIRECT', 'The provider redirect could not be followed safely.');
        const next = allowedGuestUrl(new URL(location, target));
        if (guestService(next.hostname) !== guestService(initial.hostname)) throw monitorError('AUTO_WATCH_INVALID_REDIRECT', 'The provider redirected outside its service.');
        target = next;
        if (response.status === 303 || [301, 302].includes(response.status) && method === 'POST') { method = 'GET'; bodyOption = undefined; }
    }
    const etag = headerValue(response.headers, 'etag');
    const lastModified = headerValue(response.headers, 'last-modified');
    if (response.status === 304) return { notModified: true, etag, lastModified, rateLimit: responseRateLimit(response), body: parser === 'text' ? '' : null };
    // Keep rate/quota hints without retaining unrelated error-page content.
    if (!response.ok) {
        let errorBody = null;
        if (parser === 'json' && [403, 429].includes(response.status)) {
            try { errorBody = await require('./streaming').readJsonProjection(response,
                [['message'], ['error', 'message'], ['retry_after'], ['retryAfter'], ['parameters', 'retry_after']]); }
            catch { /* A malformed error page still retains its HTTP status. */ }
        }
        response.body?.destroy?.();
        if (isRateLimited(response, errorBody)) {
            const rate = responseRateLimit(response);
            throw monitorError('AUTO_WATCH_RATE_LIMITED', 'Upstream rate limit reached.', { status: response.status,
                retryAfterMs: rate?.resetAtMs ? Math.max(0, rate.resetAtMs - Date.now()) : retryAfterMs(response, errorBody) });
        }
        throw monitorError('AUTO_WATCH_UPSTREAM_ERROR', `Upstream returned HTTP ${response.status}.`, { status: response.status });
    }
    let body = typeof options.readBody === 'function' ? await options.readBody(response) : await response.text();
    if (parser === 'json' && typeof body === 'string') {
        try { body = body ? JSON.parse(body) : null; } catch {
            if (response.status === 429) throw monitorError('AUTO_WATCH_RATE_LIMITED', 'Upstream rate limit reached.', { status: 429, retryAfterMs: retryAfterMs(response) });
            if (!response.ok) throw monitorError('AUTO_WATCH_UPSTREAM_ERROR', `Upstream returned HTTP ${response.status}.`, { status: response.status });
            throw monitorError('AUTO_WATCH_INVALID_RESPONSE', 'Upstream did not return JSON.', { status: response.status });
        }
    }
    if (isRateLimited(response, body)) {
        const rate = responseRateLimit(response);
        throw monitorError('AUTO_WATCH_RATE_LIMITED', 'Upstream rate limit reached.', {
            status: response.status,
            retryAfterMs: rate?.resetAtMs ? Math.max(0, rate.resetAtMs - Date.now()) : retryAfterMs(response, body),
        });
    }
    if (!response.ok) throw monitorError('AUTO_WATCH_UPSTREAM_ERROR', `Upstream returned HTTP ${response.status}.`, { status: response.status });
    return { body, etag, lastModified, notModified: false, rateLimit: responseRateLimit(response) };
}

function guestService(host) {
    return ['youtube.com', 'github.com', 'twitch.tv', 'spotify.com', 'pixiv.net', 'booth.pm']
        .find(domain => host === domain || host.endsWith(`.${domain}`));
}

function allowedGuestUrl(value) {
    let parsed;
    try { parsed = new URL(value); } catch { throw monitorError('AUTO_WATCH_INVALID_REDIRECT', 'The provider returned an invalid URL.'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !guestService(parsed.hostname)) {
        throw monitorError('AUTO_WATCH_INVALID_REDIRECT', 'The provider URL is outside the allowed public service.');
    }
    return parsed;
}

function requestJson(context, url, options) {
    return request(context, url, options, 'json');
}

function requestText(context, url, options) {
    return request(context, url, options, 'text');
}

function urlFromInput(value) {
    try { return new URL(String(value || '').trim()); } catch { return null; }
}

function dedupeItems(items) {
    const seen = new Set();
    return (Array.isArray(items) ? items : []).filter(item => {
        const id = String(item?.contentId || '');
        if (!id || !item?.url || seen.has(id)) return false;
        seen.add(id);
        return true;
    });
}

function conditionalHeaders(source, headers = {}) {
    const result = { ...headers };
    if (source.etag) result['If-None-Match'] = source.etag;
    if (source.last_modified) result['If-Modified-Since'] = source.last_modified;
    return result;
}

function dateMs(value) {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : null;
}

function parseState(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    try {
        const value = JSON.parse(raw || '{}');
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
        return {};
    }
}

module.exports = {
    DAY,
    HOUR,
    MINUTE,
    bool,
    conditionalHeaders,
    configurationError,
    dateMs,
    dedupeItems,
    fetchDefault,
    headerValue,
    integer,
    monitorConfig,
    monitorError,
    parseState,
    requestJson,
    requestText,
    responseRateLimit,
    retryAfterMs,
    sourceError,
    urlFromInput,
};

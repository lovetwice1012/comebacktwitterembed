'use strict';

const crypto = require('crypto');

const MAX_TEXT = 2000;

function truncate(value, maxLength = MAX_TEXT) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    if (!text) return null;
    return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function hashValue(value) {
    if (!value) return null;
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeUrl(rawUrl) {
    if (!rawUrl) return null;
    try {
        const url = new URL(String(rawUrl));
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch {
        return String(rawUrl).split(/[?#]/)[0] || String(rawUrl);
    }
}

function normalizeUrlParameterKey(value) {
    const normalized = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.:-]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return normalized ? truncate(normalized, 191) : null;
}

function urlParameterSensitivity(key) {
    const text = String(key || '').toLowerCase();
    if (/(token|auth|session|secret|password|passwd|passcode|jwt|csrf|signature|sig|access|refresh|credential|apikey|api_key)/.test(text)) return 'high';
    if (/(email|mail|phone|tel|address|discord|user|userid|user_id|uid|member|account|customer|client|invite|code)/.test(text)) return 'medium';
    if (/^utm_|^(gclid|fbclid|yclid|msclkid|mc_cid|mc_eid|igshid|si|ref|ref_src|source|campaign|affiliate|tag)$/.test(text)) return 'marketing';
    return 'low';
}

function urlParameterFamily(key) {
    const text = String(key || '').toLowerCase();
    if (/^utm_|campaign/.test(text)) return 'campaign';
    if (/(gclid|fbclid|yclid|msclkid|click|clid|mc_cid|mc_eid)/.test(text)) return 'ad_tracking';
    if (/(ref|source|affiliate|tag|partner|share)/.test(text)) return 'referral';
    if (/(token|auth|session|secret|password|jwt|csrf|signature|sig|access|refresh|credential|apikey|api_key)/.test(text)) return 'credential_risk';
    if (/(email|mail|phone|tel|address|discord|user|userid|user_id|uid|member|account|customer|client|invite|code)/.test(text)) return 'identifier_risk';
    return 'general';
}

function urlQueryParameterFacets(rawUrl, metadata = null) {
    if (!rawUrl) return [];
    let parsed = null;
    try {
        parsed = new URL(String(rawUrl));
    } catch {
        return [];
    }
    const keys = new Set();
    for (const key of parsed.searchParams.keys()) {
        const normalized = normalizeUrlParameterKey(key);
        if (normalized) keys.add(normalized);
    }
    const hashQueryIndex = parsed.hash ? parsed.hash.indexOf('?') : -1;
    if (hashQueryIndex >= 0) {
        const hashParams = new URLSearchParams(parsed.hash.slice(hashQueryIndex + 1));
        for (const key of hashParams.keys()) {
            const normalized = normalizeUrlParameterKey(key);
            if (normalized) keys.add(normalized);
        }
    }
    return [...keys].map(key => facet(
        'url.query_param',
        key,
        null,
        {
            key,
            family: urlParameterFamily(key),
            privacy_sensitivity: urlParameterSensitivity(key),
            values_stored: false,
        },
        metadata,
    )).filter(Boolean);
}

function endpointKeyFromUrl(rawUrl) {
    if (!rawUrl) return null;
    try {
        const url = new URL(String(rawUrl));
        const firstSegment = url.pathname.split('/').filter(Boolean)[0];
        return firstSegment ? `${url.hostname}/${firstSegment}` : url.hostname;
    } catch {
        return null;
    }
}

function accountKeyFromUrl(providerId, rawUrl) {
    if (!rawUrl) return null;
    try {
        const url = new URL(String(rawUrl));
        const host = url.hostname.replace(/^www\./, '').toLowerCase();
        const segments = url.pathname.split('/').filter(Boolean);
        const first = segments[0] || '';
        const second = segments[1] || '';
        const provider = String(providerId || '').toLowerCase();

        if ((provider === 'twitter' || host === 'x.com' || host === 'twitter.com') && first && !['i', 'intent', 'share', 'search', 'home'].includes(first)) return first.replace(/^@/, '').toLowerCase();
        if (provider === 'instagram' && first && !['p', 'reel', 'tv', 'stories', 'explore'].includes(first)) return first.toLowerCase();
        if (provider === 'tiktok' && first.startsWith('@')) return first.slice(1).toLowerCase();
        if (provider === 'youtube') {
            if (first.startsWith('@')) return first.toLowerCase();
            if (['channel', 'user', 'c'].includes(first) && second) return `${first}/${second}`;
        }
        if (provider === 'github' && first) return first.toLowerCase();
        if (provider === 'twitch' && first && !['videos', 'directory'].includes(first)) return first.toLowerCase();
        if (provider === 'booth') {
            const boothHost = host.endsWith('.booth.pm') ? host.replace(/\.booth\.pm$/, '') : '';
            if (boothHost && boothHost !== 'booth') return boothHost;
        }
        if (provider === 'pixiv' && first === 'users' && second) return `users/${second}`;
        if (provider === 'niconico' && first === 'user' && second) return `user/${second}`;
        if (provider === 'steam' && first === 'developer' && second) return `developer/${second}`;
        if (provider === 'spotify' && ['artist', 'show'].includes(first) && second) return `${first}/${second}`;
        if (provider === 'amazon' && second && ['dp', 'gp'].includes(first)) return `${first}/${second}`;
        return endpointKeyFromUrl(rawUrl);
    } catch {
        return null;
    }
}

function contentIdFromUrl(providerId, rawUrl) {
    if (!rawUrl) return null;
    try {
        const url = new URL(String(rawUrl));
        const segments = url.pathname.split('/').filter(Boolean);
        const provider = String(providerId || '').toLowerCase();
        if (provider === 'twitter') return segments[2] && segments[1] === 'status' ? `status/${segments[2]}` : null;
        if (provider === 'youtube') return url.searchParams.get('v') || (url.hostname.includes('youtu.be') ? segments[0] : url.searchParams.get('list'));
        if (provider === 'github') return segments.slice(0, 2).join('/');
        if (provider === 'pixiv') return segments.includes('artworks') ? `artworks/${segments[segments.indexOf('artworks') + 1]}` : null;
        if (provider === 'booth') return segments.includes('items') ? `items/${segments[segments.indexOf('items') + 1]}` : null;
        if (provider === 'amazon') return segments[segments.indexOf('dp') + 1] || segments[segments.indexOf('gp') + 2] || null;
        return segments.slice(0, 3).join('/') || null;
    } catch {
        return null;
    }
}

function embedToObject(embed) {
    if (!embed) return null;
    if (typeof embed.toJSON === 'function') return embed.toJSON();
    return embed;
}

function firstEmbed(steps) {
    return steps.flatMap(step => Array.isArray(step.embeds) ? step.embeds.map(embedToObject).filter(Boolean) : [])[0] || null;
}

function allEmbeds(steps) {
    return steps.flatMap(step => Array.isArray(step.embeds) ? step.embeds.map(embedToObject).filter(Boolean) : []);
}

function facet(key, value, numericValue = null, jsonValue = null, metadata = null) {
    if ((value === undefined || value === null || value === '') && numericValue === null && jsonValue === null) return null;
    return {
        facet_key: key,
        facet_value: value === undefined || value === null ? null : truncate(value, 512),
        numeric_value: numericValue,
        json_value: jsonValue === undefined || jsonValue === null ? null : JSON.stringify(jsonValue),
        metric_stage: truncate(metadata?.stage || 'initial', 32),
        metric_source: truncate(metadata?.source, 96),
        collected_at_ms: metadata?.collectedAtMs ?? null,
        schema_version: truncate(metadata?.schemaVersion, 64),
        collection_success: metadata?.success === undefined || metadata?.success === null ? 1 : (metadata.success ? 1 : 0),
        collection_timeout_ms: metadata?.timeoutMs ?? null,
    };
}

function finitePositiveInteger(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : null;
}

function normalizeSuccess(value) {
    if (value === undefined || value === null || value === '') return true;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    return !/^(false|0|no|failed|error)$/i.test(String(value).trim());
}

function normalizeAnalyticsMetadata(block, input, fallbackStage = 'initial') {
    const metadata = block?.metadata || block?.analyticsMetadata || block?.metricMetadata || {};
    return {
        stage: truncate(metadata.stage ?? metadata.metricStage ?? block?.stage ?? fallbackStage, 32) || fallbackStage,
        source: truncate(metadata.source ?? metadata.metricSource ?? block?.source ?? input.source, 96),
        collectedAtMs: finitePositiveInteger(metadata.collectedAtMs ?? metadata.collected_at_ms ?? metadata.fetchedAtMs ?? metadata.fetched_at_ms ?? input.occurredAtMs) ?? Date.now(),
        schemaVersion: truncate(metadata.schemaVersion ?? metadata.schema_version ?? metadata.schema ?? block?.schemaVersion ?? input.schemaVersion, 64),
        timeoutMs: finitePositiveInteger(metadata.timeoutMs ?? metadata.timeout_ms ?? block?.timeoutMs),
        success: normalizeSuccess(metadata.success ?? metadata.collectionSuccess ?? metadata.collection_success),
    };
}

function normalizeFacetKey(providerId, key) {
    const raw = String(key || '').trim().replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
    if (!raw) return null;
    return raw.includes('.') ? raw : `${providerId}.${raw}`;
}

function analyticsBlocks(steps) {
    return steps
        .flatMap(step => [step?.analytics, step?.providerAnalytics, step?.provider_content_analytics])
        .filter(item => item && typeof item === 'object');
}

function normalizeNativeFacet(providerId, item, metadata) {
    if (!item || typeof item !== 'object') return null;
    const key = normalizeFacetKey(providerId, item.facet_key || item.key || item.name);
    if (!key) return null;
    const hasOwnMetadata = item.metadata || item.analyticsMetadata || item.metricMetadata || item.source || item.stage || item.schemaVersion || item.schema_version;
    const facetMetadata = hasOwnMetadata
        ? { ...metadata, ...normalizeAnalyticsMetadata(item, { source: metadata?.source, occurredAtMs: metadata?.collectedAtMs, schemaVersion: metadata?.schemaVersion }, metadata?.stage || 'initial') }
        : metadata;
    return facet(
        key,
        item.facet_value ?? item.value ?? null,
        item.numeric_value ?? item.numericValue ?? (typeof item.value === 'number' ? item.value : null),
        item.json_value ?? item.jsonValue ?? item.json ?? null,
        facetMetadata,
    );
}

function metricFacets(providerId, metrics, metadata) {
    if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return [];
    return Object.entries(metrics).map(([key, value]) => {
        const facetKey = normalizeFacetKey(providerId, key);
        if (!facetKey) return null;
        if (typeof value === 'number' && Number.isFinite(value)) return facet(facetKey, null, value, null, metadata);
        if (value && typeof value === 'object') return facet(facetKey, value.label ?? value.value ?? null, value.numericValue ?? value.numeric_value ?? null, value, metadata);
        return facet(facetKey, value, null, null, metadata);
    }).filter(Boolean);
}

function normalizeNativeAnalytics(providerId, steps, input) {
    const blocks = analyticsBlocks(steps);
    if (!blocks.length) return { event: {}, facets: [], rawMetrics: null };
    const event = {};
    const facets = [];
    const rawMetrics = {};

    for (const block of blocks) {
        const content = block.content || block.event || block;
        const metadata = normalizeAnalyticsMetadata(block, input, 'initial');
        for (const [target, keys] of Object.entries({
            account_key: ['accountKey', 'account_key'],
            content_id: ['contentId', 'content_id'],
            content_type: ['contentType', 'content_type'],
            content_url: ['contentUrl', 'content_url', 'url'],
            normalized_url: ['normalizedUrl', 'normalized_url'],
            title: ['title'],
            description_preview: ['descriptionPreview', 'description_preview'],
            author_name: ['authorName', 'author_name'],
            language: ['language'],
            published_at_ms: ['publishedAtMs', 'published_at_ms'],
            sensitive: ['sensitive'],
            media_count: ['mediaCount', 'media_count'],
            duration_seconds: ['durationSeconds', 'duration_seconds'],
        })) {
            const value = keys.map(key => content?.[key]).find(item => item !== undefined && item !== null && item !== '');
            if (value !== undefined && value !== null && value !== '') event[target] = value;
        }

        const metrics = block.metrics || block.rawMetrics || block.raw_metrics || block.metricValues;
        Object.assign(rawMetrics, metrics && typeof metrics === 'object' && !Array.isArray(metrics) ? metrics : {});
        facets.push(...metricFacets(providerId, metrics, metadata));
        facets.push(...(Array.isArray(block.facets) ? block.facets.map(item => normalizeNativeFacet(providerId, item, metadata)) : []));
    }

    return {
        event,
        facets: facets.filter(Boolean),
        rawMetrics: Object.keys(rawMetrics).length ? rawMetrics : null,
    };
}

function summarizeProviderContent(input) {
    const providerId = String(input.providerId || '');
    const steps = Array.isArray(input.steps) ? input.steps : [];
    const embeds = allEmbeds(steps);
    const first = firstEmbed(steps) || {};
    const native = normalizeNativeAnalytics(providerId, steps, input);
    const rawUrl = native.event.content_url || input.url || first.url || null;
    const normalizedUrl = normalizeUrl(rawUrl);
    const mediaCount = steps.reduce((sum, step) => sum + (Array.isArray(step.files) ? step.files.length : 0), 0)
        + embeds.filter(embed => embed.image || embed.thumbnail).length;

    const event = {
        occurred_at_ms: Number.isFinite(input.occurredAtMs) ? Math.floor(input.occurredAtMs) : Date.now(),
        provider_id: providerId,
        account_key: input.accountKey || native.event.account_key || accountKeyFromUrl(providerId, rawUrl),
        content_id: native.event.content_id || contentIdFromUrl(providerId, rawUrl),
        content_type: truncate(native.event.content_type || input.contentType || providerId, 64),
        content_url: truncate(native.event.content_url || rawUrl, 4000),
        normalized_url: truncate(native.event.normalized_url || normalizedUrl, 4000),
        url_hash: hashValue(rawUrl || normalizedUrl),
        title: truncate(native.event.title || first.title, 4000),
        description_preview: truncate(native.event.description_preview || first.description, 4000),
        author_name: truncate(native.event.author_name || first.author?.name || first.footer?.text, 255),
        language: truncate(native.event.language || input.language, 32),
        published_at_ms: native.event.published_at_ms || (first.timestamp ? Date.parse(first.timestamp) : null),
        sensitive: native.event.sensitive ?? null,
        media_count: native.event.media_count ?? (mediaCount || null),
        duration_seconds: native.event.duration_seconds ?? null,
        guild_id: truncate(input.guildId, 32),
        channel_id: truncate(input.channelId, 32),
        author_user_id: truncate(input.authorUserId, 32),
        source: truncate(input.source, 96),
        raw_metrics_json: native.rawMetrics ? JSON.stringify(native.rawMetrics) : null,
    };

    const urlFacets = urlQueryParameterFacets(rawUrl, {
        stage: 'initial',
        source: 'url.query_param.extract',
        collectedAtMs: event.occurred_at_ms,
        schemaVersion: 'url-query-param-v1',
        success: true,
    });
    const facets = [...native.facets, ...urlFacets];
    const durationFacet = facets.find(item => item.facet_key.endsWith('duration_seconds') && item.numeric_value !== null);
    if (durationFacet) event.duration_seconds = durationFacet.numeric_value;
    const sensitiveFacet = facets.find(item => item.facet_key.includes('sensitive'));
    if (sensitiveFacet) event.sensitive = /yes|true|sensitive/i.test(String(sensitiveFacet.facet_value || '')) ? 1 : 0;

    return { event, facets, hasNativeAnalytics: native.facets.length > 0 };
}

module.exports = {
    accountKeyFromUrl,
    contentIdFromUrl,
    endpointKeyFromUrl,
    normalizeUrl,
    summarizeProviderContent,
    _internal: {
        normalizeUrlParameterKey,
        urlParameterFamily,
        urlParameterSensitivity,
        urlQueryParameterFacets,
    },
};

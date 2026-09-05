'use strict';

function cleanKey(key) {
    const text = String(key || '').trim().replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
    return text || null;
}

function cleanText(value) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text ? text : null;
}

function parseMetricNumber(raw, options = {}) {
    const result = { raw, value: null, status: 'invalid', format: options.kind || 'number', unit: null, reason: null };
    const invalid = reason => ({ ...result, reason });
    const success = (value, format = result.format, unit = result.unit) => {
        if (!Number.isFinite(value)) return invalid('non_finite');
        if (Math.abs(value) > Number.MAX_SAFE_INTEGER) return invalid('outside_safe_numeric_range');
        return { ...result, value, status: 'ok', format, unit, reason: null };
    };
    if (raw === undefined || raw === null || typeof raw === 'string' && raw.trim() === '') return { ...result, status: 'missing', reason: 'not_observed' };
    if (typeof raw === 'number') return success(raw);
    if (typeof raw !== 'string') return invalid('unsupported_type');
    let text = raw.normalize('NFKC').trim();
    const kind = options.kind || 'number';
    if (kind === 'money') {
        const prefix = text.match(/^([+-]?)(USD|JPY|EUR|GBP|CAD|AUD|CNY|KRW|INR|[$¥€£₩₹])\s*/i);
        const suffix = text.match(/\s*(USD|JPY|EUR|GBP|CAD|AUD|CNY|KRW|INR|円)$/i);
        if (prefix && suffix) return invalid('ambiguous_currency_markers');
        if (prefix) { result.unit = prefix[2].toUpperCase(); text = prefix[1] + text.slice(prefix[0].length); }
        if (suffix) { result.unit = suffix[1].toUpperCase(); text = text.slice(0, -suffix[0].length); }
    } else if (kind === 'percent') {
        const match = text.match(/^(.+?)\s*%(?:\s+off)?$/i);
        if (match) { text = match[1]; result.unit = 'percent'; }
    } else if (kind === 'duration') {
        const clock = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
        if (clock) {
            const hours = Number(clock[1] || 0), minutes = Number(clock[2]), seconds = Number(clock[3]);
            if (minutes > 59 || seconds > 59) return invalid('invalid_clock_duration');
            return success(hours * 3600 + minutes * 60 + seconds, 'duration', 'seconds');
        }
        const duration = text.match(/^(?:(\d+)\s*h\s*)?(?:(\d+)\s*m\s*)?(?:(\d+(?:\.\d+)?)\s*s)?$/i);
        if (duration && duration.slice(1).some(Boolean)) return success(Number(duration[1] || 0) * 3600 + Number(duration[2] || 0) * 60 + Number(duration[3] || 0), 'duration', 'seconds');
        result.unit = 'seconds';
    } else if (kind === 'rating') {
        const rating = text.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)(?:\s*\((?:\d{1,3}(?:,\d{3})+|\d+)\))?$/);
        if (rating) {
            const score = Number(rating[1]), scale = Number(rating[2]);
            if (scale <= 0 || score > scale) return invalid('rating_outside_scale');
            return success(score, 'rating', `out_of_${scale}`);
        }
    }
    // Only complete, recognized numeric strings qualify. Commas must form
    // three-digit groups; ranges, prose, localized decimal commas and IDs with
    // surrounding text must never turn into a first-substring count.
    const match = text.match(/^([+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)(?:\s*([KMBkmb万億]))?$/);
    if (!match) return invalid('unrecognized_numeric_format');
    if (match[2] && (kind === 'duration' || kind === 'rating' || kind === 'percent' || options.compact === false)) return invalid('compact_unit_not_allowed');
    const multiplier = ({ k: 1e3, m: 1e6, b: 1e9, '万': 1e4, '億': 1e8 })[match[2]?.toLowerCase()] || 1;
    return success(Number(match[1].replace(/,/g, '')) * multiplier, match[2] ? 'compact' : kind, result.unit);
}

function finiteNumber(value, options = {}) {
    return parseMetricNumber(value, options).value;
}

function metric(key, value, label = null) {
    const normalizedKey = cleanKey(key);
    const numericValue = finiteNumber(value);
    if (!normalizedKey || numericValue === null) return null;
    return { key: normalizedKey, value: label, numericValue };
}

function facet(key, value, numericValue = null) {
    const normalizedKey = cleanKey(key);
    const textValue = cleanText(value);
    const numeric = numericValue === null ? null : finiteNumber(numericValue);
    if (!normalizedKey || (textValue === null && numeric === null)) return null;
    return { key: normalizedKey, value: textValue, numericValue: numeric };
}

function tagFacets(key, values) {
    const list = Array.isArray(values) ? values : [];
    return list.map(value => facet(key, value)).filter(Boolean);
}

function compactObject(value) {
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(
        Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''),
    );
}

function compactMetadata(metadata = {}) {
    return compactObject({
        source: metadata.source ?? metadata.metricSource,
        schemaVersion: metadata.schemaVersion ?? metadata.schema_version,
        stage: metadata.stage ?? metadata.metricStage,
        collectedAtMs: metadata.collectedAtMs ?? metadata.collected_at_ms,
        timeoutMs: metadata.timeoutMs ?? metadata.timeout_ms,
        success: metadata.success ?? metadata.collectionSuccess ?? metadata.collection_success,
    });
}

function createProviderAnalytics({ content = {}, metrics = {}, facets = [], metadata = {} } = {}) {
    const numericParsing = Object.fromEntries(Object.entries(metrics).map(([key, value]) => [cleanKey(key), parseMetricNumber(value)]).filter(([key]) => key));
    const normalizedMetrics = Object.fromEntries(
        Object.entries(metrics)
            .map(([key, value]) => [cleanKey(key), finiteNumber(value)])
            .filter(([key, value]) => key && value !== null),
    );
    const normalizedFacets = [
        ...Object.entries(metrics).map(([key, value]) => metric(key, value)).filter(Boolean),
        ...facets.filter(Boolean),
    ];
    return {
        content: compactObject(content),
        metrics: normalizedMetrics,
        facets: normalizedFacets,
        metadata: { ...compactMetadata(metadata), numericParsing },
    };
}

module.exports = {
    cleanKey,
    cleanText,
    compactMetadata,
    createProviderAnalytics,
    facet,
    finiteNumber,
    parseMetricNumber,
    metric,
    tagFacets,
};

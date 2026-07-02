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

function finiteNumber(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const text = String(value).replace(/,/g, '');
    const match = text.match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
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
        metadata: compactMetadata(metadata),
    };
}

module.exports = {
    cleanKey,
    cleanText,
    compactMetadata,
    createProviderAnalytics,
    facet,
    finiteNumber,
    metric,
    tagFacets,
};

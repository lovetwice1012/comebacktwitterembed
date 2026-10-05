'use strict';

const { parseJsonSafely, decodeHtml, cleanText, absoluteUrl, readMetaContent, truncate } = require('./html');

const DEFAULT_DESCRIPTION_MAX_LENGTH = 700;

function jsonLdScripts(html) {
    const out = [];
    const re = /<script\b(?=[^>]*type=["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = re.exec(html)) !== null) {
        const parsed = parseJsonSafely(decodeHtml(match[1]).trim());
        if (parsed) out.push(parsed);
    }
    return out;
}

function typeIncludes(type, acceptedTypes) {
    if (Array.isArray(type)) return type.some(item => typeIncludes(item, acceptedTypes));
    return acceptedTypes.has(String(type || '').toLowerCase());
}

function findJsonLdNode(value, predicate, depth = 0) {
    if (!value || depth > 8) return null;
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findJsonLdNode(item, predicate, depth + 1);
            if (found) return found;
        }
        return null;
    }
    if (typeof value !== 'object') return null;
    if (predicate(value)) return value;

    if (Array.isArray(value['@graph'])) {
        const found = findJsonLdNode(value['@graph'], predicate, depth + 1);
        if (found) return found;
    }

    for (const child of Object.values(value)) {
        if (child && typeof child === 'object') {
            const found = findJsonLdNode(child, predicate, depth + 1);
            if (found) return found;
        }
    }
    return null;
}

function findJsonLdByType(html, typeNames, fallbackPredicate = null) {
    const acceptedTypes = new Set(typeNames.map(type => String(type).toLowerCase()));
    for (const script of jsonLdScripts(html)) {
        const found = findJsonLdNode(script, node => (
            typeIncludes(node['@type'], acceptedTypes)
            || (fallbackPredicate && fallbackPredicate(node))
        ));
        if (found) return found;
    }
    return null;
}

function firstArrayItem(value) {
    return Array.isArray(value) ? value[0] : value;
}

function imageFromValue(value) {
    const item = firstArrayItem(value);
    if (!item) return '';
    if (typeof item === 'string') return item;
    if (typeof item === 'object') return item.url || item.contentUrl || '';
    return '';
}

function thingName(value) {
    const item = firstArrayItem(value);
    if (!item) return '';
    if (typeof item === 'string') return cleanText(item);
    if (typeof item === 'object') return cleanText(item.name || item.title || '');
    return '';
}

function thingNames(value) {
    const values = Array.isArray(value) ? value : [value];
    const out = [];
    const seen = new Set();
    for (const item of values) {
        const name = thingName(item);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        out.push(name);
    }
    return out;
}

function formatNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return cleanText(value);
    return n.toLocaleString('en-US');
}

function readGenericImage(html, node, baseUrl) {
    return absoluteUrl(
        imageFromValue(node?.image)
        || readMetaContent(html, 'og:image')
        || readMetaContent(html, 'twitter:image'),
        baseUrl
    );
}

function readGenericDescription(html, node, descriptionMaxLength = DEFAULT_DESCRIPTION_MAX_LENGTH) {
    return truncate(
        cleanText(node?.description || readMetaContent(html, 'og:description') || readMetaContent(html, 'description')),
        descriptionMaxLength
    );
}

function formatIsoDuration(value) {
    const raw = cleanText(value);
    const match = raw.match(/^P(?:T)?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
    if (!match) return raw;
    const hours = Number(match[1] || 0);
    const minutes = Number(match[2] || 0);
    const seconds = Number(match[3] || 0);
    const parts = [];
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (seconds && !hours) parts.push(`${seconds}s`);
    return parts.join(' ') || raw;
}

function yearFromDate(value) {
    const match = cleanText(value).match(/\b(\d{4})\b/);
    return match?.[1] || '';
}

module.exports = {
    DEFAULT_DESCRIPTION_MAX_LENGTH,
    findJsonLdByType,
    firstArrayItem,
    formatIsoDuration,
    formatNumber,
    imageFromValue,
    readGenericDescription,
    readGenericImage,
    thingName,
    thingNames,
    yearFromDate,
};

'use strict';


function decodeHtml(value) {
    return String(value ?? '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_m, num) => String.fromCodePoint(parseInt(num, 10)));
}

function stripHtml(value) {
    return decodeHtml(value)
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .join('\n')
        .trim();
}

function cleanText(value) {
    return stripHtml(value)
        .replace(/\s+/g, ' ')
        .trim();
}

function truncate(value, maxLength) {
    const text = String(value ?? '').trim();
    if (!text || text.length <= maxLength) return text;
    if (maxLength <= 3) return text.slice(0, maxLength);
    return text.slice(0, maxLength - 3).trimEnd() + '...';
}

function extractAttr(tag, attrName) {
    if (!tag) return '';
    const re = new RegExp(`\\b${attrName}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
    const match = tag.match(re);
    return match ? decodeHtml(match[2] || match[3] || match[4] || '') : '';
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readMetaContent(html, name) {
    const attr = escapeRegExp(name);
    const tag = html.match(new RegExp(`<meta\\b(?=[^>]*(?:property|name)=["']${attr}["'])[^>]*>`, 'i'))?.[0];
    return tag ? cleanText(extractAttr(tag, 'content')) : '';
}

function readElementHtmlById(html, id) {
    const attr = escapeRegExp(id);
    const match = html.match(new RegExp(`<([a-zA-Z0-9:-]+)\\b(?=[^>]*\\bid=["']${attr}["'])[^>]*>([\\s\\S]*?)<\\/\\1>`, 'i'));
    return match ? match[2] : '';
}

function readElementTextById(html, id) {
    return cleanText(readElementHtmlById(html, id));
}

function readElementsHtmlByAttr(html, attrName, attrValue) {
    const attr = escapeRegExp(attrName);
    const value = escapeRegExp(attrValue);
    const re = new RegExp(`<([a-zA-Z0-9:-]+)\\b(?=[^>]*\\b${attr}\\s*=\\s*["']${value}["'])[^>]*>([\\s\\S]*?)<\\/\\1>`, 'gi');
    const out = [];
    let match;
    while ((match = re.exec(html)) !== null) {
        out.push(match[2]);
    }
    return out;
}

function readFirstElementHtmlByAttr(html, attrName, attrValue) {
    return readElementsHtmlByAttr(html, attrName, attrValue)[0] || '';
}

function readElementTextsByAttr(html, attrName, attrValue) {
    return readElementsHtmlByAttr(html, attrName, attrValue)
        .map(value => cleanText(value))
        .filter(Boolean);
}

function readOpeningTagsByAttr(html, attrName, attrValue) {
    const attr = escapeRegExp(attrName);
    const value = escapeRegExp(attrValue);
    return html.match(new RegExp(`<[a-zA-Z0-9:-]+\\b(?=[^>]*\\b${attr}\\s*=\\s*["']${value}["'])[^>]*>`, 'gi')) || [];
}

function readFirstOpeningTagByAttr(html, attrName, attrValue) {
    return readOpeningTagsByAttr(html, attrName, attrValue)[0] || '';
}

function readAttributeValues(html, attrName) {
    const attr = escapeRegExp(attrName);
    const re = new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'gi');
    const out = [];
    let match;
    while ((match = re.exec(html)) !== null) {
        const value = cleanText(decodeHtml(match[2] || match[3] || match[4] || ''));
        if (value) out.push(value);
    }
    return out;
}

function readFirstElementTextById(html, ids) {
    for (const id of ids) {
        const text = readElementTextById(html, id);
        if (text) return text;
    }
    return '';
}

function readTitleTag(html) {
    const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    return match ? cleanText(match[1]) : '';
}

function parseJsonSafely(value) {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function absoluteUrl(rawUrl, baseUrl) {
    const value = String(rawUrl || '').trim();
    if (!value) return '';
    if (value.startsWith('//')) return 'https:' + value;
    try {
        return new URL(value, baseUrl).toString();
    } catch {
        return value;
    }
}

function iframeSrcFromHtml(html, baseUrl) {
    const tag = String(html || '').match(/<iframe\b[^>]*>/i)?.[0] || '';
    return absoluteUrl(extractAttr(tag, 'src'), baseUrl);
}

function firstCleanText(...values) {
    for (const value of values) {
        const text = cleanText(value);
        if (text) return text;
    }
    return '';
}

module.exports = {
    absoluteUrl,
    cleanText,
    decodeHtml,
    escapeRegExp,
    extractAttr,
    firstCleanText,
    iframeSrcFromHtml,
    parseJsonSafely,
    readAttributeValues,
    readElementHtmlById,
    readElementTextById,
    readElementTextsByAttr,
    readFirstElementHtmlByAttr,
    readFirstElementTextById,
    readFirstOpeningTagByAttr,
    readMetaContent,
    readTitleTag,
    stripHtml,
    truncate,
};

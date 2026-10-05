'use strict';

function decodeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>\s*<p>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_m, num) => String.fromCodePoint(parseInt(num, 10)));
}

module.exports = { decodeHtml };

'use strict';

const { cleanText, absoluteUrl } = require('./html');

function sourceTypePriority(type) {
    const value = cleanText(type).toLowerCase();
    if (value === 'image/jpeg' || value === 'image/jpg') return 0;
    if (!value) return 1;
    if (value === 'image/webp') return 2;
    if (value === 'image/avif') return 3;
    return 4;
}

function widthFromImageUrl(url) {
    const match = String(url || '').match(/[._](?:S|U)X(\d+)[_.]/i);
    return match ? Number(match[1]) : 0;
}

function srcSetCandidates(srcset, baseUrl, priority, orderStart) {
    return String(srcset || '')
        .split(',')
        .map((entry, index) => {
            const trimmed = entry.trim();
            const width = Number(trimmed.match(/\s+(\d+)w(?:\s*$|\s)/)?.[1] || 0);
            const density = Number(trimmed.match(/\s+(\d+(?:\.\d+)?)x(?:\s*$|\s)/)?.[1] || 0);
            const rawUrl = trimmed.replace(/\s+(?:\d+w|\d+(?:\.\d+)?x)\s*$/, '').trim();
            const url = absoluteUrl(rawUrl, baseUrl);
            return url ? {
                url,
                width: width || widthFromImageUrl(url),
                density,
                priority,
                order: orderStart + index,
            } : null;
        })
        .filter(Boolean);
}

module.exports = {
    sourceTypePriority,
    srcSetCandidates,
    widthFromImageUrl,
};

'use strict';

// Pure source parsing; this folder can be copied without application dependencies.
function htmlDecode(value) {
    return String(value ?? '')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function extractAttr(tag, attrName) {
    const re = new RegExp(`\\b${attrName}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
    const match = String(tag || '').match(re);
    return match ? htmlDecode(match[2] || match[3] || match[4] || '') : '';
}

function dateMs(dateText) {
    const match = String(dateText || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return NaN;
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function parseContributionCalendar(html) {
    const cells = [];
    const dayRe = /<td\b[^>]*\bContributionCalendar-day\b[^>]*>/gi;
    let match;
    while ((match = dayRe.exec(html)) !== null) {
        const tag = match[0];
        const date = extractAttr(tag, 'data-date');
        if (!date) continue;
        const level = Math.max(0, Math.min(4, Number(extractAttr(tag, 'data-level')) || 0));
        cells.push({ date, level });
    }
    if (cells.length === 0) return null;

    const times = cells.map(cell => dateMs(cell.date)).filter(Number.isFinite);
    if (times.length === 0) return null;
    const fromMs = Math.min(...times);
    const toMs = Math.max(...times);
    const totalMatch = String(html).match(/<h2\b[^>]*id=["']js-contribution-activity-description["'][^>]*>([\s\S]*?)<\/h2>/i);
    const totalText = totalMatch ? totalMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const total = Number((totalText.match(/\d[\d,]*/) || [''])[0].replace(/,/g, ''));

    return {
        cells,
        fromDate: new Date(fromMs).toISOString().slice(0, 10),
        toDate: new Date(toMs).toISOString().slice(0, 10),
        total: Number.isFinite(total) ? total : null,
    };
}

module.exports = { parseContributionCalendar };

'use strict';
const { createHash, randomBytes } = require('node:crypto');
const { DateTime } = require('luxon');
const { urlIdentity } = require('../providers/_url_identity');
const id = () => randomBytes(16).toString('hex');
const error = code => Object.assign(new Error(code), { code });
const hash = value => createHash('sha256').update(value).digest('hex');

function link(raw, title = '') {
    let parsed;
    try { parsed = new URL(String(raw || '').trim().replace(/^<(.+)>$/, '$1')); } catch { throw error('INVALID_LINK'); }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port
        || parsed.href.length > 2048) throw error('INVALID_LINK');
    const provider = require('../providers/_loader').loadProviders().find(p => {
        const pattern = new RegExp(p.urlPattern.source, p.urlPattern.flags);
        const match = pattern.exec(parsed.href);
        return match?.index === 0 && match[0].replace(/\/$/, '') === parsed.href.replace(/\/$/, '');
    });
    if (!provider) throw error('UNSUPPORTED_LINK');
    return { url: parsed.href, providerId: provider.id, title: String(title || parsed.href).slice(0, 512),
        contentKey: hash(urlIdentity(provider.id, parsed.href)) };
}

function tags(value) {
    const list = [...new Set((Array.isArray(value) ? value : String(value || '').split(/[,、\n]/))
        .map(v => String(v).normalize('NFC').trim()).filter(Boolean))];
    if (list.length > 10 || list.some(v => v.length > 40)) throw error('INVALID_TAGS');
    return list;
}

function dueAt(input, zone = 'Asia/Tokyo', now = Date.now()) {
    const value = String(input || '').trim();
    const base = DateTime.fromMillis(now, { zone });
    if (!base.isValid) throw error('INVALID_TIME_ZONE');
    const relative = /^(\d{1,6})\s*(m|h|d)$/i.exec(value);
    let date;
    if (relative) date = base.plus({ [({ m: 'minutes', h: 'hours', d: 'days' })[relative[2].toLowerCase()]]: Number(relative[1]) });
    else if (value === 'today21') date = base.set({ hour: 21, minute: 0, second: 0, millisecond: 0 });
    else if (/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d$/.test(value)) {
        const normalized = value.replace('T', ' ');
        date = DateTime.fromFormat(normalized, 'yyyy-MM-dd HH:mm', { zone });
        if (!date.isValid || date.toFormat('yyyy-MM-dd HH:mm') !== normalized || date.getPossibleOffsets().length !== 1) throw error('INVALID_TIME');
    } else if (/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) date = DateTime.fromISO(value, { setZone: true });
    else throw error('INVALID_TIME');
    const result = date.toMillis();
    if (!date.isValid || result < now + 60000 || result > now + 366 * 86400000) throw error('TIME_OUT_OF_RANGE');
    return result;
}

function boothItem(raw) {
    let url;
    try { url = new URL(raw); } catch { throw error('INVALID_BOOTH_LINK'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port
        || !/^(?:[a-z0-9][a-z0-9-]*\.)?booth\.pm$/.test(url.hostname)) throw error('INVALID_BOOTH_LINK');
    const match = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?items\/(\d{1,20})\/?$/.exec(url.pathname);
    if (!match) throw error('INVALID_BOOTH_LINK');
    return { itemId: match[1], url: `https://booth.pm/ja/items/${match[1]}` };
}

module.exports = { id, hash, error, link, tags, dueAt, boothItem };

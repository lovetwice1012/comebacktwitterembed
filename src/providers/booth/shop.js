'use strict';

const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { resolveDensityMaxLength } = require('../_output_controls');
// Read only official, identity-checked shop information. The public search
// fallback is useful when a shop's own page returns a Cloudflare 403.
function attribute(tag, name, stripHtml) {
    for (const match of tag.matchAll(/([^\s=<>/"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        if (match[1].toLowerCase() === name) return stripHtml(match[2] ?? match[3]);
    }
    return '';
}

function isShopRoot(raw, shop) {
    try {
        const value = new URL(raw);
        return value.protocol === 'https:' && !value.username && !value.password && !value.port
            && value.hostname === `${shop}.booth.pm` && value.pathname === '/';
    } catch { return false; }
}

function parseShop(html, shop, stripHtml, search = false) {
    const source = String(html).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    if (search) {
        for (const match of source.matchAll(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi)) {
            const tag = match[0].match(/^<a\b[^>]*>/i)?.[0] || '';
            if (!attribute(tag, 'class', stripHtml).split(/\s+/).includes('item-card__shop-name-anchor')
                || !isShopRoot(attribute(tag, 'href', stripHtml), shop)) continue;
            const name = match[0].match(/<[^>]+class=["'][^"']*\bitem-card__shop-name\b[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1];
            if (name && stripHtml(name).trim()) return { name: stripHtml(name).trim(), description: '' };
        }
        return null;
    }
    const meta = {};
    for (const tag of source.match(/<meta\b[^>]*>/gi) || []) {
        const property = attribute(tag, 'property', stripHtml).toLowerCase();
        if (property.startsWith('og:')) meta[property] = attribute(tag, 'content', stripHtml);
    }
    if (!isShopRoot(meta['og:url'], shop) || !meta['og:title']?.trim()) return null;
    return { name: meta['og:title'].trim(), description: meta['og:description']?.trim() || '' };
}

async function fetchShop(fetch, shop, stripHtml) {
    const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; comebacktwitterembed/1.0; +https://github.com/lovetwice1012/comebacktwitterembed)' };
    const response = await fetch(`https://${shop}.booth.pm/`, { headers, redirect: 'manual', size: 2 * 1024 * 1024 });
    if (response.ok) {
        if (response.url && !isShopRoot(response.url, shop)) throw Object.assign(new Error('BOOTH shop redirected'), { code: 'BOOTH_INVALID_RESPONSE' });
        const info = parseShop(await response.text(), shop, stripHtml);
        if (info) return info;
        throw Object.assign(new Error('BOOTH shop returned invalid data'), { code: 'BOOTH_INVALID_RESPONSE' });
    }
    if (response.status !== 403) throw Object.assign(new Error('BOOTH shop request failed'), { code: 'BOOTH_UPSTREAM_HTTP', status: response.status });
    const search = await fetch(`https://booth.pm/ja/search/${encodeURIComponent(shop)}`, { headers, redirect: 'manual', size: 2 * 1024 * 1024 });
    if (!search.ok) throw Object.assign(new Error('BOOTH search failed'), { code: 'BOOTH_UPSTREAM_HTTP', status: search.status });
    if (search.url && new URL(search.url).hostname !== 'booth.pm') throw Object.assign(new Error('BOOTH search redirected'), { code: 'BOOTH_INVALID_RESPONSE' });
    const info = parseShop(await search.text(), shop, stripHtml, true);
    if (!info) throw Object.assign(new Error('BOOTH shop not found in public search'), { code: 'BOOTH_SHOP_UNAVAILABLE' });
    return info;
}

async function extractShop({ fetch, message, url, settings, parsed, recordProviderError, buildFailureResponse, stripHtml }) {
    let info;
    try { info = await fetchShop(fetch, parsed.shop, stripHtml); }
    catch (err) {
        recordProviderError('booth', err, message, url, { endpointKey: 'booth/shop' });
        return buildFailureResponse('booth', url, settings, err);
    }
    const japanese = String(settings.defaultLanguage || 'en').toLowerCase().startsWith('ja');
    const requester = settings.anonymous_expand === true ? (japanese ? '匿名ユーザー' : 'Anonymous requester')
        : `${message.author?.username ?? message.user?.username}(id:${message.author?.id ?? message.user?.id})`;
    const embed = { title: info.name.slice(0, 256), url: `https://${parsed.shop}.booth.pm/`, color: 0xfd494a,
        footer: { text: `${japanese ? '展開者: ' : 'Requested by '}${requester} · booth.pm` } };
    const descriptionLimit = resolveDensityMaxLength(settings, 'booth_description_max_length', 350, { compact: 140, detail: 700, hardMax: 700 });
    if (info.description && descriptionLimit > 0) embed.description = info.description.slice(0, descriptionLimit);
    const components = [{ type: ComponentType.ActionRow, components: [
        new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(japanese ? '翻訳' : 'Translate').setCustomId('translate'),
        new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel(japanese ? '削除' : 'Delete').setCustomId('delete:booth'),
    ] }];
    const step = { embeds: [embed], components, allowedMentions: { repliedUser: false }, send: settings.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel' };
    if (settings.deletemessageifonlypostedtweetlink === true && message.content.trim() === url) step.deleteSource = true;
    else if (settings.legacy_mode === true) step.suppressSourceEmbeds = true;
    return [step];
}

module.exports = { extractShop, _internal: { parseShop, isShopRoot } };

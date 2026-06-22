'use strict';

// ============================================================================
// booth.pm extractor
//
// booth.pm の商品 URL を Discord に貼られたとき、booth.pm 公式が公開している
// `<URL>.json` エンドポイントを叩いてタイトル/作者/価格/画像/タグ等を取得し、
// Discord 上に整った Embed として展開する。
//
// 参考: https://github.com/thisoverride/BoothPM-SDK
//   この SDK と同じデータソース (booth.pm の `/items/:id.json`) を直接使う。
//
// レスポンス (要点):
//   id:           number
//   name:         string
//   url:          string
//   description:  string (HTML を含むことがある)
//   price:        string  '1,000 JPY' のような表示文字列
//   category:     { id, name }
//   shop:         { name, subdomain, thumbnail_url, url }
//   images:       [{ original, resized }]
//   tags:         [{ name, url }]
//   is_adult:     boolean
//   wish_lists_count: number
// ============================================================================

const fetch = require('node-fetch');
const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { settings } = require('../../settings');
const { extractSalePeriod } = require('./_sale');

const EMBED_COLOR = 0xfd494a;       // booth のテーマカラー
const ADULT_EMBED_COLOR = 0x4d4d4d; // R-18 はやや抑え気味の色
const MAX_EMBEDS_PER_MESSAGE = 10;
const IMAGES_PER_GROUP = 4;
const DESCRIPTION_MAX_LENGTH = 350;
const TAGS_MAX_LENGTH        = 256;
const VARIATIONS_MAX_COUNT   = 5;
const VARIATION_NAME_MAX     = 60;
const VARIATIONS_FIELD_MAX_LENGTH = 1024; // Discord embed field value limit

// ---- inline 翻訳 (twitter / pixiv provider と同じ手法) -----------------------

const STR = {
    showMediaAsAttachmentsButton: { ja: 'メディアを添付ファイルとして表示する', en: 'Show media as attachments' },
    translateButton:              { ja: '翻訳',                                 en: 'Translate' },
    deleteButton:                 { ja: '削除',                                 en: 'Delete' },
    tagsField:                    { ja: 'タグ',                                 en: 'Tags' },
    priceField:                   { ja: '価格',                                 en: 'Price' },
    categoryField:                { ja: 'カテゴリ',                             en: 'Category' },
    pagesField:                   { ja: '画像',                                 en: 'Images' },
    requesterPrefix:              { ja: '展開者: ',                             en: 'Requested by ' },
    anonRequester:                { ja: '匿名ユーザー',                         en: 'Anonymous requester' },
    adultLabel:                   { ja: ' [R-18]',                              en: ' [R-18]' },
    fallbackTitle:                { ja: 'booth 商品 #',                         en: 'booth #' },
    free:                         { ja: '無料',                                 en: 'Free' },
    variationsField:              { ja: 'バリエーション',                         en: 'Variations' },
    variationsMore:               { ja: 'ほか %d 件',                            en: '+%d more' },
    soldOut:                      { ja: '売り切れ',                             en: 'Sold out' },
    unnamedVariation:             { ja: '(名称なし)',                           en: '(unnamed)' },
    salePeriodField:              { ja: '販売期間',                             en: 'Sale period' },
    saleStartsAt:                 { ja: '販売開始: ',                           en: 'Starts: ' },
    saleEndsAt:                   { ja: '販売終了: ',                           en: 'Ends: ' },
    saleStartedAt:                { ja: '販売開始 (開催中): ',                  en: 'Started (live): ' },
    saleEndedAt:                  { ja: '販売終了済み: ',                        en: 'Ended: ' },
    notifySaleButton:             { ja: '販売開始時にDMで通知',                 en: 'Notify me on sale via DM' },
};

function tr(spec, lang) {
    if (typeof spec === 'string') return spec;
    return spec[lang] ?? spec.en ?? '';
}

// ---- URL parser -----------------------------------------------------------

// パターン:
//   https://booth.pm/(ja|en|ko|zh-cn|zh-tw)/items/<id>
//   https://booth.pm/items/<id>
//   https://<shop>.booth.pm/items/<id>
// `accounts.booth.pm` 等の特殊サブドメインは除外。
const BOOTH_URL_PATTERN =
    /https?:\/\/(?:(?:[a-z0-9][a-z0-9-]*\.)?booth\.pm)\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?items\/\d+/g;

const EXCLUDED_SUBDOMAINS = new Set(['accounts', 'asset']);

/**
 * URL から item_id / language / shop subdomain を抽出。
 * @returns {{id: string, language: string, shop: string|null} | null}
 */
function parseBoothUrl(rawUrl, defaultLanguage) {
    let u;
    try { u = new URL(rawUrl); } catch { return null; }
    if (!/booth\.pm$/.test(u.hostname)) return null;

    // shop subdomain を抽出 (booth.pm 直接 / www / accounts は shop なし扱い)
    const hostParts = u.hostname.split('.');
    let shop = null;
    if (hostParts.length >= 3) {
        const sub = hostParts.slice(0, hostParts.length - 2).join('.');
        if (sub === 'www') shop = null;
        else if (EXCLUDED_SUBDOMAINS.has(sub)) return null;
        else shop = sub;
    }

    const m = u.pathname.match(/^\/(?:([a-z]{2}(?:-[a-z]{2})?)\/)?items\/(\d+)/);
    if (!m) return null;
    return {
        id: m[2],
        language: m[1] || defaultLanguage,
        shop,
    };
}

function buildItemJsonUrl(parsed) {
    const lang = parsed.language || 'ja';
    if (parsed.shop) {
        return `https://${parsed.shop}.booth.pm/items/${parsed.id}.json`;
    }
    return `https://booth.pm/${lang}/items/${parsed.id}.json`;
}

function buildCanonicalUrl(parsed, info) {
    if (info && typeof info.url === 'string' && info.url) return info.url;
    const lang = parsed.language || 'ja';
    if (parsed.shop) return `https://${parsed.shop}.booth.pm/items/${parsed.id}`;
    return `https://booth.pm/${lang}/items/${parsed.id}`;
}

async function fetchBoothInfo(parsed) {
    const api = buildItemJsonUrl(parsed);
    const res = await fetch(api, {
        headers: {
            // booth は Accept: application/json でも JSON を返すが念のため UA を付与。
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (compatible; comebacktwitterembed/1.0; +https://github.com/lovetwice1012/comebacktwitterembed)',
        },
    });
    if (!res.ok) throw new Error(`booth api ${res.status} for ${api}`);
    return /** @type {any} */ (await res.json());
}

// ---- 文字列処理 -----------------------------------------------------------

function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function truncate(s, max) {
    if (!s) return '';
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}

function joinTags(tags, lang) {
    if (!Array.isArray(tags) || tags.length === 0) return '';
    const names = tags
        .map(t => (typeof t === 'string' ? t : (t && t.name)))
        .filter(Boolean)
        .map(n => `#${n}`);
    if (names.length === 0) return '';
    void lang; // 表示順は一定
    return truncate(names.join(' '), TAGS_MAX_LENGTH);
}

function pickLanguage(guildLang) {
    // booth は ja/en/ko/zh-cn/zh-tw を受ける。簡略化のため ja/en にだけ寄せる。
    if (guildLang === 'ja') return 'ja';
    return 'en';
}

function adultLabel(isAdult, lang) {
    return isAdult ? tr(STR.adultLabel, lang) : '';
}

function formatPrice(rawPrice, lang) {
    if (rawPrice === null || rawPrice === undefined || rawPrice === '') return '';
    const s = String(rawPrice).trim();
    if (s === '0' || s === '0 JPY' || s === '0円') return tr(STR.free, lang);
    return s;
}

function pickImageUrls(info) {
    if (!Array.isArray(info?.images)) return [];
    const out = [];
    for (const img of info.images) {
        if (!img) continue;
        const url = img.original || img.resized || img.url;
        if (typeof url === 'string' && url) out.push(url);
    }
    return out;
}

// variation.price は数値 (JPY) または文字列。表示用にフォーマットする。
function formatVariationPrice(price, lang) {
    if (price === null || price === undefined || price === '') return '';
    if (typeof price === 'number') {
        if (price === 0) return tr(STR.free, lang);
        return `¥${price.toLocaleString('en-US')}`;
    }
    const s = String(price).trim();
    if (s === '0' || s === '0 JPY' || s === '0円' || s === '¥0') return tr(STR.free, lang);
    return s;
}

function buildVariationsLine(info, lang) {
    if (!Array.isArray(info?.variations) || info.variations.length === 0) return '';
    const total = info.variations.length;
    const shown = info.variations.slice(0, VARIATIONS_MAX_COUNT);
    const lines = shown.map(v => {
        const rawName = (typeof v?.name === 'string' && v.name.trim()) ? v.name.trim() : tr(STR.unnamedVariation, lang);
        const name = truncate(rawName, VARIATION_NAME_MAX);
        const priceText = formatVariationPrice(v?.price, lang);
        const status = v?.status;
        const isSoldOut = status === 'sold_out' || v?.is_sold_out === true;
        const suffix = isSoldOut ? ` (${tr(STR.soldOut, lang)})` : '';
        return priceText
            ? `• ${name} — ${priceText}${suffix}`
            : `• ${name}${suffix}`;
    });
    if (total > VARIATIONS_MAX_COUNT) {
        lines.push(tr(STR.variationsMore, lang).replace('%d', String(total - VARIATIONS_MAX_COUNT)));
    }
    return truncate(lines.join('\n'), VARIATIONS_FIELD_MAX_LENGTH);
}

/**
 * 販売期間オブジェクトを Discord embed フィールド用テキストに整形する。
 * Discord の `<t:UNIX:F>` (絶対時刻) と `<t:UNIX:R>` (相対) を併記。
 * @param {{startAt: Date|null, endAt: Date|null} | null} period
 * @param {'ja'|'en'} lang
 */
function formatSalePeriod(period, lang) {
    if (!period) return '';
    const { startAt, endAt } = period;
    if (!startAt && !endAt) return '';
    const now = Date.now();
    const lines = [];
    if (startAt) {
        const unix = Math.floor(startAt.getTime() / 1000);
        const labelKey = startAt.getTime() > now ? STR.saleStartsAt : STR.saleStartedAt;
        lines.push(`${tr(labelKey, lang)}<t:${unix}:F> (<t:${unix}:R>)`);
    }
    if (endAt) {
        const unix = Math.floor(endAt.getTime() / 1000);
        const labelKey = endAt.getTime() > now ? STR.saleEndsAt : STR.saleEndedAt;
        lines.push(`${tr(labelKey, lang)}<t:${unix}:F> (<t:${unix}:R>)`);
    }
    return lines.join('\n');
}

// ---- extract --------------------------------------------------------------

/** @type {import('../_types').Extractor} */
async function extract(message, url, s) {
    s = s || {};
    const guildId = message.guild.id;
    const guildLang = s.defaultLanguage ?? settings.defaultLanguage[guildId] ?? 'en';
    const apiLang = pickLanguage(guildLang);

    const parsed = parseBoothUrl(url, apiLang);
    if (!parsed) return null;

    let info;
    try {
        info = await fetchBoothInfo(parsed);
    } catch (err) {
        console.log(err);
        return null;
    }

    const images = pickImageUrls(info);

    const lang = guildLang === 'ja' ? 'ja' : 'en';

    const isAnon = s.anonymous_expand === true;
    const requesterName = isAnon
        ? tr(STR.anonRequester, lang)
        : `${message.author?.username ?? message.user?.username}(id:${message.author?.id ?? message.user?.id})`;

    const isAdult = info.is_adult === true;
    const canonicalUrl = buildCanonicalUrl(parsed, info);
    const title =
        (info.name || `${tr(STR.fallbackTitle, lang)}${parsed.id}`)
        + adultLabel(isAdult, lang);

    const description = truncate(stripHtml(info.description || ''), DESCRIPTION_MAX_LENGTH);
    const tagsLine = joinTags(info.tags, lang);
    const priceText = formatPrice(info.price, lang);
    const categoryName = info.category?.name || '';
    const variationsLine = buildVariationsLine(info, lang);
    const salePeriod = extractSalePeriod(info);
    const salePeriodLine = formatSalePeriod(salePeriod, lang);
    const color = isAdult ? ADULT_EMBED_COLOR : EMBED_COLOR;

    // 画像が無くてもテキスト Embed は出す
    const groups = images.length > 0
        ? images.slice(0, MAX_EMBEDS_PER_MESSAGE)
        : [null];

    const embeds = groups.map((imgUrl, idx) => {
        const groupIdx = Math.floor(idx / IMAGES_PER_GROUP);
        const groupUrl = groupIdx === 0 ? canonicalUrl : `${canonicalUrl}#g${groupIdx}`;
        /** @type {any} */
        const embed = {
            url: groupUrl,
            color,
        };
        if (imgUrl) embed.image = { url: imgUrl };
        if (idx === 0) {
            embed.title = title;
            const shopName = info.shop?.name || parsed.shop || 'booth';
            const shopUrl = info.shop?.url
                || (parsed.shop ? `https://${parsed.shop}.booth.pm/` : 'https://booth.pm/');
            embed.author = {
                name: shopName,
                url: shopUrl,
                icon_url: info.shop?.thumbnail_url || undefined,
            };
            if (description) embed.description = description;
            const fields = [];
            if (priceText) fields.push({ name: tr(STR.priceField, lang), value: priceText, inline: true });
            if (categoryName) fields.push({ name: tr(STR.categoryField, lang), value: categoryName, inline: true });
            if (images.length > 1) {
                fields.push({
                    name: tr(STR.pagesField, lang),
                    value: `${Math.min(images.length, MAX_EMBEDS_PER_MESSAGE)} / ${images.length}`,
                    inline: true,
                });
            }
            if (variationsLine) fields.push({ name: tr(STR.variationsField, lang), value: variationsLine, inline: false });
            if (salePeriodLine) fields.push({ name: tr(STR.salePeriodField, lang), value: salePeriodLine, inline: false });
            if (tagsLine) fields.push({ name: tr(STR.tagsField, lang), value: tagsLine, inline: false });
            if (fields.length > 0) embed.fields = fields;
            embed.footer = { text: `${tr(STR.requesterPrefix, lang)}${requesterName} · booth.pm` };
        }
        return embed;
    });

    const showMediaAsAttachmentsButton = new ButtonBuilder()
        .setStyle(ButtonStyle.Primary)
        .setLabel(tr(STR.showMediaAsAttachmentsButton, lang))
        .setCustomId('showMediaAsAttachments');
    const translateButton = new ButtonBuilder()
        .setStyle(ButtonStyle.Primary)
        .setLabel(tr(STR.translateButton, lang))
        .setCustomId('translate');
    const deleteButton = new ButtonBuilder()
        .setStyle(ButtonStyle.Danger)
        .setLabel(tr(STR.deleteButton, lang))
        .setCustomId('delete:booth');

    // 販売開始時刻が未来であれば「DM で通知」ボタンを追加
    let notifyButton = null;
    if (salePeriod && salePeriod.startAt && salePeriod.startAt.getTime() > Date.now()) {
        const unix = Math.floor(salePeriod.startAt.getTime() / 1000);
        notifyButton = new ButtonBuilder()
            .setStyle(ButtonStyle.Success)
            .setLabel(tr(STR.notifySaleButton, lang))
            .setCustomId(`notifyBoothSale:${parsed.id}:${lang}:${unix}`);
    }

    const components = [];
    if (images.length > 0) {
        components.push({ type: ComponentType.ActionRow, components: [showMediaAsAttachmentsButton] });
    }
    components.push({ type: ComponentType.ActionRow, components: [translateButton, deleteButton] });
    if (notifyButton) {
        components.push({ type: ComponentType.ActionRow, components: [notifyButton] });
    }

    /** @type {import('../_types').SendStep} */
    const step = {
        embeds,
        components,
        allowedMentions: { repliedUser: false },
        send: s.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel',
    };

    if (s.deletemessageifonlypostedtweetlink === true && message.content.trim() === url) {
        step.deleteSource = true;
    } else if (s.legacy_mode === true) {
        // 既定の Discord OGP プレビュー (booth は要ログインリンクなどあり弱い場合がある) を抑制
        step.suppressSourceEmbeds = true;
    }

    return [step];
}

// ---- 公開エクスポート ----------------------------------------------------

/** @type {import('../_types').Provider} */
const boothProvider = {
    id: 'booth',
    // 既定は無効。ギルド管理者が `/provider` で明示的に有効化したときだけ動く。
    enabledByDefault: false,
    urlPattern: BOOTH_URL_PATTERN,
    extract,
};
module.exports = boothProvider;

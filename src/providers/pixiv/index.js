'use strict';

// ============================================================================
// pixiv extractor (phixiv ベース)
//
// pixiv の URL を Discord に貼られたとき、phixiv の `/api/info` を叩いて
// タイトル/作者/タグ/画像 URL を取得し、Discord 上に整った Embed として展開する。
//
// 使用 API:
//   GET https://www.phixiv.net/api/info?id=:id&language=:language[&index=:index]
//
// レスポンス (要点):
//   image_proxy_urls: string[]   各ページの画像 URL (phixiv プロキシ済み)
//   title:            string
//   description:      string     (HTML を含む)
//   tags:             string[]   ("#tag" 形式)
//   url:              string     pixiv 上の正規 URL
//   author_name, author_id
//   ai_generated:     boolean
//   x_restrict:       number     0=safe / 1=R-18 / 2=R-18G
//   is_ugoira:        boolean
//   illust_id:        string
// ============================================================================

const fetch = require('node-fetch');
const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { recordProviderError } = require('../../errorTracking');
const {
    applyMediaDisplayToStep,
    buildFailureResponse,
    mediaButtonAllowed,
    mediaLinksContent,
    resolveDensityMaxLength,
    resolveDisplayDensity,
    shouldAttachVideoMedia,
    shouldShowOutputItem,
} = require('../_output_controls');
const {
    normalizeDiscordLocale,
    toApiLocaleFamily,
} = require('../../discordLocales');
const { createProviderAnalytics, facet, finiteNumber, tagFacets } = require('../../analytics/providerMetrics');
const {
    buildSensitiveSuppressedStep,
    resolveEffectiveSensitiveDisplayMode,
    resolveSensitiveDisplayMode,
    spoilerFiles,
} = require('../_sensitive_controls');

// ---- inline 翻訳 (twitter provider と同じ手法) -----------------------------
//
// pixiv extractor 内で表示する文字列のロケール定義。
// guild の defaultLanguage に従って ja/en を切り替える。

const STR = {
    showMediaAsAttachmentsButton: { ja: 'メディアを添付ファイルとして表示する', en: 'Show media as attachments' },
    translateButton:              { ja: '翻訳',                                 en: 'Translate' },
    deleteButton:                 { ja: '削除',                                 en: 'Delete' },
    tagsField:                    { ja: 'タグ',                                 en: 'Tags' },
    pagesField:                   { ja: 'ページ',                               en: 'Pages' },
    requesterPrefix:              { ja: '展開者: ',                             en: 'Requested by ' },
    anonRequester:                { ja: '匿名ユーザー',                         en: 'Anonymous requester' },
    aiPrefix:                     { ja: '[AI生成] ',                            en: '[AI] ' },
    fallbackTitle:                { ja: 'pixiv 作品 #',                         en: 'pixiv #' },
    typeField:                    { ja: 'Type',                                  en: 'Type' },
    ugoira:                       { ja: 'Ugoira',                                en: 'Ugoira' },
};

function tr(spec, lang) {
    if (typeof spec === 'string') return spec;
    return spec[lang] ?? spec.en ?? '';
}

const PHIXIV_HOST = 'www.phixiv.net';
const PIXIV_HOST = 'www.pixiv.net';
const PIXIV_AJAX_BASE = `https://${PIXIV_HOST}/ajax/illust`;
const PIXIV_REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (compatible; ComebackTwitterEmbed/1.0)',
    Referer: `https://${PIXIV_HOST}/`,
};
const EMBED_COLOR = 0x0096fa;  // pixiv のテーマカラー
const IMAGES_PER_STEP_PC = 4;
const IMAGES_PER_STEP_FULL = 10;
const MAX_EMBEDS_PER_MESSAGE = 10; // Discord limit
const IMAGES_PER_GROUP = 4;        // Discord が同一 url の embed をギャラリー表示する上限
const DESCRIPTION_MAX_LENGTH = 350;
const DESCRIPTION_LIMIT_MAX = 1200;
const TAGS_MAX_LENGTH        = 256;
const DIRECT_UGOIRA_MEDIA_RE = /^https?:\/\/\S+\.(?:mp4|gif|webm)(?:[?#].*)?$/i;
const ADULT_EMBED_COLOR = 0x4d4d4d;
const PIXIV_GENERAL_SENSITIVE_LEVEL = 4;

// ---- URL parser -----------------------------------------------------------

// pixiv.net / phixiv.net / ppxiv.net / c.phixiv / c.ppxiv 全部受け付ける。
// 末尾の `>` `|` 等はマッチさせない (cleanPattern で <...> や ||...|| を剥がす想定)。
const PIXIV_URL_PATTERN =
    /https?:\/\/(?:www\.|c\.)?(?:pixiv|phixiv|ppxiv)\.net\/(?:[a-z]{2}\/)?(?:artworks\/\d+(?:\/\d+(?:-\d+)?)?(?:\?[^\s<>|#]*)?(?:#(?:\d+|big_\d+))?|i\/\d+|member_illust\.php\?[^\s<>|]*)/g;

/**
 * URL から illust_id / language / image_index を抽出。
 * @returns {{id: string, language: string, index: number} | null}
 *   index は phixiv API の意味 (1-origin、未指定なら 0)。
 */
function parsePixivUrl(rawUrl, defaultLanguage) {
    let u;
    try { u = new URL(rawUrl); } catch { return null; }

    // /:lang/artworks/:id[/:index]
    // /artworks/:id[/:index]
    const artworks = u.pathname.match(/^\/(?:([a-z]{2})\/)?artworks\/(\d+)(?:\/(\d+))?/);
    if (artworks) {
        return {
            id: artworks[2],
            language: artworks[1] || defaultLanguage,
            index: artworks[3] ? Number(artworks[3]) : parsePixivHashIndex(u.hash),
        };
    }

    // /i/:id
    const iShort = u.pathname.match(/^\/i\/(\d+)/);
    if (iShort) {
        return { id: iShort[1], language: defaultLanguage, index: 0 };
    }

    // /member_illust.php?illust_id=:id
    if (u.pathname.endsWith('/member_illust.php') || u.pathname === '/member_illust.php') {
        const id = u.searchParams.get('illust_id');
        if (id) return { id, language: defaultLanguage, index: 0 };
    }

    return null;
}

function parsePixivHashIndex(hash) {
    const value = String(hash || '').replace(/^#/, '');
    if (/^\d+$/.test(value)) return Number(value);
    const big = value.match(/^big_(\d+)$/);
    if (big) return Number(big[1]) + 1;
    return 0;
}

async function fetchPixivInfo(id, language, index) {
    const params = new URLSearchParams({ lang: language });
    const infoApi = `${PIXIV_AJAX_BASE}/${id}?${params.toString()}`;
    const pagesApi = `${PIXIV_AJAX_BASE}/${id}/pages?${params.toString()}`;

    const infoJson = await fetchJson(infoApi);
    const body = unwrapPixivAjax(infoJson, infoApi);
    const pages = await fetchPagesJson(pagesApi);
    const imageProxyUrls = collectPixivImageUrls(pages, body);
    const isUgoira = Number(body.illustType) === 2;
    const ugoiraMeta = isUgoira ? await fetchUgoiraMeta(id, language) : null;

    return {
        title: body.title || body.illustTitle,
        description: body.description || body.illustComment,
        tags: normalizePixivTags(body.tags?.tags),
        url: `https://${PIXIV_HOST}/artworks/${body.illustId || body.id || id}`,
        author_name: body.userName,
        author_id: body.userId,
        profile_image_url: proxyPixivImageUrl(body.userImage || body.profileImageUrl),
        ai_generated: Number(body.aiType) === 2,
        x_restrict: Number(body.xRestrict ?? body.x_restrict) || 0,
        sensitive_level: Number(body.sl ?? body.sensitiveLevel ?? body.sensitive_level) || 0,
        is_ugoira: isUgoira,
        illust_id: body.illustId || body.id || id,
        created_at: body.createDate || body.uploadDate || body.create_date,
        view_count: body.viewCount,
        bookmark_count: body.bookmarkCount,
        like_count: body.likeCount,
        comment_count: body.commentCount,
        image_proxy_urls: imageProxyUrls,
        ugoira_media_urls: collectDirectUgoiraMediaUrls(body, ugoiraMeta),
    };
}

async function fetchJson(url) {
    const res = await fetch(url, { headers: PIXIV_REQUEST_HEADERS });
    if (!res.ok) throw new Error(`pixiv ajax ${res.status} for ${url}`);
    return /** @type {any} */ (await res.json());
}

async function fetchPagesJson(url) {
    const res = await fetch(url, { headers: PIXIV_REQUEST_HEADERS });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`pixiv ajax ${res.status} for ${url}`);

    const json = await res.json();
    if (json?.error === true && Array.isArray(json.body) && json.body.length === 0) return [];
    return unwrapPixivAjax(json, url);
}

async function fetchUgoiraMeta(id, language) {
    const params = new URLSearchParams({ lang: language });
    const url = `${PIXIV_AJAX_BASE}/${id}/ugoira_meta?${params.toString()}`;
    try {
        const json = await fetchJson(url);
        return unwrapPixivAjax(json, url);
    } catch {
        return null;
    }
}

function unwrapPixivAjax(json, url) {
    if (!json || json.error === true) {
        const message = json?.message ? `: ${json.message}` : '';
        throw new Error(`pixiv ajax error for ${url}${message}`);
    }
    return json.body;
}

function collectPixivImageUrls(pages, info) {
    const out = [];
    const pageList = Array.isArray(pages) ? pages : [];
    for (const page of pageList) {
        const raw = page?.urls?.regular || page?.urls?.original;
        const proxied = proxyPixivImageUrl(raw);
        if (proxied) out.push(proxied);
    }

    if (out.length === 0) {
        const raw = info?.urls?.regular || info?.urls?.original;
        const proxied = proxyPixivImageUrl(raw);
        if (proxied) out.push(proxied);
    }

    return out;
}

function proxyPixivImageUrl(rawUrl) {
    if (!rawUrl) return '';
    let u;
    try { u = new URL(rawUrl); } catch { return rawUrl; }
    if (u.hostname !== 'i.pximg.net') return rawUrl;
    return `https://${PHIXIV_HOST}/i${u.pathname}`;
}

function collectDirectUgoiraMediaUrls(...values) {
    const out = [];
    const seen = new Set();
    const visit = (value, depth = 0) => {
        if (depth > 5 || value === null || value === undefined) return;
        if (typeof value === 'string') {
            if (!DIRECT_UGOIRA_MEDIA_RE.test(value) || seen.has(value)) return;
            seen.add(value);
            out.push(proxyPixivImageUrl(value));
            return;
        }
        if (Array.isArray(value)) {
            value.forEach(item => visit(item, depth + 1));
            return;
        }
        if (typeof value === 'object') {
            Object.values(value).forEach(item => visit(item, depth + 1));
        }
    };
    values.forEach(value => visit(value));
    return out;
}

function normalizePixivTags(tags) {
    if (!Array.isArray(tags)) return [];
    return tags
        .map(tag => {
            if (typeof tag === 'string') return tag.startsWith('#') ? tag : `#${tag}`;
            const name = tag?.tag;
            if (!name) return '';
            return String(name).startsWith('#') ? String(name) : `#${name}`;
        })
        .filter(Boolean);
}

// ---- 文字列処理 -----------------------------------------------------------

function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<br\s*\/?>/gi, '\n')
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
    if (max <= 0) return '';
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}

function resolveTagLimit(settings) {
    if (!shouldShowOutputItem(settings, 'tags', { hideInCompact: false })) return 0;
    const raw = settings?.pixiv_tag_limit;
    if (raw === 'all') return Infinity;
    const n = Number(raw);
    if ([0, 5, 10, 20].includes(n)) return n;
    const density = resolveDisplayDensity(settings);
    if (density === 'compact') return 5;
    if (density === 'detail') return Infinity;
    return 10;
}

function joinTags(tags, settings = {}) {
    if (!Array.isArray(tags) || tags.length === 0) return '';
    const limit = resolveTagLimit(settings);
    if (limit <= 0) return '';
    const selected = Number.isFinite(limit) ? tags.slice(0, limit) : tags;
    return truncate(selected.join(' '), TAGS_MAX_LENGTH);
}

function pickLanguage(guildLang) {
    const normalized = normalizeDiscordLocale(guildLang, 'en-US');
    if (normalized === 'ja') return 'ja';
    if (normalized === 'zh-CN' || normalized === 'zh-TW') return 'zh';
    return 'en';
}

function maturityLabel(sensitivityKind) {
    if (sensitivityKind === 'r18') return ' [R-18]';
    if (sensitivityKind === 'r18g') return ' [R-18G]';
    return '';
}

function normalizePixivMaturityTagName(tag) {
    const value = typeof tag === 'string' ? tag : tag?.tag;
    return String(value || '')
        .replace(/^#+/, '')
        .replace(/[−ー―‐]/g, '-')
        .trim()
        .toUpperCase();
}

function pixivTagSensitivityKind(tags) {
    const values = Array.isArray(tags) ? tags.map(normalizePixivMaturityTagName) : [];
    if (values.some(value => value === 'R-18G' || value === 'R18G')) return 'r18g';
    if (values.some(value => value === 'R-18' || value === 'R18')) return 'r18';
    return null;
}

function pixivSensitivityKind(infoOrXRestrict, sensitiveLevel = 0, tags = []) {
    const value = typeof infoOrXRestrict === 'object'
        ? Number(infoOrXRestrict?.x_restrict ?? infoOrXRestrict?.xRestrict) || 0
        : Number(infoOrXRestrict) || 0;
    const level = typeof infoOrXRestrict === 'object'
        ? Number(infoOrXRestrict?.sensitive_level ?? infoOrXRestrict?.sl) || 0
        : Number(sensitiveLevel) || 0;
    const tagKind = typeof infoOrXRestrict === 'object'
        ? pixivTagSensitivityKind(infoOrXRestrict?.tags)
        : pixivTagSensitivityKind(tags);
    if (value === 2 || tagKind === 'r18g') return 'r18g';
    if (value > 0 || tagKind === 'r18') return 'r18';
    if (level >= PIXIV_GENERAL_SENSITIVE_LEVEL) return 'sensitive';
    return 'safe';
}

function resolvePixivSensitiveDisplayMode(settings, sensitivityKind) {
    if (sensitivityKind === 'r18') return resolveSensitiveDisplayMode(settings, 'pixiv_r18_display_mode', 'normal');
    if (sensitivityKind === 'r18g') return resolveSensitiveDisplayMode(settings, 'pixiv_r18g_display_mode', 'normal');
    if (sensitivityKind === 'sensitive') return resolveSensitiveDisplayMode(settings, 'pixiv_sensitive_display_mode', 'normal');
    return 'normal';
}

function pixivSensitiveControlKeys(sensitivityKind) {
    if (sensitivityKind === 'sensitive') {
        return {
            nonNsfwRestrictionEnabledKey: 'pixiv_sensitive_non_nsfw_channel_sensitive_restriction_enabled',
            allowedTargetsKey: 'pixiv_sensitive_sensitive_content_allowed_targets',
            excludedTargetsKey: 'pixiv_sensitive_sensitive_content_excluded_targets',
        };
    }
    if (sensitivityKind === 'r18') {
        return {
            nonNsfwRestrictionEnabledKey: 'pixiv_r18_non_nsfw_channel_sensitive_restriction_enabled',
            allowedTargetsKey: 'pixiv_r18_sensitive_content_allowed_targets',
            excludedTargetsKey: 'pixiv_r18_sensitive_content_excluded_targets',
        };
    }
    if (sensitivityKind === 'r18g') {
        return {
            nonNsfwRestrictionEnabledKey: 'pixiv_r18g_non_nsfw_channel_sensitive_restriction_enabled',
            allowedTargetsKey: 'pixiv_r18g_sensitive_content_allowed_targets',
            excludedTargetsKey: 'pixiv_r18g_sensitive_content_excluded_targets',
        };
    }
    return {};
}

function showAiLabel(settings) {
    return shouldShowOutputItem(settings, 'ai', { hideInCompact: false });
}

function showMaturityLabel(settings) {
    return shouldShowOutputItem(settings, 'maturity', { hideInCompact: false });
}

function resolveImagesPerStep(value) {
    const n = Number(value);
    if (n === IMAGES_PER_STEP_FULL) return IMAGES_PER_STEP_FULL;
    return IMAGES_PER_STEP_PC;
}

function resolveCaptionMaxLength(value, settings = {}) {
    if (value === undefined || value === null || value === '') {
        return resolveDensityMaxLength(settings, 'pixiv_caption_max_length', DESCRIPTION_MAX_LENGTH, {
            compact: 140,
            detail: DESCRIPTION_LIMIT_MAX,
            hardMax: DESCRIPTION_LIMIT_MAX,
        });
    }
    const n = Number(value);
    if (!Number.isFinite(n)) return DESCRIPTION_MAX_LENGTH;
    return Math.max(0, Math.min(DESCRIPTION_LIMIT_MAX, Math.round(n)));
}

function appendStepContent(step, content) {
    if (!content) return;
    step.content = [step.content, content].filter(Boolean).join('\n');
}

function appendUniqueFiles(step, urls) {
    if (!Array.isArray(urls) || urls.length === 0) return;
    const files = Array.isArray(step.files) ? [...step.files] : [];
    const seen = new Set(files.map(file => (typeof file === 'string' ? file : file?.attachment)).filter(Boolean));
    for (const url of urls) {
        if (!url || seen.has(url)) continue;
        seen.add(url);
        files.push(url);
    }
    if (files.length > 0) step.files = files;
}

function applyUgoiraMediaToStep(step, settings, urls) {
    const mediaUrls = Array.isArray(urls) ? urls.filter(Boolean) : [];
    if (mediaUrls.length === 0 || !shouldShowUgoiraMedia(settings)) return;
    if (shouldAttachVideoMedia(settings)) appendUniqueFiles(step, mediaUrls);
    appendStepContent(step, mediaLinksContent(settings, mediaUrls, 'Ugoira'));
}

function shouldShowUgoiraMedia(settings) {
    return shouldShowOutputItem(settings, 'ugoira_media', { hideInCompact: false });
}

function maturityFacetValue(sensitivityKind) {
    if (sensitivityKind === 'r18') return 'r18';
    if (sensitivityKind === 'r18g') return 'r18g';
    if (sensitivityKind === 'sensitive') return 'sensitive';
    return 'safe';
}

function normalizePixivAnalyticsTags(tags) {
    if (!Array.isArray(tags)) return [];
    return tags.map(tag => String(tag || '').replace(/^#/, '').trim()).filter(Boolean);
}

function buildPixivAnalytics(info, parsed, canonicalUrl, images, ugoiraMediaUrls) {
    const mediaCount = Array.isArray(images) ? images.length : 0;
    const ugoiraMediaCount = Array.isArray(ugoiraMediaUrls) ? ugoiraMediaUrls.length : 0;
    const sensitivityKind = pixivSensitivityKind(info);
    return createProviderAnalytics({
        content: {
            accountKey: info.author_id ? `users/${info.author_id}` : info.author_name,
            contentId: info.illust_id || parsed.id,
            contentType: info.is_ugoira ? 'ugoira' : 'illustration',
            contentUrl: canonicalUrl,
            title: info.title,
            descriptionPreview: stripHtml(info.description || ''),
            authorName: info.author_name,
            publishedAtMs: info.created_at ? Date.parse(info.created_at) : null,
            sensitive: sensitivityKind === 'safe' ? 0 : 1,
            mediaCount,
        },
        metrics: {
            views: finiteNumber(info.view_count),
            bookmarks: finiteNumber(info.bookmark_count),
            likes: finiteNumber(info.like_count),
            comments: finiteNumber(info.comment_count),
            page_count: mediaCount,
            ugoira_media_count: ugoiraMediaCount,
            ai_generated: info.ai_generated ? 1 : 0,
            x_restrict: Number(info.x_restrict) || 0,
            sensitive_level: Number(info.sensitive_level) || 0,
        },
        facets: [
            facet('type', info.is_ugoira ? 'ugoira' : 'illustration'),
            facet('age_restricted', maturityFacetValue(sensitivityKind)),
            facet('ai_generated', info.ai_generated ? 'yes' : 'no'),
            ...tagFacets('tag', normalizePixivAnalyticsTags(info.tags)),
        ],
    });
}

// ---- extract --------------------------------------------------------------

/** @type {import('../_types').Extractor} */
async function extract(message, url, s) {
    s = s || {};
    const guildLang = s.defaultLanguage ?? 'en';

    const parsed = parsePixivUrl(url, pickLanguage(guildLang));
    if (!parsed) return null;

    let info;
    try {
        info = await fetchPixivInfo(parsed.id, parsed.language, parsed.index);
    } catch (err) {
        recordProviderError('pixiv', err, message, url, { endpointKey: 'pixiv/ajax/illust' });
        console.log(err);
        return buildFailureResponse('pixiv', url, s, err);
    }

    const images = Array.isArray(info.image_proxy_urls) ? info.image_proxy_urls : [];
    const ugoiraMediaUrls = Array.isArray(info.ugoira_media_urls) ? info.ugoira_media_urls : [];
    const xRestrict = Number(info.x_restrict) || 0;
    const sensitiveLevel = Number(info.sensitive_level) || 0;
    const sensitivityKind = pixivSensitivityKind(xRestrict, sensitiveLevel, info.tags);
    const isSensitive = sensitivityKind !== 'safe';
    const sensitiveDisplayMode = isSensitive
        ? resolveEffectiveSensitiveDisplayMode(message, s, resolvePixivSensitiveDisplayMode(s, sensitivityKind), pixivSensitiveControlKeys(sensitivityKind))
        : 'normal';
    if (sensitiveDisplayMode === 'suppress') {
        return [buildSensitiveSuppressedStep(message, url, s)];
    }
    if (images.length === 0 && sensitiveDisplayMode !== 'metadata_only') return null;

    const lang = toApiLocaleFamily(guildLang);

    const isAnon = s.anonymous_expand === true;
    const requesterName = isAnon
        ? tr(STR.anonRequester, lang)
        : `${message.author?.username ?? message.user?.username}(id:${message.author?.id ?? message.user?.id})`;

    const canonicalUrl = info.url || `https://www.pixiv.net/artworks/${info.illust_id || parsed.id}`;
    const title =
        (info.ai_generated && showAiLabel(s) ? tr(STR.aiPrefix, lang) : '')
        + (info.title || `${tr(STR.fallbackTitle, lang)}${parsed.id}`)
        + (showMaturityLabel(s) ? maturityLabel(sensitivityKind) : '');

    const description = truncate(stripHtml(info.description || ''), resolveCaptionMaxLength(s.pixiv_caption_max_length, s));
    const tagsLine = joinTags(info.tags, s);

    const imagesPerStep = Math.min(resolveImagesPerStep(s.pixiv_images_per_step), MAX_EMBEDS_PER_MESSAGE);

    // /artworks/:id/2 のような index 指定時は常に 1 枚のみ。
    let displayImages;
    let pageStartIndex = 0;
    if (parsed.index && parsed.index > 0) {
        const i = Math.min(parsed.index, images.length) - 1;
        displayImages = [images[i]];
        pageStartIndex = i;
    } else {
        displayImages = images.slice(0, imagesPerStep);
    }

    const hideSensitiveMedia = sensitiveDisplayMode === 'metadata_only';
    const spoilerSensitiveMedia = sensitiveDisplayMode === 'spoiler_attachment';
    if (hideSensitiveMedia) displayImages = [];
    if (displayImages.length === 0 && !hideSensitiveMedia) return null;

    // Discord は 同じ url を持つ複数の embed を「1 個のカード」にマージし、
    // image を 2x2 グリッド (最大64枚) として表示する。
    // 画像を IMAGES_PER_GROUP 枚ごとに區切り、グループごとに異なる url
    // (フラグメントで区別) を付与することで、Discord 上で複数の
    // 4枚グリッドカードとして並ぶようにする。
    // 1枚目のembedにのみメタデータを付与し、2枚目以降は画像のみ。
    const embedImages = (hideSensitiveMedia || spoilerSensitiveMedia) ? [null] : displayImages;
    const embeds = embedImages.map((imgUrl, idx) => {
        const groupIdx = Math.floor(idx / IMAGES_PER_GROUP);
        const groupUrl = groupIdx === 0 ? canonicalUrl : `${canonicalUrl}#g${groupIdx}`;
        /** @type {any} */
        const embed = {
            url: groupUrl,
            color: isSensitive ? ADULT_EMBED_COLOR : EMBED_COLOR,
        };
        if (imgUrl) embed.image = { url: imgUrl };
        if (idx === 0) {
            embed.title = title;
            embed.author = {
                name: info.author_name ? `${info.author_name} (id:${info.author_id})` : 'pixiv',
                url: info.author_id ? `https://www.pixiv.net/users/${info.author_id}` : undefined,
                icon_url: info.profile_image_url || undefined,
            };
            if (description) embed.description = description;
            const fields = [];
            if (info.is_ugoira && shouldShowOutputItem(s, 'type')) fields.push({ name: tr(STR.typeField, lang), value: tr(STR.ugoira, lang), inline: true });
            if (tagsLine) fields.push({ name: tr(STR.tagsField, lang), value: tagsLine, inline: false });
            if (!hideSensitiveMedia && images.length > 1) {
                const pagesText = displayImages.length === 1
                    ? `${pageStartIndex + 1} / ${images.length}`
                    : `${pageStartIndex + 1}-${pageStartIndex + displayImages.length} / ${images.length}`;
                if (shouldShowOutputItem(s, 'pages')) fields.push({ name: tr(STR.pagesField, lang), value: pagesText, inline: true });
            }
            if (fields.length > 0) embed.fields = fields;
            embed.footer = { text: `${tr(STR.requesterPrefix, lang)}${requesterName} · pixiv` };
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
        .setCustomId('delete:pixiv');

    const components = [];
    if (displayImages.length > 0 && mediaButtonAllowed(s) && !spoilerSensitiveMedia) {
        components.push({ type: ComponentType.ActionRow, components: [showMediaAsAttachmentsButton] });
    }
    components.push({ type: ComponentType.ActionRow, components: [translateButton, deleteButton] });

    /** @type {import('../_types').SendStep} */
    const step = {
        embeds,
        components,
        allowedMentions: { repliedUser: false },
        send: s.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel',
        analytics: buildPixivAnalytics(info, parsed, canonicalUrl, images, ugoiraMediaUrls),
    };

    if (s.deletemessageifonlypostedtweetlink === true && message.content.trim() === url) {
        step.deleteSource = true;
    } else if (s.legacy_mode === true) {
        // 既定の Discord OGP プレビュー (pixiv は弱い) を抑制
        step.suppressSourceEmbeds = true;
    }

    if (spoilerSensitiveMedia) {
        const illustId = info.illust_id || parsed.id;
        const files = [
            ...spoilerFiles(displayImages, `pixiv-${illustId}`, { offset: pageStartIndex }),
            ...(shouldShowUgoiraMedia(s) ? spoilerFiles(ugoiraMediaUrls, `pixiv-${illustId}-ugoira`, { fallbackExtension: 'mp4' }) : []),
        ];
        if (files.length > 0) step.files = files;
    } else if (!hideSensitiveMedia) {
        applyMediaDisplayToStep(step, s, displayImages, 'Image');
        applyUgoiraMediaToStep(step, s, ugoiraMediaUrls);
    }
    return [step];
}

// ---- 公開エクスポート ----------------------------------------------------

/** @type {import('../_types').Provider} */
const pixivProvider = {
    id: 'pixiv',
    // 既定は無効。ギルド管理者が `/provider` で明示的に有効化したときだけ動く。
    enabledByDefault: false,
    urlPattern: PIXIV_URL_PATTERN,
    settings: [
        'anonymous_expand',
        'alwaysreplyifpostedtweetlink',
        'deletemessageifonlypostedtweetlink',
        'legacy_mode',
        'display_density',
        'media_display_mode',
        'pixiv_images_per_step',
        'pixiv_caption_max_length',
        'pixiv_tag_limit',
        'pixiv_sensitive_display_mode',
        'pixiv_r18_display_mode',
        'pixiv_r18g_display_mode',
        'pixiv_sensitive_non_nsfw_channel_sensitive_restriction_enabled',
        'pixiv_sensitive_sensitive_content_allowed_targets',
        'pixiv_sensitive_sensitive_content_excluded_targets',
        'pixiv_r18_non_nsfw_channel_sensitive_restriction_enabled',
        'pixiv_r18_sensitive_content_allowed_targets',
        'pixiv_r18_sensitive_content_excluded_targets',
        'pixiv_r18g_non_nsfw_channel_sensitive_restriction_enabled',
        'pixiv_r18g_sensitive_content_allowed_targets',
        'pixiv_r18g_sensitive_content_excluded_targets',
        {
            key: 'hidden_output_items',
            outputItems: [
                { value: 'ai', label: { en: 'AI-generated label', ja: 'AI-generated label' } },
                { value: 'maturity', label: { en: 'R-18/R-18G label', ja: 'R-18/R-18G label' } },
                { value: 'type', label: { en: 'Artwork type field', ja: 'Artwork type field' } },
                { value: 'ugoira_media', label: { en: 'Ugoira media attachment/link', ja: 'Ugoira media attachment/link' } },
                { value: 'pages', label: { en: 'Page count field', ja: 'Page count field' } },
                { value: 'tags', label: { en: 'Tags field', ja: 'タグ欄' } },
            ],
        },
    ],
    // cleanPattern は省略 → loader が urlPattern から自動生成 (<...> / ||...|| 除去)
    extract,
};
module.exports = pixivProvider;

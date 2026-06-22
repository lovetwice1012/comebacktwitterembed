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
const { settings } = require('../../settings');

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
};

function tr(spec, lang) {
    if (typeof spec === 'string') return spec;
    return spec[lang] ?? spec.en ?? '';
}

const PHIXIV_HOST = 'www.phixiv.net';
const EMBED_COLOR = 0x0096fa;  // pixiv のテーマカラー
const IMAGES_PER_STEP_PC = 4;
const IMAGES_PER_STEP_FULL = 10;
const MAX_EMBEDS_PER_MESSAGE = 10; // Discord limit
const IMAGES_PER_GROUP = 4;        // Discord が同一 url の embed をギャラリー表示する上限
const DESCRIPTION_MAX_LENGTH = 350;
const TAGS_MAX_LENGTH        = 256;

// ---- URL parser -----------------------------------------------------------

// pixiv.net / phixiv.net / ppxiv.net / c.phixiv / c.ppxiv 全部受け付ける。
// 末尾の `>` `|` 等はマッチさせない (cleanPattern で <...> や ||...|| を剥がす想定)。
const PIXIV_URL_PATTERN =
    /https?:\/\/(?:www\.|c\.)?(?:pixiv|phixiv|ppxiv)\.net\/(?:[a-z]{2}\/)?(?:artworks\/\d+(?:\/\d+(?:-\d+)?)?|i\/\d+|member_illust\.php\?[^\s<>|]*)/g;

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
            index: artworks[3] ? Number(artworks[3]) : 0,
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

async function fetchPixivInfo(id, language, index) {
    const params = new URLSearchParams({ id, language });
    if (index && index > 0) params.set('index', String(index));
    const api = `https://${PHIXIV_HOST}/api/info?${params.toString()}`;
    const res = await fetch(api);
    if (!res.ok) throw new Error(`phixiv api ${res.status} for ${api}`);
    return /** @type {any} */ (await res.json());
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
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}

function joinTags(tags) {
    if (!Array.isArray(tags) || tags.length === 0) return '';
    return truncate(tags.join(' '), TAGS_MAX_LENGTH);
}

function pickLanguage(guildLang) {
    // phixiv は pixiv ajax の lang をそのまま渡す。pixiv は 'ja'/'en'/'zh' 等を受ける。
    if (guildLang === 'ja') return 'ja';
    return 'en';
}

function ageRestrictionLabel(x_restrict) {
    if (x_restrict === 1) return ' [R-18]';
    if (x_restrict === 2) return ' [R-18G]';
    return '';
}

function resolveImagesPerStep(value) {
    const n = Number(value);
    if (n === IMAGES_PER_STEP_FULL) return IMAGES_PER_STEP_FULL;
    return IMAGES_PER_STEP_PC;
}

// ---- extract --------------------------------------------------------------

/** @type {import('../_types').Extractor} */
async function extract(message, url, s) {
    s = s || {};
    const guildId = message.guild.id;
    const guildLang = s.defaultLanguage ?? settings.defaultLanguage[guildId] ?? 'en';

    const parsed = parsePixivUrl(url, pickLanguage(guildLang));
    if (!parsed) return null;

    let info;
    try {
        info = await fetchPixivInfo(parsed.id, parsed.language, parsed.index);
    } catch (err) {
        console.log(err);
        return null;
    }

    const images = Array.isArray(info.image_proxy_urls) ? info.image_proxy_urls : [];
    if (images.length === 0) return null;

    const lang = guildLang === 'ja' ? 'ja' : 'en';

    const isAnon = s.anonymous_expand === true;
    const requesterName = isAnon
        ? tr(STR.anonRequester, lang)
        : `${message.author?.username ?? message.user?.username}(id:${message.author?.id ?? message.user?.id})`;

    const canonicalUrl = info.url || `https://www.pixiv.net/artworks/${info.illust_id || parsed.id}`;
    const title =
        (info.ai_generated ? tr(STR.aiPrefix, lang) : '')
        + (info.title || `${tr(STR.fallbackTitle, lang)}${parsed.id}`)
        + ageRestrictionLabel(Number(info.x_restrict) || 0);

    const description = truncate(stripHtml(info.description || ''), DESCRIPTION_MAX_LENGTH);
    const tagsLine = joinTags(info.tags);

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

    if (displayImages.length === 0) return null;

    // Discord は 同じ url を持つ複数の embed を「1 個のカード」にマージし、
    // image を 2x2 グリッド (最大64枚) として表示する。
    // 画像を IMAGES_PER_GROUP 枚ごとに區切り、グループごとに異なる url
    // (フラグメントで区別) を付与することで、Discord 上で複数の
    // 4枚グリッドカードとして並ぶようにする。
    // 1枚目のembedにのみメタデータを付与し、2枚目以降は画像のみ。
    const embeds = displayImages.map((imgUrl, idx) => {
        const groupIdx = Math.floor(idx / IMAGES_PER_GROUP);
        const groupUrl = groupIdx === 0 ? canonicalUrl : `${canonicalUrl}#g${groupIdx}`;
        /** @type {any} */
        const embed = {
            url: groupUrl,
            image: { url: imgUrl },
            color: EMBED_COLOR,
        };
        if (idx === 0) {
            embed.title = title;
            embed.author = {
                name: info.author_name ? `${info.author_name} (id:${info.author_id})` : 'pixiv',
                url: info.author_id ? `https://www.pixiv.net/users/${info.author_id}` : undefined,
                icon_url: info.profile_image_url || undefined,
            };
            if (description) embed.description = description;
            const fields = [];
            if (tagsLine) fields.push({ name: tr(STR.tagsField, lang), value: tagsLine, inline: false });
            if (images.length > 1) {
                const pagesText = displayImages.length === 1
                    ? `${pageStartIndex + 1} / ${images.length}`
                    : `${pageStartIndex + 1}-${pageStartIndex + displayImages.length} / ${images.length}`;
                fields.push({ name: tr(STR.pagesField, lang), value: pagesText, inline: true });
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

    /** @type {import('../_types').SendStep} */
    const step = {
        embeds,
        components: [
            { type: ComponentType.ActionRow, components: [showMediaAsAttachmentsButton] },
            { type: ComponentType.ActionRow, components: [translateButton, deleteButton] },
        ],
        allowedMentions: { repliedUser: false },
        send: s.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel',
    };

    if (s.deletemessageifonlypostedtweetlink === true && message.content.trim() === url) {
        step.deleteSource = true;
    } else if (s.legacy_mode === true) {
        // 既定の Discord OGP プレビュー (pixiv は弱い) を抑制
        step.suppressSourceEmbeds = true;
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
    // cleanPattern は省略 → loader が urlPattern から自動生成 (<...> / ||...|| 除去)
    extract,
};
module.exports = pixivProvider;

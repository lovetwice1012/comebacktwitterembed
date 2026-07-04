'use strict';

// ============================================================================
// Twitter / X.com extractor。
//
// このファイルは「Twitter URL を投げられたら、message と Twitter 設定だけを
// 受け取り、送信すべき Discord メッセージ群 (SendStep[]) を返す」自己完結 extractor。
// 共通 pipeline / behaviors / engine 等はもう存在しない。歴史的な bot 機能
// (banned-words / anonymous / saved-overlay / secondary-extract / quote-recurse 等)
// はすべてこのファイル内に封じ込められている。
//
// 新しいサイトを追加するときは src/providers/<id>.js を新規作成し、
// 同じ extract(message, url, settings, opts?) インターフェースを実装すれば、
// dispatcher が自動的に呼び出してくれる。
// ============================================================================

const fetch = require('node-fetch');
const { ButtonBuilder, ButtonStyle, ComponentType, PermissionsBitField } = require('discord.js');
const { isOnlyUrlMessageContent, videoExtensions } = require('../../utils');
const { recordProviderError } = require('../../errorTracking');
const { createProviderAnalytics, facet, tagFacets } = require('../../analytics/providerMetrics');
const {
    applyMediaDisplayToStep,
    buildFailureResponse,
    shouldShowOutputItem,
} = require('../_output_controls');
const { toApiLocaleFamily } = require('../../discordLocales');

// ---- Twitter 内部定数 (このファイル外には出さない) -------------------------

const SAVED_MARKERS         = ['twidata.sprink.cloud', 'localhost:3088'];
const VIDEO_MARKERS         = ['video.twimg.com'];
const ATTACHMENT_THRESHOLD  = 4;
const MAX_ATTACHMENTS       = 10;
const MAX_EMBEDS_PER_STEP   = 10;
const COLOR                 = 0x1DA1F2;
const SAVED_COLOR           = 0x00FF00;
const FOOTER_ICON           = 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png';
const TEXT_MAX_LENGTH       = 1500;
const DESC_MAX_LENGTH       = 4096;
const SAVED_TITLE_PREFIX    = '<SAVED TWEET> ';
const EXPECTED_NON_EXPANDABLE_PATTERNS = [
    /nsfw/i,
    /sensitive/i,
    /age[-_\s]?restricted/i,
    /adult content/i,
    /login required/i,
    /log in/i,
    /sign in/i,
    /not available/i,
    /unavailable/i,
    /protected/i,
    /private/i,
    /deleted/i,
    /removed/i,
    /not found/i,
    /couldn['’]?t find/i,
    /does not exist/i,
    /doesn't exist/i,
    /suspended/i,
    /withheld/i,
    /閲覧できません/,
    /ログイン/,
    /年齢制限/,
    /センシティブ/,
    /非公開/,
    /削除/,
    /存在しません/,
    /凍結/,
];
const TRANSIENT_FAILURE_PATTERNS = [
    /rate limit/i,
    /too many requests/i,
    /temporary/i,
    /temporarily/i,
    /timeout/i,
    /timed out/i,
    /server error/i,
    /bad gateway/i,
    /service unavailable/i,
    /gateway timeout/i,
    /cloudflare/i,
    /maintenance/i,
    /over capacity/i,
];

class ExpectedNonExpandableTweetError extends Error {
    constructor(reason) {
        super(reason || 'Tweet is not expandable by design.');
        this.name = 'ExpectedNonExpandableTweetError';
        this.expectedNonExpandable = true;
    }
}
const QUOTE_RECURSE_DEFAULT_DEPTH = 0; // 0 = unlimited (互換)

// ---- inline 翻訳 (中央 locales 不要) -----------------------------------------

const STR = {
    bannedWordNotice:        { ja: 'あなたのメッセージには禁止ワードが含まれています。', en: 'Your message contains a banned word.' },
    deletePermission:        { ja: 'メッセージを削除する権限がありません。',           en: "I don't have permission to delete messages." },
    requesterPrefix:         { ja: '展開者: ',                                          en: 'request by ' },
    anonRequester:           { ja: '匿名ユーザー',                                      en: 'Anonymous user' },
    anonAuthorTitle:         { ja: '匿名投稿者',                                        en: 'Anonymous author' },
    anonAuthorFooter:        { ja: '投稿者: 匿名投稿者',                                en: 'Posted by Anonymous author' },
    attachmentsButton:       { ja: '画像を埋め込み画像として表示する',                  en: 'Show media in embeds image' },
    viewAsAttachmentsButton: { ja: 'メディアを添付ファイルとして表示する',              en: 'Show media as attachments' },
    translateButton:         { ja: '翻訳',                                              en: 'Translate' },
    deleteButton:            { ja: '削除',                                              en: 'Delete' },
    saveTweetButton:         { ja: 'ツイート保存',                                      en: 'Save tweet' },
    quotePrefix:             { ja: '引用ツイート:',                                     en: 'Quoted tweet:' },
    articleTitlePrefix:      '\uD83D\uDCF0 ', // 📰
    viewLink:                { ja: 'Twitter で見る',                                    en: 'View on Twitter' },
    statsReplies:            { ja: '件のリプライ',                                      en: ' replies' },
    statsReposts:            { ja: '件のリポスト',                                      en: ' retweets' },
    statsLikes:              { ja: '件のいいね',                                        en: ' likes' },
    postedByPrefix:          { ja: '投稿者: ',                                          en: 'Posted by ' },
    repliesField:            { ja: 'Replies',                                             en: 'Replies' },
    repostsField:            { ja: 'Reposts',                                             en: 'Reposts' },
    likesField:              { ja: 'Likes',                                               en: 'Likes' },
    mediaCountField:         { ja: 'Media count',                                         en: 'Media count' },
    mediaTypeField:          { ja: 'Media type',                                          en: 'Media type' },
    sensitiveMediaField:     { ja: 'Sensitive media',                                     en: 'Sensitive media' },
    sensitiveMediaValue:     { ja: 'Yes',                                                 en: 'Yes' },
};

function tr(spec, lang) {
    if (typeof spec === 'string') return spec;
    return spec[lang] ?? spec.en ?? '';
}

// ---- 内部ヘルパ --------------------------------------------------------------

function isVideoUrl(el) {
    return VIDEO_MARKERS.some(m => el.includes(m)) || videoExtensions.some(ext => el.includes(ext));
}

function isImageUrl(el) {
    return /(?:\.|format=)(?:jpe?g|png|webp)(?:[?#&]|$)/i.test(el) || el.includes('pbs.twimg.com/media/');
}

function firstTweetMediaArray(tweet) {
    const candidates = [
        tweet.media_extended,
        tweet.mediaExtended,
        tweet.extended_entities?.media,
        tweet.entities?.media,
        tweet.media,
    ];
    return candidates.find(value => Array.isArray(value) && value.length > 0) || [];
}

function mediaTypeFromUrl(url) {
    if (typeof url !== 'string') return '';
    const value = url.toLowerCase();
    if (value.includes('tweet_video') || /\.(gif)(?:[?#]|$)/i.test(value)) return 'GIF';
    if (isVideoUrl(value)) return 'Video';
    if (isImageUrl(value)) return 'Image';
    return '';
}

function mediaUrlFromObject(media) {
    if (!media || typeof media !== 'object') return '';
    const variants = Array.isArray(media.video_info?.variants) ? media.video_info.variants : [];
    return media.url
        || media.media_url_https
        || media.media_url
        || media.mediaURL
        || media.thumbnail_url
        || media.thumbnailUrl
        || variants.find(variant => variant?.url)?.url
        || '';
}

function mediaTypeFromObject(media) {
    if (!media || typeof media !== 'object') return '';
    const rawType = String(media.type || media.media_type || media.kind || '').toLowerCase();
    if (rawType.includes('animated') || rawType.includes('gif')) return 'GIF';
    if (rawType.includes('video')) return 'Video';
    if (rawType.includes('photo') || rawType.includes('image')) return 'Image';
    return mediaTypeFromUrl(mediaUrlFromObject(media));
}

function mediaTypeCountsFromValues(values) {
    const counts = new Map();
    for (const type of values) {
        if (!type) continue;
        counts.set(type, (counts.get(type) || 0) + 1);
    }
    return counts;
}

function formatMediaTypeCounts(counts) {
    const orderedTypes = ['Image', 'Video', 'GIF'];
    return orderedTypes
        .filter(type => counts.has(type))
        .map(type => `${type} x${counts.get(type)}`)
        .join(', ');
}

function summarizeTweetMedia(tweet) {
    const mediaURLs = Array.isArray(tweet.mediaURLs)
        ? tweet.mediaURLs.filter(url => typeof url === 'string' && url.trim())
        : [];
    const mediaObjects = firstTweetMediaArray(tweet);
    const count = mediaURLs.length || mediaObjects.length;
    if (count === 0) return { count: 0, typeSummary: '' };

    const objectTypes = mediaObjects.map(mediaTypeFromObject).filter(Boolean);
    const urlTypes = mediaURLs.map(mediaTypeFromUrl).filter(Boolean);
    const typeCounts = mediaTypeCountsFromValues(objectTypes.length > 0 ? objectTypes : urlTypes);
    return { count, typeSummary: formatMediaTypeCounts(typeCounts) };
}

function isTruthyApiFlag(value) {
    if (value === true) return true;
    if (typeof value === 'number') return value > 0;
    if (typeof value === 'string') return /^(true|yes|1|sensitive|nsfw|adult)$/i.test(value.trim());
    return false;
}

function tweetHasSensitiveMedia(tweet) {
    const directFlags = [
        tweet?.possibly_sensitive,
        tweet?.possiblySensitive,
        tweet?.sensitive,
        tweet?.is_sensitive,
        tweet?.isSensitive,
        tweet?.nsfw,
        tweet?.adult_content,
        tweet?.adultContent,
    ];
    if (directFlags.some(isTruthyApiFlag)) return true;

    return firstTweetMediaArray(tweet).some(media => [
        media?.possibly_sensitive,
        media?.possiblySensitive,
        media?.sensitive,
        media?.is_sensitive,
        media?.isSensitive,
        media?.nsfw,
        media?.adult_content,
        media?.adultContent,
    ].some(isTruthyApiFlag));
}

function wordsFromText(text, regex) {
    return [...new Set([...String(text || '').matchAll(regex)].map(match => String(match[1] || '').toLowerCase()))];
}

function buildTwitterAnalytics(tweet, url) {
    const hashtags = wordsFromText(tweet.text, /#([\p{L}\p{N}_]+)/gu);
    const mentions = wordsFromText(tweet.text, /@([A-Za-z0-9_]{1,15})/g);
    const media = summarizeTweetMedia(tweet);
    return createProviderAnalytics({
        content: {
            accountKey: tweet.user_screen_name || tweet.user_name,
            contentId: tweet.tweetID || tweet.id,
            contentType: 'tweet',
            contentUrl: tweet.tweetURL || url,
            title: tweet.user_name || tweet.user_screen_name,
            descriptionPreview: tweet.text,
            authorName: tweet.user_name || tweet.user_screen_name,
            publishedAtMs: tweet.date ? Date.parse(tweet.date) : null,
            sensitive: tweetHasSensitiveMedia(tweet) ? 1 : 0,
            mediaCount: media.count,
        },
        metrics: {
            likes: tweet.likes,
            replies: tweet.replies,
            reposts: tweet.retweets,
            media: media.count,
        },
        facets: [
            ...tagFacets('hashtag', hashtags),
            ...tagFacets('mention', mentions),
            facet('media_type', media.typeSummary),
            facet('sensitive', tweetHasSensitiveMedia(tweet) ? 'yes' : 'no'),
            facet('has_article', tweet.article ? 'yes' : 'no'),
            facet('has_quote', tweet.qrtURL ? 'yes' : 'no'),
        ],
    });
}

function isSavedUrl(url) {
    return SAVED_MARKERS.some(m => url.includes(m));
}

function containsBannedWord(text, bannedWords) {
    if (!Array.isArray(bannedWords) || bannedWords.length === 0) return false;
    return bannedWords.some(w => text.includes(w));
}

function isExpectedNonExpandableTweetError(err) {
    return err?.expectedNonExpandable === true;
}

function collectPayloadText(value, out = [], depth = 0) {
    if (out.length >= 40 || depth > 4) return out;
    if (typeof value === 'string' || typeof value === 'number') {
        out.push(String(value));
        return out;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectPayloadText(item, out, depth + 1);
        return out;
    }
    if (value && typeof value === 'object') {
        for (const item of Object.values(value)) collectPayloadText(item, out, depth + 1);
    }
    return out;
}

function looksLikeTransientFailure(text) {
    const sample = String(text || '').slice(0, 5000);
    return TRANSIENT_FAILURE_PATTERNS.some(pattern => pattern.test(sample));
}

function looksLikeExpectedNonExpandable(text) {
    const sample = String(text || '').slice(0, 5000);
    if (!sample || looksLikeTransientFailure(sample)) return false;
    return EXPECTED_NON_EXPANDABLE_PATTERNS.some(pattern => pattern.test(sample));
}

function hasTweetData(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    return !!(
        payload.tweetURL
        || payload.user_name
        || payload.user_screen_name
        || payload.date
        || Array.isArray(payload.mediaURLs)
        || payload.likes !== undefined
        || payload.retweets !== undefined
        || payload.replies !== undefined
        || payload.qrtURL
        || payload.article
    );
}

function getExpectedNonExpandableReason(payload) {
    if (hasTweetData(payload)) return null;
    const text = collectPayloadText(payload).join(' ');
    return looksLikeExpectedNonExpandable(text) ? text : null;
}

function parseTweetApiResponse(text) {
    try {
        const payload = JSON.parse(text);
        const expectedReason = getExpectedNonExpandableReason(payload);
        if (expectedReason) throw new ExpectedNonExpandableTweetError(expectedReason);
        if (!hasTweetData(payload)) throw new Error('Twitter API returned a payload without tweet data.');
        return payload;
    } catch (err) {
        if (isExpectedNonExpandableTweetError(err)) throw err;
        if (looksLikeExpectedNonExpandable(text)) {
            throw new ExpectedNonExpandableTweetError('Tweet is unavailable, private, age-restricted, or login-required.');
        }
        throw err;
    }
}

async function fetchTweetData(url) {
    let api = url.replace(/twitter\.com|x\.com/g, 'api.vxtwitter.com');
    const parts = api.split('/');
    if (parts.length > 6 && !api.includes('twidata.sprink.cloud')) api = parts.slice(0, 6).join('/');
    let text = await (await fetch(api)).text();
    if (text.startsWith('T')) console.log('<<RATE LIMIT>>:' + text + new Date().toLocaleString());
    if (text.trimStart().startsWith('<') && !looksLikeExpectedNonExpandable(text)) {
        text = await (await fetch(api.replace('api.vxtwitter.com', 'api.fxtwitter.com'))).text();
    }
    return parseTweetApiResponse(text);
}

function notifyAlttwitter(tweetURL) {
    if (!tweetURL) return;
    fetch(tweetURL.replace(/twitter\.com/g, 'altterx.sprink.cloud'))
        .then(r => r.text())
        .catch(() => {});
}

function buildButtons(lang, isFullEmbed) {
    const btns = [];
    if (isFullEmbed) btns.push(new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(tr(STR.translateButton, lang)).setCustomId('translate'));
    btns.push(new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel(tr(STR.deleteButton, lang)).setCustomId('delete'));
    if (isFullEmbed) btns.push(new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(tr(STR.saveTweetButton, lang)).setCustomId('savetweet'));
    return btns;
}

// ---- Embed 構築 -------------------------------------------------------------

function twitterTextMode(s) {
    const mode = s?.twitter_text_mode;
    if (mode === 'link_only' || mode === 'hidden') return mode;
    return 'normal';
}

function twitterShowStats(s) {
    return shouldShowOutputItem(s, 'stats');
}

function twitterStatsLayout(s) {
    if (!twitterShowStats(s)) return 'hidden';
    const layout = s?.twitter_stats_layout;
    if (layout === 'fields' || layout === 'hidden') return layout;
    return 'description';
}

function tweetStatsLine(tweet, lang, s) {
    if (twitterStatsLayout(s) !== 'description') return '';
    return ':speech_balloon:' + (tweet.replies ?? 0) + tr(STR.statsReplies, lang)
        + ' \u2022 :recycle:' + (tweet.retweets ?? 0) + tr(STR.statsReposts, lang)
        + ' \u2022 :heart:' + (tweet.likes ?? 0) + tr(STR.statsLikes, lang);
}

function addEmbedField(embed, name, value, inline = true) {
    if (value === undefined || value === null || value === '') return;
    if (!Array.isArray(embed.fields)) embed.fields = [];
    embed.fields.push({ name, value: String(value), inline });
}

function applyTweetStatsFields(embed, tweet, lang, s) {
    if (twitterStatsLayout(s) !== 'fields') return;
    addEmbedField(embed, tr(STR.repliesField, lang), tweet.replies ?? 0);
    addEmbedField(embed, tr(STR.repostsField, lang), tweet.retweets ?? 0);
    addEmbedField(embed, tr(STR.likesField, lang), tweet.likes ?? 0);
}

function applyTweetMediaFields(embed, tweet, lang, s) {
    const media = summarizeTweetMedia(tweet);
    if (media.count > 0) {
        if (shouldShowOutputItem(s, 'media_count')) addEmbedField(embed, tr(STR.mediaCountField, lang), media.count);
        if (shouldShowOutputItem(s, 'media_type')) addEmbedField(embed, tr(STR.mediaTypeField, lang), media.typeSummary);
    }
    if (tweetHasSensitiveMedia(tweet) && shouldShowOutputItem(s, 'sensitive_media', { hideInCompact: true })) {
        addEmbedField(embed, tr(STR.sensitiveMediaField, lang), tr(STR.sensitiveMediaValue, lang));
    }
}

function buildTweetDescription(tweet, lang, s, compact = false) {
    const mode = twitterTextMode(s);
    if (mode === 'hidden') return '';

    const parts = [];
    const stats = tweetStatsLine(tweet, lang, s);
    if (!compact && mode === 'normal' && tweet.text) parts.push(tweet.text);
    if (!compact) parts.push('[' + tr(STR.viewLink, lang) + '](' + tweet.tweetURL + ')');
    if (stats) parts.push(stats);
    return parts.join('\n\n');
}

/** @returns {any} */
function buildFullEmbed(tweet, lang, requesterAuthorName, isAnon, s) {
    const description = buildTweetDescription(tweet, lang, s);
    const title = isAnon ? tr(STR.anonAuthorTitle, lang) : tweet.user_name;
    const footerText = isAnon
        ? tr(STR.anonAuthorFooter, lang)
        : tr(STR.postedByPrefix, lang) + (tweet.user_name ?? '') + (tweet.user_screen_name ? ' (@' + tweet.user_screen_name + ')' : '');

    const embed = {
        author: { name: requesterAuthorName },
        title,
        url: tweet.tweetURL,
        color: COLOR,
        footer: { text: footerText, icon_url: FOOTER_ICON },
        timestamp: tweet.date ? new Date(tweet.date) : undefined,
    };
    if (description) embed.description = description;
    applyTweetStatsFields(embed, tweet, lang, s);
    applyTweetMediaFields(embed, tweet, lang, s);
    return embed;
}

function buildCompactEmbed(tweet, lang, requesterAuthorName, s) {
    const description = buildTweetDescription(tweet, lang, s, true);
    const embed = {
        author: { name: requesterAuthorName },
        url: tweet.tweetURL,
        color: COLOR,
        timestamp: tweet.date ? new Date(tweet.date) : undefined,
    };
    if (description) embed.description = description;
    applyTweetStatsFields(embed, tweet, lang, s);
    applyTweetMediaFields(embed, tweet, lang, s);
    return embed;
}

function applySavedOverlay(embed, saved) {
    if (!saved) return embed;
    embed.title = SAVED_TITLE_PREFIX + (embed.title ?? '');
    embed.color = SAVED_COLOR;
    return embed;
}

function showArticleItem(s, key) {
    return shouldShowOutputItem(s, 'article_card', { hideInCompact: false })
        && shouldShowOutputItem(s, key, { hideInCompact: false });
}

function appendDescription(embed, text) {
    if (!text) return;
    embed.description = [embed.description, text].filter(Boolean).join('\n\n');
    if (embed.description.length > DESC_MAX_LENGTH) embed.description = embed.description.slice(0, DESC_MAX_LENGTH - 3) + '...';
}

function applyArticleMerge(embed, tweet, s) {
    if (!tweet.article) return;
    const titleLine = showArticleItem(s, 'article_title') && tweet.article.title
        ? STR.articleTitlePrefix + '**' + tweet.article.title + '**'
        : '';
    let previewText = showArticleItem(s, 'article_preview') ? (tweet.article.preview_text ?? '') : '';
    if (previewText) {
        const currentLen = embed.description ? embed.description.length : 0;
        const titleLen = titleLine ? titleLine.length + 1 : 0;
        const available = DESC_MAX_LENGTH - currentLen - titleLen - 10;
        if (previewText.length > available && available > 0) previewText = previewText.slice(0, available) + '...';
    }
    const articleText = [titleLine, previewText].filter(Boolean).join('\n');
    if (articleText && embed.description) {
        if (tweet.text && embed.description.includes(tweet.text)) {
            embed.description = embed.description.replace(tweet.text, tweet.text + '\n\n' + articleText);
            if (embed.description.length > DESC_MAX_LENGTH) embed.description = embed.description.slice(0, DESC_MAX_LENGTH - 3) + '...';
        } else {
            appendDescription(embed, articleText);
        }
    } else if (articleText) {
        appendDescription(embed, articleText);
    }
    if (showArticleItem(s, 'article_image') && tweet.article.image && (!tweet.mediaURLs || tweet.mediaURLs.length === 0)) {
        embed.image = { url: tweet.article.image };
    }
}

function normalizeTwitterAccount(value) {
    const handle = String(value || '').trim().replace(/^@/, '').toLowerCase();
    return /^[a-z0-9_]{1,15}$/.test(handle) ? handle : '';
}

function accountFromTweetUrl(url) {
    const match = String(url || '').match(/https?:\/\/(?:twitter\.com|x\.com)\/([^/?#]+)\/status\/\d+/i);
    return normalizeTwitterAccount(match?.[1]);
}

function quoteDepthByAccount(s) {
    const value = s?.quote_repost_depth_by_account;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out = {};
    for (const [account, depth] of Object.entries(value)) {
        const handle = normalizeTwitterAccount(account);
        const numericDepth = Number(depth);
        if (!handle || !Number.isInteger(numericDepth) || numericDepth < 0) continue;
        out[handle] = numericDepth;
    }
    return out;
}

function accountQuoteDepthForTweet(tweet, s) {
    const account = normalizeTwitterAccount(tweet?.user_screen_name) || accountFromTweetUrl(tweet?.tweetURL);
    if (!account) return undefined;
    const depths = quoteDepthByAccount(s);
    return Object.prototype.hasOwnProperty.call(depths, account) ? depths[account] : undefined;
}

function applyAccountQuoteDepth(s, tweet) {
    const depth = accountQuoteDepthForTweet(tweet, s);
    if (depth === undefined) return s;
    return {
        ...s,
        quote_repost_max_depth: depth,
        quote_repost_do_not_extract: false,
    };
}

function canRecurseQuoted(s, depth) {
    if (twitterQuoteMode(s) === 'hidden') return false;
    const maxDepth = s.quote_repost_max_depth ?? QUOTE_RECURSE_DEFAULT_DEPTH;
    return maxDepth === 0 || depth < maxDepth;
}

function twitterQuoteMode(s) {
    if (s?.quote_repost_do_not_extract === true) return 'hidden';
    const mode = s?.twitter_quote_mode;
    if (mode === 'summary' || mode === 'hidden') return mode;
    return 'full';
}

function shouldInlineQuotes(s) {
    return s?.twitter_quote_layout === 'inline';
}

function cloneInlineQuoteEmbed(embed, lang) {
    const out = {
        ...embed,
        author: embed.author ? { ...embed.author } : undefined,
        footer: embed.footer ? { ...embed.footer } : undefined,
        image: embed.image ? { ...embed.image } : undefined,
        thumbnail: embed.thumbnail ? { ...embed.thumbnail } : undefined,
        fields: Array.isArray(embed.fields) ? embed.fields.map(field => ({ ...field })) : embed.fields,
    };
    const prefix = tr(STR.quotePrefix, lang).replace(/:$/, '');
    if (out.title) out.title = `${prefix}: ${out.title}`;
    else if (out.description) out.description = `${tr(STR.quotePrefix, lang)}\n${out.description}`;
    else out.title = prefix;
    return out;
}

function canInlineQuoteSteps(parentStep, childSteps) {
    if (!Array.isArray(childSteps) || childSteps.length === 0) return false;
    const childEmbeds = childSteps.flatMap(step => step.embeds || []);
    if (childEmbeds.length === 0) return false;
    if ((parentStep.embeds || []).length + childEmbeds.length > MAX_EMBEDS_PER_STEP) return false;
    return childSteps.every(step => !Array.isArray(step.files) || step.files.length === 0);
}

function appendInlineQuoteSteps(parentStep, childSteps, lang) {
    const quotedEmbeds = childSteps.flatMap(step => step.embeds || []).map(embed => cloneInlineQuoteEmbed(embed, lang));
    parentStep.embeds.push(...quotedEmbeds);
}

function summarizeQuoteEmbed(embed, lang) {
    /** @type {any} */
    const out = {
        url: embed?.url,
        color: embed?.color ?? COLOR,
    };
    const prefix = tr(STR.quotePrefix, lang).replace(/:$/, '');
    const title = embed?.title || embed?.author?.name || 'Tweet';
    out.title = `${prefix}: ${title}`;
    if (embed?.description) out.description = String(embed.description).slice(0, 280);
    if (embed?.timestamp) out.timestamp = embed.timestamp;
    return out;
}

function summarizeQuoteSteps(childSteps, lang) {
    const embed = childSteps?.flatMap(step => step.embeds || [])[0];
    if (!embed) return null;
    /** @type {import('../_types').SendStep} */
    const step = {
        content: tr(STR.quotePrefix, lang),
        embeds: [summarizeQuoteEmbed(embed, lang)],
        files: [],
        components: [],
        allowedMentions: { repliedUser: false },
        send: 'reply-previous',
    };
    return step;
}

// ---- メディアルーティング ---------------------------------------------------

function routeMedia(tweet, baseEmbed, compact, lang, sendAsAttachmentsByDefault) {
    let mediaURLs = tweet.mediaURLs ? tweet.mediaURLs.slice() : [];
    if (mediaURLs.length === 0) {
        return { embeds: [baseEmbed], files: [], extraButton: null, compactSingleImageHandled: false };
    }

    if (compact && mediaURLs.length === 1 && !isVideoUrl(mediaURLs[0])) {
        return { embeds: [baseEmbed], files: [], extraButton: null, compactSingleImageHandled: true };
    }

    let attachments = [];
    let embeds = [];
    let extraButton = null;
    let videoflag = false;

    if (mediaURLs.length > ATTACHMENT_THRESHOLD || sendAsAttachmentsByDefault === true) {
        if (mediaURLs.length > MAX_ATTACHMENTS) mediaURLs = mediaURLs.slice(0, MAX_ATTACHMENTS);
        attachments = mediaURLs;
        embeds.push(baseEmbed);
        attachments.forEach(el => { if (isVideoUrl(el)) videoflag = true; });
        if (sendAsAttachmentsByDefault === true && !videoflag) {
            extraButton = new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(tr(STR.attachmentsButton, lang)).setCustomId('showAttachmentsAsEmbedsImage');
        }
        return { embeds, files: attachments, extraButton, compactSingleImageHandled: false };
    }

    let compactSingleImageHandled = false;
    mediaURLs.forEach(element => {
        if (VIDEO_MARKERS.some(m => element.includes(m))) {
            attachments.push(element);
            videoflag = true;
            return;
        }
        extraButton = new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(tr(STR.viewAsAttachmentsButton, lang)).setCustomId('showMediaAsAttachments');
        if (mediaURLs.length > 1) {
            if (embeds.length === 0) embeds.push(baseEmbed);
            embeds.push({ url: tweet.tweetURL, image: { url: element } });
        } else {
            baseEmbed.image = { url: element };
            embeds.push(baseEmbed);
        }
    });
    return { embeds, files: attachments, extraButton, compactSingleImageHandled };
}

// ---- メイン extractor -------------------------------------------------------

/**
 * Twitter URL を展開する。
 * @type {import('../_types').Extractor}
 *
 * @param {any} message      - Discord message
 * @param {string} url       - マッチした tweet URL
 * @param {any} s            - Twitter 設定 (フラット): { legacy_mode, passive_mode, anonymous_expand,
 *                              secondary_extract_mode, secondary_extract_mode_multiple_images,
 *                              secondary_extract_mode_video, sendMediaAsAttachmentsAsDefault,
 *                              deletemessageifonlypostedtweetlink,
 *                              deletemessageifonlypostedtweetlink_secoundaryextractmode,
 *                              alwaysreplyifpostedtweetlink, quote_repost_max_depth,
 *                              quote_repost_do_not_extract }
 * @param {object} [opts]    - 内部用: { quoted, depth }
 * @returns {Promise<import('../_types').SendStep[] | null>}
 */
async function extract(message, url, s, opts) {
    opts = opts || {};
    const quoted = opts.quoted === true;
    const depth = opts.depth ?? 0;
    s = s || {};

    const lang = toApiLocaleFamily(s.defaultLanguage);

    // legacy_mode 自動判定 (未設定なら ManageMessages 権限値で初期化)
    if (s.legacy_mode === undefined) {
        s.legacy_mode = message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageMessages);
    }

    let tweet;
    try {
        tweet = await fetchTweetData(url);
    } catch (err) {
        if (isExpectedNonExpandableTweetError(err)) return null;
        recordProviderError('twitter', err, message, url, { endpointKey: 'api.vxtwitter.com/status' });
        console.log(err);
        return buildFailureResponse('twitter', url, s, err);
    }
    notifyAlttwitter(tweet.tweetURL);
    s = applyAccountQuoteDepth(s, tweet);

    // ---- banned word: extractor 内で完結処理 (副作用直接) ----
    if (containsBannedWord(tweet.text, s.bannedWords)) {
        const reply = await message.reply(tr(STR.bannedWordNotice, lang)).catch(() => null);
        setTimeout(async () => {
            if (reply) await reply.delete().catch(() => {});
            await message.delete().catch(async () => {
                const warn = await message.channel.send(tr(STR.deletePermission, lang)).catch(() => null);
                if (warn) setTimeout(() => warn.delete().catch(() => {}), 3000);
            });
        }, 3000);
        return null;
    }

    // text truncate
    if (tweet.text && tweet.text.length > TEXT_MAX_LENGTH) tweet.text = tweet.text.slice(0, TEXT_MAX_LENGTH) + '...';

    const saved = isSavedUrl(url);
    const isAnon = s.anonymous_expand === true;
    const requesterDisplayName = isAnon
        ? tr(STR.anonRequester, lang)
        : (message.author?.username ?? message.user.username) + '(id:' + (message.author?.id ?? message.user.id) + ')';
    const requesterAuthorName = tr(STR.requesterPrefix, lang) + requesterDisplayName;
    const sourceMessageIsOnlyUrl = isOnlyUrlMessageContent(message.content, url);

    // compact 判定
    const useCompactEmbed =
        s.legacy_mode === false
        && !quoted
        && (s.deletemessageifonlypostedtweetlink !== true || !sourceMessageIsOnlyUrl)
        && !saved;

    // ---- secondary_extract pre-check ----
    if (s.secondary_extract_mode === true && !saved) {
        const mediaURLs = tweet.mediaURLs || [];
        const containsVideo = mediaURLs.some(isVideoUrl);
        const imageCount = mediaURLs.filter(el => !isVideoUrl(el)).length;
        const containsMultiImg = imageCount > 1;
        const shouldExtract =
            ((s.secondary_extract_mode_multiple_images ?? true) && containsMultiImg)
            || ((s.secondary_extract_mode_video ?? true) && containsVideo);
        const shouldSuppress = !shouldExtract && (mediaURLs.length > 0 || !tweet.article);
        if (shouldSuppress && tweet.qrtURL && canRecurseQuoted(s, depth)) {
            const r = await recurseQuoted(message, tweet.qrtURL, s, depth);
            if (r == null) return null;
            return Array.isArray(r) ? r : [r];
        }
        if (shouldSuppress) return null;
    }

    // Embed
    let embed = useCompactEmbed
        ? buildCompactEmbed(tweet, lang, requesterAuthorName, s)
        : buildFullEmbed(tweet, lang, requesterAuthorName, isAnon, s);

    if (useCompactEmbed && s.passive_mode === true) delete embed.description;
    embed = applySavedOverlay(embed, saved);
    applyArticleMerge(embed, tweet, s);

    // routeMedia
    const route = routeMedia(tweet, embed, useCompactEmbed, lang, s.sendMediaAsAttachmentsAsDefault);

    let embeds = route.embeds;
    if (embeds.length === 0) embeds.push(embed);
    const isFullEmbed = !!embeds[0].title;
    const components = [];
    if (route.extraButton) components.push({ type: ComponentType.ActionRow, components: [route.extraButton] });
    const buttonRow = buildButtons(lang, isFullEmbed);
    if (buttonRow.length > 0) components.push({ type: ComponentType.ActionRow, components: buttonRow });

    /** @type {import('../_types').SendStep} */
    const step = {
        embeds,
        files: route.files,
        components,
        allowedMentions: { repliedUser: false },
        analytics: buildTwitterAnalytics(tweet, url),
    };
    if (quoted) {
        step.send = 'reply-previous';
        const qp = tr(STR.quotePrefix, lang);
        if (qp) step.content = qp;
    } else if (opts.forceSendMode) {
        step.send = opts.forceSendMode;
    } else {
        step.send = (s.alwaysreplyifpostedtweetlink === true) ? 'reply-source' : 'channel';
    }

    // legacyModeSuppress
    if (!quoted && s.legacy_mode === true && message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        step.suppressSourceEmbeds = true;
    }

    // deleteSourceIfOnlyLink
    if (!quoted && s.deletemessageifonlypostedtweetlink === true && sourceMessageIsOnlyUrl) {
        if (s.deletemessageifonlypostedtweetlink_secoundaryextractmode === true && s.secondary_extract_mode === true) {
            step.suppressSourceEmbeds = true;
        } else {
            step.deleteSource = true;
        }
    }

    const mediaUrls = (tweet.mediaURLs && tweet.mediaURLs.length > 0)
        ? tweet.mediaURLs
        : (showArticleItem(s, 'article_image') && tweet.article?.image ? [tweet.article.image] : []);
    applyMediaDisplayToStep(step, s, mediaUrls, 'Media');

    /** @type {import('../_types').SendStep[]} */
    const allSteps = [step];

    // 引用ポスト再帰展開
    if (tweet.qrtURL && canRecurseQuoted(s, depth)) {
        const quoteMode = twitterQuoteMode(s);
        const childSettings = quoteMode === 'summary' ? { ...s, twitter_quote_mode: 'hidden' } : s;
        const childSteps = await extract(message, tweet.qrtURL, childSettings, { quoted: true, depth: depth + 1 });
        if (Array.isArray(childSteps)) {
            if (quoteMode === 'summary') {
                const summaryStep = summarizeQuoteSteps(childSteps, lang);
                if (summaryStep && !quoted && shouldInlineQuotes(s) && (step.embeds || []).length < MAX_EMBEDS_PER_STEP) {
                    step.embeds.push(summaryStep.embeds[0]);
                } else if (summaryStep) {
                    allSteps.push(summaryStep);
                }
            } else if (!quoted && shouldInlineQuotes(s) && canInlineQuoteSteps(step, childSteps)) {
                appendInlineQuoteSteps(step, childSteps, lang);
            } else {
                allSteps.push(...childSteps);
            }
        }
    }

    return allSteps;
}

async function recurseQuoted(message, quoteUrl, s, depth) {
    if (!quoteUrl) return null;
    if (!canRecurseQuoted(s, depth)) return null;
    return await extract(message, quoteUrl, s, { quoted: true, depth: depth + 1 });
}

// ---- 公開エクスポート -------------------------------------------------------

/** @type {import('../_types').Provider & {commands: Array<{definition: any, execute: Function}>}} */
const twitterProvider = {
    id: 'twitter',
    enabledByDefault: true,
    urlPattern: /https?:\/\/(twitter\.com|x\.com)\/[^\s<>|]*/g,
    cleanPattern: /<https?:\/\/(twitter\.com|x\.com)[^\s<>|]*>|\|\|https?:\/\/(twitter\.com|x\.com)[^\s<>|]*\|\|/g,
    settings: [
        'bannedWords',
        'sendMediaAsAttachmentsAsDefault',
        'deletemessageifonlypostedtweetlink',
        'deletemessageifonlypostedtweetlink_secoundaryextractmode',
        'alwaysreplyifpostedtweetlink',
        'anonymous_expand',
        'display_density',
        'media_display_mode',
        'twitter_stats_layout',
        'twitter_text_mode',
        'twitter_quote_mode',
        'twitter_quote_layout',
        {
            key: 'hidden_output_items',
            outputItems: [
                { value: 'article_card', label: { en: 'Article card', ja: 'Article card' } },
                { value: 'article_title', label: { en: 'Article title', ja: 'Article title' } },
                { value: 'article_preview', label: { en: 'Article preview', ja: 'Article preview' } },
                { value: 'article_image', label: { en: 'Article image', ja: 'Article image' } },
                { value: 'media_count', label: { en: 'Media count', ja: 'Media count' } },
                { value: 'media_type', label: { en: 'Media type', ja: 'Media type' } },
                { value: 'sensitive_media', label: { en: 'Sensitive media flag', ja: 'Sensitive media flag' } },
                { value: 'stats', label: { en: 'Reply/repost/like stats', ja: 'リプライ/リポスト/いいね数' } },
            ],
        },
        'quote_repost_do_not_extract',
        'quote_repost_max_depth',
        'legacy_mode',
        'passive_mode',
        'secondary_extract_mode',
        'secondary_extract_mode_multiple_images',
        'secondary_extract_mode_video',
    ],
    extract,
    // Twitter 専用 slash commands。registry が自動的に拾って Discord に登録する。
    commands: require('./commands'),
};
module.exports = twitterProvider;

// 後方互換: showsavetweet コマンドが直接呼ぶエントリ
/** @type {any} */ (module.exports).sendTweetEmbed = async function (message, url, opts = {}) {
    const { getProviderSettings } = require('../_provider_settings');
    const { runSendSteps } = require('../_dispatcher');
    const options = /** @type {any} */ (opts || {});
    const settingsOverride = options.settingsOverride && typeof options.settingsOverride === 'object'
        ? options.settingsOverride
        : {};
    const extractOpts = { ...options };
    delete extractOpts.settingsOverride;
    const s = {
        ...(await getProviderSettings(module.exports, message.guild.id)),
        ...settingsOverride,
    };
    const steps = await extract(message, url, s, extractOpts);
    if (Array.isArray(steps)) await runSendSteps(message, steps, 'twitter');
    return steps;
};

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
const { videoExtensions } = require('../../utils');
const { recordProviderError } = require('../../errorTracking');

// ---- Twitter 内部定数 (このファイル外には出さない) -------------------------

const SAVED_MARKERS         = ['twidata.sprink.cloud', 'localhost:3088'];
const VIDEO_MARKERS         = ['video.twimg.com'];
const ATTACHMENT_THRESHOLD  = 4;
const MAX_ATTACHMENTS       = 10;
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
};

function tr(spec, lang) {
    if (typeof spec === 'string') return spec;
    return spec[lang] ?? spec.en ?? '';
}

// ---- 内部ヘルパ --------------------------------------------------------------

function isVideoUrl(el) {
    return VIDEO_MARKERS.some(m => el.includes(m)) || videoExtensions.some(ext => el.includes(ext));
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

/** @returns {any} */
function buildFullEmbed(tweet, lang, requesterAuthorName, isAnon) {
    const stats = ':speech_balloon:' + (tweet.replies ?? 0) + tr(STR.statsReplies, lang)
        + ' \u2022 :recycle:' + (tweet.retweets ?? 0) + tr(STR.statsReposts, lang)
        + ' \u2022 :heart:' + (tweet.likes ?? 0) + tr(STR.statsLikes, lang);
    let description = (tweet.text ?? '') + '\n\n[' + tr(STR.viewLink, lang) + '](' + tweet.tweetURL + ')\n\n' + stats;

    const title = isAnon ? tr(STR.anonAuthorTitle, lang) : tweet.user_name;
    const footerText = isAnon
        ? tr(STR.anonAuthorFooter, lang)
        : tr(STR.postedByPrefix, lang) + (tweet.user_name ?? '') + (tweet.user_screen_name ? ' (@' + tweet.user_screen_name + ')' : '');

    return {
        author: { name: requesterAuthorName },
        title,
        url: tweet.tweetURL,
        description,
        color: COLOR,
        footer: { text: footerText, icon_url: FOOTER_ICON },
        timestamp: tweet.date ? new Date(tweet.date) : undefined,
    };
}

function buildCompactEmbed(tweet, lang, requesterAuthorName) {
    const stats = ':speech_balloon:' + (tweet.replies ?? 0) + tr(STR.statsReplies, lang)
        + ' \u2022 :recycle:' + (tweet.retweets ?? 0) + tr(STR.statsReposts, lang)
        + ' \u2022 :heart:' + (tweet.likes ?? 0) + tr(STR.statsLikes, lang);
    return {
        author: { name: requesterAuthorName },
        url: tweet.tweetURL,
        description: stats,
        color: COLOR,
        timestamp: tweet.date ? new Date(tweet.date) : undefined,
    };
}

function applySavedOverlay(embed, saved) {
    if (!saved) return embed;
    embed.title = SAVED_TITLE_PREFIX + (embed.title ?? '');
    embed.color = SAVED_COLOR;
    return embed;
}

function applyArticleMerge(embed, tweet) {
    if (!tweet.article) return;
    const titleLine = tweet.article.title ? STR.articleTitlePrefix + '**' + tweet.article.title + '**' : '';
    let previewText = tweet.article.preview_text ?? '';
    if (previewText) {
        const currentLen = embed.description ? embed.description.length : 0;
        const titleLen = titleLine ? titleLine.length + 1 : 0;
        const available = DESC_MAX_LENGTH - currentLen - titleLen - 10;
        if (previewText.length > available && available > 0) previewText = previewText.slice(0, available) + '...';
    }
    const articleText = [titleLine, previewText].filter(Boolean).join('\n');
    if (articleText && embed.description) {
        embed.description = embed.description.replace(tweet.text, tweet.text + '\n\n' + articleText);
        if (embed.description.length > DESC_MAX_LENGTH) embed.description = embed.description.slice(0, DESC_MAX_LENGTH - 3) + '...';
    }
    if (tweet.article.image && (!tweet.mediaURLs || tweet.mediaURLs.length === 0)) {
        embed.image = { url: tweet.article.image };
    }
}

function canRecurseQuoted(s, depth) {
    if (s.quote_repost_do_not_extract === true) return false;
    const maxDepth = s.quote_repost_max_depth ?? QUOTE_RECURSE_DEFAULT_DEPTH;
    return maxDepth === 0 || depth < maxDepth;
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

    const lang = s.defaultLanguage ?? 'en';

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
        return null;
    }
    notifyAlttwitter(tweet.tweetURL);

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

    // compact 判定
    const useCompactEmbed =
        s.legacy_mode === false
        && !quoted
        && (s.deletemessageifonlypostedtweetlink !== true || message.content !== url)
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
        ? buildCompactEmbed(tweet, lang, requesterAuthorName)
        : buildFullEmbed(tweet, lang, requesterAuthorName, isAnon);

    if (useCompactEmbed && s.passive_mode === true) delete embed.description;
    embed = applySavedOverlay(embed, saved);
    applyArticleMerge(embed, tweet);

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
    if (!quoted && s.deletemessageifonlypostedtweetlink === true && message.content === url) {
        if (s.deletemessageifonlypostedtweetlink_secoundaryextractmode === true && s.secondary_extract_mode === true) {
            step.suppressSourceEmbeds = true;
        } else {
            step.deleteSource = true;
        }
    }

    /** @type {import('../_types').SendStep[]} */
    const allSteps = [step];

    // 引用ポスト再帰展開
    if (tweet.qrtURL && canRecurseQuoted(s, depth)) {
        const childSteps = await extract(message, tweet.qrtURL, s, { quoted: true, depth: depth + 1 });
        if (Array.isArray(childSteps)) allSteps.push(...childSteps);
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
    extract,
    // Twitter 専用 slash commands。registry が自動的に拾って Discord に登録する。
    commands: require('./commands'),
};
module.exports = twitterProvider;

// 後方互換: showsavetweet コマンドが直接呼ぶエントリ
/** @type {any} */ (module.exports).sendTweetEmbed = async function (message, url, opts = {}) {
    const { getProviderSettings } = require('../_provider_settings');
    const { runSendSteps } = require('../_dispatcher');
    const s = await getProviderSettings(module.exports, message.guild.id);
    const steps = await extract(message, url, s, opts);
    if (Array.isArray(steps)) await runSendSteps(message, steps, 'twitter');
};

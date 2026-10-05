'use strict';

const fetch = require('../../providerFetch').withDeadline(require('node-fetch'));
const { recordProviderError } = require('../../errorTracking');
const { attachmentMediaUrls, buildFailureResponse, mediaLinksContent } = require('../_output_controls');
const {
    parseAmazonUrl,
    normalizeAmazonExtractTargets,
    shouldExtractAmazonParsed,
    AMAZON_URL_PATTERN,
} = require('./urls');
const { readMetaContent, readLandingImage } = require('./amazonSourceParser');
const { createAmazonClient } = require('./client');
const { fetchAmazonPage, fetchAmazonMusicSupplement } = createAmazonClient(fetch);
const {
    extractAmazonInfo,
    extractProductInfo,
    extractAmazonMusicInfo,
    extractPrimeVideoInfo,
} = require('./parsing');
const { buildEmbed, buildComponents, normalizeLanguage } = require('./presentation');
const { buildAmazonAnalytics } = require('./analytics');

function containsBannedWord(text, bannedWords) {
    if (!Array.isArray(bannedWords) || bannedWords.length === 0) return false;
    return bannedWords.some(word => word && text.includes(word));
}

/** @type {import('../_types').Extractor} */
async function extract(message, url, s) {
    s = s || {};
    const initialParsed = parseAmazonUrl(url);
    if (!initialParsed) return null;
    if (normalizeAmazonExtractTargets(s).length === 0) return null;
    if (!shouldExtractAmazonParsed(initialParsed, s)) return null;

    let parsed = initialParsed;
    let html = '';
    try {
        const page = await fetchAmazonPage(url, undefined, s.defaultLanguage);
        html = page.html;
        const resolvedParsed = parseAmazonUrl(page.finalUrl);
        if (resolvedParsed?.id) {
            parsed = {
                ...resolvedParsed,
                openUrl: initialParsed.openUrl || url,
            };
        }
    } catch (err) {
        if (!initialParsed.id) {
            recordProviderError('amazon', err, message, url, { endpointKey: 'amazon/page' });
            return buildFailureResponse('amazon', url, s, err);
        }
    }

    if (!parsed.id) return null;
    if (!shouldExtractAmazonParsed(parsed, s)) return null;

    let supplement = null;
    if (parsed.kind === 'music') {
        supplement = await fetchAmazonMusicSupplement(parsed, s.defaultLanguage);
        html = [
            html,
            supplement.socialHtml,
            supplement.embedHtml,
        ].filter(Boolean).join('\n');
    }

    const info = html ? extractAmazonInfo(html, parsed, s, supplement) : {};
    const bannedTarget = [
        info.title,
        info.description,
        info.brand,
        info.artist,
        info.album,
        info.genre,
    ].filter(Boolean).join('\n');
    if (containsBannedWord(bannedTarget, s.bannedWords)) return null;

    /** @type {import('../_types').SendStep} */
    const step = {
        embeds: [buildEmbed(parsed, info, message, s)],
        components: buildComponents(normalizeLanguage(s), parsed, !!info.imageUrl, s, parsed.kind === 'product' && info.priceAmount !== null),
        allowedMentions: { repliedUser: false },
        send: s.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel',
        suppressSourceEmbeds: true,
        analytics: buildAmazonAnalytics(parsed, info),
    };

    const mediaFiles = attachmentMediaUrls(s, info.imageUrl);
    if (mediaFiles.length > 0) step.files = mediaFiles;
    const mediaContent = mediaLinksContent(s, info.imageUrl, 'Image');
    if (mediaContent) step.content = mediaContent;

    if (s.deletemessageifonlypostedtweetlink === true && message.content.trim() === url) {
        step.deleteSource = true;
    }

    return [step];
}

/** @type {import('../_types').Provider} */
const amazonProvider = {
    id: 'amazon',
    enabledByDefault: false,
    urlPattern: new RegExp(AMAZON_URL_PATTERN.source, AMAZON_URL_PATTERN.flags),
    settings: [
        'bannedWords',
        'anonymous_expand',
        'alwaysreplyifpostedtweetlink',
        'deletemessageifonlypostedtweetlink',
        'display_density',
        'media_display_mode',
        'amazon_description_max_length',
        'amazon_extract_targets',
        {
            key: 'hidden_output_items',
            outputItems: [
                { value: 'album', label: { en: 'Music album field', ja: 'Music album field' } },
                { value: 'artist', label: { en: 'Music artist field', ja: 'Music artist field' } },
                { value: 'brand', label: { en: 'Brand field', ja: 'Brand field' } },
                { value: 'seller', label: { en: 'Seller field', ja: 'Seller field' } },
                { value: 'shipping', label: { en: 'Shipping field', ja: 'Shipping field' } },
                { value: 'review_count', label: { en: 'Review count field', ja: 'Review count field' } },
                { value: 'coupon', label: { en: 'Coupon field', ja: 'Coupon field' } },
                { value: 'deal', label: { en: 'Deal field', ja: 'Deal field' } },
                { value: 'date', label: { en: 'Music date field', ja: 'Music date field' } },
                { value: 'duration', label: { en: 'Duration field', ja: 'Duration field' } },
                { value: 'genre', label: { en: 'Prime Video genre field', ja: 'Prime Video genre field' } },
                { value: 'cast', label: { en: 'Prime Video cast field', ja: 'Prime Video cast field' } },
                { value: 'season', label: { en: 'Prime Video season field', ja: 'Prime Video season field' } },
                { value: 'maturity', label: { en: 'Prime Video maturity field', ja: 'Prime Video maturity field' } },
                { value: 'type', label: { en: 'Music type field', ja: 'Music type field' } },
                { value: 'year', label: { en: 'Prime Video year field', ja: 'Prime Video year field' } },
                { value: 'price', label: { en: 'Price field', ja: '価格欄' } },
                { value: 'rating', label: { en: 'Rating field', ja: '評価欄' } },
                { value: 'availability', label: { en: 'Availability field', ja: '在庫/配信状況欄' } },
                { value: 'id', label: { en: 'ASIN/ID field', ja: 'ASIN/ID欄' } },
            ],
        },
    ],
    extract,
};

module.exports = amazonProvider;
module.exports._internal = {
    extractAmazonMusicInfo,
    extractPrimeVideoInfo,
    extractProductInfo,
    parseAmazonUrl,
    readLandingImage,
    readMetaContent,
};

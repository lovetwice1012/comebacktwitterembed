'use strict';

const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { applyEmbedMedia, mediaButtonAllowed, shouldShowOutputItem } = require('../_output_controls');
const { DEFAULT_DISCORD_LOCALE, normalizeDiscordLocale, toApiLocaleFamily } = require('../../discordLocales');
const { cleanText, truncate } = require('./amazonSourceParser');

const AMAZON_COLOR = 0xff9900;

const FIELD_MAX_LENGTH = 1024;

const STR = {
    requesterPrefix: { ja: 'Requested by ', en: 'Requested by ' },
    anonymousRequester: { ja: 'Anonymous requester', en: 'Anonymous requester' },
    openButton: { ja: 'Open in Amazon', en: 'Open in Amazon' },
    openMusicButton: { ja: 'Open in Amazon Music', en: 'Open in Amazon Music' },
    openPrimeVideoButton: { ja: 'Open in Prime Video', en: 'Open in Prime Video' },
    showMediaAsAttachmentsButton: { ja: 'Show image as attachment', en: 'Show image as attachment' },
    translateButton: { ja: 'Translate', en: 'Translate' },
    deleteButton: { ja: 'Delete', en: 'Delete' },
    priceWatchButton: { ja: '価格通知', en: 'Price alert' },
    typeField: { ja: 'Type', en: 'Type' },
    priceField: { ja: '価格', en: 'Price' },
    brandField: { ja: 'Brand', en: 'Brand' },
    sellerField: { ja: 'Seller', en: 'Seller' },
    shippingField: { ja: 'Shipping', en: 'Shipping' },
    ratingField: { ja: 'Rating', en: 'Rating' },
    reviewCountField: { ja: 'Review count', en: 'Review count' },
    availabilityField: { ja: 'Availability', en: 'Availability' },
    couponField: { ja: 'Coupon', en: 'Coupon' },
    dealField: { ja: 'Deal', en: 'Deal' },
    artistField: { ja: 'Artist', en: 'Artist' },
    albumField: { ja: 'Album', en: 'Album' },
    dateField: { ja: 'Date', en: 'Date' },
    genreField: { ja: 'Genre', en: 'Genre' },
    castField: { ja: 'Cast', en: 'Cast' },
    seasonField: { ja: 'Season', en: 'Season' },
    yearField: { ja: 'Year', en: 'Year' },
    maturityField: { ja: 'Maturity', en: 'Maturity' },
    durationField: { ja: 'Duration', en: 'Duration' },
    asinField: { ja: 'ASIN', en: 'ASIN' },
    idField: { ja: 'ID', en: 'ID' },
    fallbackTitle: { ja: 'Amazon item ', en: 'Amazon item ' },
    musicFallbackTitle: { ja: 'Amazon Music ', en: 'Amazon Music ' },
    primeVideoFallbackTitle: { ja: 'Prime Video ', en: 'Prime Video ' },
};

function tr(spec, lang) {
    if (typeof spec === 'string') return spec;
    return spec[lang] ?? spec.en ?? '';
}

function normalizeLanguage(settings) {
    return toApiLocaleFamily(settings?.defaultLanguage);
}

function priceWatchLocale(settings) {
    return normalizeDiscordLocale(settings?.defaultLanguage, DEFAULT_DISCORD_LOCALE);
}

function addField(fields, name, value, inline = true) {
    const text = truncate(cleanText(value), FIELD_MAX_LENGTH);
    if (!text) return;
    fields.push({ name, value: text, inline });
}

function requesterName(message, lang, anonymous) {
    if (anonymous) return tr(STR.anonymousRequester, lang);
    return `${message.author?.username ?? message.user?.username}(id:${message.author?.id ?? message.user?.id})`;
}

function serviceNameFor(parsed) {
    if (parsed.kind === 'music') return 'Amazon Music';
    if (parsed.kind === 'primeVideo') return 'Prime Video';
    return 'Amazon';
}

function openButtonLabelFor(parsed, lang) {
    if (parsed.kind === 'music') return tr(STR.openMusicButton, lang);
    if (parsed.kind === 'primeVideo') return tr(STR.openPrimeVideoButton, lang);
    return tr(STR.openButton, lang);
}

function fallbackTitleFor(parsed, lang) {
    if (parsed.kind === 'music') return `${tr(STR.musicFallbackTitle, lang)}${parsed.id}`;
    if (parsed.kind === 'primeVideo') return `${tr(STR.primeVideoFallbackTitle, lang)}${parsed.id}`;
    return `${tr(STR.fallbackTitle, lang)}${parsed.asin || parsed.id}`;
}

function addProductFields(fields, info, parsed, lang, s) {
    if (shouldShowOutputItem(s, 'price')) addField(fields, tr(STR.priceField, lang), info.price);
    if (shouldShowOutputItem(s, 'brand')) addField(fields, tr(STR.brandField, lang), info.brand);
    if (shouldShowOutputItem(s, 'seller')) addField(fields, tr(STR.sellerField, lang), info.seller);
    if (shouldShowOutputItem(s, 'shipping')) addField(fields, tr(STR.shippingField, lang), info.shipping);
    if (shouldShowOutputItem(s, 'rating')) addField(fields, tr(STR.ratingField, lang), info.rating);
    if (shouldShowOutputItem(s, 'review_count')) addField(fields, tr(STR.reviewCountField, lang), info.reviewCount);
    if (shouldShowOutputItem(s, 'availability')) addField(fields, tr(STR.availabilityField, lang), info.availability);
    if (shouldShowOutputItem(s, 'coupon')) addField(fields, tr(STR.couponField, lang), info.coupon);
    if (shouldShowOutputItem(s, 'deal')) addField(fields, tr(STR.dealField, lang), info.deal);
    if (shouldShowOutputItem(s, 'id')) addField(fields, tr(STR.asinField, lang), parsed.asin);
}

function addMusicFields(fields, info, parsed, lang, s) {
    if (shouldShowOutputItem(s, 'type')) addField(fields, tr(STR.typeField, lang), info.musicType);
    if (shouldShowOutputItem(s, 'artist')) addField(fields, tr(STR.artistField, lang), info.artist);
    if (shouldShowOutputItem(s, 'album')) addField(fields, tr(STR.albumField, lang), info.album);
    if (shouldShowOutputItem(s, 'date')) addField(fields, tr(STR.dateField, lang), info.date);
    if (shouldShowOutputItem(s, 'duration')) addField(fields, tr(STR.durationField, lang), info.duration);
    if (shouldShowOutputItem(s, 'id')) addField(fields, tr(STR.idField, lang), parsed.id);
}

function addPrimeVideoFields(fields, info, parsed, lang, s) {
    if (shouldShowOutputItem(s, 'genre')) addField(fields, tr(STR.genreField, lang), info.genre);
    if (shouldShowOutputItem(s, 'cast')) addField(fields, tr(STR.castField, lang), info.cast);
    if (shouldShowOutputItem(s, 'season')) addField(fields, tr(STR.seasonField, lang), info.season);
    if (shouldShowOutputItem(s, 'year')) addField(fields, tr(STR.yearField, lang), info.year);
    if (shouldShowOutputItem(s, 'maturity')) addField(fields, tr(STR.maturityField, lang), info.maturityRating);
    if (shouldShowOutputItem(s, 'duration')) addField(fields, tr(STR.durationField, lang), info.duration);
    if (shouldShowOutputItem(s, 'rating')) addField(fields, tr(STR.ratingField, lang), info.rating);
    if (shouldShowOutputItem(s, 'id')) addField(fields, tr(STR.idField, lang), parsed.id);
}

function buildComponents(lang, parsed, hasImage, settings, canPriceWatch = false) {
    const rows = [];
    const firstRow = [
        new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel(openButtonLabelFor(parsed, lang))
            .setURL(parsed.openUrl || parsed.canonicalUrl),
    ];
    if (hasImage && mediaButtonAllowed(settings)) {
        firstRow.push(
            new ButtonBuilder()
                .setStyle(ButtonStyle.Primary)
                .setLabel(tr(STR.showMediaAsAttachmentsButton, lang))
                .setCustomId('showMediaAsAttachments')
        );
    }
    if (canPriceWatch && parsed.kind === 'product' && parsed.asin) {
        firstRow.push(
            new ButtonBuilder()
                .setStyle(ButtonStyle.Success)
                .setLabel(tr(STR.priceWatchButton, lang))
                .setCustomId(`priceWatch:a:product:${parsed.asin}:${priceWatchLocale(settings)}`)
        );
    }
    rows.push({ type: ComponentType.ActionRow, components: firstRow });
    rows.push({
        type: ComponentType.ActionRow,
        components: [
            new ButtonBuilder()
                .setStyle(ButtonStyle.Primary)
                .setLabel(tr(STR.translateButton, lang))
                .setCustomId('translate'),
            new ButtonBuilder()
                .setStyle(ButtonStyle.Danger)
                .setLabel(tr(STR.deleteButton, lang))
                .setCustomId('delete:amazon'),
        ],
    });
    return rows;
}

function buildEmbed(parsed, info, message, s) {
    const lang = normalizeLanguage(s);
    const fields = [];
    if (parsed.kind === 'music') addMusicFields(fields, info, parsed, lang, s);
    else if (parsed.kind === 'primeVideo') addPrimeVideoFields(fields, info, parsed, lang, s);
    else addProductFields(fields, info, parsed, lang, s);

    const embed = {
        title: info.title || fallbackTitleFor(parsed, lang),
        url: parsed.canonicalUrl,
        description: info.description || undefined,
        color: AMAZON_COLOR,
        fields,
        footer: { text: `${tr(STR.requesterPrefix, lang)}${requesterName(message, lang, s?.anonymous_expand === true)} - ${serviceNameFor(parsed)}` },
    };
    applyEmbedMedia(embed, info.imageUrl, s);
    return embed;
}

module.exports = {
    buildComponents,
    buildEmbed,
    normalizeLanguage,
    priceWatchLocale,
};

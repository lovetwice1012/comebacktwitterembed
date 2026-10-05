'use strict';

const amazonSourceParser = require('./amazonSourceParser');
const { resolveDensityMaxLength } = require('../_output_controls');
const { normalizeDiscordLocale, DEFAULT_DISCORD_LOCALE } = require('../../discordLocales');

function descriptionMaxLength(settings) {
    return resolveDensityMaxLength(settings, 'amazon_description_max_length', amazonSourceParser.DEFAULT_DESCRIPTION_MAX_LENGTH, {
        compact: 200,
        detail: amazonSourceParser.DEFAULT_DESCRIPTION_MAX_LENGTH,
        hardMax: amazonSourceParser.DEFAULT_DESCRIPTION_MAX_LENGTH,
    });
}

// Keep provider settings at this boundary; the source parser receives explicit values.
function extractProductInfo(html, parsed, settings) {
    return amazonSourceParser.extractProductInfo(html, parsed, descriptionMaxLength(settings),
        normalizeDiscordLocale(settings?.defaultLanguage, DEFAULT_DISCORD_LOCALE));
}

function extractAmazonMusicInfo(html, parsed, settings, supplement) {
    return amazonSourceParser.extractAmazonMusicInfo(html, parsed, descriptionMaxLength(settings), supplement);
}

function extractPrimeVideoInfo(html, parsed, settings) {
    return amazonSourceParser.extractPrimeVideoInfo(html, parsed, descriptionMaxLength(settings));
}

function extractAmazonInfo(html, parsed, settings, supplement) {
    if (parsed.kind === 'music') return extractAmazonMusicInfo(html, parsed, settings, supplement);
    if (parsed.kind === 'primeVideo') return extractPrimeVideoInfo(html, parsed, settings);
    return extractProductInfo(html, parsed, settings);
}

module.exports = {
    extractAmazonInfo,
    extractAmazonMusicInfo,
    extractPrimeVideoInfo,
    extractProductInfo,
};

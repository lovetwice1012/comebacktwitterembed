'use strict';

const {
    absoluteUrl,
    cleanText,
    extractAttr,
    iframeSrcFromHtml,
    parseJsonSafely,
    readMetaContent,
    truncate,
} = require('./html');
const { DEFAULT_DESCRIPTION_MAX_LENGTH } = require('./metadata');
const { AMAZON_MUSIC_ROUTE_LABELS, extractAmazonMusicInfo } = require('./music');
const { extractPrimeVideoInfo } = require('./primeVideo');
const { extractProductInfo, readLandingImage } = require('./product');

// Pure source parsing: callers provide HTML, URL context, an optional numeric
// description limit, a product display locale, and (for music) fetched oEmbed metadata.
module.exports = {
    AMAZON_MUSIC_ROUTE_LABELS,
    DEFAULT_DESCRIPTION_MAX_LENGTH,
    extractAmazonMusicInfo,
    extractPrimeVideoInfo,
    extractProductInfo,
    readLandingImage,
    readMetaContent,
    iframeSrcFromHtml,
    parseJsonSafely,
    absoluteUrl,
    cleanText,
    extractAttr,
    truncate,
};

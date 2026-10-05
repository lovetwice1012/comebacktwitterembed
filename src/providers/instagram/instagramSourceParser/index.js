'use strict';

// Standalone source parsers: only HTML/JSON/URL inputs, no network or rendering.
const parsing = require('./parsing');
const urls = require('./urls');

function parseInstagramOEmbed(text) {
    return parsing.normalizeOEmbedData(parsing.tryParseJson(text));
}

function parseInstagramGraphql(text, shortcode = '') {
    if (text.includes('require_login')) return null;
    const node = parsing.findMediaNode([parsing.tryParseJson(text)], shortcode);
    return parsing.normalizeMediaNode(node);
}

module.exports = {
    ...parsing,
    ...urls,
    parseInstagramOEmbed,
    parseInstagramGraphql,
};

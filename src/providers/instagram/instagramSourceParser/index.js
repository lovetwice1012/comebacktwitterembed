'use strict';

// Standalone source parsers: only HTML/JSON/URL inputs, no network or rendering.
const parsing = require('./parsing');
const urls = require('./urls');

function parseInstagramOEmbed(text) {
    return parsing.normalizeOEmbedData(parsing.tryParseJson(text));
}

function parseInstagramGraphql(text, shortcode = '') {
    return parseInstagramGraphqlSource(text, shortcode).data;
}

function parseInstagramGraphqlSource(text, shortcode = '') {
    if (text.includes('require_login')) return { data: null };
    const { node, data } = parsing.findAndNormalizeMedia([parsing.tryParseJson(text)], shortcode);
    if (data || !node) return { data };
    const source = parsing.sidecarNodes(node);
    return { data: null, incompleteMedia: true, expectedMediaCount: source.length,
        expectedVideoPositions: source.flatMap((media, index) => parsing.isVideoNode(media) ? [index] : []) };
}

module.exports = {
    ...parsing,
    ...urls,
    parseInstagramOEmbed,
    parseInstagramGraphql,
    parseInstagramGraphqlSource,
};

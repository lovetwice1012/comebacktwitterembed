'use strict';

const {
    cleanText,
    absoluteUrl,
    readMetaContent,
    extractAttr,
    readTitleTag,
    readFirstElementHtmlByAttr,
    readElementTextsByAttr,
    readFirstOpeningTagByAttr,
    readAttributeValues,
} = require('./html');
const {
    findJsonLdByType,
    DEFAULT_DESCRIPTION_MAX_LENGTH,
    firstArrayItem,
    formatNumber,
    imageFromValue,
    thingNames,
    yearFromDate,
    readGenericDescription,
    formatIsoDuration,
} = require('./metadata');
const { srcSetCandidates, sourceTypePriority, widthFromImageUrl } = require('./images');

function cleanPrimeVideoTitle(value) {
    return cleanText(value)
        .replace(/^Prime Video:\s*/i, '')
        .replace(/\s*-\s*Prime Video\s*$/i, '')
        .trim();
}

function primeVideoPictureBlocks(html) {
    const blocks = html.match(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi) || [];
    const preferred = blocks.filter(block => (
        /\bdata-testid\s*=\s*["']base-image["']/i.test(block)
        || /pv-target-images/i.test(block)
    ));
    return preferred.length > 0 ? preferred : blocks;
}

function readPrimeVideoPictureImage(html, baseUrl) {
    const candidates = [];
    let order = 0;
    for (const block of primeVideoPictureBlocks(html)) {
        const sourceTags = block.match(/<source\b[^>]*>/gi) || [];
        for (const tag of sourceTags) {
            const type = extractAttr(tag, 'type');
            const srcset = extractAttr(tag, 'srcset');
            candidates.push(...srcSetCandidates(srcset, baseUrl, sourceTypePriority(type), order));
            order += 100;
        }

        const imgTag = block.match(/<img\b[^>]*>/i)?.[0] || '';
        const imgUrl = absoluteUrl(extractAttr(imgTag, 'src'), baseUrl);
        if (imgUrl) {
            candidates.push({
                url: imgUrl,
                width: widthFromImageUrl(imgUrl),
                priority: sourceTypePriority(''),
                order,
            });
            order += 100;
        }
    }

    candidates.sort((a, b) => (
        a.priority - b.priority
        || b.width - a.width
        || a.order - b.order
    ));
    return candidates[0]?.url || '';
}

function readPrimeVideoPictureAlt(html) {
    for (const block of primeVideoPictureBlocks(html)) {
        const imgTag = block.match(/<img\b[^>]*>/i)?.[0] || '';
        const alt = cleanPrimeVideoTitle(extractAttr(imgTag, 'alt'));
        if (alt) return alt;
    }
    return '';
}

function uniqueTexts(values) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        const text = cleanText(value);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
    }
    return out;
}

function readPrimeVideoGenres(html) {
    const container = readFirstElementHtmlByAttr(html, 'data-testid', 'dv-node-dp-genres') || html;
    const genres = readElementTextsByAttr(container, 'data-testid', 'genre-texts');
    return uniqueTexts(genres).join(', ');
}

function readPrimeVideoCustomerRating(html) {
    const tag = readFirstOpeningTagByAttr(html, 'data-testid', 'star-rating-badge')
        || readFirstOpeningTagByAttr(html, 'data-automation-id', 'star-rating-badge');
    const aria = cleanText(extractAttr(tag, 'aria-label'));
    const body = cleanText(readFirstElementHtmlByAttr(html, 'data-testid', 'star-rating-badge'));
    const rating = aria.match(/5\u3064\u661f\u306e\u3046\u3061\s*([0-5](?:[.,]\d+)?)/)?.[1]
        || aria.match(/([0-5](?:[.,]\d+)?)\s*(?:out of|\/)\s*5/i)?.[1]
        || body.match(/([0-5](?:[.,]\d+)?)\s*\/\s*5/i)?.[1]
        || '';
    if (!rating) return '';

    const count = aria.match(/([\d,.]+)\s*(?:\u4eba|ratings?|reviews?)/i)?.[1] || '';
    return `Amazon ${rating.replace(',', '.')}/5${count ? ` (${count})` : ''}`;
}

function readPrimeVideoImdbRating(html) {
    const tag = readFirstOpeningTagByAttr(html, 'data-automation-id', 'imdb-rating-badge');
    const aria = cleanText(extractAttr(tag, 'aria-label'));
    const body = cleanText(readFirstElementHtmlByAttr(html, 'data-automation-id', 'imdb-rating-badge'));
    const text = body || aria;
    const rating = text.match(/IMDb[^0-9]*([0-9]+(?:[.,][0-9]+)?)(?:\s*\/\s*10)?/i)?.[1] || '';
    return rating ? `IMDb ${rating.replace(',', '.')}/10` : '';
}

function readPrimeVideoRating(html) {
    return [readPrimeVideoCustomerRating(html), readPrimeVideoImdbRating(html)]
        .filter(Boolean)
        .join(', ');
}

function readPrimeVideoReleaseYear(html) {
    const text = readElementTextsByAttr(html, 'data-automation-id', 'release-year-badge')[0]
        || readAttributeValues(html, 'aria-label').find(label => /(?:release year|\u516c\u958b\u5e74)/i.test(label))
        || '';
    return yearFromDate(text);
}

function readPrimeVideoSeason(html) {
    const label = readAttributeValues(html, 'aria-label')
        .find(value => /(?:seasons?|\u30b7\u30fc\u30ba\u30f3\u6570)/i.test(value) && /\d/.test(value));
    return cleanText(label || '');
}

function readPrimeVideoImage(html, node, baseUrl) {
    return absoluteUrl(
        imageFromValue(node?.image)
        || readPrimeVideoPictureImage(html, baseUrl)
        || readMetaContent(html, 'og:image')
        || readMetaContent(html, 'twitter:image'),
        baseUrl
    );
}

function formatList(value) {
    if (!Array.isArray(value)) return cleanText(value);
    return value.map(item => cleanText(item)).filter(Boolean).join(', ');
}

function seasonText(value) {
    const item = firstArrayItem(value);
    if (!item) return '';
    if (typeof item === 'string' || typeof item === 'number') return cleanText(item);
    if (typeof item !== 'object') return '';
    const name = cleanText(item.name || item.title || '');
    const number = cleanText(item.seasonNumber || item.position || '');
    if (name && number && !name.includes(number)) return `${name} (${number})`;
    return name || (number ? `Season ${number}` : '');
}

function formatAggregateRating(aggregateRating) {
    if (!aggregateRating || typeof aggregateRating !== 'object') return '';
    const rating = cleanText(aggregateRating.ratingValue || aggregateRating.rating || '');
    if (!rating) return '';
    const count = aggregateRating.reviewCount ?? aggregateRating.ratingCount;
    return count ? `${rating} (${formatNumber(count)})` : rating;
}

function extractPrimeVideoInfo(html, parsed, descriptionMaxLength = DEFAULT_DESCRIPTION_MAX_LENGTH) {
    const video = findJsonLdByType(
        html,
        ['Movie', 'TVSeries', 'TVSeason', 'TVEpisode', 'VideoObject', 'CreativeWork'],
        node => node.name && (node.image || node.genre || node.aggregateRating)
    ) || {};
    const title = cleanPrimeVideoTitle(
        video.name
        || video.headline
        || readPrimeVideoPictureAlt(html)
        || readMetaContent(html, 'og:title')
        || readMetaContent(html, 'twitter:title')
        || readTitleTag(html)
    );

    return {
        title,
        description: readGenericDescription(html, video, descriptionMaxLength),
        imageUrl: readPrimeVideoImage(html, video, parsed.canonicalUrl),
        genre: formatList(video.genre) || readPrimeVideoGenres(html),
        cast: thingNames(video.actor || video.actors || video.performer || video.contributor).join(', '),
        season: seasonText(video.partOfSeason || video.season || video.containsSeason) || readPrimeVideoSeason(html),
        rating: formatAggregateRating(video.aggregateRating) || readPrimeVideoRating(html),
        year: yearFromDate(video.datePublished || video.releasedEvent?.startDate || '') || readPrimeVideoReleaseYear(html),
        maturityRating: cleanText(video.contentRating || ''),
        duration: formatIsoDuration(video.duration || ''),
    };
}

module.exports = {
    extractPrimeVideoInfo,
};

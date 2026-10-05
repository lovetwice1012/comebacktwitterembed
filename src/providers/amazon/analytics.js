'use strict';

const { createProviderAnalytics, facet, finiteNumber } = require('../../analytics/providerMetrics');

function buildAmazonAnalytics(parsed, info) {
    return createProviderAnalytics({
        content: {
            accountKey: info.brand || info.artist || parsed.kind,
            contentId: parsed.id,
            contentType: parsed.kind || 'product',
            contentUrl: parsed.canonicalUrl,
            title: info.title,
            descriptionPreview: info.description,
            authorName: info.brand || info.artist || info.album,
            mediaCount: info.imageUrl ? 1 : null,
            durationSeconds: finiteNumber(info.duration, { kind: 'duration' }),
        },
        metrics: {
            price: finiteNumber(info.priceAmount),
            rating: finiteNumber(info.rating, { kind: 'rating' }),
            reviews: finiteNumber(info.reviewCount),
            duration_seconds: finiteNumber(info.duration, { kind: 'duration' }),
        },
        facets: [
            facet('brand', info.brand),
            facet('category', info.category || parsed.kind),
            facet('availability', info.availability),
            facet('artist', info.artist),
            facet('album', info.album),
            facet('genre', info.genre),
            facet('type', parsed.kind || 'product'),
        ],
    });
}

module.exports = {
    buildAmazonAnalytics,
};

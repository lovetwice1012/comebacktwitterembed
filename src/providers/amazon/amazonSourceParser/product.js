'use strict';

const {
    parseJsonSafely,
    cleanText,
    absoluteUrl,
    readMetaContent,
    truncate,
    extractAttr,
    readElementHtmlById,
    stripHtml,
    readElementTextById,
    readFirstElementTextById,
    readTitleTag,
} = require('./html');
const {
    findJsonLdByType,
    firstArrayItem,
    thingName,
    formatNumber,
    DEFAULT_DESCRIPTION_MAX_LENGTH,
    imageFromValue,
} = require('./metadata');
const { extractProductPrice, extractProductReferencePrice, formatProductPrice } = require('./prices');

function cleanAmazonTitle(value) {
    return cleanText(value)
        .replace(/^Amazon\.[^:]+:\s*/i, '')
        .replace(/\s*:\s*Amazon\.[^:]+(?:\s*:\s*.*)?$/i, '')
        .trim();
}

function findProductJsonLd(html) {
    return findJsonLdByType(html, ['Product'], node => node.name && (node.offers || node.image));
}

function brandName(value) {
    const item = firstArrayItem(value);
    if (!item) return '';
    if (typeof item === 'string') return cleanText(item);
    if (typeof item === 'object') return cleanText(item.name || item.brand || '');
    return '';
}

function offerFromValue(value) {
    const offer = firstArrayItem(value);
    if (!offer || typeof offer !== 'object') return {};
    const spec = firstArrayItem(offer.priceSpecification) || {};
    return {
        price: offer.price ?? offer.lowPrice ?? spec.price,
        currency: offer.priceCurrency ?? spec.priceCurrency,
        availability: offer.availability,
        seller: thingName(offer.seller || offer.offeredBy || offer.vendor),
        shipping: thingName(offer.shippingDetails)
            || thingName(offer.availableDeliveryMethod)
            || cleanText(offer.shippingDetails?.shippingRate?.value || ''),
    };
}

function availabilityText(value) {
    const raw = cleanText(value);
    if (!raw) return '';
    const tail = raw.split(/[/#]/).filter(Boolean).pop() || raw;
    return tail
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/_/g, ' ')
        .trim();
}

function reviewCountText(aggregateRating) {
    if (!aggregateRating || typeof aggregateRating !== 'object') return '';
    const count = aggregateRating.reviewCount ?? aggregateRating.ratingCount;
    return count === undefined || count === null || count === '' ? '' : formatNumber(count);
}

function formatRating(aggregateRating) {
    if (!aggregateRating || typeof aggregateRating !== 'object') return '';
    const rating = cleanText(aggregateRating.ratingValue || aggregateRating.rating || '');
    if (!rating) return '';
    const count = aggregateRating.reviewCount ?? aggregateRating.ratingCount;
    return count ? `${rating} / 5 (${formatNumber(count)})` : `${rating} / 5`;
}

function readLandingImage(html, baseUrl) {
    const tag = html.match(/<img\b(?=[^>]*\bid=["'](?:landingImage|imgBlkFront)["'])[^>]*>/i)?.[0] || '';
    const dynamic = extractAttr(tag, 'data-a-dynamic-image');
    const dynamicJson = dynamic ? parseJsonSafely(dynamic) : null;
    if (dynamicJson && typeof dynamicJson === 'object') {
        let bestUrl = '';
        let bestArea = -1;
        for (const [candidateUrl, dimensions] of Object.entries(dynamicJson)) {
            const width = Number(dimensions?.[0]) || 0;
            const height = Number(dimensions?.[1]) || 0;
            const area = width * height;
            if (area > bestArea) {
                bestArea = area;
                bestUrl = candidateUrl;
            }
        }
        if (bestUrl) return absoluteUrl(bestUrl, baseUrl);
    }

    return absoluteUrl(
        extractAttr(tag, 'data-old-hires') || extractAttr(tag, 'src'),
        baseUrl
    );
}

function readRatingFromHtml(html) {
    const ratingArea = readElementHtmlById(html, 'acrPopover') || html;
    const ratingMatch = stripHtml(ratingArea).match(/([0-5](?:\.\d+)?)\s+out of\s+5/i)
        || stripHtml(html).match(/([0-5](?:\.\d+)?)\s+out of\s+5/i);
    if (!ratingMatch) return '';

    const reviewText = readElementTextById(html, 'acrCustomerReviewText');
    const reviewMatch = reviewText.match(/[\d,.]+/);
    return reviewMatch ? `${ratingMatch[1]} / 5 (${reviewMatch[0]})` : `${ratingMatch[1]} / 5`;
}

function readReviewCountFromHtml(html) {
    const reviewText = readElementTextById(html, 'acrCustomerReviewText');
    const reviewMatch = reviewText.match(/[\d,.]+/);
    return reviewMatch ? reviewMatch[0] : '';
}

function normalizePromoText(value) {
    return cleanText(value)
        .replace(/\s+/g, ' ')
        .replace(/^Coupon:\s*/i, '')
        .replace(/^Deal:\s*/i, '')
        .trim();
}

function readCouponFromHtml(html) {
    return normalizePromoText(readFirstElementTextById(html, [
        'couponText',
        'couponBadge',
        'couponBadgeRegular',
        'couponApplyText',
    ]));
}

function readDealFromHtml(html) {
    return normalizePromoText(readFirstElementTextById(html, [
        'dealBadge',
        'dealBadge_feature_div',
        'dealprice_savings',
        'priceblock_savings',
        'priceSavingPercentage',
        'promoPriceBlockMessage',
    ]));
}

function extractProductInfo(html, parsed, descriptionMaxLength = DEFAULT_DESCRIPTION_MAX_LENGTH, locale = 'en-US') {
    const product = findProductJsonLd(html) || {};
    const offer = offerFromValue(product.offers);
    const price = extractProductPrice(html, offer, parsed);
    const referencePrice = extractProductReferencePrice(html, parsed);
    const baseUrl = parsed.canonicalUrl;
    const title = cleanAmazonTitle(
        product.name
        || readElementTextById(html, 'productTitle')
        || readMetaContent(html, 'og:title')
        || readTitleTag(html)
    );
    const description = truncate(
        cleanText(product.description || readMetaContent(html, 'og:description') || readMetaContent(html, 'description')),
        descriptionMaxLength
    );
    const imageUrl = absoluteUrl(
        imageFromValue(product.image)
        || readLandingImage(html, baseUrl)
        || readMetaContent(html, 'og:image')
        || readMetaContent(html, 'twitter:image'),
        baseUrl
    );

    return {
        title,
        description,
        imageUrl,
        price: formatProductPrice(price, locale),
        priceAmount: price?.amount ?? null,
        priceCurrency: price?.currency || '',
        referencePriceAmount: referencePrice && price && referencePrice.currency === price.currency ? referencePrice.amount : null,
        brand: brandName(product.brand) || cleanText(readElementTextById(html, 'bylineInfo')).replace(/^Brand:\s*/i, ''),
        seller: offer.seller,
        shipping: offer.shipping,
        rating: formatRating(product.aggregateRating) || readRatingFromHtml(html),
        reviewCount: reviewCountText(product.aggregateRating) || readReviewCountFromHtml(html),
        availability: availabilityText(offer.availability),
        coupon: readCouponFromHtml(html),
        deal: readDealFromHtml(html),
    };
}

module.exports = {
    extractProductInfo,
    readLandingImage,
};

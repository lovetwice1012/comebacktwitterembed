'use strict';

const crypto = require('crypto');

const ACCOUNT_FACET_SUFFIX = /\.(followers|subscribers|following|follower_count|subscriber_count)$/i;

function firstPresent(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null && value !== '') return String(value);
    }
    return null;
}

/** Keep this canonical identity in lockstep with dashboard/lib/metric-observation-query.ts. */
function metricObservationSubjectKey({ accountKey, facetKey, contentId, normalizedUrl, contentUrl, contentEventId }) {
    const key = String(facetKey || '');
    if (ACCOUNT_FACET_SUFFIX.test(key)) {
        return `account:${firstPresent(accountKey, `unknown:${contentEventId}`)}`;
    }
    return `content:${firstPresent(contentId, normalizedUrl, contentUrl, `unknown:${contentEventId}`)}`;
}

function metricObservationSubjectHash(subjectKey) {
    return crypto.createHash('sha256').update(String(subjectKey)).digest();
}

module.exports = { metricObservationSubjectKey, metricObservationSubjectHash, ACCOUNT_FACET_SUFFIX };

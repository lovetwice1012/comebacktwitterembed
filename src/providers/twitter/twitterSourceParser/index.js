'use strict';

// Parse upstream response text and distinguish inaccessible tweets from transient failures.
const EXPECTED_NON_EXPANDABLE_PATTERNS = [
    /nsfw/i,
    /sensitive/i,
    /age[-_\s]?restricted/i,
    /adult content/i,
    /login required/i,
    /log in/i,
    /sign in/i,
    /not available/i,
    /unavailable/i,
    /protected/i,
    /private/i,
    /deleted/i,
    /removed/i,
    /not found/i,
    /couldn['’]?t find/i,
    /does not exist/i,
    /doesn't exist/i,
    /suspended/i,
    /withheld/i,
    /閲覧できません/,
    /ログイン/,
    /年齢制限/,
    /センシティブ/,
    /非公開/,
    /削除/,
    /存在しません/,
    /凍結/,
];

const TRANSIENT_FAILURE_PATTERNS = [
    /rate limit/i,
    /too many requests/i,
    /temporary/i,
    /temporarily/i,
    /timeout/i,
    /timed out/i,
    /server error/i,
    /bad gateway/i,
    /service unavailable/i,
    /gateway timeout/i,
    /cloudflare/i,
    /maintenance/i,
    /over capacity/i,
];

class ExpectedNonExpandableTweetError extends Error {
    constructor(reason) {
        super(reason || 'Tweet is not expandable by design.');
        this.name = 'ExpectedNonExpandableTweetError';
        this.expectedNonExpandable = true;
    }
}

function isExpectedNonExpandableTweetError(err) {
    return err?.expectedNonExpandable === true;
}

function collectPayloadText(value, out = [], depth = 0) {
    if (out.length >= 40 || depth > 4) return out;
    if (typeof value === 'string' || typeof value === 'number') {
        out.push(String(value));
        return out;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectPayloadText(item, out, depth + 1);
        return out;
    }
    if (value && typeof value === 'object') {
        for (const item of Object.values(value)) collectPayloadText(item, out, depth + 1);
    }
    return out;
}

function looksLikeTransientFailure(text) {
    const sample = String(text || '').slice(0, 5000);
    return TRANSIENT_FAILURE_PATTERNS.some(pattern => pattern.test(sample));
}

function looksLikeExpectedNonExpandable(text) {
    const sample = String(text || '').slice(0, 5000);
    if (!sample || looksLikeTransientFailure(sample)) return false;
    return EXPECTED_NON_EXPANDABLE_PATTERNS.some(pattern => pattern.test(sample));
}

function hasTweetData(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    return !!(
        payload.tweetURL
        || payload.user_name
        || payload.user_screen_name
        || payload.date
        || Array.isArray(payload.mediaURLs)
        || payload.likes !== undefined
        || payload.retweets !== undefined
        || payload.replies !== undefined
        || payload.qrtURL
        || payload.article
    );
}

function getExpectedNonExpandableReason(payload) {
    if (hasTweetData(payload)) return null;
    const text = collectPayloadText(payload).join(' ');
    return looksLikeExpectedNonExpandable(text) ? text : null;
}

function parseTweetApiResponse(text) {
    try {
        const payload = JSON.parse(text);
        const expectedReason = getExpectedNonExpandableReason(payload);
        if (expectedReason) throw new ExpectedNonExpandableTweetError(expectedReason);
        if (!hasTweetData(payload)) throw new Error('Twitter API returned a payload without tweet data.');
        return payload;
    } catch (err) {
        if (isExpectedNonExpandableTweetError(err)) throw err;
        if (looksLikeExpectedNonExpandable(text)) {
            throw new ExpectedNonExpandableTweetError('Tweet is unavailable, private, age-restricted, or login-required.');
        }
        throw err;
    }
}

module.exports = {
    ExpectedNonExpandableTweetError,
    isExpectedNonExpandableTweetError,
    looksLikeExpectedNonExpandable,
    parseTweetApiResponse,
};

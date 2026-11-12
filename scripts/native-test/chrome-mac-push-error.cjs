'use strict';

// CI-only classification. Never return arbitrary server text or endpoint data.
function classifyPushError(error) {
    const status = Number.isInteger(error?.statusCode) && error.statusCode >= 100 && error.statusCode <= 599 ? String(error.statusCode) : 'UNKNOWN';
    const body = typeof error?.body === 'string' && error.body.length <= 32768 ? error.body : '';
    let category = 'OTHER';
    if (/\bunregistered\b|\bnot.registered\b/i.test(body)) category = 'UNREGISTERED';
    else if (/\binvalid.registration\b|\binvalid.token\b/i.test(body)) category = 'INVALID_TOKEN';
    else if (/\bexpired\b|\bexpiration\b/i.test(body)) category = 'EXPIRED';
    else if (/\bnot.found\b/i.test(body)) category = 'NOT_FOUND';
    return `${status}_${category}`;
}

// Only fixed labels and bounded numeric values leave the synthetic fixture.
// In particular, never interpolate the error, response body, or endpoint.
function formatSuppressedPushFailure(error, sinceSubscriptionMs, durationMs) {
    const elapsed = value => Number.isSafeInteger(value) && value >= 0 && value <= 3600000 ? value : 'unknown';
    return `synthetic Brave send stage=suppressed result=${classifyPushError(error)} sinceSubscriptionMs=${elapsed(sinceSubscriptionMs)} durationMs=${elapsed(durationMs)}`;
}
module.exports = { classifyPushError, formatSuppressedPushFailure };

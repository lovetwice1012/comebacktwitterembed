'use strict';

// Diagnostic only. Compare the first send of a fresh subscription with the
// first send of a second fresh subscription after a fixed delay. A 410 on the
// first send remains a failure, even if a later diagnostic send is accepted.
const { classifyPushError } = require('./chrome-mac-push-error.cjs');
async function compareFreshSubscriptions({ subscribe, send, sleep, elapsedMs, report, verifyPair, delayMs = 5000 }) {
    if ([subscribe, send, sleep, elapsedMs, report].some(value => typeof value !== 'function')
        || verifyPair !== undefined && typeof verifyPair !== 'function'
        || !Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > 10000) throw new Error('FIXTURE_PAIR_CONFIG_INVALID');
    const readTime = () => {
        const value = elapsedMs();
        if (!Number.isSafeInteger(value) || value < 0 || value > 300000) throw new Error('FIXTURE_PAIR_TIME_INVALID');
        return value;
    };
    async function attempt(subscription, label, createdAt) {
        const sinceSubscriptionMs = readTime() - createdAt;
        if (sinceSubscriptionMs < 0) throw new Error('FIXTURE_PAIR_TIME_INVALID');
        const started = readTime(); let result = 'accepted';
        try { await send(subscription, label); } catch (error) { result = classifyPushError(error); }
        const durationMs = readTime() - started;
        if (durationMs < 0) throw new Error('FIXTURE_PAIR_TIME_INVALID');
        report({ label, sinceSubscriptionMs, durationMs, result });
        return result;
    }
    const first = await subscribe('immediate'), firstAt = readTime();
    const firstResult = await attempt(first, 'immediate', firstAt);
    const second = await subscribe('delayed'), secondAt = readTime();
    if (verifyPair) await verifyPair(first, second);
    const remaining = delayMs - (readTime() - secondAt);
    if (remaining > 0) await sleep(remaining);
    if (readTime() - secondAt < delayMs) throw new Error('FIXTURE_PAIR_DELAY_INVALID');
    const secondResult = await attempt(second, 'delayed', secondAt);
    const retryResult = firstResult.startsWith('410_') ? await attempt(first, 'retry', firstAt) : 'not_attempted';
    return Object.freeze({ firstResult, secondResult, retryResult,
        initialFailure: firstResult !== 'accepted' || secondResult !== 'accepted' });
}
// Avoid implying delivery for a request the provider did not accept. Results
// come from the fixed classifier above; arbitrary response text is never used.
function deliveryObservation(result, observed) {
    if (result === 'not_attempted') return 'not_attempted';
    if (result !== 'accepted') return 'not_accepted';
    return observed === true ? 'observed' : 'not_observed';
}
module.exports = { compareFreshSubscriptions, deliveryObservation };

'use strict';

// Diagnostic for fresh, disposable subscriptions only. A retry is allowed
// only after an explicit 410, and must stop after the first accepted request.
// It must never be used as a production delivery policy.
const { classifyPushError } = require('./chrome-mac-push-error.cjs');
async function probeAfterGone({ send, sleep, elapsedMs, report, delays = [0, 250, 750, 3000, 1000] }) {
    if (typeof send !== 'function' || typeof sleep !== 'function' || typeof elapsedMs !== 'function' || typeof report !== 'function'
        || !Array.isArray(delays) || delays.length > 5 || delays.some(ms => !Number.isSafeInteger(ms) || ms < 0 || ms > 3000))
        throw new Error('FIXTURE_PROBE_INVALID');
    let count = 0;
    for (const wait of delays) {
        if (wait) await sleep(wait);
        const start = elapsedMs();
        try {
            await send(); count++;
            report({ attempt: count, sinceSubscriptionMs: start, durationMs: elapsedMs() - start, result: 'accepted' });
            return { accepted: true, attempts: count };
        } catch (error) {
            count++;
            const category = classifyPushError(error);
            report({ attempt: count, sinceSubscriptionMs: start, durationMs: elapsedMs() - start, result: category });
            if (!category.startsWith('410_')) return { accepted: false, attempts: count, stopped: 'non_410' };
        }
    }
    return { accepted: false, attempts: count, stopped: 'all_410' };
}
module.exports = { probeAfterGone };

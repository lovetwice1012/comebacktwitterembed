'use strict';

// For a fresh disposable subscription's first baseline only. A 410 permits
// bounded diagnostic retries of the same caller-supplied message; success is
// reported separately from the original failure and is never used for trials.
const { classifyPushError } = require('./chrome-mac-push-error.cjs');
const { probeAfterGone } = require('./chrome-mac-push-probe.cjs');
async function sendSyntheticBaseline({ send, sleep, elapsedMs, report }) {
    if (typeof send !== 'function' || typeof sleep !== 'function' || typeof elapsedMs !== 'function' || typeof report !== 'function')
        throw new Error('FIXTURE_BASELINE_CONFIG_INVALID');
    try {
        await send(); report({ phase: 'initial', result: 'accepted' });
        return { initialFailed: false };
    } catch (error) {
        const result = classifyPushError(error); report({ phase: 'initial', result });
        if (!result.startsWith('410_')) throw new Error('FIXTURE_BASELINE_SEND_FAILED');
        const retry = await probeAfterGone({ send, sleep, elapsedMs, report: event => report({ phase: 'retry', ...event }) });
        if (!retry.accepted) throw new Error('FIXTURE_BASELINE_RETRY_FAILED');
        return { initialFailed: true };
    }
}
module.exports = { sendSyntheticBaseline };

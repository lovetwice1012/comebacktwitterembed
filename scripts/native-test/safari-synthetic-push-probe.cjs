'use strict';

// CI-only sender for a freshly created synthetic Safari subscription. It is
// not a production notifier, never receives X data and never logs endpoint,
// keys or payload. Safari itself must display a notification for each push.
const fault = code => Object.assign(new Error(code), { code });

function isApplePushEndpoint(value) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 4096) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
            && /^(?:[a-z0-9-]+\.)+push\.apple\.com$/.test(url.hostname);
    } catch { return false; }
}

async function sendHostedSafariFixturePush({ subscription, publicKey, privateKey, marker }) {
    // A caller cannot substitute platform or environment for this network call.
    if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true'
        || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.CBTE_SAFARI_PUSH_HOSTED !== '1'
        || process.env.CBTE_SAFARI_SYNTHETIC_PUSH_PROBE !== '1') throw fault('FIXTURE_SAFARI_PUSH_ENVIRONMENT_INVALID');
    if (!subscription || !isApplePushEndpoint(subscription.endpoint) || !subscription.keys
        || typeof subscription.keys.p256dh !== 'string' || typeof subscription.keys.auth !== 'string'
        || !Buffer.isBuffer(publicKey) || publicKey.length !== 65 || !Buffer.isBuffer(privateKey) || privateKey.length !== 32
        || typeof marker !== 'string' || !/^fixture-[a-f0-9]{32}$/.test(marker)) throw fault('FIXTURE_SAFARI_PUSH_INPUT_INVALID');
    try {
        const push = require('web-push');
        push.setVapidDetails('mailto:fixture@example.com', publicKey.toString('base64url'), privateKey.toString('base64url'));
        await push.sendNotification(subscription, marker, { TTL: 60, timeout: 15000 });
    } catch { throw fault('FIXTURE_SAFARI_PUSH_SEND_FAILED'); }
}
module.exports = { isApplePushEndpoint, sendHostedSafariFixturePush };

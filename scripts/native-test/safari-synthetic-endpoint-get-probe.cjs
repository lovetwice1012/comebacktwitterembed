'use strict';

// Synthetic hosted-CI diagnostic only. The Web Push endpoint and VAPID
// material are never logged. A response alone does not prove push receipt.
const { isApplePushEndpoint } = require('./safari-synthetic-push-probe.cjs');
const fault = code => Object.assign(new Error(code), { code });

function summarize(status) {
    return Number.isInteger(status) && status >= 100 && status <= 599
        ? { state: 'response', status } : { state: 'invalid_response' };
}

// Kept separate for synthetic tests; production paths do not import this file.
function requestWith(factory, endpoint, authorization, timeoutMs = 8000) {
    if (typeof factory !== 'function' || !isApplePushEndpoint(endpoint)
        || authorization !== undefined && (typeof authorization !== 'string' || !authorization.startsWith('vapid '))
        || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) throw fault('FIXTURE_SAFARI_GET_INPUT_INVALID');
    const url = new URL(endpoint);
    return new Promise(resolve => {
        let session, stream, done = false;
        const finish = result => {
            if (done) return;
            done = true; clearTimeout(timer);
            try { stream?.destroy(); } catch {}
            try { session?.destroy(); } catch {}
            resolve(result);
        };
        const timer = setTimeout(() => finish({ state: 'timeout' }), timeoutMs);
        try {
            // No redirect is followed and no response headers or bytes are
            // stored or printed; the URL is used only for this request.
            session = factory(url.origin);
            session.on('error', () => finish({ state: 'transport_error' }));
            stream = session.request({ ':method': 'GET', ':path': url.pathname + url.search,
                ...(authorization ? { authorization } : {}) });
            stream.on('error', () => finish({ state: 'transport_error' }));
            stream.once('response', headers => finish(summarize(headers[':status'])));
            stream.once('end', () => finish({ state: 'ended_without_status' }));
            stream.end();
        } catch { finish({ state: 'transport_error' }); }
    });
}

async function probeHostedSyntheticEndpoint({ subscription, publicKey, privateKey }) {
    if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true'
        || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.CBTE_SAFARI_PUSH_HOSTED !== '1'
        || process.env.CBTE_SAFARI_SYNTHETIC_GET_PROBE !== '1') throw fault('FIXTURE_SAFARI_GET_ENVIRONMENT_INVALID');
    if (!subscription || !isApplePushEndpoint(subscription.endpoint) || !Buffer.isBuffer(publicKey) || publicKey.length !== 65
        || !Buffer.isBuffer(privateKey) || privateKey.length !== 32) throw fault('FIXTURE_SAFARI_GET_INPUT_INVALID');
    const url = new URL(subscription.endpoint), push = require('web-push');
    let auth;
    try {
        auth = push.getVapidHeaders(url.origin, 'mailto:fixture@example.com', publicKey.toString('base64url'),
            privateKey.toString('base64url'), 'aes128gcm').Authorization;
    } catch { throw fault('FIXTURE_SAFARI_GET_AUTH_INVALID'); }
    const connect = require('node:http2').connect;
    const anonymous = await requestWith(connect, subscription.endpoint, undefined);
    const senderAuthorized = await requestWith(connect, subscription.endpoint, auth);
    return { anonymous, senderAuthorized };
}
module.exports = { summarize, requestWith, probeHostedSyntheticEndpoint };

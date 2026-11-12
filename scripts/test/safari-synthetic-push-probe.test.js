'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isApplePushEndpoint, sendHostedSafariFixturePush } = require('../native-test/safari-synthetic-push-probe.cjs');

test('synthetic push sender accepts only HTTPS Apple push subdomains', () => {
    assert.equal(isApplePushEndpoint('https://web.push.apple.com/fixture'), true);
    for (const value of ['http://web.push.apple.com/', 'https://push.apple.com/', 'https://web.push.apple.com.example.com/',
        'https://example.com/', 'https://user@web.push.apple.com/', 'https://web.push.apple.com:444/',
        'https://web.push.apple.com/#secret', 'x'.repeat(4097)]) assert.equal(isApplePushEndpoint(value), false);
});
test('the real network sender cannot be invoked from an ordinary non-hosted process', async () => {
    if (process.platform === 'darwin' && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted'
        && process.env.CBTE_SAFARI_PUSH_HOSTED === '1' && process.env.CBTE_SAFARI_SYNTHETIC_PUSH_PROBE === '1') return;
    await assert.rejects(sendHostedSafariFixturePush({}), { code: 'FIXTURE_SAFARI_PUSH_ENVIRONMENT_INVALID' });
});

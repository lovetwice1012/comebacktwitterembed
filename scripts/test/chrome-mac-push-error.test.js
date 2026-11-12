'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyPushError, formatSuppressedPushFailure } = require('../native-test/chrome-mac-push-error.cjs');

test('synthetic push error classification does not return server text or endpoint', () => {
    assert.equal(classifyPushError({ statusCode: 410, body: 'UNREGISTERED secret-example' }), '410_UNREGISTERED');
    assert.equal(classifyPushError({ statusCode: 410, body: 'invalid registration secret-example' }), '410_INVALID_TOKEN');
    assert.equal(classifyPushError({ statusCode: 410, body: 'expired secret-example' }), '410_EXPIRED');
    assert.equal(classifyPushError({ statusCode: 410, body: 'not found secret-example' }), '410_NOT_FOUND');
    assert.equal(classifyPushError({ statusCode: 410, body: 'secret-example', endpoint: 'secret-example' }), '410_OTHER');
    assert.equal(classifyPushError({ statusCode: 1000, body: 'expired'.repeat(10000) }), 'UNKNOWN_OTHER');
});

test('suppressed-send diagnostics contain only a fixed stage, category and bounded times', () => {
    const error = { statusCode: 410, body: 'expired secret-example', endpoint: 'secret-example', message: 'secret-example' };
    assert.equal(formatSuppressedPushFailure(error, 123, 45),
        'synthetic Brave send stage=suppressed result=410_EXPIRED sinceSubscriptionMs=123 durationMs=45');
    const other = formatSuppressedPushFailure({ statusCode: 'secret-example', body: 'secret-example' }, 'secret-example', -1);
    assert.equal(other, 'synthetic Brave send stage=suppressed result=UNKNOWN_OTHER sinceSubscriptionMs=unknown durationMs=unknown');
    assert.equal(other.includes('secret-example'), false);
});

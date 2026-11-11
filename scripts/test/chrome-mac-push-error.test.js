'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyPushError } = require('../native-test/chrome-mac-push-error.cjs');

test('synthetic push error classification does not return server text or endpoint', () => {
    assert.equal(classifyPushError({ statusCode: 410, body: 'UNREGISTERED secret-example' }), '410_UNREGISTERED');
    assert.equal(classifyPushError({ statusCode: 410, body: 'invalid registration secret-example' }), '410_INVALID_TOKEN');
    assert.equal(classifyPushError({ statusCode: 410, body: 'expired secret-example' }), '410_EXPIRED');
    assert.equal(classifyPushError({ statusCode: 410, body: 'not found secret-example' }), '410_NOT_FOUND');
    assert.equal(classifyPushError({ statusCode: 410, body: 'secret-example', endpoint: 'secret-example' }), '410_OTHER');
    assert.equal(classifyPushError({ statusCode: 1000, body: 'expired'.repeat(10000) }), 'UNKNOWN_OTHER');
});

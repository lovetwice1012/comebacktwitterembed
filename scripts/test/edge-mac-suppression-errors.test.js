'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixtureFailure, safeFixtureSend } = require('../native-test/edge-mac-suppression-errors.cjs');
test('fixture send and stages never expose external error fields', async () => {
    const error = Object.assign(new Error('SECRET_MESSAGE'), { endpoint: 'SECRET_ENDPOINT', body: 'SECRET_BODY', headers: { authorization: 'SECRET_HEADER' } });
    try { await safeFixtureSend(async () => { throw error; }); assert.fail('expected failure'); }
    catch (result) {
        assert.equal(result.message, 'FIXTURE_SUPPRESSION_SEND_FAILED');
        assert.equal(/SECRET/.test(String(result.stack) + JSON.stringify(result)), false);
    }
    assert.equal(fixtureFailure('SECRET_STAGE').message, 'FIXTURE_SUPPRESSION_UNKNOWN_FAILED');
});

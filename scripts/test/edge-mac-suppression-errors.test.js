'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixtureFailure, safeFixtureSend, sendCategory, freezeObserved } = require('../native-test/edge-mac-suppression-errors.cjs');
test('fixture send and stages never expose external error fields', async () => {
    const error = Object.assign(new Error('SECRET_MESSAGE'), { endpoint: 'SECRET_ENDPOINT', body: 'SECRET_BODY', headers: { authorization: 'SECRET_HEADER' } });
    try { await safeFixtureSend(async () => { throw error; }); assert.fail('expected failure'); }
    catch (result) {
        assert.equal(result.message, 'FIXTURE_SUPPRESSION_SEND_FAILED');
        assert.equal(/SECRET/.test(String(result.stack) + JSON.stringify(result)), false);
    }
    assert.equal(fixtureFailure('SECRET_STAGE').message, 'FIXTURE_SUPPRESSION_UNKNOWN_FAILED');
    try { await safeFixtureSend(async () => { throw Object.assign(new Error('SECRET'), { statusCode: 410 }); }); assert.fail('expected failure'); }
    catch (result) { assert.equal(result.category, 'HTTP_410'); assert.equal(/SECRET/.test(String(result.stack) + JSON.stringify(result)), false); }
    try { await safeFixtureSend(async () => { throw Object.defineProperty({}, 'statusCode', { get() { throw new Error('SECRET_GETTER'); } }); }); assert.fail('expected failure'); }
    catch (result) { assert.equal(result.category, 'OTHER'); assert.equal(/SECRET/.test(String(result.stack) + JSON.stringify(result)), false); }
    assert.equal(sendCategory(Object.defineProperty({}, 'category', { get() { throw new Error('SECRET_GETTER'); } })), 'OTHER');
    assert.equal(sendCategory({ category: 'SECRET_VALUE' }), 'OTHER');
    assert.equal(sendCategory({ category: 'HTTP_410' }), 'HTTP_410');
    const response = { statusCode: 201, headers: { 'x-wns-deviceconnectionstatus': 'disconnected', 'x-wns-status': 'received',
        authorization: 'SECRET_HEADER' }, body: 'SECRET_BODY' };
    assert.equal(await safeFixtureSend(async () => response), 'H201-DDISCONNECTED-WRECEIVED');
    assert.equal(await safeFixtureSend(async () => Object.defineProperty({}, 'headers', { get() { throw new Error('SECRET_GETTER'); } })), 'HUNKNOWN-DOTHER-WOTHER');
});
test('late observer arrival cannot change the frozen baseline result', () => {
    const seen = new Set(), result = freezeObserved(seen, 'synthetic');
    seen.add('synthetic'); assert.equal(result, false); assert.equal(freezeObserved(seen, 'synthetic'), true);
});

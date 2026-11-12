'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyCodesign } = require('../native-test/brave-mac-install-diagnostic.cjs');
test('Brave signature diagnostic emits fixed categories without raw output', () => {
    assert.equal(classifyCodesign({ status: 0, stderr: 'sensitive-output' }), 'valid');
    assert.equal(classifyCodesign({ status: 1, stderr: 'sensitive-output' }), 'rejected');
    assert.equal(classifyCodesign({ status: null, error: { code: 'ETIMEDOUT', message: 'sensitive-output' } }), 'timeout');
    assert.equal(classifyCodesign({ status: null, error: { code: 'ENOENT', message: 'sensitive-output' } }), 'unavailable');
});

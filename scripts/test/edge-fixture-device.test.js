'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { replaceSyntheticKey } = require('../../experiments/chrome-push/edge-fixture-device.cjs');

test('synthetic key mutation changes exactly one uniquely located 32-byte key', () => {
    const key = Buffer.alloc(32, 7).toString('base64'), original = Buffer.from(`prefix:${key}:suffix`);
    const result = replaceSyntheticKey(original, Buffer.from(key));
    assert.notEqual(result.key.toString(), key);
    assert.equal(Buffer.from(result.key.toString(), 'base64').length, 32);
    assert.equal(result.record.toString(), `prefix:${result.key}:suffix`);
    assert.equal(original.toString(), `prefix:${key}:suffix`);
    assert.throws(() => replaceSyntheticKey(Buffer.from(key + key), Buffer.from(key)), /PROBE_DEVICE_AMBIGUOUS/);
    assert.throws(() => replaceSyntheticKey(original, Buffer.from('invalid')), /PROBE_DEVICE_INVALID/);
    result.key.fill(0); result.record.fill(0);
});

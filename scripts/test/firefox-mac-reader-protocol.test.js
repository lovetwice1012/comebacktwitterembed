'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encodeMacFirefoxReaderInput } = require('../../src/automation/firefox-mac-reader-protocol');

function fixture() {
    return { snapshotPath: '/tmp/日本語/通知', resultPath: '/tmp/日本語/result.json', readerPath: '/app/Read-PushSubscription.js',
        readerSha256: 'a'.repeat(64), uaid: '22222222-2222-4222-8222-222222222222', browserVersion: '160.0' };
}
test('reader stdin uses bounded ASCII chunks and round-trips Unicode paths', () => {
    const input = fixture(); input.snapshotPath += '/あ'.repeat(400);
    const bytes = encodeMacFirefoxReaderInput(input), lines = bytes.toString('ascii').trimEnd().split('\n');
    assert.equal(Number(lines.shift()), lines.length); assert(lines.length > 1);
    assert(lines.every(line => /^[A-Za-z0-9+/=]{1,512}$/.test(line)));
    assert.deepEqual(JSON.parse(Buffer.from(lines.join(''), 'base64').toString('utf8')), input);
    bytes.fill(0);
});
test('reader stdin rejects unknown fields, getters, malformed values and oversized paths', () => {
    for (const value of [
        { ...fixture(), unexpected: true }, { ...fixture(), uaid: 'bad' }, { ...fixture(), readerSha256: 'A'.repeat(64) },
        { ...fixture(), snapshotPath: 'relative' }, { ...fixture(), resultPath: '/tmp/\nother' },
        { ...fixture(), browserVersion: '160.0\nother' }, { ...fixture(), readerPath: '/' + 'a'.repeat(4097) },
        Object.defineProperty(fixture(), 'uaid', { enumerable: true, get() { throw new Error('getter must not run'); } }),
    ]) assert.throws(() => encodeMacFirefoxReaderInput(value), { code: 'X_FIREFOX_MAC_READER_INPUT_INVALID' });
});

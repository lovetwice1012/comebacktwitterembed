'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyName, plausibleHeader } = require('../native-test/edge-mac-store-classifier.cjs');

test('synthetic store filenames are reduced to fixed categories', () => {
    for (const [name, expected] of [['LOCK', 'lock'], ['CURRENT', 'current'], ['MANIFEST-001', 'manifest'],
        ['LOG', 'diagnosticLog'], ['LOG.old', 'diagnosticLog'], ['000003.log', 'journal'], ['000004.ldb', 'table'], ['private-name', 'other']])
        assert.equal(classifyName(name, true), expected);
    assert.equal(classifyName('LOCK', false), 'other');
});
test('header checks expose only fixed categories, never payload bytes', () => {
    assert.equal(plausibleHeader('current', Buffer.from('MANIFEST-000001\n'), 16), 'plausible');
    assert.equal(plausibleHeader('current', Buffer.from('private'), 7), 'unrecognized');
    const malformed = Buffer.from('MANIFEST-000001\n'); malformed[0] |= 0x80;
    assert.equal(plausibleHeader('current', malformed, malformed.length), 'unrecognized');
    const highNewline = Buffer.from('MANIFEST-000001\n'); highNewline[highNewline.length - 1] |= 0x80;
    assert.equal(plausibleHeader('current', highNewline, highNewline.length), 'unrecognized');
    const maxCurrent = Buffer.from(`MANIFEST-${'1'.repeat(118)}\n`);
    assert.equal(maxCurrent.length, 128);
    assert.equal(plausibleHeader('current', maxCurrent, maxCurrent.length), 'plausible');
    assert.equal(plausibleHeader('current', maxCurrent, 129), 'unrecognized');
    assert.equal(plausibleHeader('current', Buffer.alloc(0), 0), 'empty');
    assert.equal(plausibleHeader('current', Buffer.alloc(1), 0), 'unavailable');
    assert.equal(plausibleHeader('diagnosticLog', Buffer.from('2026/11/12-13:14:15.123456 synthetic'), 36), 'plausible');
    const malformedLog = Buffer.from('2026/11/12-13:14:15.123456 synthetic'); malformedLog[0] |= 0x80;
    assert.equal(plausibleHeader('diagnosticLog', malformedLog, malformedLog.length), 'unrecognized');
    const journal = Buffer.from([0, 0, 0, 0, 2, 0, 1, 65, 66]);
    assert.equal(plausibleHeader('journal', journal, journal.length), 'plausible');
    assert.equal(plausibleHeader('journal', journal.subarray(0, 6), journal.length), 'unrecognized');
    assert.equal(plausibleHeader('journal', Buffer.alloc(0), 0), 'empty');
    assert.equal(plausibleHeader('other', Buffer.from('secret'), 6), 'unavailable');
});

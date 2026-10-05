'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { outputText } = require('../../src/automation/engine');
const { NODE_TYPES } = require('../../src/automation/schema');
const { DictionaryMatcher } = require('../../src/automation/dictionary');
test('runtime replacement expansion is bounded before allocation and replacement tokens remain literal', () => {
    const display = { ...NODE_TYPES.transform.defaults, format: 'text', template: 'a', replacements: Array.from({ length: 8 }, () => ({ from: 'a', to: 'a'.repeat(128) })) };
    assert.throws(() => outputText(display, {}), { code: 'AUTOMATION_TEXT_LIMIT' });
    assert.equal(outputText({ ...display, template: 'x{x}', replacements: [{ from: 'x', to: '$&$$$1' }] }, { x: 'z' }), '$&$$$1z');
    assert.throws(() => outputText({ ...display, template: '{body}'.repeat(100), replacements: [] }, { body: 'x'.repeat(65536) }), { code: 'AUTOMATION_TEXT_LIMIT' });
});
test('word boundaries respect supplementary Unicode letters and combining marks', () => {
    const matcher = new DictionaryMatcher({ schemaVersion: 1, name: 'benign marker', mode: 'word', entries: ['AUDIT_SENTINEL'] });
    assert.equal(matcher.match('𐐀AUDIT_SENTINEL').length, 0);
    assert.equal(matcher.match('AUDIT_SENTINEL𐐀').length, 0);
    assert.equal(matcher.match('AUDIT_SENTINEL\u0345').length, 0);
    assert.equal(matcher.match('😀AUDIT_SENTINEL😀').length, 1);
});

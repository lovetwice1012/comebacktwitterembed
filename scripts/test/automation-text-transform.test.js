'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { outputText } = require('../../src/automation/engine');
const { NODE_TYPES } = require('../../src/automation/schema');
const { DictionaryMatcher } = require('../../src/automation/dictionary');
test('normal expansion keeps a complete source URL through long titles and custom text transforms', () => {
    const url = 'https://www.youtube.com/watch?v=example1234';
    const display = { ...NODE_TYPES.transform.defaults, format: 'normal' };
    const text = outputText(display, { title: '長'.repeat(5000), url });
    assert.ok(text.endsWith(`\n${url}`));
    assert.equal(text.length, display.maxLength);
    const custom = { ...display, template: '{title}', replacements: [{ from: '投稿', to: 'カスタム文' }], prefix: '前: ', suffix: ' :後' };
    assert.equal(outputText(custom, { title: '投稿', url }), `前: カスタム文 :後\n${url}`);
    assert.equal(outputText({ ...display, replacements: [{ from: url, to: '' }] }, { title: '投稿', url }), `投稿\n${url}`);
    for (const template of ['<{url}>', '||{url}||']) assert.ok(outputText({ ...display, template }, { url }).endsWith(`\n${url}`));
});
test('normal URL retention respects short limits, Discord bounds and Unicode character boundaries', () => {
    const url = 'https://youtu.be/example1234';
    const display = { ...NODE_TYPES.transform.defaults, format: 'normal' };
    assert.equal(outputText({ ...display, maxLength: url.length + 2 }, { title: '😀投稿', url }), url);
    assert.equal(outputText({ ...display, maxLength: url.length + 3 }, { title: '😀投稿', url }), `😀\n${url}`);
    assert.equal(outputText({ ...display, maxLength: url.length }, { title: '投稿', url }), url);
    assert.throws(() => outputText({ ...display, maxLength: url.length - 1 }, { title: '投稿', url }), { code: 'AUTOMATION_TEXT_LIMIT' });
    assert.throws(() => outputText(display, { url: `https://example.test/${'x'.repeat(1900)}` }), { code: 'AUTOMATION_TEXT_LIMIT' });
    const direct = outputText({ ...display, format: 'expanded', maxLength: 3 }, { title: 'AB😀', url });
    assert.equal(direct, 'AB');
});
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

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { t, getStringFromObject } = require('../../src/locales');

test('getStringFromObject: returns matching locale', () => {
    const obj = { ja: 'やあ', en: 'hi' };
    assert.equal(getStringFromObject(obj, 'ja'), 'やあ');
    assert.equal(getStringFromObject(obj, 'en'), 'hi');
});

test('getStringFromObject: falls back to en when missing', () => {
    const obj = { en: 'hi' };
    assert.equal(getStringFromObject(obj, 'ja'), 'hi');
});

test('getStringFromObject: defaultJa flag prefers ja over en', () => {
    const obj = { ja: 'やあ', en: 'hi' };
    assert.equal(getStringFromObject(obj, 'fr', true), 'やあ');
});

test('t: returns string for known key', () => {
    const v = t('userMustSpecifyAnyWordLocales', 'ja');
    assert.equal(typeof v, 'string');
    assert.ok(v.length > 0);
});

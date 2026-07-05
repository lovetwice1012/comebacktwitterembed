'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    ifUserHasRole,
    convertBoolToEnableDisable,
    cleanMessageContent,
    extractTwitterUrls,
    conv_en_to_en_US,
    discordErrorCode,
    isUnknownMessageError,
    isUnknownInteractionError,
    isInteractionAlreadyAcknowledgedError,
    isIgnorableInteractionAckError,
    isMissingPermissionsError,
    isOnlyUrlMessageContent,
} = require('../../src/utils');

test('convertBoolToEnableDisable: ja true', () => {
    assert.equal(convertBoolToEnableDisable(true, 'ja'), '有効');
});

test('convertBoolToEnableDisable: ja false', () => {
    assert.equal(convertBoolToEnableDisable(false, 'ja'), '無効');
});

test('convertBoolToEnableDisable: en fallback', () => {
    assert.equal(convertBoolToEnableDisable(true, 'en'), 'Enabled');
    assert.equal(convertBoolToEnableDisable(false, 'en-US'), 'Disabled');
});

test('extractTwitterUrls: extracts twitter.com and x.com', () => {
    const urls = extractTwitterUrls('check https://twitter.com/foo/status/1 and https://x.com/bar/status/2');
    assert.deepEqual(urls, [
        'https://twitter.com/foo/status/1',
        'https://x.com/bar/status/2',
    ]);
});

test('extractTwitterUrls: returns empty array when none', () => {
    assert.deepEqual(extractTwitterUrls('no link here'), []);
});

test('cleanMessageContent: strips angle-bracketed and spoiler-wrapped twitter URLs', () => {
    const cleaned = cleanMessageContent('a <https://twitter.com/x/status/1> b ||https://x.com/y/status/2|| c');
    assert.equal(cleaned, 'a  b  c');
});

test('cleanMessageContent: leaves bare urls intact', () => {
    const cleaned = cleanMessageContent('hello https://twitter.com/abc world');
    assert.equal(cleaned, 'hello https://twitter.com/abc world');
});

test('isOnlyUrlMessageContent: accepts whitespace and Discord URL decorations', () => {
    const url = 'https://twitter.com/foo/status/1';
    assert.equal(isOnlyUrlMessageContent(`\n ${url} \n`, url), true);
    assert.equal(isOnlyUrlMessageContent(`<${url}>`, url), true);
    assert.equal(isOnlyUrlMessageContent(`||${url}||`, url), true);
    assert.equal(isOnlyUrlMessageContent(`look ${url}`, url), false);
});

test('ifUserHasRole: accepts a role list or a single role id', () => {
    const member = { roles: { cache: new Map([['role-1', { id: 'role-1' }]]) } };
    assert.equal(ifUserHasRole(member, ['role-1', 'role-2']), true);
    assert.equal(ifUserHasRole(member, 'role-1'), true);
    assert.equal(ifUserHasRole(member, 'role'), false);
    assert.equal(ifUserHasRole(member, []), false);
});

test('conv_en_to_en_US: renames en to en-US', () => {
    assert.deepEqual(
        conv_en_to_en_US({ en: 'hi', ja: 'やあ' }),
        { ja: 'やあ', 'en-US': 'hi' },
    );
});

test('conv_en_to_en_US: returns undefined when en missing', () => {
    assert.equal(conv_en_to_en_US(null), undefined);
    assert.equal(conv_en_to_en_US({ ja: 'やあ' }), undefined);
});

test('isUnknownMessageError: matches code 10008 in either shape', () => {
    assert.equal(isUnknownMessageError({ code: 10008 }), true);
    assert.equal(isUnknownMessageError({ rawError: { code: 10008 } }), true);
    assert.equal(isUnknownMessageError({ code: 50001 }), false);
    assert.equal(isUnknownMessageError(null), false);
    assert.equal(isUnknownMessageError(undefined), false);
});

test('discord API error helpers match common interaction and permission codes', () => {
    assert.equal(discordErrorCode({ rawError: { code: 10062 } }), 10062);
    assert.equal(isUnknownInteractionError({ code: 10062 }), true);
    assert.equal(isUnknownInteractionError({ code: 10008 }), false);
    assert.equal(isInteractionAlreadyAcknowledgedError({ code: 40060 }), true);
    assert.equal(isInteractionAlreadyAcknowledgedError({ rawError: { code: 40060 } }), true);
    assert.equal(isIgnorableInteractionAckError({ code: 10062 }), true);
    assert.equal(isIgnorableInteractionAckError({ code: 40060 }), true);
    assert.equal(isIgnorableInteractionAckError({ code: 50013 }), false);
    assert.equal(isMissingPermissionsError({ code: 50013 }), true);
    assert.equal(isMissingPermissionsError({ rawError: { code: 50001 } }), true);
    assert.equal(isMissingPermissionsError({ code: 10062 }), false);
});

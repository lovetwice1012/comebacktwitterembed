'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Locale } = require('discord.js');

const { t, getStringFromObject, messageLocales, descriptionLocales, commandNameLocales } = require('../../src/locales');
const { missingCatalogKeys, normalizeLocale, toDiscordLocalizations } = require('../../src/i18n');
const {
    DISCORD_LOCALE_OPTIONS,
    DISCORD_LOCALES,
    formatDiscordLocaleName,
    normalizeDiscordLocale,
    toApiLocaleFamily,
} = require('../../src/discordLocales');

test('getStringFromObject: returns matching locale', () => {
    const obj = { ja: 'やあ', en: 'hi' };
    assert.equal(getStringFromObject(obj, 'ja'), 'やあ');
    assert.equal(getStringFromObject(obj, 'en'), 'hi');
});

test('getStringFromObject: falls back to en when missing', () => {
    const obj = { en: 'hi' };
    assert.equal(getStringFromObject(obj, 'ja'), 'hi');
});

test('getStringFromObject: accepts en-US and legacy en dictionaries', () => {
    assert.equal(getStringFromObject({ en: 'hi' }, 'en-US'), 'hi');
    assert.equal(getStringFromObject({ 'en-US': 'hello' }, 'en'), 'hello');
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

test('legacy locale catalog contains every key for every Discord locale', () => {
    assert.deepEqual(missingCatalogKeys('legacy'), []);
    assert.equal(messageLocales.finishActionLocales['en-US'], 'Finished action.');
    assert.equal(descriptionLocales.helpcommand['en-US'], 'Shows help message.');
    assert.equal(commandNameLocales.settings['en-US'], 'settings');
    assert.equal(typeof messageLocales.setdefaultlanguagetolocales.fr, 'string');
    assert.equal(typeof descriptionLocales.defaultLanguage['zh-CN'], 'string');
});

test('normalizeLocale: maps Discord locale aliases intentionally', () => {
    assert.equal(normalizeLocale('en'), 'en-US');
    assert.equal(normalizeLocale('en-GB'), 'en-GB');
    assert.equal(normalizeLocale('jp'), 'ja');
    assert.equal(normalizeLocale('ko-KR'), 'ko');
    assert.equal(normalizeLocale('kr'), 'kr');
});

test('discord locale helpers cover every Discord supported locale', () => {
    assert.deepEqual(DISCORD_LOCALE_OPTIONS.map(option => option.value).sort(), Object.values(Locale).sort());
    assert.deepEqual([...DISCORD_LOCALES].sort(), Object.values(Locale).sort());
    assert.equal(normalizeDiscordLocale('en'), 'en-US');
    assert.equal(normalizeDiscordLocale('EN-gb'), 'en-GB');
    assert.equal(normalizeDiscordLocale('jp'), 'ja');
    assert.equal(normalizeDiscordLocale('kr'), null);
    assert.equal(toApiLocaleFamily('ja'), 'ja');
    assert.equal(toApiLocaleFamily('fr'), 'en');
    assert.match(formatDiscordLocaleName('zh-CN'), /zh-CN/);
});

test('toDiscordLocalizations: accepts legacy en as en-US', () => {
    assert.deepEqual(toDiscordLocalizations({ en: 'hi', ja: 'やあ' }), {
        'en-US': 'hi',
        ja: 'やあ',
    });
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeEmbed,
    normalizeEmbedFields,
    splitLinesByLimit,
} = require('../../src/interactionResponse');

test('normalizeEmbed preserves fields on real Discord.js Embed instances', () => {
    const { Embed } = require('discord.js');
    const original = new Embed({ title: 'Quoted post', description: 'Quoted text', image: { url: 'https://example.test/image.png' } });
    const result = normalizeEmbed(original);
    assert.equal(result.title, 'Quoted post');
    assert.equal(result.description, 'Quoted text');
    assert.equal(result.image.url, 'https://example.test/image.png');
    assert.equal(Object.hasOwn(result, 'data'), false);
});

test('splitLinesByLimit keeps pages within the requested limit', () => {
    const pages = splitLinesByLimit(['aaa', 'bbb', 'ccc'], 8);
    assert.deepEqual(pages, ['aaa\nbbb', 'ccc']);
});

test('normalizeEmbedFields splits field values over the embed field limit', () => {
    const fields = normalizeEmbedFields([{ name: 'ids', value: 'x'.repeat(1500) }]);
    assert.equal(fields.length, 2);
    assert.ok(fields.every(field => field.value.length <= 1024));
    assert.equal(fields[0].name, 'ids (1/2)');
});

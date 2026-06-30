'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeEmbedFields,
    splitLinesByLimit,
} = require('../../src/interactionResponse');

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

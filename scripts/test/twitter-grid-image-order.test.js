'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { orderedGroups, orderedImageUrls } = require('../../src/twitterGridImageOrder');

test('source order can differ from the physical anchor order without changing the stored references', () => {
    const values = ['11', '12', '1', '2', '3'];
    assert.deepEqual(orderedGroups(values, [2, 3], [1, 0]), ['1', '2', '3', '11', '12']);
    assert.deepEqual(values, ['11', '12', '1', '2', '3']);
    assert.deepEqual(orderedGroups(values, [2, 3]), values);
    assert.deepEqual(orderedGroups(['1', '2'], [1, 0, 1], [1, 2, 0]), ['2', '1']);
});

test('malformed group sizes and ambiguous or incomplete order never select images', () => {
    for (const [values, sizes, order] of [
        [['a', 'b'], [1, 1], [0, 0]], [['a', 'b'], [1, 1], [0]],
        [['a', 'b'], [1, 1], [0, 2]], [['a', 'b'], [1, -1], [0, 1]],
        [['a', 'b'], [1, 2], [0, 1]], [['a'], [], []],
    ]) assert.throws(() => orderedGroups(values, sizes, order), /GRID_MANIFEST_INVALID/);
});

test('legacy records retain their original order and malformed new records fail closed', () => {
    assert.deepEqual(orderedImageUrls({ imageUrls: ['a', 'b'] }), ['a', 'b']);
    assert.deepEqual(orderedImageUrls({ imageUrls: ['b', 'a'], partSizes: [1, 1], imagePartOrder: [1, 0] }), ['a', 'b']);
    assert.throws(() => orderedImageUrls({ imageUrls: ['a', 'b'], partSizes: [1, 1], imagePartOrder: null }), /GRID_MANIFEST_INVALID/);
});

test('verified physical messages produce original order for composition', async () => {
    const cards = require('../../src/twitterGridCards');
    const grid = require('../../src/components/twitterGrid')._internal;
    const messages = ['22', '11'].map(id => ({ id, channelId: '3', guildId: '4', author: { id: '5' }, embeds: [], components: [], attachments: new Map() }));
    const urls = ['https://pbs.twimg.com/media/P2.jpg', 'https://pbs.twimg.com/media/P1.jpg'];
    const payload = { id: 'a'.repeat(32), imageUrls: urls, imagePartOrder: [1, 0], partSizes: [1, 1],
        totalParts: 2, completedParts: 2, partsState: 'complete', messageIds: messages.map(message => message.id),
        partSignatures: messages.map(message => cards.fingerprint(message)), partRefs: urls.map(url => [{ type: 'url', url }]) };
    const channel = { messages: { fetch: async ({ message }) => messages.find(item => item.id === message) } };
    const interaction = { channelId: '3', client: { user: { id: '5' } }, channel };
    const row = { message_id: '22', payload };
    assert.deepEqual(await grid.sourceImageUrls(interaction, row), [urls[1], urls[0]]);
    payload.imagePartOrder = [0, 0];
    await assert.rejects(grid.sourceImageUrls(interaction, row), /GRID_MANIFEST_INVALID/);
});

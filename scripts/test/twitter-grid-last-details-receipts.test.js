'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../../src/providers/twitter/lastDetailsReceipts');

const groupId = 'a'.repeat(32), scope = { guildId: '2', channelId: '3', client: { user: { id: '4' } } };
function receipt(id, image) {
    return { step: { files: [image], twitterGridLead: { groupId, imageUrls: [image] } },
        sent: { id, guildId: '2', channelId: '3', author: { id: '4' }, content: '', embeds: [], components: [], attachments: new Map([['20', { id: '20' }]]) } };
}
function root() { return { files: ['c'], twitterGridLastRoot: { groupId }, twitterGrid: { imageUrls: ['c'], sequence: 0, totalParts: 2 } }; }

test('only confirmed earlier messages become virtual parts, in display order', () => {
    const prior = [receipt('10', 'a'), receipt('11', 'b')], result = build(root(), prior, scope);
    assert.deepEqual(result.imagePartOrder, [1, 2, 0]);
    assert.deepEqual(result.following.map(part => part.twitterGrid.imageUrls), [['a'], ['b']]);
    assert.deepEqual(result.following.map(part => part.twitterGrid.sequence), [1, 2]);
    assert.equal(result.root.twitterGrid.totalParts, 3);
});

test('foreign, duplicate and changed receipts cannot authorize later operations', () => {
    const item = receipt('10', 'a');
    assert.equal(build(root(), [item, item], scope), null);
    for (const bad of [{ ...item.sent, author: { id: '9' } }, { ...item.sent, channelId: '9' },
        { ...item.sent, guildId: '9' }, { ...item.sent, content: 'changed' }, { ...item.sent, components: [{}] },
        { ...item.sent, attachments: new Map() }]) {
        assert.equal(build(root(), [{ ...item, sent: bad }], scope), null);
    }
    assert.equal(build(root(), [{ ...item, step: { ...item.step, twitterGridLead: { groupId: 'b'.repeat(32), imageUrls: ['a'] } } }], scope), null);
});

test('the final anchor gallery persists physical references and the verified display permutation', async () => {
    const cards = require('../../src/twitterGridCards');
    const rootUrl = 'https://pbs.twimg.com/media/last.jpg', leadUrl = 'https://pbs.twimg.com/media/first.jpg';
    const actualRoot = { files: [rootUrl], components: [], twitterGridLastRoot: { groupId },
        twitterGrid: { imageUrls: [rootUrl], sequence: 0, totalParts: 2 } };
    const plan = build(actualRoot, [receipt('10', leadUrl)], scope);
    let saved;
    const storage = { save: async payload => { saved = payload; } };
    const output = await cards.prepare(plan.root, { guildId: '2', channelId: '3', author: { id: '4' } },
        { providerId: 'twitter', presentationSettings: {} }, storage, plan.following);
    assert.ok(output.grids?.length);
    assert.deepEqual(saved.expectedImageUrls, [rootUrl, leadUrl]);
    assert.deepEqual(saved.imagePartOrder, [1, 0]);
    const malformed = { ...plan.root, twitterGridLastRoot: { groupId, imagePartOrder: [0, 0] } };
    assert.equal((await cards.prepare(malformed, { guildId: '2', channelId: '3' },
        { providerId: 'twitter', presentationSettings: {} }, storage, plan.following)).grids, undefined);
});

test('Discord.js Message receipts retain the guild, channel and attachment evidence', () => {
    const { Client, Message } = require('discord.js'), client = new Client({ intents: [] });
    client.user = { id: '4' };
    const sent = new Message(client, { id: '10', guild_id: '2', channel_id: '3', author: { id: '4', username: 'bot', discriminator: '0' },
        content: '', embeds: [], components: [], attachments: [{ id: '20', filename: 'first.jpg', size: 1,
            url: 'https://cdn.discordapp.com/attachments/3/20/first.jpg', content_type: 'image/jpeg' }] });
    const result = build(root(), [{ step: { files: ['a'], twitterGridLead: { groupId, imageUrls: ['a'] } }, sent }], scope);
    assert.deepEqual(result.imagePartOrder, [1, 0]);
});

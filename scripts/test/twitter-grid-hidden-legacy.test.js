'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client, Message, MessagePayload } = require('discord.js');
const { logicalAttachments } = require('../../src/discordAttachmentIdentity');
const { matchesEdit, _internal } = require('../../src/twitterGridLegacyActions');

const channelId = '333333333333333333', fileId = '444444444444444444', bot = '555555555555555555';
const fileName = 'photo.jpg';
const image = `https://cdn.discordapp.com/attachments/${channelId}/${fileId}/${fileName}?ex=1&is=2&hm=abc`;
function message(url = image) {
    const client = new Client({ intents: [] });
    return new Message(client, { id: '666666666666666666', channel_id: channelId,
        author: { id: bot, username: 'bot', discriminator: '0' }, content: '',
        attachments: [], embeds: [{ title: 'Post', image: { url } }],
        components: [{ type: 1, components: [{ type: 2, style: 2, label: 'Delete', custom_id: 'delete' }] }] });
}

test('a real discord.js Message verifies a hidden CDN image against the intended edit', () => {
    const actual = message(), files = logicalAttachments(actual);
    assert.equal(actual.attachments.size, 0); assert.equal(files.length, 1); assert.equal(files[0].id, fileId);
    const edit = { content: '', embeds: [{ title: 'Post', image: { url: `attachment://${fileName}` } }],
        components: actual.components.map(component => component.toJSON()), attachments: [{ id: fileId }] };
    assert.equal(matchesEdit(actual, edit, files, channelId), true);
    assert.equal(matchesEdit(message(image.replace('cdn.discordapp.com', 'attacker.invalid')), edit, files, channelId), false);
    assert.equal(matchesEdit(message(image.replace(channelId, '999999999999999999')), edit, files, channelId), false);
});

test('discord.js serializes hidden image IDs into the retained attachment PATCH body', () => {
    const actual = message(), client = actual.client;
    const channel = { id: channelId, client };
    client.channels.cache.set(channelId, channel);
    actual.components[0].components[0].data.custom_id = 'showMediaAsAttachments';
    const options = { buttons: { showAttachmentsAsMediaButton: { type: 2, style: 2, label: 'Embed', custom_id: 'showAttachmentsAsEmbedsImage' } } };
    const edit = _internal.makeEdit(actual, { title: 'Post' }, 'showMediaAsAttachments', true, options, [], { messageIds: [actual.id] });
    assert.deepEqual(edit.attachments, [{ id: fileId }]);
    const body = MessagePayload.create(channel, edit).resolveBody().body;
    assert.deepEqual(body.attachments, [{ id: fileId }]);
    assert.equal(body.embeds[0].image, undefined);
    assert.equal(body.components[0].components[0].custom_id, 'showAttachmentsAsEmbedsImage');
});

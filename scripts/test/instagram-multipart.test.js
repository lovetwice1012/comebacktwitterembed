'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const multipart = require('../../src/instagramMultipart');

const scope = { guildId: '111111111111111111', channelId: '222222222222222222', client: { user: { id: '333333333333333333' } } };
const source = { ...scope, author: { id: '444444444444444444' } };
const step = { instagramGalleryParts: 2, files: ['https://example.com/1.jpg'], components: [{ type: 1, components: [
    { type: 2, custom_id: 'translate' }, { type: 2, custom_id: 'delete:instagram' },
] }] };
function receipt(id) { return { id, ...scope, author: { id: scope.client.user.id }, embeds: [], components: [],
    attachments: new Map([['99', { id: '99', name: '1.jpg', contentType: 'image/jpeg' }]]) }; }

test('multipart Instagram deletion is bound to confirmed messages and completes only after all parts', async () => {
    let saved, row, messageId;
    const storage = { save: async payload => { saved = JSON.stringify(payload); row = saved; }, bind: async (_id, id) => { messageId = id; } };
    const db = { queryDatabase: async (_sql, [next, _id, expectedMessage, before]) => {
        assert.equal(expectedMessage, messageId);
        if (row !== before) return { affectedRows: 0 };
        row = next; return { affectedRows: 1 };
    } };
    const result = await multipart.prepare(step, source, { providerId: 'instagram' }, storage);
    assert.match(result.step.components[0].components[1].custom_id, /^delete:ig1:[a-f0-9]{32}$/);
    assert.equal(result.step.components[0].components[0].custom_id, 'translate');
    assert.equal(await multipart.record(result.group, step, receipt('5'), scope, storage, db), true);
    assert.equal(result.group.partsState, 'pending');
    assert.equal(await multipart.record(result.group, step, receipt('5'), scope, storage, db), false);
    assert.equal(await multipart.record(result.group, step, receipt('6'), scope, storage, db), true);
    assert.equal(result.group.partsState, 'complete');
    assert.deepEqual(result.group.messageIds, ['5', '6']);
    assert.notEqual(saved, row);
});

test('foreign or incomplete receipts never bind a multipart delete record', async () => {
    const scopeWithWrongChannel = { ...scope, channelId: '9' };
    assert.equal(multipart._internal.validReceipt(step, receipt('5'), scopeWithWrongChannel), false);
    assert.equal(multipart._internal.validReceipt(step, { ...receipt('5'), attachments: new Map() }, scope), false);
    assert.equal(multipart._internal.validReceipt(step, { ...receipt('5'), author: { id: '9' } }, scope), false);
});

function removalFixture() {
    const cards = require('../../src/twitterGridCards'), id = 'a'.repeat(32), messages = new Map(), calls = [];
    const first = { ...receipt('5'), content: '', embeds: [{ url: 'https://www.instagram.com/p/ABC/', description: 'original' }],
        components: [{ type: 1, components: [{ type: 2, custom_id: `delete:ig1:${id}` }] }] };
    const second = { ...receipt('6'), content: '' };
    for (const item of [first, second]) { item.delete = async () => { calls.push(item.id); messages.delete(item.id); }; messages.set(item.id, item); }
    const payload = { id, kind: 'instagram-multipart-v1', requesterId: source.author.id, expectedParts: 2, partsState: 'complete',
        messageIds: ['5', '6'], partSignatures: [cards.fingerprint(first), cards.fingerprint(second)], rootSignature: multipart._internal.rootSignature(first) };
    const channel = { messages: { fetch: async ({ message }) => {
        if (!messages.has(message)) throw Object.assign(Error('unknown'), { code: 10008 });
        return messages.get(message);
    } } };
    const interaction = { ...scope, channel, message: first, customId: `delete:ig1:${id}`, user: { id: source.author.id }, locale: 'ja', editReply: async () => {} };
    const row = { message_id: first.id, provider_id: 'instagram', payload_json: JSON.stringify(payload) };
    const db = { withDatabaseTransaction: async work => work(async sql => /^SELECT/.test(sql) ? [row] : { affectedRows: 1 }) };
    const access = { channel, permissions: { has: () => true }, member: { _roles: [] } };
    const dependencies = { db, getSettings: async () => ({}), freshAccess: async () => access };
    return { first, second, interaction, dependencies, messages, calls, row, access };
}

test('a requester can delete the complete group after translating the first caption', async () => {
    const f = removalFixture();
    f.first.embeds[0].description = 'translated';
    await multipart.remove(f.interaction, f.dependencies);
    assert.deepEqual(f.calls, ['6', '5']);
    assert.equal(f.messages.size, 0);
});

test('real Discord.js message snapshots keep a stable signature across caption translation', () => {
    const { Client, Message } = require('discord.js'), client = new Client({ intents: [] });
    const raw = { id: '555555555555555555', guild_id: scope.guildId, channel_id: scope.channelId,
        author: { id: scope.client.user.id, username: 'bot', discriminator: '0' }, content: '',
        attachments: [{ id: '666666666666666666', filename: '1.jpg', size: 1,
            url: `https://cdn.discordapp.com/attachments/${scope.channelId}/666666666666666666/1.jpg`, content_type: 'image/jpeg' }],
        embeds: [{ url: 'https://www.instagram.com/p/ABC/', description: 'before', footer: { text: 'requester' } }],
        components: [{ type: 1, components: [{ type: 2, style: 4, label: 'Delete', custom_id: `delete:ig1:${'a'.repeat(32)}` }] }] };
    const before = new Message(client, raw), after = new Message(client, { ...raw, embeds: [{ ...raw.embeds[0], description: 'after' }] });
    assert.equal(multipart._internal.rootSignature(before), multipart._internal.rootSignature(after));
    const changed = new Message(client, { ...raw, attachments: [] });
    assert.notEqual(multipart._internal.rootSignature(before), multipart._internal.rootSignature(changed));
});

test('a lost delete acknowledgement is verified without sending a second delete', async () => {
    const f = removalFixture();
    const original = f.first.delete;
    f.first.delete = async () => { await original(); throw Error('lost acknowledgement'); };
    await multipart.remove(f.interaction, f.dependencies);
    assert.deepEqual(f.calls, ['6', '5']);
    assert.equal(f.messages.size, 0);
});

test('a missing continuation can be retried, but changed, foreign or unauthorized messages are not deleted', async () => {
    const missing = removalFixture();
    missing.messages.delete('6');
    await multipart.remove(missing.interaction, missing.dependencies);
    assert.deepEqual(missing.calls, ['5']);
    for (const change of [
        f => { f.second.content = 'changed'; },
        f => { f.second.author = { id: '999' }; },
        f => { f.first.attachments.clear(); },
        f => { f.interaction.user.id = '999999999999999999'; f.access.permissions.has = () => false; },
    ]) {
        const f = removalFixture(); change(f);
        await assert.rejects(multipart.remove(f.interaction, f.dependencies));
        assert.deepEqual(f.calls, []);
    }
});

test('permission loss after the continuation is deleted leaves the root available for retry', async () => {
    const f = removalFixture();
    let calls = 0;
    f.dependencies.freshAccess = async () => ++calls < 3 ? f.access : null;
    await assert.rejects(multipart.remove(f.interaction, f.dependencies), /GRID_PERMISSION_CHANGED/);
    assert.deepEqual(f.calls, ['6']);
    assert.equal(f.messages.has('5'), true);
    f.dependencies.freshAccess = async () => f.access;
    await multipart.remove(f.interaction, f.dependencies);
    assert.deepEqual(f.calls, ['6', '5']);
});

test('a manager can delete the group while an ordinary different user cannot', async () => {
    const denied = removalFixture();
    denied.interaction.user.id = '999999999999999999';
    denied.access.permissions.has = () => false;
    await assert.rejects(multipart.remove(denied.interaction, denied.dependencies), /GRID_PERMISSION_CHANGED/);
    assert.deepEqual(denied.calls, []);
    const manager = removalFixture();
    manager.interaction.user.id = '999999999999999999';
    await multipart.remove(manager.interaction, manager.dependencies);
    assert.deepEqual(manager.calls, ['6', '5']);
});

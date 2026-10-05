'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handle } = require('../../src/components/delete');

function fixture(t) {
    t.mock.method(global, 'setTimeout', () => ({ unref() {} }));
    const calls = [];
    const interaction = { guildId: 'guild', user: { id: '111111111111111111' }, locale: 'en-US',
        member: { permissions: { has: () => true } }, memberPermissions: { has: () => false },
        message: { embeds: [{ footer: { text: 'Requested by other(id:222222222222222222)' } }], delete: async () => calls.push('delete') },
        editReply: async value => calls.push(value), deleteReply: async () => {} };
    return { interaction, calls };
}

test('delete uses channel-effective permissions, not a guild role overridden in the channel', async t => {
    const f = fixture(t);
    await handle(f.interaction);
    assert.ok(!f.calls.includes('delete'));
    assert.equal(f.calls.length, 1);
});

test('a channel-specific Manage Messages grant permits moderation', async t => {
    const f = fixture(t);
    f.interaction.member.permissions.has = () => false;
    f.interaction.memberPermissions.has = () => true;
    await handle(f.interaction);
    assert.equal(f.calls[0], 'delete');
});

test('a requester can delete their own expansion in DMs without guild member data', async t => {
    const f = fixture(t);
    f.interaction.guildId = null; f.interaction.member = null; f.interaction.memberPermissions = null;
    f.interaction.message.embeds[0].footer.text = `Requested by owner(id:${f.interaction.user.id})`;
    await handle(f.interaction);
    assert.equal(f.calls[0], 'delete');
});

test('unknown ownership and absent member permissions deny deletion without throwing', async t => {
    const f = fixture(t);
    f.interaction.member = null; f.interaction.memberPermissions = null;
    delete f.interaction.message.embeds;
    await handle(f.interaction);
    assert.ok(!f.calls.includes('delete'));
});

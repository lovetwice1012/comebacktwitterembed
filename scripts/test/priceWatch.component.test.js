'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const priceWatch = require('../../src/components/priceWatch');

test('price-watch component parses compact product and modal identifiers', () => {
    assert.deepEqual(priceWatch._internal.parseInitial('priceWatch:a:product:B012345678:ja'), {
        providerId: 'amazon', code: 'a', kind: 'product', id: 'B012345678', locale: 'ja',
    });
    assert.deepEqual(priceWatch._internal.parseDestination('priceWatchDestination:s:app:730:en-US:123456789012345678'), {
        providerId: 'steam', code: 's', kind: 'app', id: '730', locale: 'en-US', messageId: '123456789012345678',
    });
    assert.deepEqual(priceWatch._internal.parseModal('priceWatchModal:threshold:channel:s:app:730:ja:123456789012345678:234567890123456789'), {
        providerId: 'steam', code: 's', kind: 'app', id: '730', locale: 'ja', messageId: '123456789012345678',
        mode: 'threshold', destination: 'channel', channelId: '234567890123456789',
    });
    assert.equal(priceWatch.handles('priceWatchCancel:123456789012345678'), true);
});

test('price-watch button opens a private destination and mode selector', async () => {
    const replies = [];
    await priceWatch.handle({
        customId: 'priceWatch:a:product:B012345678:ja',
        message: { id: '123456789012345678' },
        locale: 'ja',
        reply: async payload => replies.push(payload),
    });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].ephemeral, true);
    const menu = replies[0].components[0].components[0];
    assert.match(menu.data.custom_id, /^priceWatchDestination:a:product:B012345678:ja:/);
    assert.equal(menu.options.length, 6);
});

test('all registration entry points enforce the correct provider button policy before side effects', async t => {
    const permissions = require('../../src/components/_permissionCheck');
    const seen = [];
    t.mock.method(permissions, 'isAllowed', async (_interaction, options) => { seen.push(options.providerId); return false; });
    for (const customId of ['priceWatch:a:product:B012345678:ja', 'priceWatchDestination:s:app:730:ja:123456789012345678', 'priceWatchChannel:s:app:730:ja:123456789012345678:change']) {
        assert.equal(await priceWatch.handle({ customId }), false);
    }
    assert.equal(await priceWatch.handleModal({ customId: 'priceWatchModal:threshold:dm:s:app:730:ja:123456789012345678' }), false);
    assert.deepEqual(seen, ['amazon', 'steam', 'steam', 'steam']);
});

test('button policy supports raw modal roles and private denial before acknowledgement', async t => {
    const settings = require('../../src/providers/_provider_settings');
    const { isAllowed } = require('../../src/components/_permissionCheck');
    let policy = { user: [], channel: [], role: ['blocked'] };
    t.mock.method(settings, 'getSetting', async (provider, key, guild) => { assert.equal(provider.id, 'steam'); assert.equal(key, 'button_disabled'); assert.equal(guild, 'guild'); return policy; });
    const replies = [], interaction = { guildId: 'guild', channelId: 'channel', member: { roles: ['blocked'] }, user: { id: 'user' }, locale: 'ja', reply: async data => replies.push(data) };
    assert.equal(await isAllowed(interaction, { providerId: 'steam' }), false);
    assert.equal(replies[0].ephemeral, true);
    interaction.member.roles = [];
    assert.equal(await isAllowed(interaction, { providerId: 'steam' }), true);
    interaction.member = null;
    assert.equal(await isAllowed(interaction, { providerId: 'steam' }), false, 'missing role data fails closed');
    policy = { channel: ['channel'] };
    assert.equal(await isAllowed(interaction, { providerId: 'steam' }), false);
    policy = { user: ['user'] };
    assert.equal(await isAllowed(interaction, { providerId: 'steam' }), false);
});

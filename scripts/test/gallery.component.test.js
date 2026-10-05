'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const gallery = require('../../src/mediaGallery');
const settings = require('../../src/providers/_provider_settings');
const { handle } = require('../../src/components/gallery');
const guildId = '333333333333333333';
const channelId = '222222222222222222';
const userId = '111111111111111111';
const botId = '444444444444444444';
const galleryId = 'a'.repeat(32);

async function fixture() {
    await settings.setSetting({ id: 'pixiv' }, 'enabled', guildId, true);
    await settings.setSetting({ id: 'pixiv' }, 'gallery_display_mode', guildId, 'gallery');
    await settings.setSetting({ id: 'pixiv' }, 'media_display_mode', guildId, 'embed');
    await settings.setSetting({ id: 'pixiv' }, 'button_disabled', guildId, { user: [], channel: [], role: [] });
    const current = await settings.getProviderSettings({ id: 'pixiv' }, guildId);
    const row = { provider_id: 'pixiv', message_id: '555555555555555555',
        payload: { id: galleryId, language: 'ja', settingsHash: gallery.settingsHash(current),
            pages: ['a', 'b'].map(name => ({ embeds: [{ title: 'Album', image: { url: `https://images.example/${name}.jpg` } }], files: [] })) } };
    const calls = [];
    const interaction = { customId: `gallery:${galleryId}:1:0`, guildId, channelId, locale: 'ja', user: { id: userId },
        member: { roles: [] }, memberPermissions: { has: () => true }, client: { user: { id: botId } },
        channel: { nsfw: false, messages: { fetch: async () => ({ author: { id: botId } }) } },
        message: { id: row.message_id, author: { id: botId }, flags: { has: () => false } },
        deferReply: async p => { interaction.deferred = true; calls.push(['deferReply', p]); },
        deferUpdate: async () => { interaction.deferred = true; calls.push(['deferUpdate']); },
        reply: async p => calls.push(['reply', p]), editReply: async p => calls.push(['editReply', p]),
        deferred: false,
    };
    const storage = { get: async (id, g, c) => id === galleryId && g === guildId && c === channelId ? row : null };
    return { interaction, storage, row, calls };
}

test('public navigation opens an ephemeral page; subsequent navigation updates only that viewer', async () => {
    const f = await fixture();
    await handle(f.interaction, f.storage);
    assert.deepEqual(f.calls[0], ['deferReply', { ephemeral: true }]);
    assert.equal(f.calls[1][1].embeds[0].image.url, 'https://images.example/b.jpg');
    assert.ok(f.calls[1][1].components[0].components.every(b => b.custom_id.endsWith(`:${userId}`)));
    f.calls.length = 0;
    f.interaction.customId = `gallery:${galleryId}:0:${userId}`;
    f.interaction.message.id = '666666666666666666';
    f.interaction.message.flags.has = value => value === 64;
    await handle(f.interaction, f.storage);
    assert.equal(f.calls[0][0], 'deferUpdate');
    assert.equal(f.calls[1][1].embeds[0].image.url, 'https://images.example/a.jpg');
    assert.deepEqual(f.calls[1][1].attachments, []);
});

test('viewer refuses another user, another channel, another bot and unbound public cards', async () => {
    const f = await fixture();
    f.interaction.customId = `gallery:${galleryId}:0:777777777777777777`;
    await handle(f.interaction, f.storage);
    assert.equal(f.calls[0][0], 'reply');
    assert.match(f.calls[0][1].content, /本人/);
    for (const mutate of [
        i => { i.channelId = '999999999999999999'; },
        i => { i.message.id = '999999999999999999'; },
    ]) {
        const f2 = await fixture(); mutate(f2.interaction);
        await handle(f2.interaction, f2.storage);
        assert.deepEqual(f2.calls.at(-1)[1].embeds, []);
    }
    const f3 = await fixture(); f3.interaction.message.author.id = 'foreign-bot';
    await handle(f3.interaction, f3.storage);
    assert.equal(f3.calls.length, 0);
});

test('expired galleries, invalid pages and changed visibility fail without exposing saved media', async () => {
    for (const scenario of ['expired', 'page', 'settings', 'nsfw']) {
        const f = await fixture();
        if (scenario === 'expired') f.storage.get = async () => null;
        if (scenario === 'page') f.interaction.customId = `gallery:${galleryId}:99:0`;
        if (scenario === 'settings') await settings.setSetting({ id: 'pixiv' }, 'media_display_mode', guildId, 'link_only');
        if (scenario === 'nsfw') f.row.payload.nsfw = true;
        await handle(f.interaction, f.storage);
        const output = f.calls.at(-1)[1];
        assert.deepEqual(output.embeds, [], scenario);
        assert.deepEqual(output.components, [], scenario);
    }
});

test('private navigation stops after public card deletion or channel access revocation', async () => {
    for (const scenario of ['deleted', 'permission']) {
        const f = await fixture();
        f.interaction.customId = `gallery:${galleryId}:1:${userId}`;
        f.interaction.message.flags.has = () => true;
        if (scenario === 'deleted') f.interaction.channel.messages.fetch = async () => { throw { code: 10008 }; };
        else f.interaction.memberPermissions.has = () => false;
        await handle(f.interaction, f.storage);
        assert.deepEqual(f.calls.at(-1)[1].embeds, []);
    }
});

test('a public gallery click also requires current channel history access', async () => {
    const f = await fixture();
    f.interaction.memberPermissions.has = () => false;
    f.storage.get = async () => assert.fail('Denied viewers must not load stored media');
    await handle(f.interaction, f.storage);
    assert.deepEqual(f.calls.at(-1)[1].embeds, []);
});

test('NSFW galleries inherit thread parent state and stop when its age restriction is removed', async () => {
    const f = await fixture();
    f.row.payload.nsfw = true;
    f.interaction.channel.parent = { nsfw: true };
    await handle(f.interaction, f.storage);
    assert.equal(f.calls.at(-1)[1].embeds[0]?.image?.url, 'https://images.example/b.jpg');
    f.interaction.channel.parent.nsfw = false;
    await handle(f.interaction, f.storage);
    assert.deepEqual(f.calls.at(-1)[1].embeds, []);
});

test('legacy thread snapshots with unknown parent NSFW context are not served as safe media', async () => {
    const f = await fixture();
    f.interaction.channel.isThread = () => true;
    f.row.payload.nsfw = false;
    await handle(f.interaction, f.storage);
    assert.deepEqual(f.calls.at(-1)[1].embeds, []);
    f.row.payload.nsfwContextVersion = 1;
    await handle(f.interaction, f.storage);
    assert.equal(f.calls.at(-1)[1].embeds[0].image.url, 'https://images.example/b.jpg');
});

test('current button restrictions apply even when the saved settings fingerprint matches', async () => {
    const f = await fixture();
    await settings.setSetting({ id: 'pixiv' }, 'button_disabled', guildId, { user: [userId], channel: [], role: [] });
    f.row.payload.settingsHash = gallery.settingsHash(await settings.getProviderSettings({ id: 'pixiv' }, guildId));
    await handle(f.interaction, f.storage);
    assert.ok(!f.calls.at(-1)[1].embeds);
    assert.ok(f.calls.at(-1)[1].content);
});

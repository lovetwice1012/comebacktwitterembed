'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cards = require('../../src/twitterGridCards');

function interaction(url) {
    return { guildId: '333333333333333333', channelId: '444444444444444444', user: { id: '111111111111111111' },
        client: { user: { id: '222222222222222222' } }, customId: 'delete',
        message: { id: '555555555555555555', embeds: [{ url }], components: [], attachments: [] } };
}
test('non-X actions do not access the gallery database', async () => {
    const urls = ['https://instagram.com/p/abc', 'https://www.pixiv.net/artworks/123', 'https://alice.booth.pm/items/123',
        'https://open.spotify.com/track/123', 'https://www.twitch.tv/example', 'https://youtube.com/watch?v=abcdefghijk',
        'https://www.nicovideo.jp/watch/sm123', 'https://github.com/example/repository', 'https://gist.github.com/example/abc',
        'https://www.tiktok.com/@example/video/123', 'https://vm.tiktok.com/example', 'https://store.steampowered.com/app/123',
        'https://steamcommunity.com/sharedfiles/filedetails/?id=123', 'https://s.team/a/123', 'https://www.amazon.co.jp/dp/B012345678',
        'https://music.amazon.co.jp/albums/B012345678', 'https://www.primevideo.com/detail/0ABCDEF0123456789',
        'https://a.co/d/example', 'http://github.com/example/repository'];
    for (const url of urls) for (const action of ['delete', 'translate', 'showMediaAsAttachments', 'showAttachmentsAsEmbedsImage']) {
        let queries = 0, actions = 0;
        const db = { queryDatabase: async () => { queries++; throw Error('DB unavailable'); } };
        await cards.withMessageLock(interaction(url), async () => { actions++; }, db, { action });
        assert.equal(queries, 0, `${action} ${url}`); assert.equal(actions, 1, `${action} ${url}`);
    }
});
test('lookalike, credentialed and non-default-port hosts never bypass the X lock', async () => {
    for (const url of ['https://github.com.evil.test/example/repository', 'https://evil.test/?url=https://github.com/example',
        'https://github.com@evil.test/example', 'https://github.com:8443/example', 'https://www.amazon.co.jp.evil.test/dp/B012345678',
        'https://x.com.evil.test/example/status/1']) {
        let actions = 0;
        await assert.rejects(cards.withMessageLock(interaction(url), async () => { actions++; }, {}, { action: 'delete' }), /GRID_LOCK_UNAVAILABLE/, url);
        assert.equal(actions, 0, url);
    }
});
test('an X post with a missing locator fails safely during a DB outage', async () => {
    let actions = 0;
    const db = { queryDatabase: async () => { throw Error('DB unavailable'); } };
    await assert.rejects(cards.withMessageLock(interaction('https://x.com/a/status/1'), async () => { actions++; }, db, { action: 'delete' }), /GRID_LOCK_UNAVAILABLE/);
    assert.equal(actions, 0);
});
test('provider selection uses the URL hostname, never another domain in its query', async () => {
    let actions = 0;
    const db = { queryDatabase: async () => { throw Error('DB unavailable'); } };
    await assert.rejects(cards.withMessageLock(interaction('https://x.com/a/status/1?ref=booth.pm'), async () => { actions++; }, db, { action: 'delete' }), /GRID_LOCK_UNAVAILABLE/);
    await cards.withMessageLock(interaction('https://www.pixiv.net/artworks/123?ref=x.com'), async () => { actions++; }, db, { action: 'delete' });
    assert.equal(actions, 1);
});
test('a gallery row with a different provider never authorizes an X action', async () => {
    const i = interaction('https://x.com/a/status/1'), id = 'a'.repeat(32);
    i.message.components = [{ components: [{ custom_id: `tg:${id}:0:open` }] }];
    const db = { withDatabaseTransaction: async fn => fn(async () => [{ message_id: i.message.id, provider_id: 'pixiv', payload_json: '{}' }]) };
    let actions = 0;
    await assert.rejects(cards.withMessageLock(i, async () => { actions++; }, db, { action: 'delete' }), /GRID_LOCK_UNAVAILABLE/);
    assert.equal(actions, 0);
});
test('an incomplete event with an unavailable source is not treated as non-X', async () => {
    let actions = 0;
    const i = interaction('');
    i.channel = { messages: { fetch: async () => { throw Error('Discord unavailable'); } } };
    await assert.rejects(cards.withMessageLock(i, async () => { actions++; }, {}, { action: 'delete' }), /GRID_LOCK_UNAVAILABLE/);
    assert.equal(actions, 0);
});
test('a known grid never falls back to the action when the database is unavailable', async () => {
    const i = interaction('https://x.com/a/status/1'), id = 'a'.repeat(32);
    i.message.components = [{ components: [{ custom_id: `tg:${id}:0:open` }] }];
    let actions = 0;
    const db = { withDatabaseTransaction: async () => { throw Error('DB unavailable'); } };
    await assert.rejects(cards.withMessageLock(i, async () => { actions++; }, db, { action: 'delete' }), /DB unavailable/);
    assert.equal(actions, 0);
});
test('an ambiguous same-message lookup does not select either group', async () => {
    const i = interaction('https://x.com/a/status/1');
    const db = { queryDatabase: async () => ['a', 'b'].map(char => ({ gallery_id: char.repeat(32),
        payload_json: JSON.stringify({ kind: 'twitter-image-grid-v1', isPrimary: true }) })) };
    let actions = 0;
    await assert.rejects(cards.withMessageLock(i, async () => { actions++; }, db, { action: 'delete' }), /GRID_LOCK_UNAVAILABLE/);
    assert.equal(actions, 0);
});
test('a malformed locator never falls back to an unlinked action', async () => {
    const i = interaction('https://x.com/a/status/1'); i.customId = 'delete:sl1:invalid';
    let actions = 0;
    await assert.rejects(cards.withMessageLock(i, async () => { actions++; }, {}, { action: 'delete' }), /GRID_LOCK_UNAVAILABLE/);
    assert.equal(actions, 0);
});
test('an X author cannot claim delete rights by placing a Discord ID in the footer', async () => {
    const handler = require('../../src/components/delete');
    const requester = '111111111111111111', attacker = '999999999999999999';
    let deleted = 0;
    const event = { locale: 'ja', user: { id: attacker }, memberPermissions: { has: () => false },
        message: { embeds: [{ url: 'https://x.com/example/status/1', author: { name: `展開者: real(id:${requester})` },
            footer: { text: `Posted by attacker(id:${attacker})` } }], delete: async () => { deleted++; } },
        editReply: async () => {}, deleteReply: async () => {} };
    await handler.handle(event); assert.equal(deleted, 0);
    event.user.id = requester;
    await handler.handle(event); assert.equal(deleted, 1);
});
test('the trusted gallery requester takes precedence over X-controlled embed text', async () => {
    const handler = require('../../src/components/delete');
    const requester = '111111111111111111', attacker = '999999999999999999';
    let deleted = 0;
    const event = { locale: 'ja', user: { id: attacker }, memberPermissions: { has: () => false },
        message: { embeds: [{ url: 'https://x.com/example/status/1', author: { name: `spoof(id:${attacker})` } }],
            delete: async () => { deleted++; } }, editReply: async () => {}, deleteReply: async () => {} };
    await handler.handle(event, { verifiedRequesterId: requester }); assert.equal(deleted, 0);
    event.user.id = requester;
    await handler.handle(event, { verifiedRequesterId: requester }); assert.equal(deleted, 1);
});
test('non-X providers retain their existing footer requester lookup', () => {
    const handler = require('../../src/components/delete');
    const message = { embeds: [{ url: 'https://www.pixiv.net/artworks/123', author: { name: 'creator(id:22)' }, footer: { text: '展開者: requester(id:111111111111111111) · pixiv' } }] };
    assert.equal(handler._internal.getRequesterIdFromMessage({ message }), '111111111111111111');
});

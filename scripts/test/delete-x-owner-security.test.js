'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const del = require('../../src/components/delete'), cards = require('../../src/twitterGridCards');
const owner = '111111111111111111', attacker = '999999999999999999', bot = '222222222222222222';
const guildId = '333333333333333333', channelId = '444444444444444444', messageId = '555555555555555555', id = 'a'.repeat(32);
function create({ url = 'https://x.com/example/status/123', requester = owner, user = attacker, footer = `投稿者: attacker(id:${attacker})`, manager = false, grid = false } = {}) {
    let deletes = 0, reply;
    const message = { id: messageId, channelId, guildId, author: { id: bot }, content: '', attachments: new Map(),
        embeds: [{ url, author: { name: `展開者: owner(id:${requester})` }, footer: { text: footer } }],
        components: [{ type: 1, components: [{ custom_id: 'delete' }, ...(grid ? [{ custom_id: `tg:${id}:0:open` }] : [])] }],
        delete: async () => { deletes++; } };
    const interaction = { guildId, channelId, user: { id: user }, client: { user: { id: bot } }, customId: 'delete', locale: 'ja',
        memberPermissions: { has: () => manager }, message, channel: { messages: { fetch: async () => message } },
        editReply: async value => { reply = value; }, deleteReply: async () => {} };
    return { interaction, message, get deletes() { return deletes; }, get reply() { return reply; } };
}
function dbFor(message, requester, totalParts = 1) {
    const payload = { id, lockId: id, requesterId: requester, kind: 'twitter-image-grid-v1', totalParts, completedParts: totalParts,
        partsState: 'complete', messageIds: totalParts === 1 ? [messageId] : [messageId, '666666666666666666'], partSignatures: [cards.fingerprint(message)] };
    const row = { message_id: messageId, payload_json: JSON.stringify(payload) };
    return { withDatabaseTransaction: async fn => fn(async () => [row]) };
}
test('X display names cannot impersonate the requester on an old untracked post', async t => {
    t.mock.method(global, 'setTimeout', () => ({ unref() {} }));
    for (const url of ['https://x.com/u/status/1', 'https://twitter.com/u/status/1', 'https://twidata.sprink.cloud/data/1/2/data.json']) {
        const f = create({ url }); await del.handle(f.interaction); assert.equal(f.deletes, 0, url);
        f.interaction.user.id = owner; await del.handle(f.interaction); assert.equal(f.deletes, 1, url);
    }
});
test('authorization uses strict host boundaries rather than provider names in a URL path or query', async t => {
    t.mock.method(global, 'setTimeout', () => ({ unref() {} }));
    for (const url of ['https://x.com/u/status/1?next=instagram.com', 'https://mobile.twitter.com/u/status/1?shop=booth.pm',
        'https://www.x.com/u/status/1/pixiv.net', 'https://X.COM:443/u/status/1']) {
        const f = create({ url, footer: `Requested by attacker(id:${attacker}) - Instagram` });
        f.interaction.customId = 'delete:instagram';
        await del.handle(f.interaction); assert.equal(f.deletes, 0, url);
        f.interaction.user.id = owner; await del.handle(f.interaction); assert.equal(f.deletes, 1, url);
    }
    for (const url of ['https://x.com.evil.invalid/status/1', 'https://evilx.com/status/1', 'https://x.com:8443/u/status/1',
        'https://user@x.com/u/status/1', 'http://x.com/u/status/1', 'https://booth.pm.evil.invalid/item/1']) {
        const f = create({ url, footer: `Requested by attacker(id:${attacker}) - Instagram` });
        f.interaction.customId = 'delete:instagram';
        await del.handle(f.interaction); assert.equal(f.deletes, 0, url);
    }
});
test('bound gallery requester is authoritative, including a verified webhook owner', async t => {
    t.mock.method(global, 'setTimeout', () => ({ unref() {} }));
    // The displayed source requester can be a webhook, while the saved ID is
    // an independently verified notification owner.
    const f = create({ grid: true, requester: '777777777777777777' }), db = dbFor(f.message, owner);
    await cards.withMessageLock(f.interaction, policy => del.handle(f.interaction, policy), db);
    assert.equal(f.deletes, 0);
    f.interaction.user.id = owner;
    await cards.withMessageLock(f.interaction, policy => del.handle(f.interaction, policy), db);
    assert.equal(f.deletes, 1);
});
test('missing or malformed saved requester never falls back to a spoofable display', async t => {
    t.mock.method(global, 'setTimeout', () => ({ unref() {} }));
    for (const requester of [null, 'not-an-id']) {
        const f = create({ grid: true, user: owner }), db = dbFor(f.message, requester);
        await cards.withMessageLock(f.interaction, policy => del.handle(f.interaction, policy), db);
        assert.equal(f.deletes, 0);
    }
});
test('known split posts remain paused before deleting any part', async t => {
    t.mock.method(global, 'setTimeout', () => ({ unref() {} }));
    const f = create({ grid: true, user: owner }), db = dbFor(f.message, owner, 2);
    await assert.rejects(cards.withMessageLock(f.interaction, policy => del.handle(f.interaction, policy), db), /GRID_SPLIT_ACTION_PAUSED/);
    assert.equal(f.deletes, 0);
});
test('channel managers retain moderation rights and anonymous or ambiguous ownership is denied', async t => {
    t.mock.method(global, 'setTimeout', () => ({ unref() {} }));
    const admin = create({ manager: true }); await del.handle(admin.interaction); assert.equal(admin.deletes, 1);
    const anonymous = create({ user: owner }); anonymous.message.embeds[0].author.name = '展開者: 匿名ユーザー';
    await del.handle(anonymous.interaction); assert.equal(anonymous.deletes, 0);
    const ambiguous = create({ url: 'https://example.invalid/?next=x.com', user: owner }); ambiguous.message.embeds[0].author.name = `展開者: owner(id:${owner})`;
    await del.handle(ambiguous.interaction); assert.equal(ambiguous.deletes, 0);
});
test('non-X requester footers still authorize the requester without trusting provider author names', async t => {
    t.mock.method(global, 'setTimeout', () => ({ unref() {} }));
    for (const [url, suffix] of [['https://www.pixiv.net/artworks/1', ' · pixiv'], ['https://booth.pm/ja/items/1', ' · booth.pm'],
        ['https://www.instagram.com/p/abc/', ' - Instagram'], ['https://www.youtube.com/watch?v=abc', ' · YouTube'], ['https://www.nicovideo.jp/watch/sm1', ' | Niconico'],
        ['https://www.amazon.com.br/dp/B000123456', ' - Amazon'], ['https://www.primevideo.com/detail/ABCD1234', ' - Amazon']]) {
        const f = create({ url, user: owner, footer: `Requested by owner(id:${owner})${suffix}` });
        f.message.embeds[0].author.name = `Remote author (id:${attacker})`;
        await del.handle(f.interaction); assert.equal(f.deletes, 1, url);
        f.interaction.user.id = attacker; await del.handle(f.interaction); assert.equal(f.deletes, 1, url);
    }
});
test('webhook display names with fake IDs or separators cannot replace the fixed final requester ID', async t => {
    t.mock.method(global, 'setTimeout', () => ({ unref() {} }));
    const f = create({ url: 'https://www.instagram.com/p/abc/', user: attacker,
        footer: `Requested by name(id:${attacker}) - tail(id:${owner}) - Instagram` });
    await del.handle(f.interaction); assert.equal(f.deletes, 0);
    f.interaction.user.id = owner; await del.handle(f.interaction); assert.equal(f.deletes, 1);
    for (const footer of [`Requested by owner(id:${owner}) - Instagram(id:${attacker})`,
        `Requested by owner(id:${owner}) - service(id:${attacker})`, `Requested by owner(id:${owner}) - Instagram - (id:${attacker})`,
        `Requested by owner(id:${attacker}) · YouTube`]) {
        const forged = create({ url: 'https://www.instagram.com/p/abc/', footer });
        await del.handle(forged.interaction); assert.equal(forged.deletes, 0, footer);
    }
});
test('an X requester author with embedded fake IDs uses only its final Bot-written ID', async t => {
    t.mock.method(global, 'setTimeout', () => ({ unref() {} }));
    const f = create({ user: attacker });
    f.message.embeds[0].author.name = `展開者: fake(id:${attacker}) - tail(id:${owner})`;
    await del.handle(f.interaction); assert.equal(f.deletes, 0);
    f.interaction.user.id = owner; await del.handle(f.interaction); assert.equal(f.deletes, 1);
});
test('real non-X presentation builders preserve requester authorization in Japanese and English', async t => {
    t.mock.method(global, 'setTimeout', () => ({ unref() {} }));
    const instagram = require('../../src/providers/instagram/presentation'), amazon = require('../../src/providers/amazon/presentation');
    const amazonUrls = require('../../src/providers/amazon/urls'), youtube = require('../../src/providers/youtube/presentation');
    const message = { author: { username: 'owner', id: owner }, content: '' };
    for (const language of ['ja', 'en']) {
        const parsed = amazonUrls.parseAmazonUrl('https://www.primevideo.com/detail/ABCD1234');
        const embeds = [
            instagram.buildProfilePayload({ username: 'fixture' }, 'https://www.instagram.com/fixture/', language, `owner(id:${owner})`, {}).embeds[0],
            amazon.buildEmbed(parsed, { title: 'fixture' }, message, { defaultLanguage: language }),
            youtube.buildChannelEmbed({ author: 'fixture', authorId: 'UC1234567890123456789012' }, { id: 'UC1234567890123456789012' }, 'https://www.youtube.com', message, { defaultLanguage: language }),
        ];
        for (const embed of embeds) {
            const f = create({ user: owner }); f.message.embeds = [embed];
            await del.handle(f.interaction); assert.equal(f.deletes, 1, `${language}: ${embed.url}`);
            f.interaction.user.id = attacker; await del.handle(f.interaction); assert.equal(f.deletes, 1, `${language}: ${embed.url}`);
        }
    }
});
test('a known provider button can identify a missing URL, while unknown guild posts remain closed', async t => {
    t.mock.method(global, 'setTimeout', () => ({ unref() {} }));
    const f = create({ user: owner, footer: `展開者: owner(id:${owner}) · pixiv` }); delete f.message.embeds[0].url;
    f.interaction.customId = 'delete:pixiv'; await del.handle(f.interaction); assert.equal(f.deletes, 1);
    f.interaction.customId = 'delete'; await del.handle(f.interaction); assert.equal(f.deletes, 1);
});

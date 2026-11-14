'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../../src/settings');
const provider = require('../../src/providers/_provider_settings');
const { isAllowed } = require('../../src/components/_permissionCheck');
const user = '111111111111111111', bot = '222222222222222222', guild = '333333333333333333', channel = '444444444444444444';

function event(url, action = 'delete') {
    return { guildId: guild, channelId: channel, locale: 'ja', user: { id: user }, client: { user: { id: bot } },
        customId: action, deferred: true, message: { id: '555555555555555555', embeds: [{ url }] }, editReply: async () => {} };
}

test('canonical URLs for all current providers select their own policy by parsed hostname', async t => {
    const samples = {
        twitter: 'https://x.com/example/status/1', instagram: 'https://www.instagram.com/p/abc', pixiv: 'https://www.pixiv.net/artworks/123',
        booth: 'https://alice.booth.pm/items/123', spotify: 'https://open.spotify.com/track/abc', twitch: 'https://www.twitch.tv/example',
        youtube: 'https://youtu.be/abcdefghijk', niconico: 'https://www.nicovideo.jp/watch/sm123', github: 'https://github.com/example/repo',
        tiktok: 'https://www.tiktok.com/@example/video/123', steam: 'https://store.steampowered.com/app/123', amazon: 'https://www.amazon.co.jp/dp/B012345678',
    };
    const queried = [], patch = t.mock.method(provider, 'getSetting', async value => { queried.push(value.id); return { user: [] }; });
    try {
        for (const [id, url] of Object.entries(samples)) for (const action of ['delete', 'translate', 'showMediaAsAttachments', 'showAttachmentsAsEmbedsImage']) {
            assert.equal(settings.detectProviderIdFromMessage({ embeds: [{ url }] }), id, url);
            assert.equal(await isAllowed(event(url, action)), true, `${id} ${action}`);
            assert.equal(queried.at(-1), id, `${id} ${action}`);
        }
    } finally { patch.mock.restore(); }
});

test('another provider name in the URL cannot bypass X or other site restrictions', async t => {
    const queried = [], patch = t.mock.method(provider, 'getSetting', async value => {
        queried.push(value.id); return { user: value.id === 'twitter' ? [user] : [] };
    });
    try {
        assert.equal(await isAllowed(event('https://x.com/example/status/1?ref=booth.pm')), false);
        assert.equal(queried.at(-1), 'twitter');
        assert.equal(await isAllowed(event('https://alice.booth.pm/items/123?next=x.com')), true);
        assert.equal(queried.at(-1), 'booth');
        for (const url of ['https://x.com.evil.test/status/1?ref=booth.pm', 'https://booth.pm@evil.test/items/123',
            'https://evil.test/?url=https://x.com/example/status/1', 'https://github.com:8443/example/repo']) {
            const count = queried.length;
            assert.equal(await isAllowed(event(url)), false, url); assert.equal(queried.length, count, url);
        }
    } finally { patch.mock.restore(); }
});

test('an incomplete event is resolved using a fresh Bot-authored source or fails closed', async t => {
    const queried = [], patch = t.mock.method(provider, 'getSetting', async value => { queried.push(value.id); return {}; });
    try {
        const i = event(''); i.channel = { messages: { fetch: async options => {
            assert.deepEqual(options, { message: i.message.id, force: true, cache: false });
            return { author: { id: bot }, embeds: [{ url: 'https://x.com/u/status/1?ref=booth.pm' }] };
        } } };
        assert.equal(await isAllowed(i), true); assert.equal(queried.at(-1), 'twitter');
        i.channel.messages.fetch = async () => ({ author: { id: user }, embeds: [{ url: 'https://booth.pm/items/1' }] });
        const count = queried.length; assert.equal(await isAllowed(i), false); assert.equal(queried.length, count);
    } finally { patch.mock.restore(); }
});

test('an invalid configured role policy does not silently become an unrestricted policy', async t => {
    let role = 'malformed';
    const patch = t.mock.method(provider, 'getSetting', async () => ({ role }));
    try {
        for (const value of ['malformed', ['not-a-snowflake'], ['1234'], [null]]) {
            role = value; assert.equal(await isAllowed(event('https://x.com/example/status/1')), false);
        }
    }
    finally { patch.mock.restore(); }
});

test('forbidden role IDs use the actual Discord.js member even when the guild role cache is incomplete', async t => {
    const { Client, Collection, GuildMember } = require('discord.js'), client = new Client({ intents: [] });
    const forbidden = '666666666666666666', other = '777777777777777777';
    const guildObject = { id: guild, client, roles: { cache: new Collection(), everyone: { id: guild } } };
    const member = new GuildMember(client, { user: { id: user, username: 'fixture', discriminator: '0' },
        joined_at: '2026-01-01T00:00:00.000Z', roles: [forbidden] }, guildObject);
    assert.equal(member.roles.cache.has(forbidden), false, 'the role manager cache is intentionally incomplete');
    const patch = t.mock.method(provider, 'getSetting', async () => ({ role: [forbidden] }));
    try {
        const i = event('https://x.com/example/status/1'); i.member = member;
        let raw = { user: { id: user }, roles: [forbidden] };
        i.client.rest = { get: async path => { assert.equal(path, `/guilds/${guild}/members/${user}`); return raw; } };
        assert.equal(await isAllowed(i), false);
        member._roles = [other]; assert.equal(await isAllowed(i), false, 'stale SDK roles cannot bypass the current REST response');
        raw = { user: { id: user }, roles: [other] };
        assert.equal(await isAllowed(i), true, 'a current non-restricted member is allowed');
        const partial = new GuildMember(client, { user: { id: user, username: 'fixture', discriminator: '0' } }, guildObject);
        assert.equal(partial.partial, true); i.member = partial; raw = { user: { id: user } };
        assert.equal(await isAllowed(i), false, 'a REST response without roles is denied');
        const ambiguous = new GuildMember(client, { user: { id: user, username: 'fixture', discriminator: '0' }, joined_at: '2026-01-01T00:00:00.000Z' }, guildObject);
        assert.equal(ambiguous.partial, false); assert.deepEqual(ambiguous._roles, []); i.member = ambiguous;
        assert.equal(await isAllowed(i), false, 'SDK empty defaults cannot prove the roles field was present');
        i.member = { roles: [] }; raw = { user: { id: user }, roles: [forbidden] };
        assert.equal(await isAllowed(i), false, 'stale empty raw interaction roles cannot bypass a current prohibition');
        raw = { user: { id: '999999999999999999' }, roles: [] };
        assert.equal(await isAllowed(i), false, 'another account is not authoritative');
        raw = { user: { id: user }, guild_id: '999999999999999999', roles: [] };
        assert.equal(await isAllowed(i), false, 'another guild is not authoritative');
        raw = { user: { id: user }, guild: { id: '999999999999999999' }, roles: [] };
        assert.equal(await isAllowed(i), false, 'a nested conflicting guild is not authoritative');
        i.client.rest.get = async () => { throw Error('unavailable'); };
        assert.equal(await isAllowed(i), false, 'a failed refresh remains denied');
        i.client.rest.get = async () => ({ user: { id: user }, roles: [] });
        i.member = { roles: [forbidden] }; assert.equal(await isAllowed(i), true, 'the current REST response supersedes stale roles');
    } finally { patch.mock.restore(); client.destroy(); }
});

'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { Client, Message } = require('discord.js');
const cards = require('../../src/twitterGridCards');
const confirm = require('../../src/components/twitterGridConfirm');
const gid = '333333333333333333', cid = '444444444444444444', mid = '555555555555555555';
const uid = '111111111111111111', bot = '222222222222222222', galleryId = 'a'.repeat(32);
function fixture() {
    const client = new Client({ intents: [] }); client.user = { id: bot };
    const raw = { id: mid, channel_id: cid, guild_id: gid, author: { id: bot, username: 'fixture', discriminator: '0' }, content: 'private fixture text',
        embeds: [{ title: 'Current post', description: 'source description' }, { title: 'Quoted post', description: 'quoted description' }], attachments: [],
        components: [{ type: 1, components: [{ type: 2, style: 2, label: 'Grid', custom_id: `tg:${galleryId}:0:open` },
            { type: 2, style: 2, label: 'Delete', custom_id: 'delete' }] }] };
    const source = new Message(client, raw), payload = { id: galleryId, lockId: galleryId, kind: 'twitter-image-grid-v1',
        partsState: 'complete', totalParts: 1, completedParts: 1, messageIds: [mid], partSignatures: [cards.fingerprint(source)] };
    const row = () => ({ provider_id: 'twitter', message_id: mid, payload, payload_json: JSON.stringify(payload) });
    let now = 1000, allowed = true, rowExists = true, dbExists = true, accessCalls = 0, failAtAccess = 0, executed = 0, firstView;
    const channel = { id: cid, guildId: gid, messages: { fetch: async () => source } };
    const access = { channel, member: { _roles: [] }, permissions: { has: () => true } };
    const db = { withDatabaseTransaction: async fn => fn(async () => dbExists ? [row()] : []), queryDatabaseIndependent: async () => [] };
    const settings = { enabled: true, button_disabled: { user: [], role: [], channel: [] }, button_invisible: {} };
    const deps = { db, storage: { get: async () => rowExists ? row() : null }, now: () => now,
        freshAccess: async () => { accessCalls++; return allowed && accessCalls !== failAtAccess ? access : null; }, getSettings: async () => settings,
        handlers: { delete: { handle: async interaction => { assert.equal(interaction.message, source); executed++; } } }, buildButtons: () => ({}) };
    const original = { guildId: gid, channelId: cid, user: { id: uid }, client, locale: 'ja', customId: 'delete', message: source, deferred: true, ephemeral: true,
        channel, editReply: async view => { firstView = view; } };
    const offer = async () => { await confirm.offer(original, deps); return firstView.components[0].components[0].custom_id; };
    const click = customId => { const interaction = { guildId: gid, channelId: cid, user: { id: uid }, client, locale: 'ja', customId,
        message: { ephemeral: true }, channel, deferReply: async () => { interaction.deferred = true; interaction.ephemeral = true; } }; return interaction; };
    return { source, raw, payload, row, db, settings, deps, original, channel, client, offer, click,
        get view() { return firstView; }, get executed() { return executed; }, advance: ms => { now += ms; },
        setAllowed: value => { allowed = value; }, setRowExists: value => { rowExists = value; },
        setDbExists: value => { dbExists = value; }, setAccessFailure: count => { failAtAccess = count; } };
}
test('a private review shows current source and executes exactly once for its owner', async () => {
    const f = fixture(), token = await f.offer();
    assert.match(f.view.content, /現在の投稿/); assert.match(f.view.embeds[0].description, /quoted description/);
    assert.deepEqual(f.view.allowedMentions.parse, []); assert.match(f.view.embeds[0].url, /^https:\/\/discord.com\/channels\//);
    const stored = [...confirm._internal.tokens.values()].at(-1);
    assert.equal(JSON.stringify(stored).includes('private fixture text'), false);
    await confirm.confirm(f.click(token), f.deps); assert.equal(f.executed, 1);
    await assert.rejects(confirm.confirm(f.click(token), f.deps), /GRID_SOURCE_CHANGED/); assert.equal(f.executed, 1);
});
test('confirmation uses the actual Twitter default and respects an explicit disable', async () => {
    const f = fixture(), settings = require('../../src/providers/_provider_settings');
    const provider = require('../../src/providers/twitter');
    const isolatedGuild = '987654321098765432';
    f.original.guildId = isolatedGuild;
    f.source.guildId = isolatedGuild;
    f.channel.guildId = isolatedGuild;
    delete f.deps.getSettings;
    assert.equal(provider.enabledByDefault, true);
    assert.equal((await settings.getFreshProviderSettings(provider, isolatedGuild)).enabled, true);
    await confirm.offer(f.original, f.deps);
    assert.ok(f.view.components[0].components[0].custom_id.startsWith('gcf:'));
    await settings.setSetting(provider, 'enabled', isolatedGuild, false);
    await assert.rejects(confirm.offer(f.original, f.deps), /GRID_SOURCE_CHANGED/);
});
test('private confirmation also works when a split record has no visible grid button', async () => {
    const f = fixture();
    f.payload.headless = true; f.payload.isPrimary = true; f.payload.totalParts = f.payload.completedParts = 2;
    f.payload.messageIds = [mid, '666666666666666666'];
    f.source.components[0].components.shift();
    f.source.embeds[0].data.url = 'https://x.com/example/status/123';
    f.payload.partSignatures = [cards.fingerprint(f.source), '0'.repeat(64)];
    const second = { id: f.payload.messageIds[1], author: { id: bot }, content: '', embeds: [], components: [], attachments: [] };
    f.payload.partSignatures[1] = cards.fingerprint(second);
    f.channel.messages.fetch = async ({ message }) => message === mid ? f.source : second;
    f.db.queryDatabase = async () => [{ gallery_id: galleryId, payload_json: JSON.stringify(f.payload) }];
    f.deps.storage.get = async () => f.row();
    await confirm.offer(f.original, { ...f.deps, galleryId });
    const token = f.view.components[0].components[0].custom_id;
    // This test checks the full owner/scope/snapshot verification path; the
    // action itself is mocked so that it does not alter the fixture messages.
    await confirm.confirm(f.click(token), f.deps);
    assert.equal(f.executed, 1);
});
test('another user, guild or channel cannot consume the owner token', async () => {
    const f = fixture(), token = await f.offer();
    for (const patch of [{ user: { id: '999999999999999999' } }, { guildId: '777777777777777777' }, { channelId: '888888888888888888' }])
        await assert.rejects(confirm.confirm(Object.assign(f.click(token), patch), f.deps), /GRID_SOURCE_CHANGED/);
    await confirm.confirm(f.click(token), f.deps); assert.equal(f.executed, 1);
});
test('expired tokens, revoked access and disabled settings fail before action', async () => {
    for (const change of [f => f.advance(confirm._internal.TTL), f => f.setAllowed(false),
        f => { f.settings.button_disabled.user.push(uid); }, f => { f.settings.button_invisible.delete = true; }, f => { f.settings.enabled = false; }]) {
        const f = fixture(), token = await f.offer(); change(f);
        await assert.rejects(confirm.confirm(f.click(token), f.deps), /GRID_SOURCE_CHANGED/); assert.equal(f.executed, 0);
    }
});
test('permission loss while waiting for the message lock stops the action', async () => {
    const f = fixture(), token = await f.offer(); f.setAccessFailure(3);
    await assert.rejects(confirm.confirm(f.click(token), f.deps), /GRID_SOURCE_CHANGED/); assert.equal(f.executed, 0);
});
test('changed source, changed quote, removed action and missing database row are rejected', async () => {
    for (const change of [f => { f.source.content = 'changed'; }, f => { f.source.embeds[1].data.description = 'changed quote'; },
        f => { f.source.components[0].components[1].data.disabled = true; }, f => f.setRowExists(false), f => f.setDbExists(false)]) {
        const f = fixture(), token = await f.offer(); change(f);
        await assert.rejects(confirm.confirm(f.click(token), f.deps), /GRID_SOURCE_CHANGED|GRID_LOCK_UNAVAILABLE/); assert.equal(f.executed, 0);
    }
});
test('access loss or foreign author prevents exposing the preview', async () => {
    for (const change of [f => f.setAllowed(false), f => { f.client.user = { id: '999999999999999999' }; }, f => f.setRowExists(false)]) {
        const f = fixture(); change(f);
        await assert.rejects(f.offer(), /GRID_SOURCE_CHANGED/); assert.equal(f.view, undefined);
    }
});
test('a public or non-deferred reply never reveals the current post', async () => {
    for (const patch of [{ deferred: false }, { ephemeral: false }]) {
        const f = fixture(); Object.assign(f.original, patch);
        await assert.rejects(f.offer(), /GRID_SOURCE_CHANGED/); assert.equal(f.view, undefined);
    }
    const f = fixture(), token = await f.offer(), click = f.click(token);
    click.deferReply = async () => { click.deferred = true; click.ephemeral = false; };
    await assert.rejects(confirm.confirm(click, f.deps), /GRID_SOURCE_CHANGED/); assert.equal(f.executed, 0);
});
test('an interaction snapshot matching the fetched message keeps the original direct action', async () => {
    const f = fixture(); let count = 0;
    await cards.withMessageLock(f.original, async () => { count++; }, f.db);
    assert.equal(count, 1); assert.equal(f.view, undefined);
});
test('the component event routes a stale message to private review and then to the original handler', async () => {
    const f = fixture(), modulePath = require.resolve('../../src/handlers/messageComponents');
    const permission = require('../../src/components/_permissionCheck'), tracking = require('../../src/errorTracking');
    const patches = [
        mock.method(permission, 'isAllowed', async () => true),
        ...['recordAnalyticsEvent', 'recordError', 'recordMetric'].map(name => mock.method(tracking, name, () => {})),
        mock.method(tracking, 'runWithErrorContext', (_context, fn) => fn()),
    ];
    const realOffer = confirm.offer, realConfirm = confirm.confirm, realLock = cards.withMessageLock;
    patches.push(mock.method(confirm, 'offer', interaction => realOffer(interaction, f.deps)));
    patches.push(mock.method(confirm, 'confirm', interaction => realConfirm(interaction, f.deps)));
    patches.push(mock.method(cards, 'withMessageLock', (interaction, work, db, options) => realLock(interaction, work, db || f.db, options)));
    delete require.cache[modulePath];
    try {
        const { Events, InteractionType } = require('discord.js');
        require(modulePath).register(f.client);
        const listener = f.client.listeners(Events.InteractionCreate).at(-1);
        f.original.type = InteractionType.MessageComponent;
        f.original.message = new Message(f.client, { ...f.raw, embeds: [] });
        f.original.deferReply = async () => { f.original.deferred = true; f.original.ephemeral = true; };
        await listener(f.original);
        const token = f.view.components[0].components[0].custom_id;
        assert.match(token, /^gcf:/); assert.equal(f.executed, 0);
        const accepted = f.click(token); accepted.type = InteractionType.MessageComponent;
        await listener(accepted);
        assert.equal(f.executed, 1);
    } finally {
        f.client.removeAllListeners(); delete require.cache[modulePath];
        for (const patch of patches.reverse()) patch.mock.restore();
    }
});

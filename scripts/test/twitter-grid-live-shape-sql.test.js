'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client, Message } = require('discord.js');
const { createTestDatabase } = require('../lib/automation-test-db');
const cards = require('../../src/twitterGridCards');
const gallery = require('../../src/mediaGallery');
const grid = require('../../src/components/twitterGrid');
const schema = require('../../src/db_schema');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (![33621, 33622].includes(port)) throw Error('Explicit isolated DB port required');
const guildId = '333333333333333333', channelId = '444444444444444444';
const user = '111111111111111111', bot = '222222222222222222';
const image = n => `https://pbs.twimg.com/media/photo${n}.jpg`;
const settings = { enabled: true, defaultLanguage: 'ja', button_disabled: { user: [], role: [], channel: [] }, twitter_grid_replace_permission: 'restricted' };

async function fixture({ sharedInline = false, hideEmbeddedAttachments = false } = {}) {
    const db = await createTestDatabase(port);
    const sql = fs.readFileSync(path.join(schema.MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
    await db.queryDatabase(schema._internal.splitSqlStatements(sql).find(s => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(s)));
    const storage = gallery.createStore(db), client = new Client({ intents: [] });
    client.user = { id: bot };
    const urls = Array.from({ length: 13 }, (_, i) => image(i));
    const firstPart = { imageUrls: urls.slice(0, 10), sequence: 0, totalParts: 2, embedStart: 0, embedEnd: 1 };
    const secondPart = { imageUrls: urls.slice(10), sequence: 1, totalParts: 2 };
    const embeds = [{ title: 'Post', description: 'Body', url: 'https://x.com/example/status/123' }];
    if (sharedInline) embeds.push({ title: 'Quote', url: 'https://x.com/quoted/status/456', image: { url: image(20) } }, { image: { url: image(21) } });
    const inline = sharedInline ? [{ imageUrls: [image(20), image(21)], sequence: 0, totalParts: 1, embedStart: 1, embedEnd: 3 }] : [];
    const prepared = await cards.prepare({ files: urls.slice(0, 10), embeds, twitterGrid: firstPart,
        ...(sharedInline ? { twitterGridSharedInline: true, twitterGridInline: inline } : {}),
        components: [{ type: 1, components: [{ type: 2, style: 4, label: 'Delete', custom_id: 'delete' }] }] }, { guildId, channelId, author: { id: user } },
    { providerId: 'twitter', presentationSettings: settings }, storage, [{ files: urls.slice(10), twitterGrid: secondPart }]);
    const attachment = (id, filename) => ({ id: String(id), filename, size: 4, content_type: 'image/jpeg',
        url: `https://cdn.discordapp.com/attachments/${channelId}/${id}/${filename}?ex=1&is=2&hm=abc`,
        proxy_url: `https://media.discordapp.net/attachments/${channelId}/${id}/${filename}?ex=1&is=2&hm=abc` });
    const firstId = '555555555555555555', secondId = '666666666666666666';
    const first = new Message(client, { id: firstId, channel_id: channelId, guild_id: guildId, author: { id: bot, username: 'bot', discriminator: '0' },
        content: '', embeds, components: prepared.step.components,
        attachments: Array.from({ length: 10 }, (_, i) => attachment(700000000000000000n + BigInt(i), `photo${i}.jpg`)) });
    const second = new Message(client, { id: secondId, channel_id: channelId, guild_id: guildId, author: { id: bot, username: 'bot', discriminator: '0' },
        content: '', embeds: [], components: [], attachments: Array.from({ length: 3 }, (_, i) => attachment(710000000000000000n + BigInt(i), `photo${i + 10}.jpg`)) });
    const entries = new Map([[firstId, first], [secondId, second]]), editEvents = [], deleted = [];
    let nextId = 800000000000000000n, revision = 0;
    let serverFiles = new Map([...first.attachments.values()].map(file => [String(file.id), attachment(file.id, file.name)]));
    first.edit = async request => {
        const kept = request.attachments.map(item => serverFiles.get(String(item.id)));
        if (kept.some(item => !item)) throw new Error('attempted to retain an unknown attachment');
        const name = request.files[0].name, file = attachment(String(++nextId), name);
        const embeds = request.embeds.map(item => ({ ...item, image: item.image?.url === `attachment://${name}`
            ? { url: file.url } : item.image }));
        serverFiles = new Map([...kept, file].map(item => [String(item.id), item]));
        const visible = hideEmbeddedAttachments ? [...serverFiles.values()].filter(item => !embeds.some(embed => {
            try { return new URL(embed.image?.url).pathname === new URL(item.url).pathname; } catch { return false; }
        })) : [...serverFiles.values()];
        editEvents.push({ id: file.id, name });
        first._patch({ id: firstId, channel_id: channelId, guild_id: guildId, embeds, attachments: visible });
        return first;
    };
    second.delete = async () => { deleted.push(secondId); entries.delete(secondId); };
    const channel = { id: channelId, guildId, nsfw: false, messages: { fetch: async ({ message }) => {
        const result = entries.get(String(message));
        if (!result) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        // Each REST fetch may return a fresh signed URL for the same file.
        revision++;
        for (const file of result.attachments.values()) {
            const refreshed = new URL(file.url); refreshed.searchParams.set('ex', revision.toString(16));
            file.url = refreshed.toString();
        }
        for (const embed of result.embeds) {
            if (!embed.data.image?.url?.startsWith('https://cdn.discordapp.com/')) continue;
            const refreshed = new URL(embed.data.image.url); refreshed.searchParams.set('ex', revision.toString(16));
            embed.data.image.url = refreshed.toString();
        }
        return result;
    } } };
    const [item] = prepared.grids;
    assert.equal(await cards.bind(item, first, storage, db, firstPart), true);
    assert.equal(await cards.append(item, secondPart, second, db), true);
    assert.equal((await cards.finish(item, db)).state, 'complete');
    if (sharedInline) {
        assert.equal(await cards.bind(prepared.grids[1], first, storage, db), true);
        assert.equal((await cards.finish(prepared.grids[1], db)).state, 'complete');
    }
    const calls = [];
    const interaction = { customId: `tg:${item.id}:0:open`, guildId, channelId, locale: 'ja', user: { id: user }, client,
        memberPermissions: { has: () => true }, message: first, channel,
        deferReply: async () => {}, deferUpdate: async () => {}, reply: async value => calls.push(value), editReply: async value => calls.push(value) };
    const deps = { db, storage, getSettings: async () => settings, isAllowed: async () => true,
        freshAccess: async () => ({ channel, member: { _roles: [] }, permissions: { has: () => true }, guild: { ownerId: user } }),
        compose: async urls => { assert.deepEqual(urls, urls.length === 13 ? Array.from({ length: 13 }, (_, i) => image(i)) : [image(20), image(21)]);
            return { data: Buffer.from('composite'), filename: 'grid.jpg' }; } };
    const ephemeral = () => new Message(client, { id: '999999999999999999', channel_id: channelId, guild_id: guildId,
        author: { id: bot, username: 'bot', discriminator: '0' }, content: '', embeds: [], components: [], attachments: [], flags: 64 });
    return { db, item, quote: prepared.grids[1], first, second, entries, deleted, editEvents, interaction, deps, calls, ephemeral };
}

async function replaceFromFreshClick(f, galleryId = f.item.id) {
    const { interaction, deps, calls } = f;
    interaction.customId = `tg:${galleryId}:0:open`; interaction.message = f.first;
    await grid.handle(interaction, deps);
    let panel = calls.at(-1);
    assert.ok(panel.components?.length, `open failed: ${panel.content}`);
    interaction.customId = panel.components[3].components[0].custom_id; interaction.values = ['r']; interaction.message = f.ephemeral();
    await grid.handle(interaction, deps);
    panel = calls.at(-1); assert.ok(panel.components?.length, `target failed: ${panel.content}`);
    interaction.customId = panel.components[4].components[0].custom_id; interaction.values = undefined;
    await grid.handle(interaction, deps);
    panel = calls.at(-1); assert.equal(panel.components?.[0]?.components?.[0]?.label, '置き換える', panel.content);
    interaction.customId = panel.components[0].components[0].custom_id;
    await grid.handle(interaction, deps);
    return calls.at(-1);
}

test('two fresh clicks replace the complete split gallery with distinct Discord attachment IDs', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        assert.match((await replaceFromFreshClick(f)).content, /公開画像を置き換えました/);
        assert.deepEqual(f.deleted, [f.second.id]); assert.equal(f.entries.has(f.second.id), false);
        assert.match((await replaceFromFreshClick(f)).content, /公開画像を置き換えました/);
        assert.equal(f.editEvents.length, 2); assert.notEqual(f.editEvents[0].id, f.editEvents[1].id);
        assert.equal(f.first.attachments.size, 1); assert.deepEqual(f.deleted, [f.second.id]);
    } finally { await f.db.close(); }
});

test('a failed continuation deletion stays visible, then a fresh click completes the new replacement', { timeout: 60000 }, async () => {
    const f = await fixture(), remove = f.second.delete;
    let attempts = 0;
    f.second.delete = async () => { if (++attempts === 1) throw new Error('temporary failure'); return remove(); };
    try {
        assert.match((await replaceFromFreshClick(f)).content, /後続の画像は残っています/);
        assert.equal(f.entries.has(f.second.id), true); assert.equal(f.editEvents.length, 1);
        assert.match((await replaceFromFreshClick(f)).content, /公開画像を置き換えました/);
        assert.equal(f.entries.has(f.second.id), false); assert.equal(attempts, 2);
        assert.equal(f.editEvents.length, 2); assert.notEqual(f.editEvents[0].id, f.editEvents[1].id);
    } finally { await f.db.close(); }
});

test('loss of access between fresh clicks preserves the combined message and submits no second edit', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        assert.match((await replaceFromFreshClick(f)).content, /公開画像を置き換えました/);
        const oldId = [...f.first.attachments.values()][0].id;
        f.deps.freshAccess = async () => null;
        f.interaction.customId = `tg:${f.item.id}:0:open`; f.interaction.message = f.first;
        await grid.handle(f.interaction, f.deps);
        assert.match(f.calls.at(-1).content, /画像を表示できません/);
        assert.equal(f.editEvents.length, 1); assert.equal([...f.first.attachments.values()][0].id, oldId);
    } finally { await f.db.close(); }
});

test('loss of access after selecting replacement prevents the first edit and all deletions', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        await grid.handle(f.interaction, f.deps);
        let panel = f.calls.at(-1);
        f.interaction.customId = panel.components[3].components[0].custom_id;
        f.interaction.values = ['r']; f.interaction.message = f.ephemeral();
        await grid.handle(f.interaction, f.deps);
        panel = f.calls.at(-1); f.interaction.customId = panel.components[4].components[0].custom_id;
        await grid.handle(f.interaction, f.deps);
        panel = f.calls.at(-1); f.interaction.customId = panel.components[0].components[0].custom_id;
        f.deps.freshAccess = async () => null;
        await grid.handle(f.interaction, f.deps);
        assert.match(f.calls.at(-1).content, /画像を表示できません/);
        assert.equal(f.editEvents.length, 0); assert.equal(f.entries.has(f.second.id), true);
    } finally { await f.db.close(); }
});

test('fresh parent and quote clicks preserve each other across repeated replacements', { timeout: 60000 }, async () => {
    const f = await fixture({ sharedInline: true });
    try {
        assert.match((await replaceFromFreshClick(f)).content, /公開画像を置き換えました/);
        assert.equal(f.entries.has(f.second.id), false);
        assert.match((await replaceFromFreshClick(f, f.quote.id)).content, /公開画像を置き換えました/);
        assert.match((await replaceFromFreshClick(f)).content, /公開画像を置き換えました/);
        assert.equal(f.first.attachments.size, 2);
        assert.ok([...f.first.attachments.values()].some(file => file.name.includes(f.item.id)));
        assert.ok([...f.first.attachments.values()].some(file => file.name.includes(f.quote.id)));
    } finally { await f.db.close(); }
});

test('an embed-only Discord marker completes the first replacement and supports a later replacement', { timeout: 60000 }, async () => {
    const f = await fixture({ hideEmbeddedAttachments: true });
    try {
        assert.match((await replaceFromFreshClick(f)).content, /公開画像を置き換えました/);
        assert.equal(f.first.attachments.size, 0); assert.equal(f.entries.has(f.second.id), false);
        let executed = 0;
        f.interaction.message = f.first;
        await cards.withMessageLock(f.interaction, async () => { executed++; }, f.db);
        assert.equal(executed, 1, 'a bound hidden marker must still authorize the guarded existing action');
        const confirm = require('../../src/components/twitterGridConfirm');
        let preview;
        const oldAction = { ...f.interaction, customId: `delete:sl1:${f.item.id}`, message: f.first, deferred: true, ephemeral: true,
            editReply: async value => { preview = value; } };
        await confirm.offer(oldAction, { ...f.deps, galleryId: f.item.id });
        assert.ok(preview.components?.[0]?.components?.[0]?.custom_id.startsWith('gcf:'), 'private confirmation handles already-deleted continuation');
        assert.match((await replaceFromFreshClick(f)).content, /公開画像を置き換えました/);
        assert.equal(f.first.attachments.size, 0); assert.equal(f.editEvents.length, 2);
        assert.notEqual(f.editEvents[0].id, f.editEvents[1].id);
    } finally { await f.db.close(); }
});

test('an old partial with an embed-only marker resumes without deleting an unrelated message', { timeout: 60000 }, async () => {
    const f = await fixture({ hideEmbeddedAttachments: true });
    try {
        const row = await f.deps.storage.get(f.item.id, guildId, channelId);
        const payload = grid._internal.editPayload(f.first, row.payload, { data: Buffer.from('previous'), filename: 'grid.jpg' });
        await f.first.edit(payload);
        const pending = { ...row.payload, replacePhase: 'partial' };
        await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(pending), f.item.id]);
        assert.equal(f.first.attachments.size, 0); assert.equal(f.entries.has(f.second.id), true);
        assert.match((await replaceFromFreshClick(f)).content, /公開画像を置き換えました/);
        assert.equal(f.entries.has(f.second.id), false); assert.deepEqual(f.deleted, [f.second.id]);
        assert.equal(f.editEvents.length, 2);
    } finally { await f.db.close(); }
});

test('forged or ambiguous embedded markers never authorize a continuation deletion', { timeout: 60000 }, async () => {
    for (const scenario of ['host', 'channel', 'duplicate', 'author']) {
        const f = await fixture({ hideEmbeddedAttachments: true });
        try {
            const row = await f.deps.storage.get(f.item.id, guildId, channelId);
            const edit = grid._internal.editPayload(f.first, row.payload, { data: Buffer.from('previous'), filename: 'grid.jpg' });
            await f.first.edit(edit);
            await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?',
                [JSON.stringify({ ...row.payload, replacePhase: 'partial' }), f.item.id]);
            const marker = f.first.embeds[0].data.image.url;
            if (scenario === 'host') f.first.embeds[0].data.image.url = marker.replace('cdn.discordapp.com', 'attacker.example');
            if (scenario === 'channel') f.first.embeds[0].data.image.url = marker.replace(channelId, '999999999999999999');
            if (scenario === 'duplicate') f.first.embeds.push({ image: { url: marker } });
            if (scenario === 'author') f.first.author = { id: '999999999999999999' };
            f.interaction.customId = `tg:${f.item.id}:0:open`; f.interaction.message = f.first;
            await grid.handle(f.interaction, f.deps);
            assert.equal(f.entries.has(f.second.id), true, scenario);
            assert.deepEqual(f.deleted, [], scenario);
            assert.equal(f.editEvents.length, 1, scenario);
        } finally { await f.db.close(); }
    }
});

test('a stale GET after an accepted hidden-marker edit never deletes a continuation and can be resumed', { timeout: 60000 }, async () => {
    const f = await fixture({ hideEmbeddedAttachments: true }), stale = f.first._clone();
    const originalEdit = f.first.edit, originalFetch = f.interaction.channel.messages.fetch;
    let staleNext = false, injected = false;
    f.first.edit = async payload => {
        const result = await originalEdit(payload);
        if (!injected) { injected = true; staleNext = true; }
        return result;
    };
    f.interaction.channel.messages.fetch = async request => {
        if (staleNext && request.message === f.first.id) { staleNext = false; return stale; }
        return originalFetch(request);
    };
    try {
        assert.match((await replaceFromFreshClick(f)).content, /後続の画像は残っています/);
        assert.equal(f.entries.has(f.second.id), true); assert.deepEqual(f.deleted, []);
        assert.match((await replaceFromFreshClick(f)).content, /公開画像を置き換えました/);
        assert.equal(f.entries.has(f.second.id), false); assert.deepEqual(f.deleted, [f.second.id]);
    } finally { await f.db.close(); }
});

test('hidden parent and quote markers remain distinct across repeated replacements', { timeout: 60000 }, async () => {
    const f = await fixture({ sharedInline: true, hideEmbeddedAttachments: true });
    try {
        assert.match((await replaceFromFreshClick(f)).content, /公開画像を置き換えました/);
        assert.match((await replaceFromFreshClick(f, f.quote.id)).content, /公開画像を置き換えました/);
        assert.match((await replaceFromFreshClick(f)).content, /公開画像を置き換えました/);
        assert.equal(f.first.attachments.size, 0);
        assert.ok(f.first.embeds.some(embed => embed.image?.url.includes(f.item.id)));
        assert.ok(f.first.embeds.some(embed => embed.image?.url.includes(f.quote.id)));
    } finally { await f.db.close(); }
});

for (const stage of ['first', 'continuation', 'combined', 'before delete root', 'before delete continuation']) for (const invalid of ['wrong id', 'missing id', 'wrong channel', 'missing channel', 'wrong author']) {
    test(`replacement rejects ${invalid} in the ${stage} REST response`, { timeout: 60000 }, async () => {
        const f = await fixture({ hideEmbeddedAttachments: true });
        try {
            const fetch = f.interaction.channel.messages.fetch;
            const fake = message => new Proxy(message, { get(target, name, receiver) {
                if (name === 'id' && invalid === 'wrong id') return '987654321098765432';
                if (name === 'id' && invalid === 'missing id') return undefined;
                if (name === 'channelId' && invalid === 'wrong channel') return '987654321098765432';
                if (name === 'channelId' && invalid === 'missing channel') return undefined;
                if (name === 'author' && invalid === 'wrong author') return { id: '987654321098765432' };
                return Reflect.get(target, name, receiver);
            } });
            let rootAfterEditFetches = 0, continuationAfterEditFetches = 0;
            f.interaction.channel.messages.fetch = async request => {
                const message = await fetch(request);
                if (f.editEvents.length && request.message === f.first.id) rootAfterEditFetches++;
                if (f.editEvents.length && request.message === f.second.id) continuationAfterEditFetches++;
                const selected = stage === 'first' && request.message === f.first.id && !f.editEvents.length
                    || stage === 'continuation' && request.message === f.second.id && !f.editEvents.length
                    || stage === 'combined' && request.message === f.first.id && rootAfterEditFetches === 1
                    || stage === 'before delete root' && request.message === f.first.id && rootAfterEditFetches === 2
                    || stage === 'before delete continuation' && request.message === f.second.id && continuationAfterEditFetches === 1;
                return selected ? fake(message) : message;
            };
            const row = await f.deps.storage.get(f.item.id, guildId, channelId);
            if (stage === 'first' || stage === 'continuation') {
                const access = await f.deps.freshAccess();
                assert.equal(await grid._internal.sourcesRemainValid(f.interaction, row, access), false);
                await assert.rejects(grid._internal.sourceImageUrls(f.interaction, row, access), /GRID_SOURCE_CHANGED/);
            }
            const status = await grid._internal.replacePublic(f.interaction, row,
                { data: Buffer.from('composite'), filename: 'grid.jpg' }, f.deps);
            const edited = !['first', 'continuation'].includes(stage);
            assert.equal(status, edited ? 'partial' : 'changed');
            assert.equal(f.editEvents.length, edited ? 1 : 0);
            assert.equal(f.entries.has(f.second.id), true);
            assert.deepEqual(f.deleted, []);
        } finally { await f.db.close(); }
    });
}

for (const target of ['root', 'continuation']) for (const invalid of ['wrong id', 'missing id', 'wrong channel', 'missing channel', 'wrong author']) {
    test(`image source resolution rejects ${invalid} in a later ${target} fetch`, { timeout: 60000 }, async () => {
        const f = await fixture({ hideEmbeddedAttachments: true });
        try {
            const fetch = f.interaction.channel.messages.fetch, counts = new Map();
            f.interaction.channel.messages.fetch = async request => {
                const message = await fetch(request), count = (counts.get(request.message) || 0) + 1;
                counts.set(request.message, count);
                const targetId = target === 'root' ? f.first.id : f.second.id;
                if (request.message !== targetId || count !== 2) return message;
                return new Proxy(message, { get(actual, name, receiver) {
                    if (name === 'id' && invalid === 'wrong id') return '987654321098765432';
                    if (name === 'id' && invalid === 'missing id') return undefined;
                    if (name === 'channelId' && invalid === 'wrong channel') return '987654321098765432';
                    if (name === 'channelId' && invalid === 'missing channel') return undefined;
                    if (name === 'author' && invalid === 'wrong author') return { id: '987654321098765432' };
                    return Reflect.get(actual, name, receiver);
                } });
            };
            const row = await f.deps.storage.get(f.item.id, guildId, channelId);
            await assert.rejects(grid._internal.sourceImageUrls(f.interaction, row, await f.deps.freshAccess()), /GRID_SOURCE_CHANGED/);
            assert.equal(f.editEvents.length, 0); assert.deepEqual(f.deleted, []);
        } finally { await f.db.close(); }
    });
}

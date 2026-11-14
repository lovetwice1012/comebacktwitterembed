'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestDatabase } = require('../lib/automation-test-db');
const gallery = require('../../src/mediaGallery');
const cards = require('../../src/twitterGridCards');
const grid = require('../../src/components/twitterGrid');
const schema = require('../../src/db_schema');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (![33621, 33622].includes(port)) throw Error('Explicit isolated DB port required');
const gid = '333333333333333333', cid = '444444444444444444', user = '111111111111111111', bot = '222222222222222222';
const image = n => `https://pbs.twimg.com/media/image${n}.jpg`;
const buttons = {
    showMediaAsAttachmentsButton: { type: 2, style: 2, label: 'Attachments', custom_id: 'showMediaAsAttachments' },
    showAttachmentsAsMediaButton: { type: 2, style: 2, label: 'Embed', custom_id: 'showAttachmentsAsEmbedsImage' },
    translateButton: { type: 2, style: 2, label: 'Translate', custom_id: 'translate' }, deleteButton: { type: 2, style: 2, label: 'Delete', custom_id: 'delete' },
};

async function fixture({ quote = false, nonImage = null, hideEmbeddedAttachments = false, discordMessages = false, firstPhotoCount = 10 } = {}) {
    const db = await createTestDatabase(port);
    const sql = fs.readFileSync(path.join(schema.MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
    await db.queryDatabase(schema._internal.splitSqlStatements(sql).find(s => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(s)));
    const locatorSql = fs.readFileSync(path.join(schema.MIGRATIONS_DIR, '20261113_add_twitter_gallery_locator_index.sql'), 'utf8');
    for (const statement of schema._internal.splitSqlStatements(locatorSql)) await db.queryDatabase(statement);
    const journalSql = fs.readFileSync(path.join(schema.MIGRATIONS_DIR, '20261113_add_twitter_grid_action_intents.sql'), 'utf8');
    for (const statement of schema._internal.splitSqlStatements(journalSql)) await db.queryDatabase(statement);
    const storage = gallery.createStore(db), settings = { enabled: true, defaultLanguage: 'ja', twitter_grid_replace_permission: 'restricted' };
    const urls = Array.from({ length: 13 }, (_, i) => image(i + 1));
    const parts = [urls.slice(0, firstPhotoCount), urls.slice(firstPhotoCount)];
    const metadata = parts.map((imageUrls, sequence) => ({ imageUrls, sequence, totalParts: 2 }));
    if (nonImage) metadata[1].containsNonImage = true;
    if (quote) Object.assign(metadata[0], { embedStart: 0, embedEnd: 1 });
    const quoteUrls = [image('quote1'), image('quote2')];
    const prepared = await cards.prepare({ files: parts[0], twitterGrid: metadata[0],
        ...(quote ? { twitterGridSharedInline: true, twitterGridInline: [{ imageUrls: quoteUrls, sequence: 0, totalParts: 1, embedStart: 1, embedEnd: 3 }] } : {}),
        components: [{ type: 1, components: [buttons.showAttachmentsAsMediaButton, buttons.translateButton, buttons.deleteButton] }] },
        { guildId: gid, channelId: cid, author: { id: user } }, { providerId: 'twitter', presentationSettings: settings }, storage,
        [{ files: parts[1], twitterGrid: metadata[1] }]);
    assert.equal(prepared.grids.length, quote ? 2 : 1);
    let nextId = 100000000000000000n;
    const makeFiles = urls => new Map(urls.map(url => { const id = String(++nextId), name = new URL(url).pathname.split('/').pop(); return [id, { id, name, url: `https://cdn.discordapp.com/attachments/${cid}/${id}/${name}?ex=1&is=2&hm=abc`, contentType: 'image/jpeg' }]; }));
    let first = { id: '555555555555555555', channelId: cid, author: { id: bot }, content: '', embeds: [{ title: 'post', description: '本文', url: 'https://x.com/example/status/123', author: { name: `requester(id:${user})` } }], components: prepared.step.components, attachments: makeFiles(parts[0]) };
    if (quote) first.embeds.push({ title: 'quote', image: { url: quoteUrls[0] } }, { image: { url: quoteUrls[1] } });
    let second = { id: '666666666666666666', channelId: cid, author: { id: bot }, content: '', embeds: [], components: [], attachments: makeFiles(parts[1]) };
    if (nonImage) second.attachments.set('888888888888888888', { id: '888888888888888888', name: nonImage === 'video' ? 'movie.mp4' : 'unknown.bin', url: `https://cdn.discordapp.com/attachments/${gid}/${cid}/${nonImage}`, contentType: nonImage === 'video' ? 'video/mp4' : null });
    let discordClient;
    const apiFile = file => ({ id: file.id, filename: file.name, content_type: file.contentType, size: 4, url: file.url, proxy_url: file.url });
    if (discordMessages) {
        const { Client, Message } = require('discord.js');
        discordClient = new Client({ intents: [] }); discordClient.user = { id: bot };
        const convert = value => new Message(discordClient, { id: value.id, channel_id: cid, guild_id: gid,
            author: { id: bot, username: 'bot', discriminator: '0' }, content: value.content, embeds: value.embeds,
            components: value.components, attachments: [...value.attachments.values()].map(apiFile) });
        first = convert(first); second = convert(second);
    }
    const messages = new Map([[first.id, first], [second.id, second]]), serverByMessage = new Map(), editRequests = [];
    for (const message of messages.values()) {
        // Model Discord GET hiding files that are referenced from Embeds,
        // while retaining those files server-side for later PATCH requests.
        serverByMessage.set(message.id, [...message.attachments.values()]);
        message.edit = async request => {
            editRequests.push({ messageId: message.id, attachments: (request.attachments || []).map(item => String(item.id)) });
            const old = hideEmbeddedAttachments ? serverByMessage.get(message.id) : [...message.attachments.values()];
            // discord.js sends an attachment list for a supplied files array;
            // without an explicit retain list the old files are replaced.
            const retained = request.attachments ? request.attachments.map(item => old.find(file => String(item.id) === file.id)).filter(Boolean) : request.files ? [] : old;
            const added = (request.files || []).map(file => { const url = typeof file === 'string' ? file : file.attachment; const name = typeof file === 'string' ? new URL(url).pathname.split('/').pop() : file.name; const id = String(++nextId); return { id, name, contentType: 'image/jpeg', url: `https://cdn.discordapp.com/attachments/${cid}/${id}/${name}` }; });
            const serverFiles = [...retained, ...added]; serverByMessage.set(message.id, serverFiles);
            const embeds = request.embeds ? request.embeds.map(embed => ({ ...embed, image: embed.image?.url?.startsWith('attachment://') ? { url: [...retained, ...added].find(file => file.name === embed.image.url.slice(13))?.url } : embed.image }))
                : message.embeds.map(embed => embed?.toJSON ? embed.toJSON() : embed);
            const usedUrls = new Set(embeds.map(embed => embed.image?.url).filter(Boolean));
            const visible = hideEmbeddedAttachments ? serverFiles.filter(file => !usedUrls.has(file.url)) : serverFiles;
            if (discordMessages) message._patch({ id: message.id, channel_id: cid, guild_id: gid, embeds,
                attachments: visible.map(apiFile), ...(request.components ? { components: request.components } : {}) });
            else {
                message.attachments = new Map(visible.map(file => [file.id, file]));
                message.embeds = embeds;
                if (request.components) message.components = request.components;
            }
            return message;
        };
        message.delete = async () => messages.delete(message.id);
    }
    const item = prepared.grids[0];
    assert.equal(await cards.bind(item, first, storage, db, metadata[0]), true);
    assert.equal(await cards.append(item, metadata[1], second, db), true);
    assert.equal((await cards.finish(item, db)).state, 'complete');
    if (quote) {
        assert.equal(await cards.bind(prepared.grids[1], first, storage, db), true);
        assert.equal((await cards.finish(prepared.grids[1], db)).state, 'complete');
    }
    const channel = { nsfw: false, messages: { fetch: async ({ message }) => { const found = messages.get(message); if (!found) throw Object.assign(new Error('deleted'), { code: 10008 }); return found; } } };
    const interaction = { guildId: gid, channelId: cid, locale: 'ja', user: { id: user }, client: { user: { id: bot } }, memberPermissions: { has: () => true }, channel, message: first, editReply: async () => {}, deleteReply: async () => {} };
    const deps = { db, storage, getSettings: async () => settings, freshAccess: async () => ({ permissions: { has: () => true }, member: { _roles: [] }, channel }),
        fetchTwitterMedia: async () => ({ data: Buffer.from('validated image fixture'), format: 'jpeg' }) };
    return { db, storage, item, quote: prepared.grids[1], quoteUrls, interaction, first, second, messages, urls, deps, serverByMessage, editRequests };
}

async function perform(f, moduleName, translateOriginal = false, db = f.db) {
    const settings = require('../../src/settings');
    const filter = mock.method(settings, 'checkComponentIncludesDisabledButtonAndIfFindDeleteIt', async value => value);
    const providerSettings = require('../../src/providers/_provider_settings');
    const translation = mock.method(providerSettings, 'getSetting', async () => translateOriginal);
    const fetcher = require('../../src/providerFetch');
    const fetch = mock.method(fetcher, 'withDeadline', () => async () => ({ ok: true, text: async () => 'translated text' }));
    const modulePath = require.resolve(`../../src/components/${moduleName}`);
    delete require.cache[modulePath];
    try {
        const control = f.first.components.flatMap(row => row.components || []).find(component =>
            String(component.custom_id || component.customId || '').split(':')[0] === moduleName);
        f.interaction.customId = control?.custom_id || control?.customId || moduleName;
        const handler = require(modulePath);
        await cards.withMessageLock(f.interaction, group => handler.handle(f.interaction, { buttons, ...group }), db,
            { action: moduleName, buttons, freshAccess: f.deps.freshAccess, getSettings: f.deps.getSettings, fetchTwitterMedia: f.deps.fetchTwitterMedia,
                operationNow: f.deps.operationNow });
    } finally { delete require.cache[modulePath]; filter.mock.restore(); translation.mock.restore(); fetch.mock.restore(); }
}

test('gallery lookup uses its scoped locator index', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const rows = await f.db.queryDatabase('EXPLAIN SELECT gallery_id,payload_json FROM bot_media_galleries FORCE INDEX (idx_media_galleries_locator) WHERE guild_id=? AND channel_id=? AND message_id=? AND provider_id=? AND expires_at_ms>?',
            [gid, cid, f.first.id, 'twitter', Date.now()]);
        assert.equal(rows[0].key, 'idx_media_galleries_locator');
    } finally { await f.db.close(); }
});
test('the cleanup index migration is safe when the index already exists', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const tracking = schema.SCHEMA_STATEMENTS.find(statement => /^CREATE TABLE IF NOT EXISTS schema_migrations\s*\(/.test(statement));
        await f.db.queryDatabase(tracking);
        await schema._internal.applyMigrationFile(f.db.queryDatabase, '20261113_add_twitter_grid_intent_age_index.sql');
        await schema._internal.applyMigrationFile(f.db.queryDatabase, '20261113_add_twitter_grid_intent_age_index.sql');
        const rows = await f.db.queryDatabase('SHOW INDEX FROM bot_twitter_grid_action_intents WHERE Key_name=?', ['idx_grid_intents_updated']);
        assert.equal(rows.length, 2);
    } finally { await f.db.close(); }
});
test('a confirmed split keeps its action locator and retention until the whole post is deleted', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const read = async () => (await f.db.queryDatabase('SELECT expires_at_ms FROM bot_media_galleries WHERE gallery_id=?', [f.item.id]))[0];
        assert.equal(Number((await read()).expires_at_ms), Number.MAX_SAFE_INTEGER);
        const locate = action => f.first.components.flatMap(row => row.components || []).map(item => item.custom_id || item.customId)
            .find(id => String(id || '').startsWith(`${action}:sl1:`));
        assert.equal(cards.locatorIdFromAction(locate('delete')), f.item.id);
        await perform(f, 'showAttachmentsAsEmbedsImage');
        assert.equal(cards.locatorIdFromAction(locate('showMediaAsAttachments')), f.item.id);
        await perform(f, 'delete');
        assert.ok(Number((await read()).expires_at_ms) < Number.MAX_SAFE_INTEGER);
    } finally { await f.db.close(); }
});

test('existing display toggle updates both parts, keeps the grid control, and supports composition and public replacement', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        // Discord returns CDN attachment URLs rather than the X URL supplied
        // at send time; both representations must remain replaceable.
        for (const message of [f.first, f.second]) for (const file of message.attachments.values())
            file.url = `https://cdn.discordapp.com/attachments/${cid}/${file.id}/${file.name}?ex=1`;
        await perform(f, 'showAttachmentsAsEmbedsImage');
        assert.equal(f.first.embeds.filter(embed => embed.image).length, 10, 'first part is displayed as embeds');
        assert.equal(f.second.embeds.filter(embed => embed.image).length, 3, 'continuation is displayed as embeds');
        assert.equal(cards.gridIdFromMessage(f.first), f.item.id, 'the grid button remains usable');
        const row = await f.storage.get(f.item.id, gid, cid);
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, row), f.urls);
        assert.equal(await grid._internal.replacePublic(f.interaction, row, { data: Buffer.from('combined'), filename: 'twitter-grid.jpg' }, f.deps), 'done');
        assert.equal(f.messages.has(f.second.id), false);
    } finally { await f.db.close(); }
});

for (const quote of [false, true]) test(`real Discord Message: switch to hidden embeds, combine all images, then replace again (quote=${quote})`, { timeout: 60000 }, async () => {
    const f = await fixture({ quote, hideEmbeddedAttachments: true, discordMessages: true });
    try {
        await perform(f, 'showAttachmentsAsEmbedsImage');
        assert.equal(f.second.attachments.size, 0, 'Discord omits the continuation attachments used by embeds');
        assert.equal(f.second.embeds.length, 3);
        const saved = await f.storage.get(f.item.id, gid, cid);
        assert.deepEqual(saved.payload.partContainsNonImage, [false, false]);
        assert.deepEqual(saved.payload.partRefs.flat().map(ref => ref.url), f.urls);
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, saved), f.urls);
        const { Message } = require('discord.js');
        const ephemeral = () => new Message(f.first.client, { id: '999999999999999999', channel_id: cid, guild_id: gid,
            author: { id: bot, username: 'bot', discriminator: '0' }, content: '', embeds: [], components: [], attachments: [], flags: 64 });
        const calls = [];
        Object.assign(f.interaction, { deferReply: async () => {}, deferUpdate: async () => {}, reply: async value => calls.push(value), editReply: async value => calls.push(value) });
        Object.assign(f.deps, { isAllowed: async () => true, compose: async urls => {
            assert.deepEqual(urls, f.urls); return { data: Buffer.from('composite'), filename: 'grid.jpg' };
        } });
        const replace = async () => {
            f.interaction.customId = `tg:${f.item.id}:0:open`; f.interaction.message = f.first;
            await grid.handle(f.interaction, f.deps);
            let panel = calls.at(-1); assert.ok(panel.components?.length, panel.content);
            f.interaction.customId = panel.components[3].components[0].custom_id;
            f.interaction.values = ['r']; f.interaction.message = ephemeral();
            await grid.handle(f.interaction, f.deps);
            panel = calls.at(-1); assert.ok(panel.components?.length, panel.content);
            f.interaction.customId = panel.components[4].components[0].custom_id; f.interaction.values = undefined;
            await grid.handle(f.interaction, f.deps);
            panel = calls.at(-1); assert.equal(panel.components?.[0]?.components?.[0]?.label, '置き換える', panel.content);
            f.interaction.customId = panel.components[0].components[0].custom_id;
            await grid.handle(f.interaction, f.deps);
            assert.match(calls.at(-1).content, /公開画像を置き換えました/);
        };
        await replace(); assert.equal(f.messages.has(f.second.id), false);
        const firstMarker = f.first.embeds.map(embed => embed.image?.url).find(url => url?.includes(`tg-${f.item.id}.`));
        assert.ok(firstMarker); await replace();
        const secondMarker = f.first.embeds.map(embed => embed.image?.url).find(url => url?.includes(`tg-${f.item.id}.`));
        assert.ok(secondMarker); assert.notEqual(new URL(firstMarker).pathname, new URL(secondMarker).pathname);
        if (quote) assert.ok(f.first.embeds.some(embed => embed.title === 'quote'), 'the unrelated quote remains intact');
    } finally { await f.db.close(); }
});

for (const damage of ['missing refs', 'video']) test(`hidden continuation cannot be deleted when saved evidence is ${damage}`, { timeout: 60000 }, async () => {
    const f = await fixture({ hideEmbeddedAttachments: true, discordMessages: true });
    try {
        await perform(f, 'showAttachmentsAsEmbedsImage');
        assert.equal(f.second.attachments.size, 0);
        const row = await f.storage.get(f.item.id, gid, cid), payload = row.payload;
        if (damage === 'missing refs') delete payload.partRefs[1];
        else payload.partContainsNonImage[1] = true;
        await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(payload), f.item.id]);
        const damaged = await f.storage.get(f.item.id, gid, cid), before = cards.fingerprint(f.first);
        const result = await grid._internal.replacePublic(f.interaction, damaged, { data: Buffer.from('combined'), filename: 'grid.jpg' }, f.deps);
        assert.notEqual(result, 'done'); assert.equal(f.messages.has(f.second.id), true);
        assert.equal(cards.fingerprint(f.first), before, 'neither the root nor unrelated content was changed');
    } finally { await f.db.close(); }
});

test('a video-bearing continuation receives actionable private guidance without changing either post', { timeout: 60000 }, async () => {
    const f = await fixture({ nonImage: 'video', discordMessages: true }), calls = [];
    try {
        const { Message } = require('discord.js');
        const beforeFirst = cards.fingerprint(f.first), beforeSecond = cards.fingerprint(f.second);
        const state = { ...grid._internal.defaults({ twitter_grid_replace_permission: 'restricted' }, 13, true), target: 'r' };
        f.interaction.customId = grid._internal.custom(f.item.id, user, 'confirm', state);
        f.interaction.message = new Message(f.first.client, { id: '999999999999999999', channel_id: cid, guild_id: gid,
            author: { id: bot, username: 'bot', discriminator: '0' }, content: '', embeds: [], components: [], attachments: [], flags: 64 });
        f.interaction.deferUpdate = async () => {}; f.interaction.editReply = async value => calls.push(value);
        Object.assign(f.deps, { isAllowed: async () => true, compose: async urls => {
            assert.deepEqual(urls, f.urls); return { data: Buffer.from('composite'), filename: 'grid.jpg' };
        } });
        await grid.handle(f.interaction, f.deps);
        assert.match(calls.at(-1).content, /動画など.*自分にだけ表示/);
        assert.equal(cards.fingerprint(f.first), beforeFirst); assert.equal(cards.fingerprint(f.second), beforeSecond);
        assert.equal(f.messages.has(f.second.id), true);
    } finally { await f.db.close(); }
});

for (const damage of ['missing root refs', 'reordered root refs', 'unknown root media', 'foreign root URL', 'duplicate root image'])
    test(`a ${damage} never authorizes replacement or continuation deletion`, { timeout: 60000 }, async () => {
        const f = await fixture({ hideEmbeddedAttachments: true, discordMessages: true });
        try {
            await perform(f, 'showAttachmentsAsEmbedsImage');
            const row = await f.storage.get(f.item.id, gid, cid), payload = row.payload;
            if (damage === 'missing root refs') delete payload.partRefs[0];
            if (damage === 'reordered root refs') payload.partRefs[0].reverse();
            if (damage === 'unknown root media') payload.partContainsNonImage[0] = null;
            if (damage === 'foreign root URL') f.first.embeds[0].data.image.url = f.first.embeds[0].image.url.replace('cdn.discordapp.com', 'attacker.example');
            if (damage === 'duplicate root image') f.first.embeds[1].data.image.url = f.first.embeds[0].image.url;
            // Exercise the ownership/identity checks even if the saved row is
            // otherwise trusted. Discord's real Message instance is used.
            if (damage === 'foreign root URL' || damage === 'duplicate root image') payload.partSignatures[0] = cards.fingerprint(f.first);
            await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(payload), f.item.id]);
            const damaged = await f.storage.get(f.item.id, gid, cid), before = cards.fingerprint(f.first);
            const result = await grid._internal.replacePublic(f.interaction, damaged, { data: Buffer.from('combined'), filename: 'grid.jpg' }, f.deps);
            assert.notEqual(result, 'done', damage); assert.equal(f.messages.has(f.second.id), true, damage);
            assert.equal(cards.fingerprint(f.first), before, 'the root message is not altered');
        } finally { await f.db.close(); }
    });

test('unexpected hidden CDN content after the combined edit prevents continuation deletion', { timeout: 60000 }, async () => {
    const f = await fixture({ hideEmbeddedAttachments: true, discordMessages: true });
    try {
        await perform(f, 'showAttachmentsAsEmbedsImage');
        const oldEdit = f.first.edit;
        f.first.edit = async request => {
            const result = await oldEdit(request);
            // Discord may expose an upload only in an Embed, not in attachments.
            f.first.embeds.push({ image: { url: `https://cdn.discordapp.com/attachments/${cid}/999999999999999999/unexpected.jpg?ex=1&is=2&hm=abc` } });
            return result;
        };
        const row = await f.storage.get(f.item.id, gid, cid);
        assert.equal(await grid._internal.replacePublic(f.interaction, row, { data: Buffer.from('combined'), filename: 'grid.jpg' }, f.deps), 'partial');
        assert.equal(f.messages.has(f.second.id), true, 'the continuation must not be deleted');
    } finally { await f.db.close(); }
});

test('unexpected hidden content after a resumed final edit cannot be recorded as success', { timeout: 60000 }, async () => {
    const f = await fixture({ hideEmbeddedAttachments: true, discordMessages: true });
    try {
        await perform(f, 'showAttachmentsAsEmbedsImage');
        const originalDelete = f.second.delete; let attempts = 0;
        f.second.delete = async () => { if (++attempts === 1) throw new Error('temporary failure'); return originalDelete(); };
        let row = await f.storage.get(f.item.id, gid, cid);
        assert.equal(await grid._internal.replacePublic(f.interaction, row, { data: Buffer.from('first'), filename: 'grid.jpg' }, f.deps), 'partial');
        const originalEdit = f.first.edit;
        f.first.edit = async request => {
            const result = await originalEdit(request);
            f.first.embeds.push({ image: { url: `https://cdn.discordapp.com/attachments/${cid}/999999999999999999/unexpected.jpg?ex=1&is=2&hm=abc` } });
            return result;
        };
        row = await f.storage.get(f.item.id, gid, cid);
        assert.equal(await grid._internal.replacePublic(f.interaction, row, { data: Buffer.from('second'), filename: 'grid.jpg' }, f.deps), 'unknown');
        assert.equal((await f.storage.get(f.item.id, gid, cid)).payload.replacePhase, 'unknown');
    } finally { await f.db.close(); }
});

for (const scenario of ['normal', 'ack lost', 'database rollback']) test(`combining a quote preserves every hidden parent photo after a display switch: ${scenario}`, { timeout: 60000 }, async () => {
    const f = await fixture({ quote: true, hideEmbeddedAttachments: true, discordMessages: true, firstPhotoCount: 9 });
    try {
        const parentIds = f.serverByMessage.get(f.first.id).map(file => String(file.id));
        await perform(f, 'showAttachmentsAsEmbedsImage');
        assert.equal(f.first.attachments.size, 1, 'eight parent images are hidden by embeds');
        let quote = await f.storage.get(f.quote.id, gid, cid);
        const composed = { data: Buffer.from('quote'), filename: 'grid.jpg' };
        if (scenario === 'ack lost') {
            const original = f.first.edit; let calls = 0;
            f.first.edit = async request => { const message = await original(request); if (++calls === 1) throw new Error('response lost'); return message; };
            assert.equal(await grid._internal.replacePublic(f.interaction, quote, composed, f.deps), 'unknown');
        } else if (scenario === 'database rollback') {
            const failing = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(async query => { await work(query); throw new Error('fixture rollback'); }) };
            await assert.rejects(grid._internal.replacePublic(f.interaction, quote, composed, { ...f.deps, db: failing }), /fixture rollback/);
        } else assert.equal(await grid._internal.replacePublic(f.interaction, quote, composed, f.deps), 'done');
        if (scenario !== 'normal') {
            quote = await f.storage.get(f.quote.id, gid, cid);
            assert.equal(await grid._internal.replacePublic(f.interaction, quote, composed, f.deps), 'done');
        }
        const retained = new Set(f.serverByMessage.get(f.first.id).map(file => String(file.id)));
        assert.ok(parentIds.every(id => retained.has(id)), 'all parent attachments must survive the quote edit');
        assert.ok(parentIds.every(id => f.editRequests.at(-1).attachments.includes(id)), 'PATCH must explicitly retain hidden parent IDs');
    } finally { await f.db.close(); }
});

test('combining a quote with ten hidden/visible parent attachments stops before exceeding Discord capacity', { timeout: 60000 }, async () => {
    const f = await fixture({ quote: true, hideEmbeddedAttachments: true, discordMessages: true });
    try {
        const parentIds = f.serverByMessage.get(f.first.id).map(file => String(file.id));
        await perform(f, 'showAttachmentsAsEmbedsImage');
        const quote = await f.storage.get(f.quote.id, gid, cid), before = cards.fingerprint(f.first), edits = f.editRequests.length;
        assert.equal(await grid._internal.replacePublic(f.interaction, quote, { data: Buffer.from('quote'), filename: 'grid.jpg' }, f.deps), 'attachment_limit');
        assert.equal(f.editRequests.length, edits, 'no PATCH was made'); assert.equal(cards.fingerprint(f.first), before);
        assert.ok(parentIds.every(id => f.serverByMessage.get(f.first.id).some(file => String(file.id) === id)));
    } finally { await f.db.close(); }
});

for (const change of ['foreign host', 'different id', 'reordered embeds', 'changed text']) test(`a changed sibling before the first quote combination is rejected: ${change}`, { timeout: 60000 }, async () => {
    const f = await fixture({ quote: true, hideEmbeddedAttachments: true, discordMessages: true, firstPhotoCount: 9 });
    try {
        await perform(f, 'showAttachmentsAsEmbedsImage');
        const quote = await f.storage.get(f.quote.id, gid, cid), edits = f.editRequests.length;
        const firstImage = f.first.embeds[0].data.image;
        if (change === 'foreign host') firstImage.url = firstImage.url.replace('cdn.discordapp.com', 'attacker.example');
        if (change === 'different id') firstImage.url = firstImage.url.replace(/\/attachments\/\d+\/\d+\//, `/attachments/${cid}/999999999999999999/`);
        if (change === 'reordered embeds') [f.first.embeds[1], f.first.embeds[2]] = [f.first.embeds[2], f.first.embeds[1]];
        if (change === 'changed text') f.first.embeds[0].data.description = 'changed';
        assert.equal(await grid._internal.replacePublic(f.interaction, quote, { data: Buffer.from('quote'), filename: 'grid.jpg' }, f.deps), 'changed');
        assert.equal(f.editRequests.length, edits, 'the Discord PATCH is never sent');
    } finally { await f.db.close(); }
});

for (const scenario of ['normal', 'ack lost', 'database rollback', 'missing sibling', 'bad witness', 'bad static']) test(`replacing a hidden parent marker retains hidden restored quote attachments: ${scenario}`, { timeout: 60000 }, async () => {
    const f = await fixture({ quote: true, hideEmbeddedAttachments: true, discordMessages: true });
    try {
        const parent = await f.storage.get(f.item.id, gid, cid);
        assert.equal(await grid._internal.replacePublic(f.interaction, parent, { data: Buffer.from('parent'), filename: 'grid.jpg' }, f.deps), 'done');
        assert.equal(f.first.attachments.size, 0, 'the parent marker is visible only through its Embed');
        const quoteFiles = [0, 1].map(index => {
            const fileId = String(930000000000000000n + BigInt(index)), name = `restore-${'c'.repeat(32)}-${index}.jpg`;
            return { id: fileId, name, contentType: 'image/jpeg', url: `https://cdn.discordapp.com/attachments/${cid}/${fileId}/${name}?ex=1&is=2&hm=abc` };
        });
        const embeds = f.first.embeds.map(embed => embed.toJSON());
        const quoteStart = embeds.findIndex(embed => embed.title === 'quote'); assert.ok(quoteStart >= 0);
        for (let i = 0; i < quoteFiles.length; i++) embeds[quoteStart + i].image = { url: quoteFiles[i].url };
        f.serverByMessage.set(f.first.id, [...f.serverByMessage.get(f.first.id), ...quoteFiles]);
        f.first._patch({ id: f.first.id, channel_id: cid, guild_id: gid, embeds, attachments: [] });
        // Model the DB state after a previously verified quote restoration.
        const quote = await f.storage.get(f.quote.id, gid, cid), payload = quote.payload;
        payload.embedStart = quoteStart; payload.embedEnd = quoteStart + quoteFiles.length;
        payload.embedWitness = { hashes: f.first.embeds.slice(payload.embedStart, payload.embedEnd).map(embed => cards.embedFingerprint(embed, f.first)), attachments: [] };
        payload.partSignatures[0] = cards.fingerprint(f.first); payload.firstStaticSignature = cards.fingerprint(f.first, true);
        await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(payload), f.quote.id]);
        if (scenario === 'missing sibling') await f.db.queryDatabase('DELETE FROM bot_media_galleries WHERE gallery_id=?', [f.quote.id]);
        if (scenario === 'bad witness' || scenario === 'bad static') {
            if (scenario === 'bad witness') payload.embedWitness.hashes[0] = 'f'.repeat(64);
            else payload.firstStaticSignature = 'f'.repeat(64);
            await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(payload), f.quote.id]);
        }
        let freshParent = await f.storage.get(f.item.id, gid, cid);
        const composed = { data: Buffer.from('new parent'), filename: 'grid.jpg' };
        if (['missing sibling', 'bad witness', 'bad static'].includes(scenario)) {
            const before = cards.fingerprint(f.first), editCount = f.editRequests.length;
            assert.equal(await grid._internal.replacePublic(f.interaction, freshParent, composed, f.deps), 'changed');
            assert.equal(f.editRequests.length, editCount, 'no Discord PATCH before sibling evidence is proved');
            assert.equal(cards.fingerprint(f.first), before);
            assert.ok(quoteFiles.every(file => f.serverByMessage.get(f.first.id).some(item => String(item.id) === file.id)));
            return;
        }
        if (scenario === 'ack lost') {
            const original = f.first.edit; let calls = 0;
            f.first.edit = async request => { const message = await original(request); if (++calls === 1) throw new Error('response lost'); return message; };
            assert.equal(await grid._internal.replacePublic(f.interaction, freshParent, composed, f.deps), 'unknown');
        } else if (scenario === 'database rollback') {
            const failing = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(async query => { await work(query); throw new Error('fixture rollback'); }) };
            await assert.rejects(grid._internal.replacePublic(f.interaction, freshParent, composed, { ...f.deps, db: failing }), /fixture rollback/);
        } else assert.equal(await grid._internal.replacePublic(f.interaction, freshParent, composed, f.deps), 'done');
        if (scenario !== 'normal') {
            freshParent = await f.storage.get(f.item.id, gid, cid);
            assert.equal(await grid._internal.replacePublic(f.interaction, freshParent, composed, f.deps), 'done');
        }
        const retained = new Set(f.serverByMessage.get(f.first.id).map(file => String(file.id)));
        assert.ok(quoteFiles.every(file => retained.has(file.id)), 'restored quote attachments must remain available');
        assert.ok(quoteFiles.every(file => f.editRequests.at(-1).attachments.includes(file.id)), 'PATCH retains each verified quote ID');
    } finally { await f.db.close(); }
});

for (const quote of [false, true]) test(`hidden Embed attachments remain ordered across display toggles (quote=${quote})`, { timeout: 60000 }, async () => {
    const f = await fixture({ quote, hideEmbeddedAttachments: true });
    try {
        const firstIds = [...f.first.attachments.keys()], secondIds = [...f.second.attachments.keys()];
        await perform(f, 'showAttachmentsAsEmbedsImage');
        assert.equal(f.first.attachments.size, quote ? 2 : 0);
        assert.equal(f.second.attachments.size, 0);
        assert.equal(cards.gridIdFromMessage(f.first), f.item.id);
        const signed = await f.storage.get(f.item.id, gid, cid);
        assert.ok(cards.matchesFingerprint(f.first, signed.payload.partSignatures[0]));
        assert.ok(cards.matchesFingerprint(f.second, signed.payload.partSignatures[1]));
        await perform(f, 'showMediaAsAttachments');
        assert.deepEqual([...f.first.attachments.keys()], firstIds, 'root photo order is preserved');
        assert.deepEqual([...f.second.attachments.keys()], secondIds, 'continuation photo order is preserved');
        assert.equal(cards.gridIdFromMessage(f.first), f.item.id);
        if (quote) assert.ok(f.first.embeds.some(embed => embed.title === 'quote'));
        const row = await f.storage.get(f.item.id, gid, cid);
        assert.ok(cards.matchesFingerprint(f.first, row.payload.partSignatures[0]));
        assert.ok(cards.matchesFingerprint(f.second, row.payload.partSignatures[1]));
    } finally { await f.db.close(); }
});

test('hidden photos and a visible video survive both display modes', { timeout: 60000 }, async () => {
    const f = await fixture({ nonImage: 'video', hideEmbeddedAttachments: true });
    try {
        const firstIds = [...f.first.attachments.keys()], secondIds = [...f.second.attachments.keys()];
        await perform(f, 'showAttachmentsAsEmbedsImage');
        assert.equal(f.second.attachments.size, 1);
        assert.equal([...f.second.attachments.values()][0].contentType, 'video/mp4');
        await perform(f, 'showMediaAsAttachments');
        assert.deepEqual([...f.first.attachments.keys()], firstIds);
        assert.deepEqual([...f.second.attachments.keys()], secondIds);
        assert.equal(f.messages.size, 2);
    } finally { await f.db.close(); }
});

for (const alteration of ['foreign host', 'other channel', 'other id', 'other name', 'duplicate'])
    test(`hidden continuation rejects ${alteration} without altering either post`, { timeout: 60000 }, async () => {
        const f = await fixture({ hideEmbeddedAttachments: true });
        try {
            await perform(f, 'showAttachmentsAsEmbedsImage');
            const image = f.second.embeds[0].image;
            if (alteration === 'foreign host') image.url = image.url.replace('cdn.discordapp.com', 'evil.invalid');
            if (alteration === 'other channel') image.url = image.url.replace(`/attachments/${cid}/`, '/attachments/999999999999999999/');
            if (alteration === 'other id') image.url = image.url.replace(/\/\d+\/([^/?]+\?)/, '/999999999999999999/$1');
            if (alteration === 'other name') image.url = image.url.replace(/([^/]+)\?/, 'different.jpg?');
            if (alteration === 'duplicate') f.second.embeds[1].image.url = image.url;
            const firstBefore = cards.fingerprint(f.first), secondBefore = cards.fingerprint(f.second);
            await assert.rejects(perform(f, 'showMediaAsAttachments'), /GRID_SOURCE_CHANGED/);
            assert.equal(cards.fingerprint(f.first), firstBefore); assert.equal(cards.fingerprint(f.second), secondBefore);
            assert.equal(f.messages.size, 2);
        } finally { await f.db.close(); }
    });

for (const alteration of ['wrong message', 'wrong channel', 'wrong author'])
    test(`hidden continuation rejects a ${alteration} response before editing`, { timeout: 60000 }, async () => {
        const f = await fixture({ hideEmbeddedAttachments: true });
        try {
            await perform(f, 'showAttachmentsAsEmbedsImage');
            const fetch = f.interaction.channel.messages.fetch;
            f.interaction.channel.messages.fetch = async query => {
                const result = await fetch(query);
                if (query.message !== f.second.id) return result;
                if (alteration === 'wrong message') return { ...result, id: '999999999999999999' };
                if (alteration === 'wrong channel') return { ...result, channelId: '999999999999999999' };
                return { ...result, author: { id: '999999999999999999' } };
            };
            const firstBefore = cards.fingerprint(f.first), secondBefore = cards.fingerprint(f.second);
            await assert.rejects(perform(f, 'showMediaAsAttachments'), /GRID_SOURCE_CHANGED/);
            assert.equal(cards.fingerprint(f.first), firstBefore); assert.equal(cards.fingerprint(f.second), secondBefore);
            assert.equal(f.messages.size, 2);
        } finally { await f.db.close(); }
    });

test('refreshed Discord signature parameters do not invalidate hidden photos', { timeout: 60000 }, async () => {
    const f = await fixture({ hideEmbeddedAttachments: true });
    try {
        await perform(f, 'showAttachmentsAsEmbedsImage');
        for (const message of [f.first, f.second]) for (const embed of message.embeds) if (embed.image?.url?.includes('cdn.discordapp.com'))
            embed.image.url = embed.image.url.replace('?ex=1&is=2&hm=abc', '?ex=3&is=4&hm=def');
        await perform(f, 'showMediaAsAttachments');
        assert.equal(f.first.attachments.size, 10); assert.equal(f.second.attachments.size, 3);
    } finally { await f.db.close(); }
});

for (const evidence of ['missing flags', 'missing refs', 'reordered sources', 'foreign source', 'hidden video'])
    test(`hidden photos require saved ordered X evidence (${evidence})`, { timeout: 60000 }, async () => {
        const f = await fixture({ nonImage: evidence === 'hidden video' ? 'video' : null, hideEmbeddedAttachments: true });
        try {
            await perform(f, 'showAttachmentsAsEmbedsImage');
            const row = await f.storage.get(f.item.id, gid, cid), payload = row.payload;
            if (evidence === 'missing flags') delete payload.partContainsNonImage;
            if (evidence === 'missing refs') delete payload.partRefs;
            if (evidence === 'reordered sources') [payload.partRefs[1][0], payload.partRefs[1][1]] = [payload.partRefs[1][1], payload.partRefs[1][0]];
            if (evidence === 'foreign source') payload.partRefs[1][0].url = payload.imageUrls[10] = 'https://evil.invalid/photo.jpg';
            if (evidence === 'hidden video') f.second.attachments.clear();
            await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(payload), f.item.id]);
            const before = [cards.fingerprint(f.first), cards.fingerprint(f.second)];
            await assert.rejects(perform(f, 'showMediaAsAttachments'), /GRID_SOURCE_CHANGED/);
            assert.deepEqual([cards.fingerprint(f.first), cards.fingerprint(f.second)], before);
            assert.equal(f.messages.size, 2);
        } finally { await f.db.close(); }
    });

test('revoked permissions prevent edits of verified hidden images', { timeout: 60000 }, async () => {
    const f = await fixture({ hideEmbeddedAttachments: true });
    try {
        await perform(f, 'showAttachmentsAsEmbedsImage');
        const before = [cards.fingerprint(f.first), cards.fingerprint(f.second)];
        f.deps.freshAccess = async () => null;
        await assert.rejects(perform(f, 'showMediaAsAttachments'), /GRID_PERMISSION_CHANGED/);
        assert.deepEqual([cards.fingerprint(f.first), cards.fingerprint(f.second)], before);
    } finally { await f.db.close(); }
});

test('missing legacy photo evidence prevents creating an unrecoverable hidden state', { timeout: 60000 }, async () => {
    const f = await fixture({ hideEmbeddedAttachments: true });
    try {
        const row = await f.storage.get(f.item.id, gid, cid), payload = row.payload;
        delete payload.partContainsNonImage;
        await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(payload), f.item.id]);
        const before = [cards.fingerprint(f.first), cards.fingerprint(f.second)];
        await assert.rejects(perform(f, 'showAttachmentsAsEmbedsImage'), /GRID_SOURCE_CHANGED/);
        assert.deepEqual([cards.fingerprint(f.first), cards.fingerprint(f.second)], before);
        assert.equal(f.first.attachments.size, 10); assert.equal(f.second.attachments.size, 3);
    } finally { await f.db.close(); }
});

test('a video-bearing Embed is never lost during a hidden-image display change', { timeout: 60000 }, async () => {
    const f = await fixture({ hideEmbeddedAttachments: true });
    try {
        await perform(f, 'showAttachmentsAsEmbedsImage');
        f.second.embeds[0].video = { url: 'https://example.invalid/video.mp4' };
        const before = JSON.stringify(f.second.embeds), firstBefore = cards.fingerprint(f.first);
        await assert.rejects(perform(f, 'showMediaAsAttachments'), /GRID_SOURCE_CHANGED/);
        assert.equal(JSON.stringify(f.second.embeds), before);
        assert.equal(cards.fingerprint(f.first), firstBefore);
    } finally { await f.db.close(); }
});

test('existing delete action removes all verified parts of a split post', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        await perform(f, 'delete');
        assert.equal(f.messages.has(f.first.id), false);
        assert.equal(f.messages.has(f.second.id), false, 'no orphaned continuation remains');
    } finally { await f.db.close(); }
});

test('editing the original translation preserves all 13 image references for a later grid operation', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        await perform(f, 'translate', true);
        assert.equal(f.first.embeds[0].description, 'translated text');
        assert.equal(cards.gridIdFromMessage(f.first), f.item.id);
        const row = await f.storage.get(f.item.id, gid, cid);
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, row), f.urls);
    } finally { await f.db.close(); }
});

test('unauthorized deletion leaves both parts intact', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        f.interaction.user = { id: '999999999999999999' };
        f.interaction.memberPermissions = { has: () => false };
        await perform(f, 'delete');
        assert.equal(f.messages.has(f.first.id), true);
        assert.equal(f.messages.has(f.second.id), true);
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, await f.storage.get(f.item.id, gid, cid)), f.urls);
    } finally { await f.db.close(); }
});
test('upstream X display text cannot forge the requester of a split gallery', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const attacker = '999999999999999999';
        f.first.embeds[0].footer = { text: `X author(id:${attacker})` };
        const row = await f.storage.get(f.item.id, gid, cid);
        row.payload.partSignatures[0] = cards.fingerprint(f.first);
        row.payload.firstStaticSignature = cards.fingerprint(f.first, true);
        await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(row.payload), f.item.id]);
        f.interaction.user = { id: attacker }; f.interaction.memberPermissions = { has: () => false };
        await perform(f, 'delete');
        assert.equal(f.messages.size, 2);
        f.interaction.user = { id: user };
        await perform(f, 'delete');
        assert.equal(f.messages.size, 0);
    } finally { await f.db.close(); }
});

test('a tampered continuation is not edited or deleted by an existing action', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        f.second.content = 'changed by someone';
        const firstBefore = cards.fingerprint(f.first), secondBefore = cards.fingerprint(f.second);
        await assert.rejects(perform(f, 'delete'), /GRID_SOURCE_CHANGED/);
        assert.equal(cards.fingerprint(f.first), firstBefore);
        assert.equal(cards.fingerprint(f.second), secondBefore);
        assert.equal(f.messages.size, 2);
    } finally { await f.db.close(); }
});

test('a partial discord.js Message is patched by REST before an authorized split deletion', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const { Client, Message } = require('discord.js'), client = new Client({ intents: [] });
        const raw = { id: f.first.id, channel_id: cid, guild_id: gid, content: f.first.content,
            author: { id: bot, username: 'fixture', discriminator: '0', bot: true }, embeds: f.first.embeds,
            components: f.first.components, attachments: [...f.first.attachments.values()].map(file => ({ ...file, content_type: file.contentType, size: 1, filename: file.name })) };
        const real = new Message(client, raw);
        real.delete = async () => f.messages.delete(real.id);
        f.messages.set(real.id, real);
        const row = await f.storage.get(f.item.id, gid, cid);
        row.payload.partSignatures[0] = cards.fingerprint(real);
        row.payload.firstStaticSignature = cards.fingerprint(real, true);
        await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(row.payload), f.item.id]);
        real._patch({ id: real.id, embeds: [], attachments: [] });
        assert.notEqual(cards.fingerprint(real), row.payload.partSignatures[0]);
        f.interaction.message = real;
        f.interaction.channel.messages.fetch = async ({ message }) => {
            if (message === real.id) { real._patch(raw); return real; }
            const found = f.messages.get(message); if (!found) throw Object.assign(new Error('deleted'), { code: 10008 }); return found;
        };
        await assert.rejects(perform(f, 'delete'), error => error.code === 'GRID_SNAPSHOT_MISMATCH');
        assert.equal(f.messages.size, 2, 'a partial event must not act on a newer source without confirmation');
        const digest = cards.fingerprint(real);
        const handler = require('../../src/components/delete');
        await cards.withMessageLock(f.interaction, group => handler.handle(f.interaction, { buttons, ...group }), f.db,
            { action: 'delete', buttons, expectedFingerprint: digest, galleryId: f.item.id, actionId: `delete:sl1:${f.item.id}`,
                freshAccess: f.deps.freshAccess, getSettings: f.deps.getSettings });
        assert.equal(f.messages.size, 0);
        client.destroy();
    } finally { await f.db.close(); }
});

test('a partial event missing its grid control is still resolved and requests confirmation', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const { Client, Message } = require('discord.js'), client = new Client({ intents: [] });
        const raw = { id: f.first.id, channel_id: cid, guild_id: gid, content: f.first.content,
            author: { id: bot, username: 'fixture', discriminator: '0', bot: true }, embeds: f.first.embeds,
            components: f.first.components, attachments: [...f.first.attachments.values()].map(file => ({ ...file, content_type: file.contentType, size: 1, filename: file.name })) };
        const real = new Message(client, raw);
        const row = await f.storage.get(f.item.id, gid, cid);
        row.payload.partSignatures[0] = cards.fingerprint(real);
        await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(row.payload), f.item.id]);
        real._patch({ id: real.id, embeds: [], components: [], attachments: [] });
        f.interaction.message = real;
        f.interaction.channel.messages.fetch = async ({ message }) => {
            if (message === real.id) { real._patch(raw); return real; }
            return f.second;
        };
        await assert.rejects(perform(f, 'delete'), error => error.code === 'GRID_SNAPSHOT_MISMATCH');
        assert.equal(f.messages.size, 2);
        client.destroy();
    } finally { await f.db.close(); }
});

test('a truly changed REST message is not accepted even if the interaction snapshot matches the record', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const snapshot = { ...f.first };
        f.interaction.message = snapshot;
        f.first.content = 'a changed source';
        await assert.rejects(perform(f, 'delete'), /GRID_SOURCE_CHANGED/);
        assert.equal(f.messages.size, 2);
    } finally { await f.db.close(); }
});

test('a single message without a grid record retains its existing component behavior', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        f.first.components = f.first.components.filter(row => !row.components.some(component => String(component.custom_id || '').startsWith('tg:')));
        for (const row of f.first.components) for (const component of row.components) {
            if (typeof component.custom_id === 'string') component.custom_id = component.custom_id.split(':')[0];
        }
        await f.db.queryDatabase('DELETE FROM bot_media_galleries WHERE gallery_id=?', [f.item.id]);
        await f.db.queryDatabase('DELETE FROM bot_media_galleries WHERE gallery_id=?', [f.item.id]);
        const before = cards.fingerprint(f.second);
        await perform(f, 'showAttachmentsAsEmbedsImage');
        assert.equal(f.first.embeds.filter(embed => embed.image).length, 10);
        assert.equal(cards.fingerprint(f.second), before);
    } finally { await f.db.close(); }
});

test('existing embed-only X photos can become attachments while retaining the grid', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        f.messages.delete(f.second.id);
        f.first.attachments.clear();
        f.first.embeds = [f.first.embeds[0], { image: { url: f.urls[0] } }, { image: { url: f.urls[1] } }];
        f.first.components[0].components[0] = buttons.showMediaAsAttachmentsButton;
        const row = await f.storage.get(f.item.id, gid, cid), data = row.payload;
        data.totalParts = data.completedParts = 1; data.messageIds = [f.first.id]; data.partSizes = [2];
        data.imageUrls = f.urls.slice(0, 2); data.partRefs = [data.imageUrls.map(url => ({ type: 'url', url }))];
        data.partContainsNonImage = [false]; data.partSignatures = [cards.fingerprint(f.first)];
        data.firstStaticSignature = cards.fingerprint(f.first, true);
        await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(data), f.item.id]);
        await perform(f, 'showMediaAsAttachments');
        assert.equal(f.first.attachments.size, 2);
        assert.equal(cards.gridIdFromMessage(f.first), f.item.id);
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, await f.storage.get(f.item.id, gid, cid)), data.imageUrls);
    } finally { await f.db.close(); }
});
for (const mode of ['normal', 'rollback']) test(`embed-only parent conversion preserves quoted photos after ${mode}`, { timeout: 60000 }, async () => {
    const f = await fixture({ quote: true });
    try {
        f.messages.delete(f.second.id); f.first.attachments.clear();
        const quoted = f.first.embeds.slice(1);
        f.first.embeds = [f.first.embeds[0], { image: { url: f.urls[0] } }, { image: { url: f.urls[1] } }, ...quoted];
        f.first.components[0].components[0] = buttons.showMediaAsAttachmentsButton;
        for (const id of [f.item.id, f.quote.id]) {
            const row = await f.storage.get(id, gid, cid), data = row.payload;
            data.partSignatures = [cards.fingerprint(f.first)]; data.firstStaticSignature = cards.fingerprint(f.first, true);
            if (id === f.item.id) {
                data.totalParts = data.completedParts = 1; data.messageIds = [f.first.id]; data.partSizes = [2];
                data.imageUrls = f.urls.slice(0, 2); data.partRefs = [data.imageUrls.map(url => ({ type: 'url', url }))];
                data.partContainsNonImage = [false]; data.embedStart = 0; data.embedEnd = 3;
            } else { data.embedStart = 3; data.embedEnd = 5; }
            data.embedWitness = { hashes: f.first.embeds.slice(data.embedStart, data.embedEnd).map(cards.embedFingerprint), attachments: [] };
            await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(data), id]);
        }
        if (mode === 'rollback') {
            const flaky = rollbackAfterSideEffect(f.db, () => f.first.attachments.size > 0);
            await assert.rejects(perform(f, 'showMediaAsAttachments', false, flaky));
        }
        await perform(f, 'showMediaAsAttachments');
        assert.equal(f.first.attachments.size, 2);
        assert.ok(f.first.embeds.some(embed => embed.title === 'quote'));
        const parent = await f.storage.get(f.item.id, gid, cid), quote = await f.storage.get(f.quote.id, gid, cid);
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, parent), f.urls.slice(0, 2));
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, quote), f.quoteUrls);
        assert.equal(await grid._internal.replacePublic(f.interaction, parent, { data: Buffer.from('combined'), filename: 'twitter-grid.jpg' }, f.deps), 'done');
        assert.ok(f.first.embeds.some(embed => embed.title === 'quote'));
    } finally { await f.db.close(); }
});

test('splitting and an inline quote keep the quote and its own grid available', { timeout: 60000 }, async () => {
    const f = await fixture({ quote: true });
    try {
        const retained = await f.db.queryDatabase('SELECT gallery_id,expires_at_ms FROM bot_media_galleries WHERE gallery_id IN (?,?)', [f.item.id, f.quote.id]);
        assert.equal(retained.length, 2);
        assert.ok(retained.every(row => Number(row.expires_at_ms) === Number.MAX_SAFE_INTEGER));
        await perform(f, 'showAttachmentsAsEmbedsImage');
        assert.ok(f.first.embeds.some(embed => embed.title === 'quote'));
        const quote = await f.storage.get(f.quote.id, gid, cid);
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, quote), f.quoteUrls);
        const parent = await f.storage.get(f.item.id, gid, cid);
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, parent), f.urls);
    } finally { await f.db.close(); }
});

test('an older inline quote summary without a separate grid is preserved', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        f.first.embeds.push({ title: 'Quoted tweet: original', description: 'quoted text' });
        const row = await f.storage.get(f.item.id, gid, cid);
        row.payload.sharedInline = false; row.payload.embedStart = 0; row.payload.embedEnd = 1;
        row.payload.partSignatures[0] = cards.fingerprint(f.first);
        row.payload.firstStaticSignature = cards.fingerprint(f.first, true);
        await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(row.payload), f.item.id]);
        await perform(f, 'showAttachmentsAsEmbedsImage');
        assert.ok(f.first.embeds.some(embed => embed.title === 'Quoted tweet: original' && embed.description === 'quoted text'));
        const current = await f.storage.get(f.item.id, gid, cid);
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, current), f.urls);
        assert.equal(await grid._internal.replacePublic(f.interaction, current, { data: Buffer.from('combined'), filename: 'twitter-grid.jpg' }, f.deps), 'done');
        assert.ok(f.first.embeds.some(embed => embed.title === 'Quoted tweet: original' && embed.description === 'quoted text'));
    } finally { await f.db.close(); }
});

test('a definitively rejected continuation edit can be retried without losing the 13 source images', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const edit = f.second.edit;
        let failed = false;
        f.second.edit = async request => {
            if (!failed) { failed = true; throw Object.assign(new Error('Discord rejected the edit'), { status: 403 }); }
            return edit(request);
        };
        await assert.rejects(perform(f, 'showAttachmentsAsEmbedsImage'));
        assert.equal(f.messages.size, 2);
        await perform(f, 'showAttachmentsAsEmbedsImage');
        assert.equal(f.first.embeds.filter(embed => embed.image).length, 10);
        assert.equal(f.second.embeds.filter(embed => embed.image).length, 3);
        const row = await f.storage.get(f.item.id, gid, cid);
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, row), f.urls);
    } finally { await f.db.close(); }
});

test('a definitively rejected continuation deletion leaves a usable control and can be safely retried', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const remove = f.second.delete;
        let failed = false;
        f.second.delete = async () => {
            if (!failed) { failed = true; throw Object.assign(new Error('Discord rejected the deletion'), { status: 403 }); }
            return remove();
        };
        await assert.rejects(perform(f, 'delete'));
        assert.equal(f.messages.has(f.first.id), true);
        assert.equal(f.messages.has(f.second.id), true);
        await perform(f, 'delete');
        assert.equal(f.messages.size, 0);
    } finally { await f.db.close(); }
});

test('concurrent delete actions never delete either physical message twice', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const deletions = new Map();
        for (const message of [f.first, f.second]) {
            const remove = message.delete;
            message.delete = async () => { deletions.set(message.id, (deletions.get(message.id) || 0) + 1); return remove(); };
        }
        const handler = require('../../src/components/delete');
        const invoke = () => {
            const interaction = { ...f.interaction, customId: `delete:sl1:${f.item.id}` };
            return cards.withMessageLock(interaction, group => handler.handle(interaction, { buttons, ...group }), f.db,
                { action: 'delete', buttons, freshAccess: f.deps.freshAccess, getSettings: f.deps.getSettings });
        };
        await Promise.allSettled([invoke(), invoke()]);
        assert.equal(deletions.get(f.first.id), 1);
        assert.equal(deletions.get(f.second.id), 1);
        assert.equal(f.messages.size, 0);
    } finally { await f.db.close(); }
});

test('a source changed while the intent is persisted is never overwritten', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        let changed = false;
        const db = { ...f.db, queryDatabaseIndependent: async (sql, params) => {
            const result = await f.db.queryDatabaseIndependent(sql, params);
            if (!changed && /^INSERT INTO bot_twitter_grid_action_intents/i.test(sql)) {
                changed = true; f.first.embeds[0].description = 'updated by another action';
            }
            return result;
        } };
        await assert.rejects(perform(f, 'showAttachmentsAsEmbedsImage', false, db), /GRID_SOURCE_CHANGED/);
        assert.equal(f.first.embeds[0].description, 'updated by another action');
        assert.equal(f.second.embeds.length, 0);
        assert.equal(f.messages.size, 2);
    } finally { await f.db.close(); }
});
test('loss of channel access during a multi-part delete stops before the remaining message', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        let allowed = true;
        const access = f.deps.freshAccess;
        f.deps.freshAccess = async () => allowed ? access() : null;
        const remove = f.second.delete;
        f.second.delete = async () => { await remove(); allowed = false; };
        await assert.rejects(perform(f, 'delete'), /GRID_PERMISSION_CHANGED/);
        assert.equal(f.messages.has(f.first.id), true);
        assert.equal(f.messages.has(f.second.id), false);
        allowed = true;
        await perform(f, 'delete');
        assert.equal(f.messages.size, 0);
    } finally { await f.db.close(); }
});
test('a long operation stops at its deadline and resumes remaining deletes', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        let now = 0; f.deps.operationNow = () => now;
        const remove = f.second.delete;
        f.second.delete = async () => { await remove(); now = 13 * 60 * 1000; };
        await assert.rejects(perform(f, 'delete'), /GRID_OPERATION_TIME/);
        assert.equal(f.messages.has(f.first.id), true); assert.equal(f.messages.has(f.second.id), false);
        await perform(f, 'delete');
        assert.equal(f.messages.size, 0);
    } finally { await f.db.close(); }
});
test('twenty physical messages survive a 429 and can be explicitly retried without duplicate deletion', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const entries = [...f.first.attachments.entries()];
        f.first.attachments = new Map([entries[0]]);
        f.second.attachments = new Map([entries[1]]);
        const messages = [f.first, f.second];
        for (let index = 2; index < 20; index++) {
            const id = String(700000000000000000n + BigInt(index)), photo = { id: String(800000000000000000n + BigInt(index)), name: `photo${index}.jpg`, contentType: 'image/jpeg' };
            const item = { id, channelId: cid, author: { id: bot }, content: '', embeds: [], components: [], attachments: new Map([[photo.id, photo]]) };
            f.messages.set(id, item); messages.push(item);
        }
        const attempts = new Map();
        for (const item of messages) item.delete = async () => {
            const count = (attempts.get(item.id) || 0) + 1; attempts.set(item.id, count);
            if (item === messages[3] && count === 1) throw Object.assign(Error('rate limited'), { status: 429 });
            f.messages.delete(item.id);
        };
        const row = await f.storage.get(f.item.id, gid, cid), data = row.payload;
        const urls = Array.from({ length: 20 }, (_, i) => image(i + 1));
        data.messageIds = messages.map(item => item.id); data.totalParts = data.completedParts = 20;
        data.imageUrls = urls; data.partRefs = urls.map(url => [{ type: 'url', url }]);
        data.partSizes = Array(20).fill(1); data.partContainsNonImage = Array(20).fill(false);
        data.partSignatures = messages.map(item => cards.fingerprint(item)); data.firstStaticSignature = cards.fingerprint(f.first, true);
        await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(data), f.item.id]);
        await assert.rejects(perform(f, 'delete'), /rate limited/);
        assert.equal(f.messages.has(f.first.id), true);
        assert.equal(f.messages.has(messages[1].id), false);
        assert.equal(f.messages.has(messages[2].id), false);
        await perform(f, 'delete');
        assert.equal(f.messages.size, 0);
        assert.equal(attempts.get(messages[1].id), 1); assert.equal(attempts.get(messages[2].id), 1);
        assert.equal(attempts.get(messages[3].id), 2);
    } finally { await f.db.close(); }
});
test('changed content-safety settings stop a pending multi-part display edit', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const get = f.deps.getSettings; let checks = 0;
        f.deps.getSettings = async (...args) => {
            const value = await get(...args);
            return ++checks === 1 ? value : { ...value, enabled: false };
        };
        await assert.rejects(perform(f, 'showAttachmentsAsEmbedsImage'), /GRID_PERMISSION_CHANGED/);
        assert.equal(f.first.embeds.filter(embed => embed.image).length, 0);
        assert.equal(f.second.embeds.length, 0);
        assert.equal(f.messages.size, 2);
    } finally { await f.db.close(); }
});

function rollbackAfterSideEffect(db, hasEffect) {
    let injected = false;
    return { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(async query => {
        const value = await work(query);
        if (hasEffect() && !injected) { injected = true; throw Error('fixture commit failure'); }
        return value;
    }) };
}

test('successful Discord edits followed by database rollback can be safely recovered', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        let edited = false;
        const edit = f.second.edit;
        f.second.edit = async request => { const result = await edit(request); edited = true; return result; };
        const flaky = rollbackAfterSideEffect(f.db, () => edited);
        await assert.rejects(perform(f, 'showAttachmentsAsEmbedsImage', false, flaky));
        assert.equal(edited, true);
        assert.equal(f.messages.size, 2);
        await perform(f, 'showAttachmentsAsEmbedsImage');
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, await f.storage.get(f.item.id, gid, cid)), f.urls);
        assert.equal(f.first.embeds.filter(embed => embed.image).length, 10);
        assert.equal(f.second.embeds.filter(embed => embed.image).length, 3);
    } finally { await f.db.close(); }
});

test('hidden continuation edits recover after DB rollback without changing other messages', { timeout: 60000 }, async () => {
    const f = await fixture({ quote: true, hideEmbeddedAttachments: true });
    try {
        let edited = false, attempts = 0;
        const edit = f.second.edit;
        f.second.edit = async request => { attempts++; const result = await edit(request); edited = true; return result; };
        const flaky = rollbackAfterSideEffect(f.db, () => edited);
        await assert.rejects(perform(f, 'showAttachmentsAsEmbedsImage', false, flaky), /fixture commit failure/);
        assert.equal(f.second.attachments.size, 0); assert.equal(f.messages.size, 2);
        await perform(f, 'showAttachmentsAsEmbedsImage');
        assert.equal(attempts, 1, 'the confirmed continuation edit is not submitted again');
        assert.ok(f.first.embeds.some(embed => embed.title === 'quote'));
        const row = await f.storage.get(f.item.id, gid, cid);
        assert.ok(cards.matchesFingerprint(f.first, row.payload.partSignatures[0]));
        assert.ok(cards.matchesFingerprint(f.second, row.payload.partSignatures[1]));
        await perform(f, 'showMediaAsAttachments');
        assert.equal(f.first.attachments.size, 10); assert.equal(f.second.attachments.size, 3);
    } finally { await f.db.close(); }
});

test('successful Discord deletion followed by rollback does not delete any message twice', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        let deleted = false, attempts = 0;
        const remove = f.second.delete;
        f.second.delete = async () => { attempts++; await remove(); deleted = true; };
        const flaky = rollbackAfterSideEffect(f.db, () => deleted);
        await assert.rejects(perform(f, 'delete', false, flaky));
        assert.equal(deleted, true);
        if (f.messages.has(f.first.id)) await perform(f, 'delete');
        assert.equal(f.messages.size, 0);
        assert.equal(attempts, 1);
    } finally { await f.db.close(); }
});

test('a deleted root is reconciled after DB rollback without another Discord mutation', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        let deletes = 0;
        for (const message of [f.first, f.second]) {
            const remove = message.delete;
            message.delete = async () => { deletes++; await remove(); };
        }
        const flaky = rollbackAfterSideEffect(f.db, () => !f.messages.has(f.first.id));
        await assert.rejects(perform(f, 'delete', false, flaky));
        assert.equal(f.messages.size, 0); assert.equal(deletes, 2);
        const rows = await f.db.queryDatabaseIndependent('SELECT * FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [f.item.lockId]);
        assert.equal(rows.length, 1);
        const channel = { ...f.interaction.channel, guildId: gid };
        const client = { guilds: { cache: { has: id => id === gid } }, channels: { fetch: async () => channel } };
        const cleanup = require('../../src/twitterGridDeletedCleanup')._internal;
        assert.equal(await cleanup.reconcile(rows[0], client, f.db), true);
        assert.equal(deletes, 2, 'reconciliation only reads Discord state');
        assert.equal((await f.db.queryDatabaseIndependent('SELECT * FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [f.item.lockId])).length, 0);
        const saved = await f.db.queryDatabase('SELECT expires_at_ms FROM bot_media_galleries WHERE gallery_id=?', [f.item.id]);
        assert.ok(Number(saved[0].expires_at_ms) < Number.MAX_SAFE_INTEGER);
    } finally { await f.db.close(); }
});
test('cleanup can reconcile a root deleted after an earlier complete public replacement', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const row = await f.storage.get(f.item.id, gid, cid);
        assert.equal(await grid._internal.replacePublic(f.interaction, row, { data: Buffer.from('combined'), filename: 'twitter-grid.jpg' }, f.deps), 'done');
        assert.equal(f.messages.has(f.second.id), false);
        await assert.rejects(perform(f, 'delete', false, rollbackAfterSideEffect(f.db, () => !f.messages.has(f.first.id))));
        const rows = await f.db.queryDatabaseIndependent('SELECT * FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [f.item.lockId]);
        const channel = { ...f.interaction.channel, guildId: gid };
        const client = { guilds: { cache: { has: id => id === gid } }, channels: { fetch: async () => channel } };
        assert.equal(await require('../../src/twitterGridDeletedCleanup')._internal.reconcile(rows[0], client, f.db), true);
        assert.equal((await f.db.queryDatabaseIndependent('SELECT * FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [f.item.lockId])).length, 0);
    } finally { await f.db.close(); }
});

test('deleted-root reconciliation keeps journal when any part exists or Discord state is unknown', { timeout: 60000 }, async () => {
    for (const scenario of ['exists', 'forbidden', 'timeout']) {
        const f = await fixture();
        try {
            const flaky = rollbackAfterSideEffect(f.db, () => !f.messages.has(f.first.id));
            await assert.rejects(perform(f, 'delete', false, flaky));
            const rows = await f.db.queryDatabaseIndependent('SELECT * FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [f.item.lockId]);
            const channel = { guildId: gid, messages: { fetch: async () => {
                if (scenario === 'exists') return { id: f.first.id };
                throw Object.assign(Error('fixture'), scenario === 'forbidden' ? { status: 403 } : { code: 'ETIMEDOUT' });
            } } };
            const client = { guilds: { cache: { has: id => id === gid } }, channels: { fetch: async () => channel } };
            assert.equal(await require('../../src/twitterGridDeletedCleanup')._internal.reconcile(rows[0], client, f.db), false, scenario);
            assert.equal((await f.db.queryDatabaseIndependent('SELECT * FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [f.item.lockId])).length, 1);
        } finally { await f.db.close(); }
    }
});
test('deleted-root cleanup requires a complete ordered delete intent for the exact group', async () => {
    const { candidate } = require('../../src/twitterGridDeletedCleanup')._internal;
    const id = 'a'.repeat(32), op = 'b'.repeat(32), sig = 'c'.repeat(64), ids = ['555555555555555555', '666666666666666666'];
    const payload = { id, lockId: id, kind: 'twitter-image-grid-v1', totalParts: 2, completedParts: 2, partsState: 'complete', messageIds: ids, partSignatures: [sig, sig] };
    const journal = { operationId: op, payload: { version: 1, operationId: op, action: 'delete', galleryId: id, lockId: id,
        steps: [{ type: 'delete', index: 1, id: ids[1], before: sig }, { type: 'delete', index: 0, id: ids[0], before: sig }] } };
    assert.equal(candidate(payload, journal), true);
    for (const invalid of [
        { ...journal.payload, steps: [journal.payload.steps[1]] },
        { ...journal.payload, steps: [...journal.payload.steps].reverse() },
        { ...journal.payload, steps: [{ ...journal.payload.steps[0], id: '777777777777777777' }, journal.payload.steps[1]] },
        { ...journal.payload, action: 'showMediaAsAttachments' },
        { ...journal.payload, kind: 'twitter-grid-restore' },
    ]) assert.equal(candidate(payload, { ...journal, payload: invalid }), false);
});
test('two cleanup workers reconcile the same deleted root safely', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        let mutations = 0;
        for (const message of [f.first, f.second]) {
            const remove = message.delete;
            message.delete = async () => { mutations++; await remove(); };
        }
        await assert.rejects(perform(f, 'delete', false, rollbackAfterSideEffect(f.db, () => !f.messages.has(f.first.id))));
        const rows = await f.db.queryDatabaseIndependent('SELECT * FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [f.item.lockId]);
        const channel = { ...f.interaction.channel, guildId: gid };
        const client = { guilds: { cache: { has: id => id === gid } }, channels: { fetch: async () => channel } };
        const Module = require('node:module'), filename = require.resolve('../../src/twitterGridCards');
        const separate = new Module(filename); separate.filename = filename; separate.paths = Module._nodeModulePaths(path.dirname(filename));
        separate._compile(fs.readFileSync(filename, 'utf8'), filename);
        const cleanupFile = require.resolve('../../src/twitterGridDeletedCleanup'), actual = require('node:module').createRequire(cleanupFile);
        const loaded = { exports: {} };
        require('node:vm').compileFunction(fs.readFileSync(cleanupFile, 'utf8'), ['require', 'module', 'exports'], { filename: cleanupFile })(
            id => id === './twitterGridCards' ? separate.exports : actual(id), loaded, loaded.exports);
        const main = require('../../src/twitterGridDeletedCleanup')._internal;
        const results = await Promise.all([main.reconcile(rows[0], client, f.db), loaded.exports._internal.reconcile(rows[0], client, f.db)]);
        assert.ok(results.some(Boolean)); assert.equal(mutations, 2);
        assert.equal((await f.db.queryDatabaseIndependent('SELECT * FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [f.item.lockId])).length, 0);
    } finally { await f.db.close(); }
});

test('a lost acknowledgement after a successful Discord edit can be reconciled without losing images', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        let attempts = 0;
        const edit = f.second.edit;
        f.second.edit = async request => {
            attempts++;
            const result = await edit(request);
            if (attempts === 1) throw Object.assign(new Error('connection lost after write'), { code: 'ETIMEDOUT' });
            return result;
        };
        try { await perform(f, 'showAttachmentsAsEmbedsImage'); } catch { /* User can retry after a disclosed uncertain result. */ }
        if (!await grid._internal.sourcesRemainValid(f.interaction, await f.storage.get(f.item.id, gid, cid))) {
            await perform(f, 'showAttachmentsAsEmbedsImage');
        }
        assert.equal(f.messages.size, 2);
        assert.equal(attempts, 1, 'the successful edit was not submitted twice');
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, await f.storage.get(f.item.id, gid, cid)), f.urls);
    } finally { await f.db.close(); }
});

test('a lost acknowledgement after a hidden continuation edit is not resubmitted', { timeout: 60000 }, async () => {
    const f = await fixture({ hideEmbeddedAttachments: true });
    try {
        let attempts = 0;
        const edit = f.second.edit;
        f.second.edit = async request => {
            attempts++; const result = await edit(request);
            if (attempts === 1) throw Object.assign(new Error('response lost after write'), { code: 'ETIMEDOUT' });
            return result;
        };
        await perform(f, 'showAttachmentsAsEmbedsImage');
        assert.equal(attempts, 1); assert.equal(f.second.attachments.size, 0);
        await perform(f, 'showMediaAsAttachments');
        assert.equal(f.second.attachments.size, 3);
    } finally { await f.db.close(); }
});

for (const problem of ['timeout', 'server error']) test(`an edit with ${problem} and an unchanged read is not retried while its outcome is unknown`, { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        let attempts = 0;
        f.second.edit = async () => { attempts++; throw Object.assign(new Error(problem), problem === 'timeout' ? { code: 'ETIMEDOUT' } : { status: 500 }); };
        const before = cards.fingerprint(f.second);
        await assert.rejects(perform(f, 'showAttachmentsAsEmbedsImage'));
        assert.equal(attempts, 1);
        assert.equal(cards.fingerprint(f.second), before, 'an unchanged REST read does not prove an uncertain edit failed');
        await assert.rejects(perform(f, 'showAttachmentsAsEmbedsImage'));
        assert.equal(attempts, 1, 'an uncertain Discord write must never be automatically resubmitted');
        assert.equal(f.messages.size, 2);
    } finally { await f.db.close(); }
});

test('legacy display actions on a publicly combined post keep its complete original photo set usable', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const row = await f.storage.get(f.item.id, gid, cid);
        assert.equal(await grid._internal.replacePublic(f.interaction, row, { data: Buffer.from('combined'), filename: 'twitter-grid.jpg' }, f.deps), 'done');
        assert.equal(f.messages.has(f.second.id), false);
        assert.ok(f.first.attachments.size);
        await perform(f, 'showAttachmentsAsEmbedsImage');
        assert.equal(cards.gridIdFromMessage(f.first), f.item.id);
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, await f.storage.get(f.item.id, gid, cid)), f.urls);
    } finally { await f.db.close(); }
});

test('an authorized existing delete action still works after public image replacement', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const row = await f.storage.get(f.item.id, gid, cid);
        assert.equal(await grid._internal.replacePublic(f.interaction, row, { data: Buffer.from('combined'), filename: 'twitter-grid.jpg' }, f.deps), 'done');
        assert.notEqual(cards.fingerprint(f.first), row.payload.partSignatures[0]);
        await perform(f, 'delete');
        assert.equal(f.messages.size, 0);
    } finally { await f.db.close(); }
});

for (const change of ['extra attachment', 'unrelated embed image']) test(`a combined post with ${change} is rejected without deleting it`, { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const row = await f.storage.get(f.item.id, gid, cid);
        assert.equal(await grid._internal.replacePublic(f.interaction, row, { data: Buffer.from('combined'), filename: 'twitter-grid.jpg' }, f.deps), 'done');
        if (change === 'extra attachment') f.first.attachments.set('777777777777777777', { id: '777777777777777777', name: 'other.png', contentType: 'image/png' });
        else f.first.embeds[0].image = { url: 'https://pbs.twimg.com/media/unrelated.jpg' };
        await assert.rejects(perform(f, 'delete'), /GRID_SOURCE_CHANGED/);
        assert.equal(f.messages.has(f.first.id), true);
    } finally { await f.db.close(); }
});

test('a headless gallery links both physical messages to existing controls without revealing a grid button', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        f.first.components = f.first.components.filter(row => !row.components.some(component => String(component.custom_id || '').startsWith('tg:')));
        assert.equal(cards.gridIdFromMessage(f.first), null);
        const row = await f.storage.get(f.item.id, gid, cid);
        row.payload.headless = true;
        row.payload.partSignatures[0] = cards.fingerprint(f.first);
        row.payload.firstStaticSignature = cards.fingerprint(f.first, true);
        await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(row.payload), f.item.id]);
        await perform(f, 'showAttachmentsAsEmbedsImage');
        assert.equal(f.first.embeds.filter(embed => embed.image).length, 10);
        assert.equal(f.second.embeds.filter(embed => embed.image).length, 3);
        assert.equal(cards.gridIdFromMessage(f.first), null);
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, await f.storage.get(f.item.id, gid, cid)), f.urls);
    } finally { await f.db.close(); }
});

test('a video-only continuation stays with nine photos during display and delete', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const firstFiles = [...f.first.attachments.values()], secondFiles = [...f.second.attachments.values()];
        firstFiles[9].contentType = 'video/mp4'; firstFiles[9].name = 'video1.mp4';
        secondFiles[0].contentType = 'video/mp4'; secondFiles[0].name = 'video2.mp4';
        f.second.attachments = new Map([[secondFiles[0].id, secondFiles[0]]]);
        const row = await f.storage.get(f.item.id, gid, cid), data = row.payload;
        data.imageUrls = f.urls.slice(0, 9); data.partSizes = [9, 0]; data.partContainsNonImage = [true, true];
        data.partRefs = [data.imageUrls.map(url => ({ type: 'url', url })), []];
        data.partSignatures = [cards.fingerprint(f.first), cards.fingerprint(f.second)];
        data.firstStaticSignature = cards.fingerprint(f.first, true);
        await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(data), f.item.id]);
        await perform(f, 'showAttachmentsAsEmbedsImage');
        assert.equal(f.first.embeds.filter(embed => embed.image).length, 9);
        assert.equal(f.first.attachments.get(firstFiles[9].id).contentType, 'video/mp4');
        assert.equal(f.second.attachments.get(secondFiles[0].id).contentType, 'video/mp4');
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, await f.storage.get(f.item.id, gid, cid)), data.imageUrls);
        await perform(f, 'showMediaAsAttachments');
        assert.equal(f.first.attachments.get(firstFiles[9].id).contentType, 'video/mp4');
        assert.equal(f.second.attachments.get(secondFiles[0].id).contentType, 'video/mp4');
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, await f.storage.get(f.item.id, gid, cid)), data.imageUrls);
        await perform(f, 'delete');
        assert.equal(f.messages.size, 0);
    } finally { await f.db.close(); }
});

for (const action of ['showAttachmentsAsEmbedsImage', 'showMediaAsAttachments']) {
    for (const variant of ['root_name', 'tail_name', 'flag', 'flag_object', 'spoiler_property']) {
        test(`spoiler ${variant} blocks ${action} without edits or misleading success`, { timeout: 60000 }, async () => {
            const f = await fixture();
            try {
                f.first.components = f.first.components.map(row => ({ ...row, components: row.components.filter(component => !String(component.custom_id || '').startsWith('tg:')) }))
                    .filter(row => row.components.length);
                const firstControl = f.first.components[0].components[0];
                firstControl.custom_id = `${action}:sl1:${f.item.id}`;
                const rootFile = [...f.first.attachments.values()][0], tailFile = [...f.second.attachments.values()][0];
                if (variant === 'root_name') rootFile.name = `SPOILER_${rootFile.name}`;
                if (variant === 'tail_name') tailFile.name = `SPOILER_${tailFile.name}`;
                if (variant === 'flag') rootFile.flags = 8;
                if (variant === 'flag_object') rootFile.flags = { has: bit => bit === 8 };
                if (variant === 'spoiler_property') rootFile.spoiler = true;
                const row = await f.storage.get(f.item.id, gid, cid), data = row.payload;
                data.headless = true; data.imageUrls = []; data.expectedImageUrls = []; data.expectedRefs = [];
                data.initialImageUrls = []; data.partRefs = [[], []]; data.partSizes = [0, 0]; data.partContainsNonImage = [true, true];
                data.partSignatures = [cards.fingerprint(f.first), cards.fingerprint(f.second)];
                data.firstStaticSignature = cards.fingerprint(f.first, true);
                const originalRecord = JSON.stringify(data);
                await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [originalRecord, f.item.id]);
                const before = [cards.fingerprint(f.first), cards.fingerprint(f.second)], names = [...f.first.attachments.values(), ...f.second.attachments.values()].map(file => file.name);
                let edits = 0, replies = 0;
                for (const message of [f.first, f.second]) { const edit = message.edit; message.edit = async request => { edits++; return edit(request); }; }
                f.interaction.editReply = async () => { replies++; };
                await assert.rejects(perform(f, action), /GRID_SPOILER_DISPLAY_UNAVAILABLE/);
                assert.equal(edits, 0); assert.equal(replies, 0);
                assert.deepEqual([cards.fingerprint(f.first), cards.fingerprint(f.second)], before);
                assert.deepEqual([...f.first.attachments.values(), ...f.second.attachments.values()].map(file => file.name), names);
                assert.equal((await f.storage.get(f.item.id, gid, cid)).payload_json, originalRecord);
                assert.equal((await f.db.queryDatabaseIndependent('SELECT * FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [f.item.lockId])).length, 0);
                // A display rejection does not stop the requester deleting
                // the same verified multi-message group.
                await perform(f, 'delete'); assert.equal(f.messages.size, 0);
            } finally { await f.db.close(); }
        });
    }
}

test('a video-only group never reports an image display conversion', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        f.first.components = f.first.components.map(row => ({ ...row, components: row.components.filter(component => !String(component.custom_id || '').startsWith('tg:')) }))
            .filter(row => row.components.length);
        for (const file of [...f.first.attachments.values(), ...f.second.attachments.values()]) {
            file.name = file.name.replace(/\.jpg$/, '.mp4'); file.contentType = 'video/mp4';
        }
        const row = await f.storage.get(f.item.id, gid, cid), data = row.payload;
        data.headless = true; data.imageUrls = []; data.expectedImageUrls = []; data.expectedRefs = []; data.initialImageUrls = [];
        data.partRefs = [[], []]; data.partSizes = [0, 0]; data.partContainsNonImage = [true, true];
        data.partSignatures = [cards.fingerprint(f.first), cards.fingerprint(f.second)]; data.firstStaticSignature = cards.fingerprint(f.first, true);
        await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(data), f.item.id]);
        const before = [cards.fingerprint(f.first), cards.fingerprint(f.second)];
        await assert.rejects(perform(f, 'showAttachmentsAsEmbedsImage'), /GRID_NO_DISPLAYABLE_IMAGES/);
        assert.deepEqual([cards.fingerprint(f.first), cards.fingerprint(f.second)], before);
        assert.equal((await f.db.queryDatabaseIndependent('SELECT * FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [f.item.lockId])).length, 0);
    } finally { await f.db.close(); }
});

test('a revoked channel permission takes precedence over the spoiler notice', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        [...f.first.attachments.values()][0].name = 'SPOILER_private.jpg';
        const row = await f.storage.get(f.item.id, gid, cid), data = row.payload;
        data.partSignatures = [cards.fingerprint(f.first), cards.fingerprint(f.second)];
        data.firstStaticSignature = cards.fingerprint(f.first, true);
        await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(data), f.item.id]);
        f.deps.freshAccess = async () => null;
        const before = [cards.fingerprint(f.first), cards.fingerprint(f.second)];
        await assert.rejects(perform(f, 'showAttachmentsAsEmbedsImage'), /GRID_PERMISSION_CHANGED/);
        assert.deepEqual([cards.fingerprint(f.first), cards.fingerprint(f.second)], before);
    } finally { await f.db.close(); }
});

test('a verified text-only continuation is deleted without touching unrelated posts', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        f.first.components = f.first.components.map(row => ({ ...row, components: row.components.filter(component => !String(component.custom_id || '').startsWith('tg:')) }))
            .filter(row => row.components.length);
        f.first.attachments.clear(); f.second.attachments.clear(); f.second.content = 'continued link list';
        const unrelated = { id: '777777777777777777', author: { id: user }, content: 'other post' };
        f.messages.set(unrelated.id, unrelated);
        const row = await f.storage.get(f.item.id, gid, cid), data = row.payload;
        data.headless = true; data.imageUrls = []; data.expectedImageUrls = []; data.partSizes = [0, 0];
        data.partRefs = [[], []]; data.partContainsNonImage = [false, true];
        data.partSignatures = [cards.fingerprint(f.first), cards.fingerprint(f.second)];
        data.firstStaticSignature = cards.fingerprint(f.first, true);
        await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(data), f.item.id]);
        await perform(f, 'delete');
        assert.equal(f.messages.has(f.first.id), false); assert.equal(f.messages.has(f.second.id), false);
        assert.equal(f.messages.get(unrelated.id), unrelated);
    } finally { await f.db.close(); }
});

test('a visible quote button does not hide the headless split parent from delete', { timeout: 60000 }, async () => {
    const f = await fixture({ quote: true });
    try {
        f.first.components = f.first.components.map(row => ({ ...row, components: row.components.filter(component => component.custom_id !== `tg:${f.item.id}:0:open`) }))
            .filter(row => row.components.length);
        assert.equal(cards.gridIdFromMessage(f.first), f.quote.id);
        for (const id of [f.item.id, f.quote.id]) {
            const row = await f.storage.get(id, gid, cid), data = row.payload;
            if (id === f.item.id) data.headless = true;
            data.partSignatures[0] = cards.fingerprint(f.first); data.firstStaticSignature = cards.fingerprint(f.first, true);
            await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(data), id]);
        }
        await perform(f, 'delete');
        assert.equal(f.messages.size, 0);
    } finally { await f.db.close(); }
});

test('both parent and quoted photos can be publicly combined after a multi-part parent', { timeout: 60000 }, async () => {
    const f = await fixture({ quote: true });
    try {
        const parent = await f.storage.get(f.item.id, gid, cid), oldQuote = await f.storage.get(f.quote.id, gid, cid);
        const combined = { data: Buffer.from('combined'), filename: 'twitter-grid.jpg' };
        assert.equal(await grid._internal.replacePublic(f.interaction, parent, combined, f.deps), 'done');
        assert.equal(f.messages.has(f.second.id), false);
        const quote = await grid._internal.reconcileSibling(f.interaction, oldQuote, f.deps);
        assert.ok(quote);
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, quote), f.quoteUrls);
        assert.equal(await grid._internal.replacePublic(f.interaction, quote, combined, f.deps), 'done');
        const names = [...f.first.attachments.values()].map(item => item.name);
        assert.ok(names.some(name => name.includes(f.item.id)));
        assert.ok(names.some(name => name.includes(f.quote.id)));
    } finally { await f.db.close(); }
});

test('combining a quote first retains parent display controls and both galleries', { timeout: 60000 }, async () => {
    const f = await fixture({ quote: true });
    try {
        const moved = [...f.first.attachments.entries()].slice(8);
        for (const [id] of moved) f.first.attachments.delete(id);
        f.second.attachments = new Map([...moved, ...f.second.attachments]);
        for (const id of [f.item.id, f.quote.id]) {
            const row = await f.storage.get(id, gid, cid), data = row.payload;
            data.partSignatures[0] = cards.fingerprint(f.first); data.firstStaticSignature = cards.fingerprint(f.first, true);
            if (id === f.item.id) {
                data.partSizes = [8, 5]; data.partSignatures[1] = cards.fingerprint(f.second);
                data.partRefs = [f.urls.slice(0, 8), f.urls.slice(8)].map(urls => urls.map(url => ({ type: 'url', url })));
                if (data.embedWitness) data.embedWitness.attachments = [...f.first.attachments.values()].map(file => ({ id: file.id, name: file.name }));
            }
            await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(data), id]);
        }
        const quote = await f.storage.get(f.quote.id, gid, cid);
        assert.equal(await grid._internal.replacePublic(f.interaction, quote, { data: Buffer.from('quote'), filename: 'twitter-grid.jpg' }, f.deps), 'done');
        await perform(f, 'translate', true);
        assert.equal(f.first.embeds[0].description, 'translated text');
        await perform(f, 'showAttachmentsAsEmbedsImage');
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, await f.storage.get(f.item.id, gid, cid)), f.urls);
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, await f.storage.get(f.quote.id, gid, cid)), f.quoteUrls);
    } finally { await f.db.close(); }
});

for (const kind of ['video', 'unknown']) {
    test(`mixed ${kind} media survives existing controls and public image replacement`, { timeout: 60000 }, async () => {
        const f = await fixture({ nonImage: kind });
        try {
            const before = cards.fingerprint(f.first);
            const result = await grid._internal.replacePublic(f.interaction, await f.storage.get(f.item.id, gid, cid), { data: Buffer.from('combined'), filename: 'twitter-grid.jpg' }, f.deps);
            assert.ok(f.messages.has(f.second.id), 'the continuation carrying non-image data is retained');
            assert.equal(f.second.attachments.get('888888888888888888')?.name, kind === 'video' ? 'movie.mp4' : 'unknown.bin');
            if (result !== 'done') assert.equal(cards.fingerprint(f.first), before, 'a refused operation makes no partial first-message change');
        } finally { await f.db.close(); }
    });
    test(`mixed ${kind} media survives existing display controls`, { timeout: 60000 }, async () => {
        const f = await fixture({ nonImage: kind });
        try {
            const beforeFirst = cards.fingerprint(f.first), beforeSecond = cards.fingerprint(f.second);
            let refused = false;
            try { await perform(f, 'showAttachmentsAsEmbedsImage'); } catch { refused = true; }
            assert.equal(f.second.attachments.get('888888888888888888')?.name, kind === 'video' ? 'movie.mp4' : 'unknown.bin');
            if (refused) {
                assert.equal(cards.fingerprint(f.first), beforeFirst);
                assert.equal(cards.fingerprint(f.second), beforeSecond);
            } else {
                assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, await f.storage.get(f.item.id, gid, cid)), f.urls);
            }
        } finally { await f.db.close(); }
    });
}

for (const editOriginal of [false, true]) test(`translation with inline quote preserves both galleries, edit original=${editOriginal}`, { timeout: 60000 }, async () => {
    const f = await fixture({ quote: true });
    try {
        await perform(f, 'translate', editOriginal);
        const parent = await f.storage.get(f.item.id, gid, cid), quote = await f.storage.get(f.quote.id, gid, cid);
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, parent), f.urls);
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, quote), f.quoteUrls);
        const combined = { data: Buffer.from('combined'), filename: 'twitter-grid.jpg' };
        assert.equal(await grid._internal.replacePublic(f.interaction, parent, combined, f.deps), 'done');
        const refreshedQuote = await grid._internal.reconcileSibling(f.interaction, quote, f.deps);
        assert.ok(refreshedQuote);
        assert.equal(await grid._internal.replacePublic(f.interaction, refreshedQuote, combined, f.deps), 'done');
    } finally { await f.db.close(); }
});

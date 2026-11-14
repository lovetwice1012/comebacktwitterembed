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

async function fixture({ quote = false, nonImage = null } = {}) {
    const db = await createTestDatabase(port);
    const sql = fs.readFileSync(path.join(schema.MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
    await db.queryDatabase(schema._internal.splitSqlStatements(sql).find(s => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(s)));
    const locatorSql = fs.readFileSync(path.join(schema.MIGRATIONS_DIR, '20261113_add_twitter_gallery_locator_index.sql'), 'utf8');
    for (const statement of schema._internal.splitSqlStatements(locatorSql)) await db.queryDatabase(statement);
    const journalSql = fs.readFileSync(path.join(schema.MIGRATIONS_DIR, '20261113_add_twitter_grid_action_intents.sql'), 'utf8');
    for (const statement of schema._internal.splitSqlStatements(journalSql)) await db.queryDatabase(statement);
    const storage = gallery.createStore(db), settings = { enabled: true, defaultLanguage: 'ja', twitter_grid_replace_permission: 'restricted' };
    const urls = Array.from({ length: 13 }, (_, i) => image(i + 1));
    const parts = [urls.slice(0, 10), urls.slice(10)];
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
    const first = { id: '555555555555555555', channelId: cid, author: { id: bot }, content: '', embeds: [{ title: 'post', description: '本文', url: 'https://x.com/example/status/123', author: { name: `requester(id:${user})` } }], components: prepared.step.components, attachments: makeFiles(parts[0]) };
    if (quote) first.embeds.push({ title: 'quote', image: { url: quoteUrls[0] } }, { image: { url: quoteUrls[1] } });
    const second = { id: '666666666666666666', channelId: cid, author: { id: bot }, content: '', embeds: [], components: [], attachments: makeFiles(parts[1]) };
    if (nonImage) second.attachments.set('888888888888888888', { id: '888888888888888888', name: nonImage === 'video' ? 'movie.mp4' : 'unknown.bin', url: `https://cdn.discordapp.com/attachments/${gid}/${cid}/${nonImage}`, contentType: nonImage === 'video' ? 'video/mp4' : null });
    const messages = new Map([[first.id, first], [second.id, second]]);
    for (const message of messages.values()) {
        message.edit = async request => {
            const old = [...message.attachments.values()];
            // discord.js sends an attachment list for a supplied files array;
            // without an explicit retain list the old files are replaced.
            const retained = request.attachments ? old.filter(file => request.attachments.some(item => String(item.id) === file.id)) : request.files ? [] : old;
            const added = (request.files || []).map(file => { const url = typeof file === 'string' ? file : file.attachment; const name = typeof file === 'string' ? new URL(url).pathname.split('/').pop() : file.name; const id = String(++nextId); return { id, name, contentType: 'image/jpeg', url: `https://cdn.discordapp.com/attachments/${cid}/${id}/${name}` }; });
            message.attachments = new Map([...retained, ...added].map(file => [file.id, file]));
            if (request.embeds) message.embeds = request.embeds.map(embed => ({ ...embed, image: embed.image?.url?.startsWith('attachment://') ? { url: [...retained, ...added].find(file => file.name === embed.image.url.slice(13))?.url } : embed.image }));
            if (request.components) message.components = request.components;
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
    return { db, storage, item, quote: prepared.grids[1], quoteUrls, interaction, first, second, messages, urls, deps };
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
            const item = { id, author: { id: bot }, content: '', embeds: [], components: [], attachments: new Map([[photo.id, photo]]) };
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

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const gallery = require('../../src/mediaGallery'), cards = require('../../src/twitterGridCards'), grid = require('../../src/components/twitterGrid');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (![33621, 33622].includes(port)) throw Error('Explicit isolated DB port required');
const gid = '333333333333333333', cid = '444444444444444444', user = '111111111111111111', bot = '222222222222222222';
const img = n => `https://pbs.twimg.com/media/photo${n}.jpg`;
async function setup(db, { parentAttached = false, parentCount = 2 } = {}) {
    const schema = require('../../src/db_schema'), fs = require('node:fs'), path = require('node:path');
    const sql = fs.readFileSync(path.join(schema.MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
    await db.queryDatabase(schema._internal.splitSqlStatements(sql).find(statement => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(statement)));
    const storage = gallery.createStore(db), settings = { enabled: true, button_disabled: { user: [], channel: [], role: ['888888888888888888'] } };
    const parent = { imageUrls: Array.from({ length: parentCount }, (_, i) => img(i + 1)), sequence: 0, totalParts: 1, embedStart: 0, embedEnd: parentAttached ? 1 : 2 };
    const quote = { imageUrls: [img(1), img(3)], sequence: 0, totalParts: 1, embedStart: parentAttached ? 1 : 2, embedEnd: parentAttached ? 3 : 4 };
    const step = { components: [], twitterGrid: parent, twitterGridSharedInline: true, twitterGridInline: [quote], ...(parentAttached ? { files: parent.imageUrls } : {}) };
    const prepared = await cards.prepare(step, { guildId: gid, channelId: cid, author: { id: user } }, { providerId: 'twitter', presentationSettings: settings }, storage);
    const first = { id: '555555555555555555', author: { id: bot }, content: '', components: prepared.step.components,
        attachments: parentAttached ? new Map(Array.from({ length: parentCount }, (_, i) => [String(i + 1), { id: String(i + 1), name: `photo${i + 1}.jpg`, contentType: 'image/jpeg' }])) : new Map(),
        embeds: parentAttached ? [{ title: 'parent' }, { title: 'quote', image: { url: img(1) } }, { image: { url: img(3) } }]
            : [{ title: 'parent', image: { url: img(1) } }, { image: { url: img(2) } }, { title: 'quote', image: { url: img(1) } }, { image: { url: img(3) } }] };
    let nextId = 900;
    first.edit = async request => {
        const keep = [...first.attachments.values()].filter(file => request.attachments.some(item => item.id === String(file.id)));
        const name = request.files[0].name, file = { id: String(++nextId), name, contentType: 'image/jpeg', url: `https://cdn.discordapp.com/attachments/3/4/${name}` };
        first.attachments = new Map([...keep, file].map(item => [String(item.id), item]));
        first.embeds = request.embeds.map(embed => embed.image?.url === `attachment://${name}` ? { ...embed, image: { url: file.url } } : embed);
        return first;
    };
    for (const item of prepared.grids) { assert.equal(await cards.bind(item, first, storage, db), true); assert.equal((await cards.finish(item, db)).state, 'complete'); }
    const channel = { nsfw: false, messages: { fetch: async () => first } };
    const interaction = { guildId: gid, channelId: cid, user: { id: user }, client: { user: { id: bot } }, channel };
    const deps = { db, getSettings: async () => settings, freshAccess: async () => ({ permissions: { has: () => true }, member: { _roles: [] }, channel }) };
    return { storage, settings, parentId: prepared.grids[0].id, quoteId: prepared.grids[1].id, first, interaction, deps };
}
test('same URL in parent and quote survives both replacements with real database reconciliation', { timeout: 60000 }, async () => {
    const db = await createTestDatabase(port);
    try {
        const f = await setup(db), parent = await f.storage.get(f.parentId, gid, cid), oldQuote = await f.storage.get(f.quoteId, gid, cid);
        const image = { data: Buffer.from('parent'), filename: 'twitter-grid.jpg' };
        assert.equal(await grid._internal.replacePublic(f.interaction, parent, image, f.deps), 'done');
        assert.equal(await grid._internal.sourcesRemainValid(f.interaction, oldQuote), false);
        const quote = await grid._internal.reconcileSibling(f.interaction, oldQuote, f.deps);
        assert.ok(quote); assert.deepEqual([quote.payload.embedStart, quote.payload.embedEnd], [1, 3]);
        assert.equal(await grid._internal.sourcesRemainValid(f.interaction, quote), true);
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, quote), [img(1), img(3)]);
        assert.equal(await grid._internal.replacePublic(f.interaction, quote, { data: Buffer.from('quote'), filename: 'twitter-grid.jpg' }, f.deps), 'done');
        const names = [...f.first.attachments.values()].map(item => item.name);
        assert.equal(names.length, 2); assert.ok(names.some(name => name.includes(f.parentId))); assert.ok(names.some(name => name.includes(f.quoteId)));
        assert.equal(await grid._internal.sourcesRemainValid(f.interaction, await f.storage.get(f.parentId, gid, cid)), true);
    } finally { await db.close(); }
});
test('quote replacement retains parent source attachments and parent can be reconciled afterward', { timeout: 60000 }, async () => {
    const db = await createTestDatabase(port);
    try {
        const f = await setup(db, { parentAttached: true }), parentBefore = await f.storage.get(f.parentId, gid, cid), quote = await f.storage.get(f.quoteId, gid, cid);
        assert.equal(await grid._internal.replacePublic(f.interaction, quote, { data: Buffer.from('quote'), filename: 'twitter-grid.jpg' }, f.deps), 'done');
        assert.ok(f.first.attachments.has('1')); assert.ok(f.first.attachments.has('2'));
        const parent = await grid._internal.reconcileSibling(f.interaction, parentBefore, f.deps);
        assert.ok(parent); assert.equal(await grid._internal.sourcesRemainValid(f.interaction, parent), true);
        assert.equal(await grid._internal.replacePublic(f.interaction, parent, { data: Buffer.from('parent'), filename: 'twitter-grid.jpg' }, f.deps), 'done');
        const names = [...f.first.attachments.values()].map(item => item.name);
        assert.equal(names.length, 2); assert.ok(names.some(name => name.includes(f.parentId))); assert.ok(names.some(name => name.includes(f.quoteId)));
    } finally { await db.close(); }
});
test('ten parent attachments block quote replacement before editing and offer a safe recovery path', { timeout: 60000 }, async () => {
    const db = await createTestDatabase(port);
    try {
        const f = await setup(db, { parentAttached: true, parentCount: 10 }), quote = await f.storage.get(f.quoteId, gid, cid);
        const before = cards.fingerprint(f.first), composed = { data: Buffer.from('quote'), filename: 'twitter-grid.jpg' };
        assert.equal(await grid._internal.replacePublic(f.interaction, quote, composed, f.deps), 'attachment_limit');
        assert.equal(f.first.attachments.size, 10); assert.equal(cards.fingerprint(f.first), before);
        const calls = [], state = { ...grid._internal.defaults(f.settings, 2), target: 'r' };
        f.interaction.customId = grid._internal.custom(f.quoteId, user, 'confirm', state); f.interaction.locale = 'ja';
        f.interaction.message = { author: { id: bot }, flags: { has: value => value === 64 } };
        f.interaction.memberPermissions = { has: () => true }; f.interaction.deferUpdate = async () => {};
        f.interaction.editReply = async value => calls.push(value);
        f.deps.storage = f.storage; f.deps.isAllowed = async () => true; f.deps.compose = async () => composed;
        await grid.handle(f.interaction, f.deps);
        assert.match(calls.at(-1).content, /添付がいっぱい.*先に親投稿の画像をまとめて/);
        assert.equal(f.first.attachments.size, 10); assert.equal(cards.fingerprint(f.first), before);
        const parent = await f.storage.get(f.parentId, gid, cid);
        assert.equal(await grid._internal.replacePublic(f.interaction, parent, { data: Buffer.from('parent'), filename: 'twitter-grid.jpg' }, f.deps), 'done');
        const refreshedQuote = await grid._internal.reconcileSibling(f.interaction, quote, f.deps); assert.ok(refreshedQuote);
        assert.equal(await grid._internal.replacePublic(f.interaction, refreshedQuote, composed, f.deps), 'done');
        assert.equal(f.first.attachments.size, 2);
    } finally { await db.close(); }
});
test('reconciliation fails closed on ambiguity, revoked role and DB failure', { timeout: 60000 }, async () => {
    const db = await createTestDatabase(port);
    try {
        const f = await setup(db), parent = await f.storage.get(f.parentId, gid, cid), quote = await f.storage.get(f.quoteId, gid, cid);
        assert.equal(await grid._internal.replacePublic(f.interaction, parent, { data: Buffer.from('parent'), filename: 'twitter-grid.jpg' }, f.deps), 'done');
        const denied = { ...f.deps, freshAccess: async () => ({ permissions: { has: () => true }, member: { _roles: ['888888888888888888'] }, channel: f.interaction.channel }) };
        assert.equal(await grid._internal.reconcileSibling(f.interaction, quote, denied), null);
        await assert.rejects(grid._internal.reconcileSibling(f.interaction, quote, { ...f.deps, db: { withDatabaseTransaction: async () => { throw Error('fixture DB failure'); } } }), /fixture DB failure/);
        assert.equal((await f.storage.get(f.quoteId, gid, cid)).payload.partSignatures[0], quote.payload.partSignatures[0]);
        const witness = quote.payload.embedWitness;
        const duplicate = { embeds: [ ...f.first.embeds, ...f.first.embeds.slice(1, 3) ], attachments: f.first.attachments };
        assert.equal(grid._internal.embedWitnessPosition(duplicate, witness), null);
        const original = f.first.embeds[1].image;
        f.first.embeds[1].image = { url: img(99) };
        assert.equal(await grid._internal.reconcileSibling(f.interaction, quote, f.deps), null);
        f.first.embeds[1].image = original;
        assert.equal(await grid._internal.reconcileSibling(f.interaction, quote, { ...f.deps, freshAccess: async () => null }), null);
        assert.equal((await f.storage.get(f.quoteId, gid, cid)).payload.partSignatures[0], quote.payload.partSignatures[0]);
    } finally { await db.close(); }
});
test('Discord success followed by DB rollback allows safe sibling recovery without revealing stale data', { timeout: 60000 }, async () => {
    const db = await createTestDatabase(port);
    try {
        const f = await setup(db), parent = await f.storage.get(f.parentId, gid, cid), quote = await f.storage.get(f.quoteId, gid, cid);
        const failDb = { withDatabaseTransaction: work => db.withDatabaseTransaction(async query => { await work(query); throw Error('fixture commit failure'); }) };
        await assert.rejects(grid._internal.replacePublic(f.interaction, parent, { data: Buffer.from('parent'), filename: 'twitter-grid.jpg' }, { ...f.deps, db: failDb }), /fixture commit failure/);
        assert.equal((await f.storage.get(f.parentId, gid, cid)).payload.replacePhase, undefined);
        const reconciled = await grid._internal.reconcileSibling(f.interaction, quote, f.deps);
        assert.ok(reconciled); assert.equal(await grid._internal.sourcesRemainValid(f.interaction, reconciled), true);
        assert.deepEqual(await grid._internal.sourceImageUrls(f.interaction, reconciled), [img(1), img(3)]);
    } finally { await db.close(); }
});
test('ordinary user button refreshes a validated sibling automatically after a group replacement', { timeout: 60000 }, async () => {
    const db = await createTestDatabase(port);
    try {
        const f = await setup(db), parent = await f.storage.get(f.parentId, gid, cid);
        assert.equal(await grid._internal.replacePublic(f.interaction, parent, { data: Buffer.from('parent'), filename: 'twitter-grid.jpg' }, f.deps), 'done');
        const calls = [], state = grid._internal.defaults(f.settings, 2);
        f.interaction.customId = grid._internal.custom(f.quoteId, user, 'preview', state); f.interaction.locale = 'ja';
        f.interaction.message = { author: { id: bot }, flags: { has: value => value === 64 } };
        f.interaction.memberPermissions = { has: () => true }; f.interaction.deferUpdate = async () => {};
        f.interaction.editReply = async value => calls.push(value);
        f.deps.storage = f.storage; f.deps.isAllowed = async () => true;
        f.deps.compose = async urls => { assert.deepEqual(urls, [img(1), img(3)]); return { data: Buffer.from('preview'), filename: 'twitter-grid.jpg' }; };
        await grid.handle(f.interaction, f.deps);
        assert.equal(calls.at(-1).files[0].attachment.toString(), 'preview');
        assert.equal(await grid._internal.sourcesRemainValid(f.interaction, await f.storage.get(f.quoteId, gid, cid)), true);
    } finally { await db.close(); }
});

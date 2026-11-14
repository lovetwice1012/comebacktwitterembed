'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const gallery = require('../../src/mediaGallery');
const cards = require('../../src/twitterGridCards');
const grid = require('../../src/components/twitterGrid');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (![33621, 33622].includes(port)) throw Error('An explicit isolated test database port is required');

test('same-message quote groups use one real SQL lock and preserve unrelated embeds', { timeout: 60000 }, async () => {
    const db = await createTestDatabase(port);
    try {
        const schema = require('../../src/db_schema')._internal;
        const sql = require('node:fs').readFileSync(require('node:path').join(schema.MIGRATIONS_DIR || require('../../src/db_schema').MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
        await db.queryDatabase(schema.splitSqlStatements(sql).find(statement => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(statement)));
        const storage = gallery.createStore(db), user = '111111111111111111', bot = '222222222222222222', guildId = '333333333333333333', channelId = '444444444444444444';
        const img = n => `https://pbs.twimg.com/media/${n}?format=jpg`;
        const meta = (urls, start, end) => ({ imageUrls: urls, sequence: 0, totalParts: 1, embedStart: start, embedEnd: end });
        const settings = { enabled: true, defaultLanguage: 'ja', twitter_grid_replace_permission: 'restricted' };
        const step = { components: [], twitterGrid: meta([img(1), img(2)], 0, 2), twitterGridInline: [meta([img(1), img(3)], 2, 4)] };
        const original = { guildId, channelId, author: { id: user } };
        const prepared = await cards.prepare(step, original, { providerId: 'twitter', presentationSettings: settings }, storage);
        assert.equal(prepared.grids.length, 2); assert.equal(prepared.grids[0].lockId, prepared.grids[1].lockId);
        const first = { id: '555555555555555555', author: { id: bot }, content: '', components: prepared.step.components, attachments: new Map(), embeds: [
            { title: '親', image: { url: img(1) } }, { url: 'https://x.com/a', image: { url: img(2) } },
            { title: '引用', image: { url: img(1) } }, { url: 'https://x.com/b', image: { url: img(3) } },
        ] };
        for (const item of prepared.grids) {
            assert.equal(await cards.bind(item, first, storage, db), true);
            assert.deepEqual(await cards.finish(item, db), { state: 'complete' });
        }
        const [parent, quote] = await Promise.all(prepared.grids.map(item => storage.get(item.id, guildId, channelId)));
        let editing = 0, release, enter;
        const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
        first.edit = async payload => {
            editing++; enter(); await gate;
            first.embeds = payload.embeds; first.attachments = new Map([['new', { id: '777777777777777777', name: payload.files[0].name, contentType: 'image/jpeg' }]]);
            return first;
        };
        const interaction = { guildId, channelId, user: { id: user }, client: { user: { id: bot } }, channel: { nsfw: false, messages: { fetch: async () => first } } };
        const deps = { db, getSettings: async () => settings, freshAccess: async () => ({ has: () => true }) };
        const composed = { data: Buffer.from('grid'), filename: 'twitter-grid.jpg' };
        const p = grid._internal.replacePublic(interaction, parent, composed, deps); await entered;
        let secondDone = false;
        const q = grid._internal.replacePublic(interaction, quote, composed, deps).then(value => { secondDone = true; return value; });
        let legacyDone = false;
        const legacy = cards.withMessageLock({ ...interaction, message: first }, async () => { legacyDone = true; }, db)
            .then(() => 'unexpected', error => error.message);
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(secondDone, false); assert.equal(legacyDone, false); assert.equal(editing, 1, 'both the second group and legacy edits must wait for the shared row lock');
        release(); assert.equal(await p, 'done'); assert.equal(await q, 'changed');
        assert.equal(await legacy, 'GRID_SOURCE_CHANGED'); assert.equal(legacyDone, false);
        assert.equal(first.embeds.at(-1).image.url, img(3));
    } finally { await db.close(); }
});

test('SQL rollback after Discord accepted both operations can be recovered using the message marker', { timeout: 60000 }, async () => {
    const db = await createTestDatabase(port);
    try {
        const schema = require('../../src/db_schema'), sql = require('node:fs').readFileSync(require('node:path').join(schema.MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
        await db.queryDatabase(schema._internal.splitSqlStatements(sql).find(statement => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(statement)));
        const storage = gallery.createStore(db), guildId = '333333333333333333', channelId = '444444444444444444', user = '111111111111111111', bot = '222222222222222222';
        const img = n => `https://pbs.twimg.com/media/${n}?format=jpg`;
        const settings = { enabled: true, defaultLanguage: 'ja', twitter_grid_replace_permission: 'restricted' };
        const part1 = { imageUrls: Array.from({ length: 10 }, (_, i) => img(i)), sequence: 0, totalParts: 2 }, part2 = { imageUrls: [img(10), img(11)], sequence: 1, totalParts: 2 };
        const prepared = await cards.prepare({ components: [], twitterGrid: part1 }, { guildId, channelId, author: { id: user } }, { providerId: 'twitter', presentationSettings: settings }, storage, { twitterGrid: part2 });
        const attachment = (id, name) => ({ id: String(id), name, contentType: 'image/jpeg', url: `https://cdn.discordapp.com/attachments/${channelId}/${id}/${name}` });
        const first = { id: '555555555555555555', channelId, author: { id: bot }, content: '', embeds: [{ title: '本文' }], components: prepared.step.components,
            attachments: new Map(Array.from({ length: 10 }, (_, i) => [String(i), attachment(i, `photo${i}.jpg`)])) };
        const second = { id: '666666666666666666', author: { id: bot }, content: '', embeds: [], components: [], attachments: new Map([['10', attachment(10, '10.jpg')], ['11', attachment(11, '11.jpg')]]) };
        assert.equal(await cards.bind(prepared.grids[0], first, storage, db), true); assert.equal(await cards.append(prepared.grids[0], part2, second, db), true);
        assert.deepEqual(await cards.finish(prepared.grids[0], db), { state: 'complete' });
        let deleted = false, deletes = 0;
        first.edit = async value => { first.embeds = value.embeds; first.attachments = new Map([['grid', attachment('777777777777777777', value.files[0].name)]]); return first; };
        second.delete = async () => { deleted = true; deletes++; };
        const interaction = { guildId, channelId, user: { id: user }, client: { user: { id: bot } }, channel: { nsfw: false, messages: { fetch: async ({ message }) => {
            if (message === first.id) return first; if (message === second.id && !deleted) return second; throw { code: 10008 };
        } } } };
        const failDb = { withDatabaseTransaction: work => db.withDatabaseTransaction(async query => { await work(query); throw Error('fixture transaction failure'); }) };
        const deps = { db: failDb, getSettings: async () => settings, freshAccess: async () => ({ has: () => true }) };
        const composed = { data: Buffer.from('grid'), filename: 'twitter-grid.jpg' }, id = prepared.grids[0].id;
        await assert.rejects(grid._internal.replacePublic(interaction, await storage.get(id, guildId, channelId), composed, deps), /fixture transaction failure/);
        const rolledBack = await storage.get(id, guildId, channelId);
        assert.equal(rolledBack.payload.replacePhase, undefined); assert.equal(deleted, true);
        assert.equal(await grid._internal.sourcesRemainValid(interaction, rolledBack), true);
        deps.db = db;
        assert.equal(await grid._internal.replacePublic(interaction, rolledBack, composed, deps), 'done');
        assert.equal(deletes, 1);
    } finally { await db.close(); }
});

test('incomplete outcomes are durable and cannot overwrite a concurrent completed append', { timeout: 60000 }, async () => {
    const db = await createTestDatabase(port);
    try {
        const schema = require('../../src/db_schema'), sql = require('node:fs').readFileSync(require('node:path').join(schema.MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
        await db.queryDatabase(schema._internal.splitSqlStatements(sql).find(statement => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(statement)));
        const storage = gallery.createStore(db), guildId = '333333333333333333', channelId = '444444444444444444', user = '111111111111111111', bot = '222222222222222222';
        const img = n => `https://pbs.twimg.com/media/${n}?format=jpg`;
        const settings = { enabled: true }, part1 = { imageUrls: Array.from({ length: 10 }, (_, i) => img(i)), sequence: 0, totalParts: 2 }, part2 = { imageUrls: [img(10), img(11)], sequence: 1, totalParts: 2 };
        async function setup(messageId) {
            const prepared = await cards.prepare({ components: [], twitterGrid: part1 }, { guildId, channelId, author: { id: user } }, { providerId: 'twitter', presentationSettings: settings }, storage, { twitterGrid: part2 });
            const first = { id: messageId, author: { id: bot }, content: '', embeds: [{ title: 'Post' }], components: prepared.step.components, attachments: new Map() };
            const item = prepared.grids[0]; assert.equal(await cards.bind(item, first, storage, db), true);
            assert.equal(item.partsState, 'pending'); assert.ok(item.pendingAtMs > 0);
            return item;
        }
        const finished = await setup('555555555555555555'), stale = JSON.parse(JSON.stringify(finished));
        const second = { id: '666666666666666666', author: { id: bot }, content: '', embeds: [], components: [], attachments: new Map() };
        assert.equal(await cards.append(finished, part2, second, db), true);
        assert.deepEqual(await cards.finish(finished, db), { state: 'complete' });
        assert.equal(await cards.markIncomplete(stale, 'failed', db), false, 'a stale error must not replace the confirmed complete state');
        assert.equal((await storage.get(finished.id, guildId, channelId)).payload.partsState, 'complete');
        const failing = await setup('777777777777777777');
        assert.equal(await cards.markIncomplete(failing, 'delivery_unknown', db), true);
        const afterRestart = await gallery.createStore(db).get(failing.id, guildId, channelId);
        assert.equal(afterRestart.payload.partsState, 'delivery_unknown'); assert.equal(afterRestart.payload.completedParts, 1);
        const outage = await setup('888888888888888888');
        await assert.rejects(cards.markIncomplete(outage, 'record_unknown', { queryDatabase: async () => { throw Error('fixture DB outage'); } }), /fixture DB outage/);
        const persisted = await storage.get(outage.id, guildId, channelId);
        assert.equal(persisted.payload.partsState, 'pending');
        assert.match(grid._internal.partsProgress(persisted.payload, 'ja', persisted.payload.pendingAtMs + 301000), /送信状況を確認できません/);
    } finally { await db.close(); }
});

test('saved media is left unchanged and receives no premature grid button', { timeout: 60000 }, async () => {
    const db = await createTestDatabase(port);
    try {
        const schema = require('../../src/db_schema'), sql = require('node:fs').readFileSync(require('node:path').join(schema.MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
        await db.queryDatabase(schema._internal.splitSqlStatements(sql).find(statement => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(statement)));
        const storage = gallery.createStore(db), guildId = '333333333333333333', channelId = '444444444444444444', user = '111111111111111111', bot = '222222222222222222';
        const root = `https://twidata.sprink.cloud/data/${user}/123/`, source = `${root}data.json`;
        const pics = [`${root}media-0-a.jpg`, `${root}media-2-b.png`], movie = `${root}media-1-movie.mp4`;
        const meta = { imageUrls: pics, sequence: 0, totalParts: 1 }, settings = { enabled: true };
        const step = { twitterGrid: meta, files: [pics[0], movie, pics[1]], components: [] };
        const context = { providerId: 'twitter', url: source, presentationSettings: settings };
        const refs = cards.references(meta, step, context);
        assert.deepEqual(refs.map(ref => ref.name), ['media-0-a.jpg', 'media-2-b.png']);
        const prepared = await cards.prepare(step, { guildId, channelId, author: { id: user } }, context, storage);
        assert.equal(prepared.grids, undefined);
        assert.deepEqual(prepared.step.files, [pics[0], movie, pics[1]]);
        assert.deepEqual(prepared.step.components, []);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM bot_media_galleries'))[0].n), 0);
        const first = { id: '555555555555555555', author: { id: bot }, content: '', embeds: [{ title: 'saved' }], components: prepared.step.components,
            attachments: new Map([
                ['1', { id: '1', name: 'media-0-a.jpg', contentType: 'image/jpeg', url: 'https://cdn.discordapp.com/attachments/3/1/media-0-a.jpg?ex=1' }],
                ['2', { id: '2', name: 'media-1-movie.mp4', contentType: 'video/mp4', url: 'https://cdn.discordapp.com/attachments/3/2/media-1-movie.mp4?ex=1' }],
                ['3', { id: '3', name: 'media-2-b.png', contentType: 'image/png', url: 'https://cdn.discordapp.com/attachments/3/3/media-2-b.png?ex=1' }],
            ]) };
        first.attachments.get('1').url = 'https://cdn.discordapp.com/attachments/3/1/media-0-a.jpg?ex=2';
        assert.deepEqual(cards.resolveReferences(refs, first), [first.attachments.get('1').url, first.attachments.get('3').url]);
        const missing = await cards.prepare({ twitterGrid: meta, files: [], components: [] }, { guildId, channelId, author: { id: user } }, { providerId: 'twitter', url: source, presentationSettings: settings }, storage);
        assert.equal(missing.grids, undefined);
        const duplicate = await cards.prepare({ twitterGrid: meta, files: [{ attachment: pics[0], name: 'same.jpg' }, { attachment: pics[1], name: 'same.jpg' }], components: [] }, { guildId, channelId, author: { id: user } }, { providerId: 'twitter', url: source, presentationSettings: settings }, storage);
        assert.equal(duplicate.grids, undefined);
    } finally { await db.close(); }
});

test('three physical parts require every ordered ACK and safely resume a partial public replacement', { timeout: 60000 }, async () => {
    const db = await createTestDatabase(port);
    try {
        const schema = require('../../src/db_schema'), sql = require('node:fs').readFileSync(require('node:path').join(schema.MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
        await db.queryDatabase(schema._internal.splitSqlStatements(sql).find(statement => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(statement)));
        const storage = gallery.createStore(db), guildId = '333333333333333333', channelId = '444444444444444444', user = '111111111111111111', bot = '222222222222222222';
        const images = Array.from({ length: 20 }, (_, index) => `https://pbs.twimg.com/media/photo${index}?format=jpg`);
        const firstMeta = { imageUrls: images.slice(0, 10), sequence: 0, totalParts: 2 };
        const lastMeta = { imageUrls: images.slice(10), sequence: 1, totalParts: 2 };
        const settings = { enabled: true, twitter_grid_replace_permission: 'restricted' };
        const prepared = await cards.prepare({ components: [], twitterGrid: firstMeta }, { guildId, channelId, author: { id: user } },
            { providerId: 'twitter', presentationSettings: settings }, storage, [{ twitterGrid: lastMeta }]);
        assert.equal(prepared.grids.length, 1);
        const item = prepared.grids[0];
        const attachment = (id, name) => ({ id: String(id), name, contentType: 'image/jpeg', url: `https://cdn.discordapp.com/attachments/${channelId}/${id}/${name}` });
        const message = (id, start, count) => ({ id, channelId, author: { id: bot }, content: '', embeds: start ? [] : [{ title: '投稿本文' }],
            components: start ? [] : prepared.step.components,
            attachments: new Map(Array.from({ length: count }, (_, n) => [String(start + n), attachment(start + n, `photo${start + n}.jpg`)])) });
        const first = message('555555555555555555', 0, 8), second = message('666666666666666666', 8, 8), third = message('777777777777777777', 16, 4);
        const docs = new Map([[first.id, first], [second.id, second], [third.id, third]]), deleted = [], edits = [];
        first.edit = async value => { edits.push(value); first.embeds = value.embeds; first.attachments = new Map([['grid', attachment('999999999999999999', value.files[0].name)]]); return first; };
        second.delete = async () => { deleted.push(second.id); docs.delete(second.id); };
        let failThird = true;
        third.delete = async () => { if (failThird) { failThird = false; throw Error('fixture failure'); } deleted.push(third.id); docs.delete(third.id); };
        assert.equal(await cards.bind(item, first, storage, db, { imageUrls: images.slice(0, 8), containsNonImage: false }), true);
        assert.deepEqual(await cards.finish(item, db), { state: 'pending' });
        assert.equal(await cards.append(item, { imageUrls: images.slice(8, 16), containsNonImage: false }, second, db), true);
        assert.deepEqual(await cards.finish(item, db), { state: 'pending' });
        assert.equal(await cards.append(item, { imageUrls: images.slice(16), containsNonImage: false }, third, db), true);
        assert.deepEqual(await cards.finish(item, db), { state: 'complete' });
        assert.equal(item.totalParts, 3); assert.deepEqual(item.partSizes, [8, 8, 4]); assert.deepEqual(item.imageUrls, images);
        const channel = { nsfw: false, messages: { fetch: async ({ message: messageId }) => {
            if (!docs.has(messageId)) throw Object.assign(Error('unknown message'), { code: 10008 });
            return docs.get(messageId);
        } } };
        const interaction = { guildId, channelId, user: { id: user }, client: { user: { id: bot } }, channel };
        const deps = { db, getSettings: async () => settings, freshAccess: async () => ({ has: () => true }) };
        let row = await storage.get(item.id, guildId, channelId);
        assert.deepEqual(await grid._internal.sourceImageUrls(interaction, row), images);
        const composed = { data: Buffer.from('grid'), filename: 'twitter-grid.jpg' };
        assert.equal(await grid._internal.replacePublic(interaction, row, composed, deps), 'partial');
        assert.deepEqual(deleted, [second.id]); assert.equal(edits.length, 1);
        row = await gallery.createStore(db).get(item.id, guildId, channelId);
        assert.equal(await grid._internal.replacePublic(interaction, row, composed, deps), 'done');
        assert.deepEqual(deleted, [second.id, third.id]); assert.equal(edits.length, 2, 'resume completes the old operation then applies the newly confirmed layout');
    } finally { await db.close(); }
});

test('discard after a rejected pre-send removes only the exact still-unbound grid row', { timeout: 60000 }, async () => {
    const db = await createTestDatabase(port);
    try {
        const schema = require('../../src/db_schema'), sql = require('node:fs').readFileSync(require('node:path').join(schema.MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
        await db.queryDatabase(schema._internal.splitSqlStatements(sql).find(statement => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(statement)));
        const storage = gallery.createStore(db), guildId = '333333333333333333', channelId = '444444444444444444', user = '111111111111111111';
        const meta = { imageUrls: ['https://pbs.twimg.com/media/a.jpg', 'https://pbs.twimg.com/media/b.jpg'], sequence: 0, totalParts: 1 };
        const create = () => cards.prepare({ twitterGrid: meta, components: [] }, { guildId, channelId, author: { id: user } },
            { providerId: 'twitter', presentationSettings: { enabled: true } }, storage);
        const unbound = await create();
        assert.equal(await cards.discardUnbound(unbound.grids, db), 1);
        assert.equal(await storage.get(unbound.grids[0].id, guildId, channelId), null);
        const bound = await create(), first = { id: '555555555555555555', content: '', components: bound.step.components, embeds: [], attachments: new Map() };
        assert.equal(await cards.bind(bound.grids[0], first, storage, db), true);
        assert.equal(await cards.discardUnbound(bound.grids, db), 0);
        assert.ok(await storage.get(bound.grids[0].id, guildId, channelId));
        const changed = await create();
        await db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', ['{}', changed.grids[0].id]);
        assert.equal(await cards.discardUnbound(changed.grids, db), 0);
        assert.ok(await storage.get(changed.grids[0].id, guildId, channelId));
    } finally { await db.close(); }
});

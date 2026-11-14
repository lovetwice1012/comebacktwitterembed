'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestDatabase } = require('../lib/automation-test-db');
const cards = require('../../src/twitterGridCards');
const gallery = require('../../src/mediaGallery');
const grid = require('../../src/components/twitterGrid')._internal;
const schema = require('../../src/db_schema');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (process.env.NODE_ENV !== 'test' || ![33621, 33622].includes(port)) throw Error('Use an isolated test database');

test('a newly stored group survives signed URL refresh while an old hash remains proof-bound', { timeout: 60000 }, async () => {
    const db = await createTestDatabase(port);
    try {
        const sql = fs.readFileSync(path.join(schema.MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
        await db.queryDatabase(schema._internal.splitSqlStatements(sql).find(value => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(value)));
        const guildId = '333333333333333333', channelId = '444444444444444444', bot = '222222222222222222';
        const requester = '111111111111111111', firstId = '555555555555555555', secondId = '666666666666666666';
        const media = n => `https://pbs.twimg.com/media/P${n}?format=jpg`;
        const urls = Array.from({ length: 12 }, (_, i) => media(i));
        const part0 = { imageUrls: urls.slice(0, 10), sequence: 0, totalParts: 2 };
        const part1 = { imageUrls: urls.slice(10), sequence: 1, totalParts: 2 };
        const storage = gallery.createStore(db);
        const prepared = await cards.prepare({ components: [], twitterGrid: part0 }, { guildId, channelId, author: { id: requester } },
            { providerId: 'twitter', presentationSettings: { enabled: true } }, storage, { twitterGrid: part1 });
        const group = prepared.grids[0];
        const attachment = (id, name) => ({ id, name, contentType: 'image/jpeg', url: `https://cdn.discordapp.com/attachments/${channelId}/${id}/${name}?ex=111&is=222&hm=aaa` });
        const first = { id: firstId, channelId, author: { id: bot }, content: '', components: prepared.step.components, embeds: [{ title: 'post' }], attachments: new Map() };
        const file0 = attachment('777777777777777777', 'first.jpg'), file1 = attachment('888888888888888888', 'second.jpg');
        const second = { id: secondId, channelId, author: { id: bot }, content: '', components: [],
            embeds: [{ image: { url: file0.url } }, { image: { url: file1.url } }], attachments: new Map([[file0.id, file0], [file1.id, file1]]) };
        assert.equal(await cards.bind(group, first, storage, db, part0), true);
        assert.equal(await cards.append(group, part1, second, db), true);
        assert.equal((await cards.finish(group, db)).state, 'complete');
        const row = await storage.get(group.id, guildId, channelId), originalJson = JSON.stringify(row.payload);
        const channel = { id: channelId, messages: { fetch: async ({ message }) => message === firstId ? first : second } };
        const interaction = { guildId, channelId, client: { user: { id: bot } }, channel };
        second.embeds[0].image.url = second.embeds[0].image.url.replace('ex=111', 'ex=999');
        assert.equal(await grid.sourcesRemainValid(interaction, row), true);
        second.embeds[0].image.url = second.embeds[0].image.url.replace('cdn.discordapp.com', 'attacker.invalid');
        assert.equal(await grid.sourcesRemainValid(interaction, row), false);
        assert.equal((await db.queryDatabase('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=?', [group.id]))[0].payload_json, originalJson);
        second.embeds[0].image.url = file0.url;
        const legacy = { ...row.payload, partSignatures: [cards.legacyFingerprint(first), cards.legacyFingerprint(second)] };
        await db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(legacy), group.id]);
        const oldRow = await storage.get(group.id, guildId, channelId);
        assert.equal(await grid.sourcesRemainValid(interaction, oldRow), true);
        second.embeds[0].image.url = second.embeds[0].image.url.replace('ex=111', 'ex=999');
        assert.equal(await grid.sourcesRemainValid(interaction, oldRow), false);
        assert.equal((await db.queryDatabase('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=?', [group.id]))[0].payload_json, JSON.stringify(legacy));
    } finally { await db.close(); }
});

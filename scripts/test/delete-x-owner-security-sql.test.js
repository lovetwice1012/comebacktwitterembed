'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createTestDatabase } = require('../lib/automation-test-db');
const schema = require('../../src/db_schema'), gallery = require('../../src/mediaGallery');
const cards = require('../../src/twitterGridCards'), del = require('../../src/components/delete');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (![33621, 33622].includes(port)) throw Error('An explicit isolated test database port is required');
test('real gallery row binds deletion to its verified webhook owner, not X footer text', { timeout: 60000 }, async t => {
    t.mock.method(global, 'setTimeout', () => ({ unref() {} }));
    const db = await createTestDatabase(port);
    try {
        const sql = fs.readFileSync(path.join(schema.MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
        await db.queryDatabase(schema._internal.splitSqlStatements(sql).find(s => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(s)));
        const owner = '111111111111111111', attacker = '999999999999999999', webhook = '777777777777777777', bot = '222222222222222222';
        const guildId = '333333333333333333', channelId = '444444444444444444', messageId = '555555555555555555';
        const urls = ['https://pbs.twimg.com/media/a.jpg', 'https://pbs.twimg.com/media/b.jpg'];
        const storage = gallery.createStore(db), context = { providerId: 'twitter', gridRequesterId: owner, presentationSettings: { enabled: true } };
        const prepared = await cards.prepare({ components: [{ type: 1, components: [{ custom_id: 'delete' }] }],
            twitterGrid: { imageUrls: urls, sequence: 0, totalParts: 1 } }, { guildId, channelId, author: { id: webhook } }, context, storage);
        let deletions = 0;
        const message = { id: messageId, channelId, guildId, author: { id: bot }, content: '', attachments: new Map(), components: prepared.step.components,
            embeds: [{ url: 'https://x.com/u/status/1', author: { name: `展開者: hook(id:${webhook})` }, footer: { text: `投稿者: evil(id:${attacker})` } }],
            delete: async () => { deletions++; } };
        const item = prepared.grids[0]; assert.equal(await cards.bind(item, message, storage, db), true);
        assert.deepEqual(await cards.finish(item, db), { state: 'complete' });
        const interaction = { guildId, channelId, message, customId: 'delete', locale: 'ja', client: { user: { id: bot } }, user: { id: attacker },
            memberPermissions: { has: () => false }, channel: { messages: { fetch: async () => message } }, editReply: async () => {}, deleteReply: async () => {} };
        const options = { action: 'delete', getSettings: async () => ({ enabled: true }),
            freshAccess: async () => ({ channel: interaction.channel, member: { _roles: [] }, permissions: { has: () => false } }) };
        await cards.withMessageLock(interaction, policy => del.handle(interaction, policy), db, options); assert.equal(deletions, 0);
        interaction.user.id = owner;
        await cards.withMessageLock(interaction, policy => del.handle(interaction, policy), db, options); assert.equal(deletions, 1);
    } finally { await db.close(); }
});

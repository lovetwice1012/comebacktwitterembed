'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createTestDatabase } = require('../lib/automation-test-db');
const gallery = require('../../src/mediaGallery'), cards = require('../../src/twitterGridCards'), confirm = require('../../src/components/twitterGridConfirm');
const schema = require('../../src/db_schema');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (![33621, 33622].includes(port)) throw Error('An explicit isolated test database port is required');
const gid = '333333333333333333', cid = '444444444444444444', mid = '555555555555555555', tail = '666666666666666666';
const uid = '111111111111111111', bot = '222222222222222222';
async function fixture({ single = false } = {}) {
    const db = await createTestDatabase(port);
    const sql = fs.readFileSync(path.join(schema.MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
    await db.queryDatabase(schema._internal.splitSqlStatements(sql).find(s => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(s)));
    const storage = gallery.createStore(db), images = Array.from({ length: 13 }, (_, i) => `https://pbs.twimg.com/media/p${i}.jpg`);
    const totalParts = single ? 1 : 2;
    const firstPart = { imageUrls: images.slice(0, 10), sequence: 0, totalParts }, secondPart = { imageUrls: images.slice(10), sequence: 1, totalParts };
    const input = { guildId: gid, channelId: cid, author: { id: uid } };
    const result = await cards.prepare({ components: [{ type: 1, components: [{ type: 2, style: 2, label: 'Delete', custom_id: 'delete' }] }], twitterGrid: firstPart }, input,
        { providerId: 'twitter', presentationSettings: { enabled: true } }, storage, { twitterGrid: secondPart });
    const [item] = result.grids;
    const first = { id: mid, channelId: cid, guildId: gid, author: { id: bot }, content: 'fixture', embeds: [{ title: 'source' }, { title: 'quote' }],
        attachments: new Map(), components: result.step.components };
    const second = { id: tail, channelId: cid, guildId: gid, author: { id: bot }, content: '', embeds: [], attachments: new Map(), components: [] };
    assert.equal(await cards.bind(item, first, storage, db, firstPart), true);
    if (!single) assert.equal(await cards.append(item, secondPart, second, db), true);
    assert.deepEqual(await cards.finish(item, db), { state: 'complete' });
    const channel = { id: cid, guildId: gid, messages: { fetch: async ({ message }) => message === mid ? first : second } };
    const client = { user: { id: bot } }, access = { channel, member: { _roles: [] }, permissions: { has: () => true } };
    let view, executed = 0;
    const deps = { db, storage, freshAccess: async () => access, getSettings: async () => ({ enabled: true, button_invisible: {}, button_disabled: {} }),
        handlers: { delete: { handle: async () => { executed++; } } }, buildButtons: () => ({}) };
    const original = { guildId: gid, channelId: cid, user: { id: uid }, client, locale: 'ja', customId: 'delete', message: first, channel, deferred: true, ephemeral: true,
        editReply: async data => { view = data; } };
    const click = token => { const interaction = { guildId: gid, channelId: cid, user: { id: uid }, client, locale: 'ja', customId: token,
        message: { ephemeral: true }, channel, deferReply: async () => { interaction.deferred = true; interaction.ephemeral = true; } }; return interaction; };
    const offer = async () => { await confirm.offer(original, deps); return view.components[0].components[0].custom_id; };
    return { db, item, first, second, click, offer, deps, get executed() { return executed; } };
}
test('a confirmed single-post action checks the actual SQL rows and runs once', { timeout: 60000 }, async () => {
    const f = await fixture({ single: true });
    try { const token = await f.offer(); await confirm.confirm(f.click(token), f.deps); assert.equal(f.executed, 1); }
    finally { await f.db.close(); }
});
test('a source changed while confirmation waits for the SQL lock is not acted on', { timeout: 60000 }, async () => {
    const f = await fixture({ single: true });
    try {
        const token = await f.offer(); let release, entered;
        const gate = new Promise(resolve => { release = resolve; }), locked = new Promise(resolve => { entered = resolve; });
        const holder = f.db.withDatabaseTransaction(async query => { await query('SELECT gallery_id FROM bot_media_galleries WHERE gallery_id=? FOR UPDATE', [f.item.id]); entered(); await gate; });
        await locked;
        const action = confirm.confirm(f.click(token), f.deps).then(() => null, error => error);
        await new Promise(resolve => setTimeout(resolve, 100));
        f.first.embeds[1].description = 'changed quote'; release(); await holder;
        assert.match((await action).message, /GRID_SOURCE_CHANGED/); assert.equal(f.executed, 0);
    } finally { await f.db.close(); }
});
test('a continuation changed after the preview is not acted on', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const token = await f.offer(); f.second.content = 'changed continuation';
        await assert.rejects(confirm.confirm(f.click(token), f.deps), /GRID_SOURCE_CHANGED/); assert.equal(f.executed, 0);
    } finally { await f.db.close(); }
});
test('split controls are paused before a single-part edit or deletion, including after confirmation', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        for (const action of ['delete', 'showMediaAsAttachments', 'showAttachmentsAsEmbedsImage']) {
            for (const stale of [false, true]) {
                const sourceInteraction = f.click(action);
                sourceInteraction.message = stale ? { ...f.first, content: 'stale event content' } : f.first;
                await assert.rejects(cards.withMessageLock(sourceInteraction, async () => { throw Error('must not run'); }, f.db), /GRID_SPLIT_ACTION_PAUSED/);
            }
        }
        const token = await f.offer();
        await assert.rejects(confirm.confirm(f.click(token), f.deps), /GRID_SPLIT_ACTION_PAUSED/); assert.equal(f.executed, 0);
        const translation = f.click('translate'); translation.message = f.first;
        let policy;
        await cards.withMessageLock(translation, async value => { policy = value; }, f.db);
        assert.deepEqual(policy, { previewOnlyTranslation: true });
    } finally { await f.db.close(); }
});
test('a record removed after the preview cannot authorize the action', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const token = await f.offer(); await f.db.queryDatabase('DELETE FROM bot_media_galleries WHERE gallery_id=?', [f.item.id]);
        await assert.rejects(confirm.confirm(f.click(token), f.deps), /GRID_SOURCE_CHANGED|GRID_LOCK_UNAVAILABLE/); assert.equal(f.executed, 0);
    } finally { await f.db.close(); }
});

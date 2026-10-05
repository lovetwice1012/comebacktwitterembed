'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { SCHEMA } = require('../../src/linkPresentationSchema');
const { createHistory, contentKey } = require('../../src/sharedPostHistory');
const { createStore } = require('../../src/mediaGallery');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);

test('real SQL: durable gallery and shared history, scoped lookup, expiry and stale write protection', { skip: !port }, async () => {
    const db = await createTestDatabase(port);
    try {
        for (const sql of SCHEMA) await db.queryDatabase(sql);
        const message = { id: '111111111111111111', guildId: '222222222222222222', channelId: '333333333333333333',
            channel: { messages: { fetch: async () => ({ channelId: '333333333333333333' }) } } };
        const steps = [{ embeds: [{ title: 'Album' }] }];
        const key = contentKey('pixiv', steps, 'https://www.pixiv.net/artworks/123');
        const first = { sent: [{ stepIndex: 0, messageId: '444444444444444444' }], postprocess: [{ operation: 'delete_source', success: true }] };
        await createHistory(db).remember(message, key, first, 0);
        const next = { ...message, id: '555555555555555555' };
        assert.match(await createHistory(db).previous(next, key), /\/444444444444444444$/);
        assert.equal(await createHistory(db).previous({ ...next, channelId: '666666666666666666' }, key), null);
        assert.equal(await createHistory(db).previous({ ...next, guildId: '666666666666666666' }, key), null);
        await createHistory(db).remember(next, key, { sent: [{ stepIndex: 0, messageId: '777777777777777777' }] }, 0);
        await createHistory(db).remember(message, key, first, 0);
        const [stored] = await db.queryDatabase('SELECT * FROM bot_shared_posts');
        assert.equal(stored.source_message_id, next.id);
        assert.equal(stored.response_message_id, '777777777777777777');
        await db.queryDatabase('UPDATE bot_shared_posts SET shared_at_ms=0');
        assert.equal(await createHistory(db).previous({ ...next, id: '888888888888888888' }, key), null);

        const gallery = { id: 'a'.repeat(32), pages: [{ embeds: [{ title: 'one' }] }, { embeds: [{ title: 'two' }] }] };
        await createStore(db).save(gallery, message, 'pixiv');
        await createStore(db).bind(gallery.id, '444444444444444444');
        const reloaded = await createStore(db).get(gallery.id, message.guildId, message.channelId);
        assert.deepEqual(reloaded.payload, gallery);
        assert.equal(reloaded.message_id, '444444444444444444');
        assert.equal(await createStore(db).get(gallery.id, 'other-guild', message.channelId), null);
        assert.equal(await createStore(db).get(gallery.id, message.guildId, 'other-channel'), null);
        await db.queryDatabase('UPDATE bot_media_galleries SET expires_at_ms=0');
        assert.equal(await createStore(db).get(gallery.id, message.guildId, message.channelId), null);
    } finally { await db.close(); }
});

test('real dispatcher sends a gallery plus repeat-share notice and persists its message binding', { skip: !port }, async () => {
    const db = await createTestDatabase(port);
    const liveDb = require('../../src/db');
    const originalQuery = liveDb.queryDatabase;
    try {
        for (const sql of SCHEMA) await db.queryDatabase(sql);
        liveDb.queryDatabase = db.queryDatabase;
        const { runSendSteps } = require('../../src/providers/_dispatcher');
        const payloads = [];
        const message = { id: '111111111111111111', guildId: '222222222222222222', channelId: '333333333333333333',
            channel: { id: '333333333333333333', messages: { fetch: async () => ({ channelId: '333333333333333333' }) },
                send: async payload => { payloads.push(payload); return { id: `44444444444444444${payloads.length}`, channelId: '333333333333333333' }; } } };
        const step = { embeds: [{ title: 'Album', image: { url: 'https://images.example/a.jpg' } }, { image: { url: 'https://images.example/b.jpg' } }] };
        const context = { url: 'https://www.pixiv.net/artworks/123', sharedHistory: true,
            presentationSettings: { gallery_display_mode: 'gallery', defaultLanguage: 'ja' } };
        await runSendSteps(message, [step], 'pixiv', context);
        await runSendSteps({ ...message, id: '555555555555555555' }, [step], 'pixiv', context);
        assert.equal(payloads.length, 2);
        assert.equal(payloads[0].embeds.length, 1);
        assert.equal(payloads[0].content, undefined);
        assert.match(payloads[1].content, /以前にも共有/);
        assert.equal(payloads[1].embeds[0].image.url, 'https://images.example/a.jpg');
        const records = await db.queryDatabase('SELECT * FROM bot_media_galleries ORDER BY message_id');
        assert.equal(records.length, 2);
        assert.equal(records[1].message_id, '444444444444444442');
        assert.equal(JSON.parse(records[1].payload_json).pages.length, 2);
    } finally { liveDb.queryDatabase = originalQuery; await db.close(); }
});

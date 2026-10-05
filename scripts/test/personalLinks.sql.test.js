'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { SCHEMA } = require('../../src/personalLinks/schema');
const { createStore } = require('../../src/personalLinks/store');
const model = require('../../src/personalLinks/model');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const user = '111111111111111111', other = '222222222222222222';
const entry = () => model.link('https://booth.pm/ja/items/123', 'Sample item');
async function fixture(work) {
    const db = await createTestDatabase(port);
    try { for (const sql of SCHEMA) await db.queryDatabase(sql); await work(db, createStore(db)); }
    finally { await db.close(); }
}

test('real SQL saved links: concurrent deduplication, tags, notes, search and owner isolation', { skip: !port }, async () => fixture(async (db, store) => {
    const results = await Promise.all([store.save(user, entry(), { tags: '作品, 後で', note: 'gift idea' }), store.save(user, entry())]);
    assert.equal(results[0].id, results[1].id);
    assert.equal((await store.getSaved(user, results[0].id)).note, 'gift idea');
    assert.equal((await store.listSaved(user, { query: 'gift', tag: '作品' })).length, 1);
    assert.equal((await store.listSaved(user, { tag: '作品の一部' })).length, 0);
    assert.equal((await store.listSaved(other)).length, 0);
    assert.equal(await store.getSaved(other, results[0].id), null);
    await assert.rejects(store.editSaved(other, results[0].id, 'bad', 'bad'), /NOT_FOUND/);
    await assert.rejects(store.deleteSaved(other, results[0].id), /NOT_FOUND/);
    await store.editSaved(user, results[0].id, '新しいタグ', 'new note');
    const restarted = createStore(db);
    assert.equal((await restarted.listSaved(user, { query: 'new note', tag: '新しいタグ' })).length, 1);
    await restarted.deleteSaved(user, results[0].id);
    assert.equal((await restarted.listSaved(user)).length, 0);
}));

test('real SQL reminders: idempotent registration, durable due time, cancellation and unknown delivery leases', { skip: !port }, async () => fixture(async (db, store) => {
    const now = Date.now(), due = now + 120000;
    const opts = { kind: 'reminder', requestKey: 'request-1', dueAtMs: due, locale: 'ja' };
    const [a, b] = await Promise.all([store.createNotification(user, entry(), opts), store.createNotification(user, entry(), opts)]);
    assert.equal(a.id, b.id);
    assert.equal(await store.claim(now), null);
    const claims = await Promise.all([store.claim(due + 1), createStore(db).claim(due + 1)]);
    assert.equal(claims.filter(Boolean).length, 1);
    const job = claims.find(Boolean);
    await assert.rejects(store.cancel(other, job.id, 'reminder'), /NOT_FOUND/);
    await store.cancel(user, job.id, 'reminder');
    assert.equal(await store.beginSend(job, due + 2), false);
    const c = await store.createNotification(user, entry(), { ...opts, requestKey: 'request-2' });
    const sending = await store.claim(due + 3);
    assert.equal(sending.id, c.id);
    assert.equal(await store.beginSend(sending, due + 4), true);
    await assert.rejects(store.cancel(user, c.id, 'reminder'), /ALREADY_SENDING/);
    assert.equal(await createStore(db).claim(due + 200000), null);
    const [saved] = await db.queryDatabase('SELECT status FROM bot_link_notifications WHERE id=?', [c.id]);
    assert.equal(saved.status, 'unknown');
    assert.equal((await store.listNotifications(other, 'reminder')).length, 0);
}));

test('real SQL repeated saves retain omitted metadata regardless of which save arrives first', { skip: !port }, async () => fixture(async (db, store) => {
    const first = await store.save(user, entry());
    const detailed = await store.save(user, entry(), { tags: '作品', note: 'gift idea' });
    assert.equal(detailed.id, first.id);
    assert.equal(detailed.note, 'gift idea');
    assert.deepEqual(JSON.parse(detailed.tags_json), ['作品']);
    await store.save(user, entry(), { tags: null, note: null });
    assert.equal((await store.getSaved(user, first.id)).note, 'gift idea');
    const tagsOnly = await store.save(user, entry(), { tags: '後で' });
    assert.equal(tagsOnly.note, 'gift idea');
    const noteOnly = await store.save(user, entry(), { note: 'birthday' });
    assert.deepEqual(JSON.parse(noteOnly.tags_json), ['後で']);
    assert.equal(noteOnly.note, 'birthday');
    await store.save(user, entry());
    assert.equal((await store.getSaved(user, first.id)).note, 'birthday');
    const theirs = await store.save(other, entry(), { note: 'private other note' });
    assert.notEqual(theirs.id, first.id);
    assert.equal((await store.getSaved(user, first.id)).note, 'birthday');
}));

test('real SQL restock: shared polling, first baseline, variant transition and one-shot notification', { skip: !port }, async () => fixture(async (db, store) => {
    const opts = { kind: 'restock', requestKey: 'watch-1', variationId: '7' };
    const a = await store.createNotification(user, entry(), opts);
    const b = await store.createNotification(other, entry(), opts);
    const duplicate = await store.createNotification(user, entry(), { ...opts, requestKey: 'watch-again' });
    assert.equal(duplicate.id, a.id);
    const any = await store.createNotification(user, entry(), { ...opts, requestKey: 'any', variationId: '*' });
    assert.equal((await db.queryDatabase('SELECT * FROM bot_restock_sources')).length, 1);
    let now = Date.now() + 1;
    async function observe(state) {
        await db.queryDatabase('UPDATE bot_restock_sources SET next_check_at_ms=?', [now]);
        const source = await store.claimSource(now);
        assert.ok(source);
        assert.equal(await createStore(db).claimSource(now), null);
        assert.equal(await store.observe(source, { state: 'available', variations: [{ id: '7', state }, { id: '8', state: 'available' }] }, now + 1), true);
        now += 1800000;
    }
    const status = async id => (await db.queryDatabase('SELECT status,last_stock_state FROM bot_link_notifications WHERE id=?', [id]))[0];
    await observe('available');
    assert.equal((await status(a.id)).status, 'watching');
    await observe('sold_out'); await observe('unavailable'); await observe('available');
    assert.equal((await status(a.id)).status, 'watching');
    await observe('sold_out'); await observe('unknown');
    assert.equal((await status(a.id)).last_stock_state, 'sold_out');
    await observe('available');
    assert.equal((await status(a.id)).status, 'pending');
    assert.equal((await status(b.id)).status, 'pending');
    assert.equal((await status(any.id)).status, 'watching');
    await store.cancel(user, a.id, 'restock');
    const job = await store.claim(now);
    assert.equal(job.id, b.id);
    assert.equal(await store.beginSend(job, now), true);
    await store.finish(job, 'sent', { messageId: '333333333333333333' });
    await observe('sold_out'); await observe('available');
    assert.equal(await store.claim(now), null);
}));

test('real SQL card-to-bookmark and scheduled DM delivery use the real dispatcher and durable store', { skip: !port }, async () => fixture(async (db, store) => {
    const live = require('../../src/db'), original = live.queryDatabase;
    live.queryDatabase = db.queryDatabase;
    try {
        const { runSendSteps } = require('../../src/providers/_dispatcher');
        const { handle } = require('../../src/components/personalLinks');
        const { createRunner } = require('../../src/personalLinks/runner');
        const sent = [];
        const botId = '999999999999999999', publicId = '888888888888888888';
        const message = { guildId: '777777777777777777', channelId: '666666666666666666', channel: { send: async payload => { sent.push(payload); return { id: publicId }; } } };
        await runSendSteps(message, [{ embeds: [{ title: 'Item', url: entry().url }] }], 'booth', { url: entry().url, personalActions: true, presentationSettings: { defaultLanguage: 'ja' } });
        const saveId = sent[0].components.flatMap(r => r.components).find(b => b.custom_id.startsWith('personal:save:')).custom_id;
        const cardId = saveId.split(':')[2];
        assert.equal((await store.getCard(cardId, message.guildId, message.channelId)).messageId, publicId);
        assert.equal(await store.getCard(cardId, 'other-guild', message.channelId), null);
        let reply;
        const interaction = { type: 3, id: 'interaction', customId: saveId, guildId: message.guildId, channelId: message.channelId,
            user: { id: user }, client: { user: { id: botId } }, message: { id: publicId, author: { id: botId } }, locale: 'ja',
            deferReply: async () => { interaction.deferred = true; }, editReply: async p => { reply = p; } };
        await handle(interaction, store);
        assert.match(reply.content, /保存しました/);
        assert.equal((await store.listSaved(user)).length, 1);
        const due = Date.now() + 120000;
        await store.createNotification(user, entry(), { kind: 'reminder', requestKey: 'dm-1', dueAtMs: due });
        const deliveries = [];
        const runtime = createRunner({ store: createStore(db), clock: () => due + 1, assertAllowed: () => {}, notificationAllowed: () => true,
            transport: { prepare: async job => { assert.equal(job.user_id, user); return 'dm'; }, send: async (_channel, job) => { deliveries.push(job); return '555555555555555555'; } } });
        assert.equal(await runtime.deliver(), 'sent');
        assert.equal(await runtime.deliver(), 'idle');
        assert.equal(deliveries.length, 1);
        assert.equal((await store.listNotifications(user, 'reminder'))[0].status, 'sent');
    } finally { live.queryDatabase = original; }
}));

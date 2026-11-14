'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createRestoreJournal } = require('../../src/twitterGridRestoreJournal');
const restore = require('../../src/twitterGridRestore');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (![33621, 33622].includes(port)) throw Error('An explicit isolated test database port is required');

async function fixture() {
    const db = await createTestDatabase(port), pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root',
        password: process.env.AUTOMATION_TEST_DB_PASSWORD || '', database: db.schema, connectionLimit: 2, supportBigNumbers: true, bigNumberStrings: true });
    db.queryDatabaseIndependent = (sql, params = []) => new Promise((resolve, reject) => pool.query(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
    const galleryId = 'a'.repeat(32), botId = '111111111111111111', channelId = '222222222222222222', guildId = '333333333333333333';
    const messageId = '444444444444444444', continuationId = '555555555555555555', markerId = '666666666666666666', statusId = '1234567890123456789';
    const urls = Array.from({ length: 13 }, (_, n) => `https://pbs.twimg.com/media/P${n}?format=jpg`);
    const payload = { id: galleryId, lockId: galleryId, sourceStatusId: statusId, replacePhase: 'done', messageIds: [messageId, continuationId], imageUrls: urls };
    const markerName = `tg-${galleryId}.jpg`, attachment = (id, name) => ({ id, name, contentType: 'image/jpeg', url: `https://cdn.discordapp.com/attachments/${channelId}/${id}/${name}` });
    const first = { id: messageId, channelId, author: { id: botId }, content: '', components: [], embeds: [{ url: `https://x.com/example/status/${statusId}`,
        image: { url: `https://cdn.discordapp.com/attachments/${channelId}/${markerId}/${markerName}` } }], attachments: new Map([[markerId, attachment(markerId, markerName)]]) };
    const scope = { lockId: galleryId, galleryId, guildId, channelId, messageId }, journal = createRestoreJournal(db, scope);
    await db.queryDatabase(`CREATE TABLE IF NOT EXISTS bot_twitter_grid_action_intents (gallery_id CHAR(32) PRIMARY KEY,guild_id VARCHAR(22),channel_id VARCHAR(22),message_id VARCHAR(22),operation_id CHAR(32),payload_json LONGTEXT,updated_at_ms BIGINT) ENGINE=InnoDB`);
    await db.queryDatabase('CREATE TABLE restore_fixture_gallery (gallery_id CHAR(32) PRIMARY KEY,payload_json LONGTEXT) ENGINE=InnoDB');
    await db.queryDatabase('INSERT INTO restore_fixture_gallery VALUES (?,?)', [galleryId, JSON.stringify(payload)]);
    const state = { latest: messageId, messages: [], events: [], operation: null, rollback: false };
    let query;
    const adapter = {
        withLock: async (_request, work) => {
            let result;
            result = await db.withDatabaseTransaction(async q => {
                query = q;
                const rows = await q('SELECT payload_json FROM restore_fixture_gallery WHERE gallery_id=? FOR UPDATE', [galleryId]);
                return work({ payload: JSON.parse(rows[0].payload_json), first });
            });
            if (result.status === 'done') await journal.clearAfterCommit(state.operation);
            return result;
        },
        authorize: async () => true, latestMessageId: async () => state.latest, adjacency: async () => 'adjacent', fileLimit: async () => 25 * 1024 * 1024,
        verifyLiveSource: async () => urls, measureImages: async values => values.map(source => ({ source, size: 4, format: 'jpeg', sha256: require('node:crypto').createHash('sha256').update(Buffer.from('ffd8ff00', 'hex')).digest('hex') })),
        prepareImages: async values => values.map(source => ({ source, data: Buffer.from('ffd8ff00', 'hex'), format: 'jpeg' })), preflight: async () => true,
        begin: async (...args) => { state.operation = await journal.begin(...args); return state.operation; }, cancel: (...args) => journal.cancel(...args),
        plan: (...args) => journal.plan(...args), reject: (...args) => journal.reject(...args), confirm: (...args) => journal.confirm(...args), markUnknown: (...args) => journal.markUnknown(...args),
        editOnce: async (_request, _snapshot, files) => {
            state.events.push('edit'); const edited = { ...first, embeds: [{ url: first.embeds[0].url }], attachments: new Map() };
            files.forEach((file, i) => { const id = String(BigInt(markerId) + BigInt(i + 1)); edited.attachments.set(id, attachment(id, file.name)); });
            state.messages.push(edited); return edited;
        },
        sendOnce: async (_request, _snapshot, files) => {
            state.events.push('send'); const sent = { id: continuationId, channelId, author: { id: botId }, content: '', embeds: [], components: [], attachments: new Map() };
            files.forEach((file, i) => { const id = String(BigInt(markerId) + BigInt(100 + i)); sent.attachments.set(id, attachment(id, file.name)); });
            state.latest = sent.id; state.messages.push(sent); return sent;
        },
        verifyResult: async (_request, _snapshot, _group, files, result) => restore.verifyRestoredAttachments(result, { channelId, botId }, files),
        finish: async (op, request, snapshot) => {
            const next = restore.restoredManifest(snapshot.payload, op.id, request.mode, state.messages, urls, statusId);
            await query('UPDATE restore_fixture_gallery SET payload_json=? WHERE gallery_id=?', [JSON.stringify(next), galleryId]);
            await journal.markFinished(op);
            if (state.rollback) throw Error('fixture rollback');
        },
    };
    return { db, pool, adapter, state, urls, galleryId, close: async () => { await new Promise((resolve, reject) => pool.end(error => error ? reject(error) : resolve())); await db.close(); } };
}

test('a restored 13-image group commits its manifest and clears the journal only after commit', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        assert.deepEqual(await restore.executeRestore({ mode: 'here', id: f.galleryId }, f.adapter), { status: 'done', completed: 2 });
        const rows = await f.db.queryDatabase('SELECT payload_json FROM restore_fixture_gallery WHERE gallery_id=?', [f.galleryId]);
        const record = JSON.parse(rows[0].payload_json);
        assert.deepEqual(record.imageUrls, f.urls); assert.deepEqual(record.partSizes, [10, 3]);
        assert.deepEqual(record.restoreArchive.imageUrls, f.urls); assert.deepEqual(f.state.events, ['edit', 'send']);
        assert.equal((await f.db.queryDatabase('SELECT * FROM bot_twitter_grid_action_intents')).length, 0);
    } finally { await f.close(); }
});

test('after a newer channel message, the user may restore only the first 10 images', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        f.state.latest = '999999999999999999';
        assert.deepEqual(await restore.executeRestore({ mode: 'first', id: f.galleryId }, f.adapter), { status: 'done', completed: 1 });
        const rows = await f.db.queryDatabase('SELECT payload_json FROM restore_fixture_gallery WHERE gallery_id=?', [f.galleryId]);
        const record = JSON.parse(rows[0].payload_json);
        assert.deepEqual(record.imageUrls, f.urls.slice(0, 10)); assert.deepEqual(record.partSizes, [10]);
        assert.deepEqual(record.restoreArchive.imageUrls, f.urls); assert.deepEqual(f.state.events, ['edit']);
    } finally { await f.close(); }
});

test('manifest rollback after Discord success retains the journal and blocks a duplicate operation', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        f.state.rollback = true;
        await assert.rejects(restore.executeRestore({ mode: 'here', id: f.galleryId }, f.adapter), /fixture rollback/);
        assert.deepEqual(f.state.events, ['edit', 'send']);
        const journal = await f.db.queryDatabase('SELECT payload_json FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [f.galleryId]);
        const saved = JSON.parse(journal[0].payload_json);
        assert.equal(saved.state, 'finished'); assert.equal(saved.steps.length, 2);
        assert.ok(saved.steps.every(step => step.state === 'confirmed'));
        f.state.latest = '444444444444444444'; f.state.rollback = false;
        await assert.rejects(restore.executeRestore({ mode: 'here', id: f.galleryId }, f.adapter), /duplicate/i);
        assert.deepEqual(f.state.events, ['edit', 'send']);
    } finally { await f.close(); }
});

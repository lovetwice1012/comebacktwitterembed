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
        plan: (...args) => journal.plan(...args), markRejected413: (...args) => journal.markRejected413(...args), repartition: (...args) => journal.repartition(...args), reject: (...args) => journal.reject(...args), confirm: (...args) => journal.confirm(...args), markUnknown: (...args) => journal.markUnknown(...args),
        editOnce: async (_request, _snapshot, files) => {
            state.events.push('edit'); const edited = { ...first, embeds: [{ url: first.embeds[0].url }], attachments: new Map() };
            files.forEach((file, i) => { const id = String(BigInt(markerId) + BigInt(i + 1)); edited.attachments.set(id, attachment(id, file.name)); });
            state.messages.push(edited); return edited;
        },
        sendOnce: async (_request, _snapshot, files) => {
            state.events.push('send'); const sent = { id: String(BigInt(continuationId) + BigInt(state.messages.length)), channelId, author: { id: botId }, content: '', embeds: [], components: [], attachments: new Map() };
            files.forEach((file, i) => { const id = String(BigInt(markerId) + BigInt(100 + i)); sent.attachments.set(id, attachment(id, file.name)); });
            state.latest = sent.id; state.messages.push(sent); return sent;
        },
        verifyResult: async (_request, _snapshot, _group, files, result) => restore.verifyRestoredAttachments(result, { channelId, botId }, files),
        finish: async (op, request, snapshot) => {
            const next = restore.restoredManifest(snapshot.payload, op.id, request.mode, state.messages, urls, statusId, op.record.groupSizes);
            await query('UPDATE restore_fixture_gallery SET payload_json=? WHERE gallery_id=?', [JSON.stringify(next), galleryId]);
            await journal.markFinished(op);
            if (state.rollback) throw Error('fixture rollback');
        },
    };
    return { db, pool, adapter, state, urls, galleryId, close: async () => { await new Promise((resolve, reject) => pool.end(error => error ? reject(error) : resolve())); await db.close(); } };
}

const { DiscordAPIError } = require('discord.js');
const rejected413 = () => new DiscordAPIError({ message: 'too large' }, 0, 413, 'PATCH', '/fixture', {});
test('verified 413 partitions and commits ordered groups with the real journal', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const edit = f.adapter.editOnce; let attempts = 0;
        f.adapter.editOnce = async (...args) => { if (++attempts === 1) throw rejected413(); return edit(...args); };
        assert.deepEqual(await restore.executeRestore({ mode: 'here', id: f.galleryId }, f.adapter), { status: 'done', completed: 3 });
        const saved = JSON.parse((await f.db.queryDatabase('SELECT payload_json FROM restore_fixture_gallery WHERE gallery_id=?', [f.galleryId]))[0].payload_json);
        assert.deepEqual(saved.partSizes, [5, 5, 3]); assert.deepEqual(saved.imageUrls, f.urls);
        assert.deepEqual(f.state.events, ['edit', 'send', 'send']); assert.equal(attempts, 2);
    } finally { await f.close(); }
});
test('repeated verified 413 responses refine only the rejected group and preserve order', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const edit = f.adapter.editOnce; let attempts = 0;
        f.adapter.editOnce = async (...args) => { if (++attempts <= 2) throw rejected413(); return edit(...args); };
        assert.deepEqual(await restore.executeRestore({ mode: 'here', id: f.galleryId }, f.adapter), { status: 'done', completed: 4 });
        const saved = JSON.parse((await f.db.queryDatabase('SELECT payload_json FROM restore_fixture_gallery WHERE gallery_id=?', [f.galleryId]))[0].payload_json);
        assert.deepEqual(saved.partSizes, [3, 2, 5, 3]); assert.deepEqual(saved.imageUrls, f.urls); assert.equal(attempts, 3);
    } finally { await f.close(); }
});
test('permission withdrawn after 413 prevents the smaller submission', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        let permitted = true, attempts = 0; f.adapter.authorize = async () => permitted;
        f.adapter.editOnce = async () => { attempts++; permitted = false; throw rejected413(); };
        assert.deepEqual(await restore.executeRestore({ mode: 'here', id: f.galleryId }, f.adapter), { status: 'denied', completed: 0 });
        assert.equal(attempts, 1); assert.equal((await f.db.queryDatabase('SELECT * FROM bot_twitter_grid_action_intents')).length, 0);
    } finally { await f.close(); }
});
test('first 10: a 413 requests explicit confirmation for the new 5+5 plan', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        f.state.latest = '999999999999999999';
        const edit = f.adapter.editOnce; let attempts = 0;
        f.adapter.editOnce = async (...args) => { if (++attempts === 1) throw rejected413(); return edit(...args); };
        const requested = await restore.executeRestore({ mode: 'first', id: f.galleryId }, f.adapter);
        assert.equal(requested.status, 'confirm_split'); assert.deepEqual(requested.sizes, [5, 5]); assert.deepEqual(f.state.events, []);
        assert.deepEqual(await restore.executeRestore({ mode: 'first', id: f.galleryId, confirmedPlan: requested.planDigest, confirmedSizes: requested.sizes }, f.adapter),
            { status: 'done', completed: 2 });
        const saved = JSON.parse((await f.db.queryDatabase('SELECT payload_json FROM restore_fixture_gallery WHERE gallery_id=?', [f.galleryId]))[0].payload_json);
        assert.deepEqual(saved.partSizes, [5, 5]); assert.deepEqual(f.state.events, ['edit', 'send']);
    } finally { await f.close(); }
});
test('ambiguous errors carrying status 413 never retry a submission', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        let attempts = 0; f.adapter.editOnce = async () => { attempts++; throw Object.assign(Error('network lost'), { status: 413 }); };
        assert.equal((await restore.executeRestore({ mode: 'here', id: f.galleryId }, f.adapter)).status, 'unknown');
        assert.equal(attempts, 1);
        const saved = JSON.parse((await f.db.queryDatabase('SELECT payload_json FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [f.galleryId]))[0].payload_json);
        assert.equal(saved.state, 'unknown'); assert.equal(saved.steps[0].state, 'planned');
    } finally { await f.close(); }
});
test('a single image rejected with 413 is not split or retried', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        f.adapter.rootCapacity = async () => 1; let attempts = 0;
        f.adapter.editOnce = async () => { attempts++; throw rejected413(); };
        assert.equal((await restore.executeRestore({ mode: 'here', id: f.galleryId }, f.adapter)).status, 'discord_upload_too_large');
        assert.equal(attempts, 1); assert.equal((await f.db.queryDatabase('SELECT * FROM bot_twitter_grid_action_intents')).length, 0);
    } finally { await f.close(); }
});
test('413 after a successful prefix respects a new channel message and does not resend', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        let sends = 0; f.adapter.sendOnce = async () => { sends++; f.state.latest = '999999999999999999'; throw rejected413(); };
        assert.deepEqual(await restore.executeRestore({ mode: 'here', id: f.galleryId }, f.adapter), { status: 'partial', completed: 1 });
        assert.equal(sends, 1); assert.deepEqual(f.state.events, ['edit']);
        const saved = JSON.parse((await f.db.queryDatabase('SELECT payload_json FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [f.galleryId]))[0].payload_json);
        assert.deepEqual(saved.groupSizes, [10, 2, 1]); assert.equal(saved.steps.length, 1); assert.equal(saved.steps[0].state, 'confirmed');
    } finally { await f.close(); }
});
test('a 413 raised after a successful request is ambiguous and is never retried', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        f.adapter.verifyResult = async () => { throw rejected413(); };
        assert.equal((await restore.executeRestore({ mode: 'here', id: f.galleryId }, f.adapter)).status, 'unknown');
        assert.deepEqual(f.state.events, ['edit']);
    } finally { await f.close(); }
});
test('transaction rollback leaves repartition journal and in-memory record unchanged', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const repartition = f.adapter.repartition;
        f.adapter.repartition = async (operation, index, sizes) => {
            const connection = await new Promise((resolve, reject) => f.pool.getConnection((error, value) => error ? reject(error) : resolve(value)));
            const query = (sql, params = []) => new Promise((resolve, reject) => connection.query(sql, params, (error, value) => error ? reject(error) : resolve(value)));
            try {
                await query('START TRANSACTION');
                const result = await repartition(operation, index, sizes, query);
                assert.deepEqual(result.groupSizes, [5, 5, 3]); assert.deepEqual(operation.record.groupSizes, [10, 3]);
                await query('ROLLBACK');
            } finally { connection.release(); }
            throw Error('transaction failed');
        };
        let attempts = 0; f.adapter.editOnce = async () => { attempts++; throw rejected413(); };
        assert.equal((await restore.executeRestore({ mode: 'here', id: f.galleryId }, f.adapter)).status, 'unknown');
        assert.equal(attempts, 1);
        const saved = JSON.parse((await f.db.queryDatabase('SELECT payload_json FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [f.galleryId]))[0].payload_json);
        assert.deepEqual(saved.groupSizes, [10, 3]); assert.equal(saved.steps[0].state, 'planned');
    } finally { await f.close(); }
});

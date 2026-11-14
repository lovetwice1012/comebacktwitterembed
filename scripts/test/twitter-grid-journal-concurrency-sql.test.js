'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createTestDatabase } = require('../lib/automation-test-db');
const schema = require('../../src/db_schema');
const gallery = require('../../src/mediaGallery'), cards = require('../../src/twitterGridCards');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (![33621, 33622].includes(port)) throw Error('Explicit isolated DB port required');
const guildId = '333333333333333333', channelId = '444444444444444444', user = '111111111111111111', bot = '222222222222222222';
const buttons = { showMediaAsAttachmentsButton: { type: 2, style: 2, label: 'Attachments', custom_id: 'showMediaAsAttachments' },
    showAttachmentsAsMediaButton: { type: 2, style: 2, label: 'Embed', custom_id: 'showAttachmentsAsEmbedsImage' },
    deleteButton: { type: 2, style: 2, label: 'Delete', custom_id: 'delete' } };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function setup(db, n) {
    const storage = gallery.createStore(db), settings = { enabled: true, defaultLanguage: 'ja' };
    const urls = [1, 2].map(i => `https://pbs.twimg.com/media/${n}-${i}.jpg`);
    const metas = urls.map((url, sequence) => ({ imageUrls: [url], sequence, totalParts: 2 }));
    const prepared = await cards.prepare({ files: [urls[0]], twitterGrid: metas[0], components: [{ type: 1, components: [buttons.showAttachmentsAsMediaButton, buttons.deleteButton] }] },
        { guildId, channelId, author: { id: user } }, { providerId: 'twitter', presentationSettings: settings }, storage,
        [{ files: [urls[1]], twitterGrid: metas[1] }]);
    assert.equal(prepared.grids.length, 1);
    const make = (id, i, components, embeds) => ({ id, channelId, author: { id: bot }, content: '', components, embeds,
        attachments: new Map([[String(1000 + n * 10 + i), { id: String(1000 + n * 10 + i), name: `${n}-${i}.jpg`, contentType: 'image/jpeg',
            url: `https://cdn.discordapp.com/attachments/${channelId}/${String(1000 + n * 10 + i)}/${n}-${i}.jpg?ex=1&is=1&hm=1` }]]) });
    const first = make(String(555555555555555000n + BigInt(n) * 10n), 1, prepared.step.components, [{ title: 'post', description: 'body', url: 'https://x.com/example/status/123', author: { name: `requester(id:${user})` } }]);
    const second = make(String(BigInt(first.id) + 1n), 2, [], []);
    const messages = new Map([[first.id, first], [second.id, second]]);
    for (const message of messages.values()) {
        message.edit = async request => {
            if (request.components) message.components = request.components;
            if (request.embeds) message.embeds = request.embeds.map(embed => ({ ...embed, image: embed.image?.url?.startsWith('attachment://')
                ? { url: [...message.attachments.values()].find(file => file.name === embed.image.url.slice(13))?.url } : embed.image }));
            return message;
        };
        message.delete = async () => messages.delete(message.id);
    }
    const item = prepared.grids[0];
    assert.equal(await cards.bind(item, first, storage, db, metas[0]), true);
    assert.equal(await cards.append(item, metas[1], second, db), true);
    assert.equal((await cards.finish(item, db)).state, 'complete');
    const interaction = { guildId, channelId, locale: 'ja', user: { id: user }, client: { user: { id: bot } }, memberPermissions: { has: () => true },
        channel: { nsfw: false, messages: { fetch: async ({ message }) => { const result = messages.get(message); if (!result) throw Object.assign(new Error('deleted'), { code: 10008 }); return result; } } },
        message: first, editReply: async () => {}, deleteReply: async () => {} };
    return { first, second, interaction, item, messages };
}
async function invoke(f, action, db) {
    const control = f.first.components.flatMap(row => row.components || []).find(component =>
        String(component.custom_id || component.customId || '').split(':')[0] === action);
    const interaction = { ...f.interaction, customId: control?.custom_id || control?.customId || action };
    const handler = require(`../../src/components/${action}`);
    return cards.withMessageLock(interaction, group => handler.handle(interaction, { buttons, ...group }), db, { action, buttons,
        freshAccess: async () => ({ permissions: { has: () => true }, member: { _roles: [] } }), getSettings: async () => ({ enabled: true, defaultLanguage: 'ja' }) });
}
async function database() {
    const db = await createTestDatabase(port);
    const sql = fs.readFileSync(path.join(schema.MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
    await db.queryDatabase(schema._internal.splitSqlStatements(sql).find(s => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(s)));
    const indexSql = fs.readFileSync(path.join(schema.MIGRATIONS_DIR, '20261113_add_twitter_gallery_locator_index.sql'), 'utf8');
    for (const statement of schema._internal.splitSqlStatements(indexSql)) await db.queryDatabase(statement);
    return db;
}

test('seven concurrent grid actions holding all application connections can still commit intent journals', { timeout: 30000 }, async () => {
    const db = await database();
    try {
        const groups = [];
        for (let i = 1; i <= 7; i++) groups.push(await setup(db, i));
        let arrived = 0, release;
        const gate = new Promise(resolve => { release = resolve; });
        for (const f of groups) {
            const remove = f.second.delete;
            f.second.delete = async () => { if (++arrived === groups.length) release(); await gate; return remove(); };
        }
        const operations = Promise.all(groups.map(f => invoke(f, 'delete', db)));
        await Promise.race([operations, delay(10000).then(() => { throw Error('grid journal deadlock'); })]);
        assert.equal(arrived, groups.length);
        assert.ok(groups.every(f => f.messages.size === 0));
        assert.equal(Number((await db.queryDatabaseIndependent('SELECT COUNT(*) AS n FROM bot_twitter_grid_action_intents'))[0].n), 0);
    } finally { await db.close(); }
});

test('many operations waiting on one post do not exhaust the application pool', { timeout: 30000 }, async () => {
    const db = await database();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    try {
        const f = await setup(db, 9);
        let entered;
        const ready = new Promise(resolve => { entered = resolve; });
        const remove = f.second.delete;
        f.second.delete = async () => { entered(); await gate; return remove(); };
        const calls = Promise.allSettled(Array.from({ length: 20 }, () => invoke(f, 'delete', db)));
        await Promise.race([ready, delay(5000).then(() => { throw Error('action did not begin'); })]);
        const other = await Promise.race([db.queryDatabase('SELECT 42 AS value'), delay(1500).then(() => { throw Error('unrelated query was blocked'); })]);
        assert.equal(Number(other[0].value), 42);
        release(); await calls;
        assert.equal(f.messages.size, 0);
    } finally { release(); await db.close(); }
});

test('a pending journal contains no post text or image URLs', { timeout: 30000 }, async () => {
    const db = await database();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    try {
        const f = await setup(db, 15);
        let entered;
        const ready = new Promise(resolve => { entered = resolve; });
        const edit = f.second.edit;
        f.second.edit = async request => { entered(); await gate; return edit(request); };
        const pending = invoke(f, 'showAttachmentsAsEmbedsImage', db);
        await Promise.race([ready, delay(5000).then(() => { throw Error('edit did not begin'); })]);
        const rows = await db.queryDatabaseIndependent('SELECT payload_json FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [f.item.lockId]);
        assert.equal(rows.length, 1);
        const text = String(rows[0].payload_json);
        assert.doesNotMatch(text, /body|pbs\.twimg|x\.com/);
        const journal = JSON.parse(text);
        assert.match(journal.steps[0].expected, /^[a-f0-9]{64}$/);
        release(); await pending;
    } finally { release(); await db.close(); }
});

test('restore and legacy actions share the same post and SQL locks', { timeout: 30000 }, async () => {
    const db = await database();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    try {
        const f = await setup(db, 13);
        let entered;
        const ready = new Promise(resolve => { entered = resolve; });
        const remove = f.second.delete;
        f.second.delete = async () => { entered(); await gate; return remove(); };
        const deletion = invoke(f, 'delete', db);
        await Promise.race([ready, delay(5000).then(() => { throw Error('action did not begin'); })]);
        // Load an independent module instance so this check cannot pass
        // merely because the process-local queue serialized the calls.
        const Module = require('node:module'), filename = require.resolve('../../src/twitterGridCards');
        const separateWorker = new Module(filename); separateWorker.filename = filename;
        separateWorker.paths = Module._nodeModulePaths(path.dirname(filename));
        separateWorker._compile(fs.readFileSync(filename, 'utf8'), filename);
        let restoreEntered = false;
        const restored = separateWorker.exports.withGalleryLock({ galleryId: f.item.id, guildId, channelId, messageId: f.first.id }, async ({ payload }) => {
            restoreEntered = true; assert.equal(payload.id, f.item.id);
        }, db);
        await delay(100);
        assert.equal(restoreEntered, false);
        release(); await deletion; await restored;
        assert.equal(restoreEntered, true);
    } finally { release(); await db.close(); }
});

test('a separate process waits on the shared MariaDB gallery row lock', { timeout: 30000 }, async () => {
    const db = await database();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let child;
    try {
        const f = await setup(db, 14);
        let entered;
        const ready = new Promise(resolve => { entered = resolve; });
        const locked = db.withDatabaseTransaction(async query => {
            await query('SELECT gallery_id FROM bot_media_galleries WHERE gallery_id=? FOR UPDATE', [f.item.lockId]);
            entered(); await gate;
        });
        await ready;
        const code = `
            const mysql = require('mysql');
            const cards = require('./src/twitterGridCards');
            const pool = mysql.createPool({host:'127.0.0.1',port:Number(process.env.TEST_PORT),user:'root',
                password:process.env.AUTOMATION_TEST_DB_PASSWORD || '',database:process.env.TEST_SCHEMA,connectionLimit:3});
            const on = connection => (sql, values=[]) => new Promise((resolve,reject) => connection.query(sql,values,(err,rows) => err ? reject(err) : resolve(rows)));
            const db = { queryDatabaseIndependent: (sql,values=[]) => new Promise((resolve,reject) => pool.query(sql,values,(err,rows) => err ? reject(err) : resolve(rows))),
                withDatabaseTransaction: async work => {
                    const c = await new Promise((resolve,reject) => pool.getConnection((err,connection) => err ? reject(err) : resolve(connection)));
                    const query = on(c);
                    try { await query('START TRANSACTION'); const value = await work(query); await query('COMMIT'); return value; }
                    catch (error) { await query('ROLLBACK'); throw error; } finally { c.release(); }
                } };
            process.stdout.write('WAITING\\n');
            cards.withGalleryLock({galleryId:process.env.TEST_GALLERY,guildId:process.env.TEST_GUILD,channelId:process.env.TEST_CHANNEL,messageId:process.env.TEST_MESSAGE},
                async () => { process.stdout.write('ENTERED\\n'); },db).then(() => pool.end(() => process.exit(0)), error => { process.stderr.write(String(error)); pool.end(() => process.exit(1)); });
        `;
        child = require('node:child_process').spawn(process.execPath, ['-e', code], { cwd: process.cwd(),
            env: { ...process.env, TEST_PORT: String(port), TEST_SCHEMA: db.schema, TEST_GALLERY: f.item.id,
                TEST_GUILD: guildId, TEST_CHANNEL: channelId, TEST_MESSAGE: f.first.id }, windowsHide: true });
        const closed = new Promise(resolve => child.on('close', resolve));
        let output = '', errors = '';
        child.stdout.on('data', chunk => { output += chunk.toString(); });
        child.stderr.on('data', chunk => { errors += chunk.toString(); });
        for (let count = 0; count < 100 && !output.includes('WAITING'); count++) await delay(25);
        assert.match(output, /WAITING/);
        await delay(200); assert.doesNotMatch(output, /ENTERED/);
        release(); await locked;
        const status = await closed;
        assert.equal(status, 0, errors); assert.match(output, /ENTERED/);
    } finally { release(); if (child && child.exitCode === null) child.kill(); await db.close(); }
});
test('separate processes reconcile the same deleted group without an extra Discord mutation', { timeout: 30000 }, async () => {
    const db = await database();
    const children = [];
    try {
        const f = await setup(db, 16), storage = gallery.createStore(db), row = await storage.get(f.item.id, guildId, channelId);
        const op = 'b'.repeat(32), payload = row.payload;
        const intent = { version: 1, operationId: op, action: 'delete', galleryId: payload.id, lockId: payload.lockId,
            steps: [1, 0].map(index => ({ type: 'delete', index, id: payload.messageIds[index], before: payload.partSignatures[index] })) };
        await db.queryDatabaseIndependent('INSERT INTO bot_twitter_grid_action_intents (gallery_id,guild_id,channel_id,message_id,operation_id,payload_json,updated_at_ms) VALUES (?,?,?,?,?,?,?)',
            [payload.lockId, guildId, channelId, f.first.id, op, JSON.stringify(intent), Date.now() - 600000]);
        const entry = { gallery_id: payload.lockId, guild_id: guildId, channel_id: channelId, message_id: f.first.id, operation_id: op };
        const code = `
            const mysql=require('mysql'), cleanup=require('./src/twitterGridDeletedCleanup')._internal;
            const pool=mysql.createPool({host:'127.0.0.1',port:Number(process.env.TEST_PORT),user:'root',password:process.env.AUTOMATION_TEST_DB_PASSWORD || '',database:process.env.TEST_SCHEMA,connectionLimit:3});
            const on=c=>(sql,values=[])=>new Promise((resolve,reject)=>c.query(sql,values,(error,rows)=>error?reject(error):resolve(rows)));
            const db={queryDatabaseIndependent:(sql,values=[])=>new Promise((resolve,reject)=>pool.query(sql,values,(error,rows)=>error?reject(error):resolve(rows))),
                withDatabaseTransaction:async work=>{ const c=await new Promise((resolve,reject)=>pool.getConnection((error,conn)=>error?reject(error):resolve(conn))); const query=on(c);
                    try {await query('START TRANSACTION');const result=await work(query);await query('COMMIT');return result;}
                    catch(error){await query('ROLLBACK');throw error;}finally{c.release();} }};
            const entry=JSON.parse(process.env.TEST_ENTRY);
            const channel={guildId:entry.guild_id,messages:{fetch:async()=>{throw Object.assign(Error('deleted'),{code:10008});}}};
            const client={guilds:{cache:{has:()=>true}},channels:{fetch:async()=>channel}};
            cleanup.reconcile(entry,client,db).then(()=>pool.end(()=>process.exit(0)),error=>{process.stderr.write(String(error));pool.end(()=>process.exit(1));});
        `;
        const statuses = Array.from({ length: 2 }, () => {
            const child = require('node:child_process').spawn(process.execPath, ['-e', code], { cwd: process.cwd(), windowsHide: true,
                env: { ...process.env, TEST_PORT: String(port), TEST_SCHEMA: db.schema, TEST_ENTRY: JSON.stringify(entry) } });
            children.push(child); let errorText = '';
            child.stderr.on('data', chunk => { errorText += chunk.toString(); });
            return new Promise(resolve => child.on('close', status => resolve({ status, errorText })));
        });
        const outcomes = await Promise.all(statuses);
        assert.ok(outcomes.every(result => result.status === 0), JSON.stringify(outcomes));
        assert.equal((await db.queryDatabaseIndependent('SELECT * FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [payload.lockId])).length, 0);
        const saved = await db.queryDatabase('SELECT expires_at_ms FROM bot_media_galleries WHERE gallery_id=?', [payload.id]);
        assert.ok(Number(saved[0].expires_at_ms) < Number.MAX_SAFE_INTEGER);
    } finally {
        for (const child of children) if (child.exitCode === null) child.kill();
        await db.close();
    }
});

test('an old worker cleanup cannot erase a newer action journal after recovery', { timeout: 30000 }, async () => {
    const db = await database();
    let releaseOld, releaseNew;
    const oldGate = new Promise(resolve => { releaseOld = resolve; });
    const newGate = new Promise(resolve => { releaseNew = resolve; });
    try {
        const f = await setup(db, 1);
        let signalOld, oldId, signalNew;
        const oldReady = new Promise(resolve => { signalOld = resolve; }), newReady = new Promise(resolve => { signalNew = resolve; });
        const oldWorkerDb = { ...db, queryDatabaseIndependent: async (sql, params) => {
            if (/^DELETE FROM bot_twitter_grid_action_intents/i.test(sql)) { oldId = params[1]; signalOld(); await oldGate; }
            return db.queryDatabaseIndependent(sql, params);
        } };
        const oldWorker = invoke(f, 'showAttachmentsAsEmbedsImage', oldWorkerDb);
        await Promise.race([oldReady, delay(10000).then(() => { throw Error('old cleanup was not reached'); })]);
        const oldRows = await db.queryDatabaseIndependent('SELECT operation_id FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [f.item.lockId]);
        assert.equal(oldRows[0].operation_id, oldId);

        // A successor reconciles the already completed action and clears its
        // old journal. The first worker remains paused before its own cleanup.
        await invoke(f, 'showAttachmentsAsEmbedsImage', db);
        assert.equal((await db.queryDatabaseIndependent('SELECT operation_id FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [f.item.lockId])).length, 0);

        const edit = f.second.edit;
        f.second.edit = async request => { signalNew(); await newGate; return edit(request); };
        const successor = invoke(f, 'showMediaAsAttachments', db);
        await Promise.race([newReady, delay(10000).then(() => { throw Error('new operation was not journaled'); })]);
        const newRows = await db.queryDatabaseIndependent('SELECT operation_id FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [f.item.lockId]);
        assert.equal(newRows.length, 1); assert.notEqual(newRows[0].operation_id, oldId);
        releaseOld(); await oldWorker;
        const after = await db.queryDatabaseIndependent('SELECT operation_id FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [f.item.lockId]);
        assert.equal(after[0]?.operation_id, newRows[0].operation_id, 'a delayed cleanup must only clear its own operation id');
        releaseNew(); await successor;
        assert.equal(f.messages.size, 2);
        assert.equal((await db.queryDatabaseIndependent('SELECT operation_id FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [f.item.lockId])).length, 0);
    } finally { releaseOld(); releaseNew(); await db.close(); }
});

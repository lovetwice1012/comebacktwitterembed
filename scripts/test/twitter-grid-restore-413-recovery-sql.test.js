'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const mysql = require('mysql');
const fs = require('node:fs'), path = require('node:path');
const { createTestDatabase } = require('../lib/automation-test-db');
const schema = require('../../src/db_schema'), cards = require('../../src/twitterGridCards');
const { recoverConfirmed } = require('../../src/twitterGridRestoreRecovery');
const { createRestoreJournal } = require('../../src/twitterGridRestoreJournal');
const restore = require('../../src/twitterGridRestore');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (![33621, 33622].includes(port)) throw Error('An explicit isolated test database port is required');
const gid = '111111111111111111', cid = '222222222222222222', bot = '333333333333333333', uid = '444444444444444444';
const mid = '555555555555555555', id = 'a'.repeat(32), status = '1234567890123456789', hash = 'd'.repeat(64);
const urls = Array.from({ length: 13 }, (_, i) => `https://pbs.twimg.com/media/P${i}?format=jpg`);
const file = (id, name) => ({ id, name, contentType: 'image/jpeg', url: `https://cdn.discordapp.com/attachments/${cid}/${id}/${name}` });
function post(messageId, op, start, count, first = false, newGridId = null) {
    const files = Array.from({ length: count }, (_, i) => file(String(710000000000000000n + BigInt(start + i)), `restore-${op}-${start + i}.jpg`));
    return { id: messageId, channelId: cid, guildId: gid, author: { id: bot }, content: '',
        embeds: first ? [{ title: '本文', url: `https://x.com/u/status/${status}` }] : [],
        components: newGridId ? [{ type: 1, components: [{ custom_id: `tg:${newGridId}:0:open` }] }] : [],
        attachments: new Map(files.map(item => [item.id, item])) };
}
function steps(op, sizes, messages, { plannedLast = false, type = 'edit', base = 0, root = mid } = {}) {
    let start = base;
    return messages.map((message, index) => {
        const count = sizes[index], step = { index, type: index ? 'send' : type, start, count,
            previousId: index ? messages[index - 1].id : root, state: plannedLast && index === messages.length - 1 ? 'planned' : 'confirmed',
            proofs: Array.from({ length: count }, (_, i) => ({ name: `restore-${op}-${start + i}.jpg`, sha256: hash })) };
        if (step.state === 'confirmed') step.messageId = message.id;
        start += count; return step;
    });
}
async function fixture() {
    const db = await createTestDatabase(port);
    const pool = mysql.createPool({ host:'127.0.0.1', port, user:'root', password:process.env.AUTOMATION_TEST_DB_PASSWORD || '', database: db.schema, connectionLimit: 2 });
    db.withIndependentTransaction = async work => { const c = await new Promise((resolve, reject) => pool.getConnection((e, value) => e ? reject(e) : resolve(value))); const query = (sql, params=[]) => new Promise((resolve, reject) => c.query(sql, params, (e, value) => e ? reject(e) : resolve(value))); try { await query('START TRANSACTION'); const value = await work(query); await query('COMMIT'); return value; } catch (e) { await query('ROLLBACK'); throw e; } finally { c.release(); } };
    const close = db.close.bind(db); db.close = async () => { await new Promise(resolve => pool.end(resolve)); await close(); };
    const migration = fs.readFileSync(path.join(schema.MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
    await db.queryDatabase(schema._internal.splitSqlStatements(migration).find(sql => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(sql)));
    const channel = { id: cid, guildId: gid, messages: { fetch: async query => {
        const message = data.messages.get(String(query.message)); if (!message) throw Object.assign(Error('missing'), { code: 10008 }); return message;
    } } };
    const interaction = { guildId: gid, channelId: cid, user: { id: uid }, client: { user: { id: bot } }, channel };
    const data = { db, channel, interaction, messages: new Map(), calls: 0 };
    channel.send = async () => { data.calls++; throw new Error('unexpected Discord submission during recovery'); };
    data.createPayload = async (galleryId, first, values = {}) => {
        const payload = { id: galleryId, lockId: galleryId, kind: 'twitter-image-grid-v1', replacePhase: 'done', sourceStatusId: status,
            imageUrls: urls, expectedImageUrls: urls, totalParts: 2, completedParts: 2, partsState: 'complete', messageIds: [first.id, '777777777777777777'],
            partSizes: [10, 3], partRefs: [urls.slice(0, 10).map(url => ({ type: 'url', url })), urls.slice(10).map(url => ({ type: 'url', url }))],
            partContainsNonImage: [false, false], partSignatures: [cards.fingerprint(first), 'f'.repeat(64)], firstStaticSignature: cards.fingerprint(first, true),
            requesterId: uid, nsfw: false, ...values };
        await db.queryDatabase('INSERT INTO bot_media_galleries (gallery_id,guild_id,channel_id,message_id,provider_id,payload_json,expires_at_ms) VALUES (?,?,?,?,?,?,?)',
            [galleryId, gid, cid, first.id, 'twitter', JSON.stringify(payload), Date.now() + 600000]);
        return payload;
    };
    data.insertJournal = async record => db.queryDatabase('INSERT INTO bot_twitter_grid_action_intents (gallery_id,guild_id,channel_id,message_id,operation_id,payload_json,updated_at_ms) VALUES (?,?,?,?,?,?,?)',
        [record.lockId, gid, cid, record.rootId || mid, record.operationId, JSON.stringify(record), Date.now()]);
    data.read = async galleryId => JSON.parse((await db.queryDatabase('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=?', [galleryId]))[0].payload_json);
    data.recover = async (galleryId, root, record, pending) => {
        const result = await cards.withGalleryLock({ galleryId, guildId: gid, channelId: cid, messageId: root }, async lock => recoverConfirmed(lock, interaction,
            { authorize: async () => true, fetchVerifiedSource: async (_source, payload) => payload.imageUrls, hashAttachment: async () => hash,
                findUnknownSend: async () => pending ? data.messages.get(pending) : null }), db);
        if (result) await result.journal.clearAfterCommit(result.operation);
        return result;
    };
    return data;
}
function record(op, mode, sizes, messages, options = {}) {
    return { version: 1, kind: 'twitter-grid-restore', operationId: op, galleryId: options.galleryId || id, lockId: options.galleryId || id,
        state: options.state || (options.plannedLast === false ? 'in_progress' : 'unknown'), mode, sourceStatusId: status, imageCount: 13, baseOffset: options.base || 0, targetCount: options.target || 13,
        startedAtMs: Date.now(), groupSizes: sizes, firstFingerprint: options.firstFingerprint || '0'.repeat(64),
        ...(options.newGalleryId ? { newGalleryId: options.newGalleryId } : {}),
        steps: steps(op, sizes, messages, { plannedLast: options.plannedLast !== false, type: ['new', 'resume'].includes(mode) ? 'send' : 'edit', base: options.base || 0, root: options.root || mid }) };
}

function rejected(saved, phase = 'rejected', replacement = [5, 5]) {
    const step = saved.steps.at(-1);
    const marker = { phase, index: step.index, originalGroups: [...saved.groupSizes], step };
    if (phase === 'repartitioned') {
        marker.replacement = replacement;
        saved.groupSizes.splice(step.index, 1, ...replacement);
        saved.steps.pop();
    }
    saved.rejected413 = marker;
    return saved;
}

async function savedJournal(db) {
    const rows = await db.queryDatabase('SELECT payload_json FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [id]);
    return rows.length ? JSON.parse(rows[0].payload_json) : null;
}

async function plannedJournal(f, mode = 'here', newGalleryId = null) {
    const original = post(mid, 'b'.repeat(32), 0, 1, true);
    f.messages.set(mid, original);
    const payload = await f.createPayload(id, original);
    const journal = createRestoreJournal(f.db, { galleryId: id, lockId: id, guildId: gid, channelId: cid, messageId: mid });
    const plan = restore.planFromSizes(urls, mode, [10, 3]);
    const operation = await journal.begin({ mode }, { first: original, payload }, plan, { id: status });
    if (newGalleryId) await journal.registerNewGallery(operation, newGalleryId);
    await journal.plan(operation, { index: 0, type: mode === 'new' ? 'send' : 'edit', start: 0, count: 10, previousId: mid,
        proofs: Array.from({ length: 10 }, (_, i) => ({ name: `restore-${operation.id}-${i}.jpg`, sha256: hash })) });
    return { original, payload, journal, operation };
}

async function newGallery(f, galleryId, totalParts = 2) {
    const row = { id: galleryId, lockId: galleryId, kind: 'twitter-image-grid-v1', partsState: 'pending',
        totalParts, completedParts: 0, messageIds: [], imageUrls: [], expectedImageUrls: urls };
    await f.db.queryDatabase('INSERT INTO bot_media_galleries (gallery_id,guild_id,channel_id,message_id,provider_id,payload_json,expires_at_ms) VALUES (?,?,?,?,?,?,?)',
        [galleryId, gid, cid, null, 'twitter', JSON.stringify(row), Date.now() + 600000]);
    return row;
}

for (const phase of ['rejected', 'repartitioned']) {
    test(`durable ${phase} 413 before any change clears only its verified intent`, { timeout: 60000 }, async () => {
        const f = await fixture(), op = 'b'.repeat(32);
        try {
            const original = post(mid, op, 0, 1, true), attempted = post(mid, op, 0, 10, true);
            f.messages.set(mid, original);
            const payload = await f.createPayload(id, original);
            const saved = rejected(record(op, 'here', [10, 3], [attempted], { firstFingerprint: cards.fingerprint(original) }), phase);
            await f.insertJournal(saved);
            assert.ok(await f.recover(id, mid, saved));
            assert.equal(await savedJournal(f.db), null);
            assert.deepEqual(await f.read(id), payload);
            assert.equal(f.calls, 0, 'recovery must not submit another Discord request');
        } finally { await f.db.close(); }
    });
}

for (const phase of ['rejected', 'repartitioned']) {
    test(`a resumed restore with ${phase} 413 records the confirmed prefix once`, { timeout: 60000 }, async () => {
        const f = await fixture(), op = 'f'.repeat(32), oldOp = 'a'.repeat(32);
        try {
            const original = post(mid, oldOp, 0, 5, true), first = post('666666666666666666', op, 5, 4), attempted = post('777777777777777777', op, 9, 4);
            const initial = await f.createPayload(id, original, { imageUrls: urls.slice(0, 5), expectedImageUrls: urls.slice(0, 5),
                partsState: 'complete', totalParts: 1, completedParts: 1, messageIds: [mid], partSizes: [5], partContainsNonImage: [false],
                partSignatures: [cards.fingerprint(original)], partRefs: [urls.slice(0, 5).map(url => ({ type: 'url', url }))],
                restoreArchive: { sourceStatusId: status, imageUrls: urls }, restoreContinuation: { sourceStatusId: status, nextIndex: 5, targetCount: 13 } });
            f.messages.set(mid, original); f.messages.set(first.id, first);
            const saved = rejected(record(op, 'resume', [4, 4], [first, attempted], { base: 5, target: 13, firstFingerprint: cards.fingerprint(original) }), phase, [2, 2]);
            await f.insertJournal(saved);
            assert.ok(await f.recover(id, mid, saved));
            const result = await f.read(id);
            assert.deepEqual(result.imageUrls, urls.slice(0, 9));
            assert.deepEqual(result.restoreArchive.imageUrls, urls);
            assert.deepEqual(result.messageIds, [mid, first.id]);
            assert.equal(result.restoreContinuation.nextIndex, 9);
            assert.equal(result.restoreContinuation.targetCount, 13);
            assert.equal(await savedJournal(f.db), null);
            assert.equal(f.calls, 0);
            assert.notDeepEqual(result, initial);
        } finally { await f.db.close(); }
    });
}

test('rollback after resolving a partial rejection can recover the confirmed prefix again', { timeout: 60000 }, async () => {
    const f = await fixture(), op = 'd'.repeat(32);
    try {
        const original = post(mid, op, 0, 1, true), first = post(mid, op, 0, 5, true), attempted = post('777777777777777777', op, 5, 5);
        const payload = await f.createPayload(id, original);
        f.messages.set(mid, first);
        const saved = rejected(record(op, 'rest', [5, 5, 3], [first, attempted], { firstFingerprint: cards.fingerprint(original) }));
        await f.insertJournal(saved);
        const deps = { authorize: async () => true, fetchVerifiedSource: async (_source, item) => item.imageUrls, hashAttachment: async () => hash };
        await assert.rejects(cards.withGalleryLock({ galleryId: id, guildId: gid, channelId: cid, messageId: mid }, async lock => {
            assert.ok(await recoverConfirmed(lock, f.interaction, deps));
            throw new Error('fixture outer transaction rollback');
        }, f.db), /fixture outer transaction rollback/);
        assert.deepEqual(await f.read(id), payload);
        const durable = await savedJournal(f.db);
        assert.equal(durable.state, 'partial_saved');
        assert.equal(durable.rejected413, undefined);
        assert.ok(await f.recover(id, mid, durable));
        assert.deepEqual((await f.read(id)).imageUrls, urls.slice(0, 5));
        assert.equal(await savedJournal(f.db), null);
        assert.equal(f.calls, 0);
    } finally { await f.db.close(); }
});

test('lost acknowledgement after empty-new-gallery cleanup leaves no duplicate send or orphan', { timeout: 60000 }, async () => {
    const f = await fixture(), newId = 'e'.repeat(32);
    try {
        const { payload, journal, operation } = await plannedJournal(f, 'new', newId);
        await newGallery(f, newId);
        await journal.markRejected413(operation, 0);
        const saved = await savedJournal(f.db);
        const transaction = f.db.withIndependentTransaction;
        f.db.withIndependentTransaction = async work => {
            await transaction(work);
            throw new Error('cleanup committed but response was lost');
        };
        await assert.rejects(f.recover(id, mid, saved), /cleanup committed but response was lost/);
        f.db.withIndependentTransaction = transaction;
        assert.equal(await savedJournal(f.db), null);
        assert.equal((await f.db.queryDatabase('SELECT * FROM bot_media_galleries WHERE gallery_id=?', [newId])).length, 0);
        assert.deepEqual(await f.read(id), payload);
        assert.equal(f.calls, 0);
    } finally { await f.db.close(); }
});

for (const phase of ['rejected', 'repartitioned']) {
    test(`new-gallery ${phase} 413 after one confirmed post preserves its first five images`, { timeout: 60000 }, async () => {
        const f = await fixture(), op = 'f'.repeat(32), newId = 'e'.repeat(32);
        try {
            const original = post(mid, op, 0, 1, true);
            const first = post('666666666666666666', op, 0, 5, true, newId);
            const attempted = post('777777777777777777', op, 5, 5);
            const payload = await f.createPayload(id, original);
            f.messages.set(mid, original); f.messages.set(first.id, first);
            const saved = rejected(record(op, 'new', [5, 5, 3], [first, attempted],
                { firstFingerprint: cards.fingerprint(original), newGalleryId: newId }), phase, [3, 2]);
            const refs = urls.map(url => ({ type: 'url', url }));
            const created = { id: newId, lockId: newId, kind: 'twitter-image-grid-v1', isPrimary: true,
                partsState: 'pending', totalParts: saved.groupSizes.length, completedParts: 1,
                messageIds: [first.id], partSignatures: [cards.fingerprint(first)], firstStaticSignature: cards.fingerprint(first, true),
                imageUrls: urls.slice(0, 5), expectedImageUrls: urls, expectedRefs: refs,
                partRefs: [refs.slice(0, 5)], partSizes: [5], partContainsNonImage: [false], sourceStatusId: status };
            await f.db.queryDatabase('INSERT INTO bot_media_galleries (gallery_id,guild_id,channel_id,message_id,provider_id,payload_json,expires_at_ms) VALUES (?,?,?,?,?,?,?)',
                [newId, gid, cid, first.id, 'twitter', JSON.stringify(created), Date.now() + 600000]);
            await f.insertJournal(saved);
            assert.ok(await f.recover(id, mid, saved));
            const result = await f.read(newId);
            assert.deepEqual(result.imageUrls, urls.slice(0, 5));
            assert.deepEqual(result.restoreArchive.imageUrls, urls);
            assert.deepEqual(result.messageIds, [first.id]);
            assert.equal(result.restoreContinuation.nextIndex, 5);
            assert.equal(result.restoreContinuation.targetCount, 13);
            assert.equal(await savedJournal(f.db), null);
            assert.deepEqual(await f.read(id), payload);
            assert.equal(f.calls, 0);
        } finally { await f.db.close(); }
    });
}

test('a committed rejection with lost acknowledgement is recovered without submitting the request again', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const { payload, journal, operation } = await plannedJournal(f);
        const query = f.db.queryDatabaseIndependent;
        let injected = false;
        f.db.queryDatabaseIndependent = async (sql, params) => {
            const result = await query(sql, params);
            if (!injected && sql.includes('UPDATE bot_twitter_grid_action_intents') && JSON.parse(params[0]).rejected413?.phase === 'rejected') {
                injected = true; throw new Error('acknowledgement lost after commit');
            }
            return result;
        };
        await assert.rejects(journal.markRejected413(operation, 0), /acknowledgement lost/);
        f.db.queryDatabaseIndependent = query;
        const saved = await savedJournal(f.db);
        assert.equal(saved.rejected413.phase, 'rejected');
        assert.ok(await f.recover(id, mid, saved));
        assert.equal(await savedJournal(f.db), null);
        assert.deepEqual(await f.read(id), payload);
        assert.equal(f.calls, 0);
    } finally { await f.db.close(); }
});

test('a committed repartition with lost acknowledgement is recovered without another submission', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const { payload, journal, operation } = await plannedJournal(f);
        await journal.markRejected413(operation, 0);
        const query = f.db.queryDatabaseIndependent;
        let injected = false;
        f.db.queryDatabaseIndependent = async (sql, params) => {
            const result = await query(sql, params);
            if (!injected && sql.includes('UPDATE bot_twitter_grid_action_intents') && JSON.parse(params[0]).rejected413?.phase === 'repartitioned') {
                injected = true; throw new Error('acknowledgement lost after commit');
            }
            return result;
        };
        await assert.rejects(journal.repartition(operation, 0, [5, 5]), /acknowledgement lost/);
        f.db.queryDatabaseIndependent = query;
        const saved = await savedJournal(f.db);
        assert.equal(saved.rejected413.phase, 'repartitioned');
        assert.deepEqual(saved.groupSizes, [5, 5, 3]);
        assert.ok(await f.recover(id, mid, saved));
        assert.equal(await savedJournal(f.db), null);
        assert.deepEqual(await f.read(id), payload);
        assert.equal(f.calls, 0);
    } finally { await f.db.close(); }
});

test('a failed marker write leaves an unproven planned request blocked', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const { payload, journal, operation } = await plannedJournal(f);
        const query = f.db.queryDatabaseIndependent;
        f.db.queryDatabaseIndependent = async () => { throw new Error('database unavailable before commit'); };
        await assert.rejects(journal.markRejected413(operation, 0), /database unavailable/);
        f.db.queryDatabaseIndependent = query;
        const saved = await savedJournal(f.db);
        assert.equal(saved.rejected413, undefined);
        assert.equal(saved.steps[0].state, 'planned');
        assert.equal(await f.recover(id, mid, saved), null);
        assert.deepEqual(await savedJournal(f.db), saved);
        assert.deepEqual(await f.read(id), payload);
        assert.equal(f.calls, 0);
    } finally { await f.db.close(); }
});

for (const outcome of ['committed', 'rolled_back']) {
    test(`new-gallery repartition ${outcome} with lost response is reconciled atomically`, { timeout: 60000 }, async () => {
        const f = await fixture(), newId = 'e'.repeat(32);
        try {
            const { payload, journal, operation } = await plannedJournal(f, 'new', newId);
            await newGallery(f, newId);
            await journal.markRejected413(operation, 0);
            const original = await f.read(newId);
            const run = async () => f.db.withIndependentTransaction(async query => {
                await journal.repartition(operation, 0, [5, 5], query);
                const next = { ...original, totalParts: 3 };
                const result = await query('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=? AND BINARY payload_json=BINARY ?',
                    [JSON.stringify(next), newId, JSON.stringify(original)]);
                assert.equal(result.affectedRows, 1);
                if (outcome === 'rolled_back') throw new Error('transaction rolled back');
            });
            if (outcome === 'committed') {
                await run();
                // The caller lost the commit response: its in-memory state is intentionally stale.
                assert.equal(operation.record.rejected413.phase, 'rejected');
            } else await assert.rejects(run(), /transaction rolled back/);
            const saved = await savedJournal(f.db);
            assert.equal(saved.rejected413.phase, outcome === 'committed' ? 'repartitioned' : 'rejected');
            assert.equal((await f.read(newId)).totalParts, outcome === 'committed' ? 3 : 2);
            assert.ok(await f.recover(id, mid, saved));
            assert.equal(await savedJournal(f.db), null);
            assert.equal((await f.db.queryDatabase('SELECT * FROM bot_media_galleries WHERE gallery_id=?', [newId])).length, 0);
            assert.deepEqual(await f.read(id), payload);
            assert.equal(f.calls, 0);
        } finally { await f.db.close(); }
    });
}

test('a repartitioned new-gallery marker with inconsistent gallery state remains blocked', { timeout: 60000 }, async () => {
    const f = await fixture(), newId = 'e'.repeat(32);
    try {
        const { payload, journal, operation } = await plannedJournal(f, 'new', newId);
        await newGallery(f, newId, 2);
        await journal.markRejected413(operation, 0);
        await journal.repartition(operation, 0, [5, 5]);
        const saved = await savedJournal(f.db);
        assert.equal(saved.rejected413.phase, 'repartitioned');
        assert.equal(await f.recover(id, mid, saved), null);
        assert.deepEqual(await savedJournal(f.db), saved);
        assert.equal((await f.read(newId)).totalParts, 2);
        assert.deepEqual(await f.read(id), payload);
        assert.equal(f.calls, 0);
    } finally { await f.db.close(); }
});

test('an unknown submission without a durable rejection stays blocked', { timeout: 60000 }, async () => {
    const f = await fixture(), op = 'c'.repeat(32);
    try {
        const original = post(mid, op, 0, 1, true), attempted = post(mid, op, 0, 10, true);
        f.messages.set(mid, original);
        const payload = await f.createPayload(id, original);
        const saved = record(op, 'here', [10, 3], [attempted], { firstFingerprint: cards.fingerprint(original) });
        await f.insertJournal(saved);
        assert.equal(await f.recover(id, mid, saved), null);
        assert.deepEqual(await savedJournal(f.db), saved);
        assert.deepEqual(await f.read(id), payload);
        assert.equal(f.calls, 0);
    } finally { await f.db.close(); }
});

test('a changed source after the 413 is never used to clear a journal', { timeout: 60000 }, async () => {
    const f = await fixture(), op = 'c'.repeat(32);
    try {
        const original = post(mid, op, 0, 1, true), attempted = post(mid, op, 0, 10, true);
        const payload = await f.createPayload(id, original);
        const saved = rejected(record(op, 'here', [10, 3], [attempted], { firstFingerprint: cards.fingerprint(original) }));
        await f.insertJournal(saved);
        f.messages.set(mid, { ...original, content: 'changed after rejection' });
        assert.equal(await f.recover(id, mid, saved), null);
        assert.deepEqual(await savedJournal(f.db), saved);
        assert.deepEqual(await f.read(id), payload);
        assert.equal(f.calls, 0);
    } finally { await f.db.close(); }
});

test('a corrupt rejected request cannot authorize cleanup', { timeout: 60000 }, async () => {
    const f = await fixture(), op = 'c'.repeat(32);
    try {
        const original = post(mid, op, 0, 1, true), attempted = post(mid, op, 0, 10, true);
        f.messages.set(mid, original);
        const payload = await f.createPayload(id, original);
        const saved = rejected(record(op, 'here', [10, 3], [attempted], { firstFingerprint: cards.fingerprint(original) }));
        saved.rejected413.step.start = 1;
        // Keep both copies equal: cleanup must check the immutable plan, not
        // merely trust that two corrupt copies happen to match.
        saved.steps[0].start = 1;
        await f.insertJournal(saved);
        assert.equal(await f.recover(id, mid, saved), null);
        assert.deepEqual(await savedJournal(f.db), saved);
        assert.deepEqual(await f.read(id), payload);
        assert.equal(f.calls, 0);
    } finally { await f.db.close(); }
});

test('two concurrent recovery attempts cannot clear or apply the same intent twice', { timeout: 60000 }, async () => {
    const f = await fixture(), op = 'c'.repeat(32);
    try {
        const original = post(mid, op, 0, 1, true), attempted = post(mid, op, 0, 10, true);
        f.messages.set(mid, original);
        const payload = await f.createPayload(id, original);
        const saved = rejected(record(op, 'here', [10, 3], [attempted], { firstFingerprint: cards.fingerprint(original) }));
        await f.insertJournal(saved);
        const outcomes = await Promise.all([f.recover(id, mid, saved), f.recover(id, mid, saved)]);
        assert.equal(outcomes.filter(Boolean).length, 1);
        assert.equal(await savedJournal(f.db), null);
        assert.deepEqual(await f.read(id), payload);
        assert.equal(f.calls, 0);
    } finally { await f.db.close(); }
});

for (const phase of ['rejected', 'repartitioned']) {
    test(`a ${phase} 413 after a confirmed first group preserves it without sending again`, { timeout: 60000 }, async () => {
        const f = await fixture(), op = 'd'.repeat(32);
        try {
            const original = post(mid, op, 0, 1, true), first = post(mid, op, 0, 5, true), attempted = post('777777777777777777', op, 5, 5);
            const initial = await f.createPayload(id, original);
            f.messages.set(mid, first);
            const saved = rejected(record(op, 'rest', [5, 5, 3], [first, attempted], { firstFingerprint: cards.fingerprint(original) }), phase, [3, 2]);
            await f.insertJournal(saved);
            assert.ok(await f.recover(id, mid, saved));
            const result = await f.read(id);
            assert.deepEqual(result.imageUrls, urls.slice(0, 5));
            assert.deepEqual(result.restoreArchive.imageUrls, urls);
            assert.deepEqual(result.messageIds, [mid]);
            assert.equal(result.restoreContinuation.nextIndex, 5);
            assert.equal(result.restoreContinuation.targetCount, 13);
            assert.equal(await savedJournal(f.db), null);
            assert.equal(f.calls, 0);
            assert.notDeepEqual(result, initial);
        } finally { await f.db.close(); }
    });
}

'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createTestDatabase } = require('../lib/automation-test-db');
const schema = require('../../src/db_schema'), cards = require('../../src/twitterGridCards');
const { recoverConfirmed } = require('../../src/twitterGridRestoreRecovery');
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
    const db = await createTestDatabase(port), migration = fs.readFileSync(path.join(schema.MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
    await db.queryDatabase(schema._internal.splitSqlStatements(migration).find(sql => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(sql)));
    const channel = { id: cid, guildId: gid, messages: { fetch: async query => {
        const message = data.messages.get(String(query.message)); if (!message) throw Object.assign(Error('missing'), { code: 10008 }); return message;
    } } };
    const interaction = { guildId: gid, channelId: cid, user: { id: uid }, client: { user: { id: bot } }, channel };
    const data = { db, channel, interaction, messages: new Map(), calls: 0 };
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
test('4+4+5: confirmed first two groups recover partially and retain ordered continuation', { timeout: 60000 }, async () => {
    const f = await fixture(), op = 'b'.repeat(32), first = post(mid, op, 0, 4, true), second = post('666666666666666666', op, 4, 4);
    try {
        f.messages.set(mid, first); f.messages.set(second.id, second); await f.createPayload(id, first);
        const journal = record(op, 'here', [4, 4, 5], [first, second], { plannedLast: false }); await f.insertJournal(journal);
        assert.ok(await f.recover(id, mid, journal));
        const payload = await f.read(id); assert.deepEqual(payload.partSizes, [4, 4]); assert.deepEqual(payload.imageUrls, urls.slice(0, 8));
        assert.deepEqual(payload.restoreContinuation, { sourceStatusId: status, nextIndex: 8, targetCount: 13 });
        assert.deepEqual(payload.messageIds, [mid, second.id]); assert.equal((await f.db.queryDatabase('SELECT * FROM bot_twitter_grid_action_intents')).length, 0);
    } finally { await f.db.close(); }
});
test('4+4+5: unknown middle send recovers only the proven prefix without resending', { timeout: 60000 }, async () => {
    const f = await fixture(), op = 'b'.repeat(32), first = post(mid, op, 0, 4, true), second = post('666666666666666666', op, 4, 4);
    try {
        f.messages.set(mid, first); f.messages.set(second.id, second); await f.createPayload(id, first);
        const journal = record(op, 'here', [4, 4, 5], [first, second]); await f.insertJournal(journal);
        assert.ok(await f.recover(id, mid, journal, second.id));
        const payload = await f.read(id); assert.deepEqual(payload.messageIds, [mid, second.id]);
        assert.deepEqual(payload.restoreContinuation, { sourceStatusId: status, nextIndex: 8, targetCount: 13 });
    } finally { await f.db.close(); }
});
test('4+4+5: unknown final send is verified once and all three groups recover', { timeout: 60000 }, async () => {
    const f = await fixture(), op = 'b'.repeat(32), messages = [post(mid, op, 0, 4, true), post('666666666666666666', op, 4, 4), post('888888888888888888', op, 8, 5)];
    try {
        for (const message of messages) f.messages.set(message.id, message); await f.createPayload(id, messages[0]);
        const journal = record(op, 'here', [4, 4, 5], messages); await f.insertJournal(journal);
        assert.ok(await f.recover(id, mid, journal, messages.at(-1).id));
        const payload = await f.read(id); assert.deepEqual(payload.partSizes, [4, 4, 5]); assert.deepEqual(payload.imageUrls, urls);
        assert.deepEqual(payload.messageIds, messages.map(item => item.id)); assert.equal(payload.restoreContinuation, undefined);
    } finally { await f.db.close(); }
});
test('4+4+5: a modified final receipt is never included in the recovered group', { timeout: 60000 }, async () => {
    const f = await fixture(), op = 'b'.repeat(32), messages = [post(mid, op, 0, 4, true), post('666666666666666666', op, 4, 4), post('888888888888888888', op, 8, 5)];
    try {
        for (const message of messages) f.messages.set(message.id, message); await f.createPayload(id, messages[0]);
        const journal = record(op, 'here', [4, 4, 5], messages); await f.insertJournal(journal);
        messages[2].content = 'unrelated changed content';
        assert.equal(await f.recover(id, mid, journal, messages[2].id), null);
        assert.equal((await f.read(id)).messageIds.length, 2);
        assert.equal((await f.db.queryDatabase('SELECT * FROM bot_twitter_grid_action_intents')).length, 1);
    } finally { await f.db.close(); }
});
test('resume from 8: changed earlier part blocks recovery and a verified 2+3 continuation completes', { timeout: 60000 }, async () => {
    const f = await fixture(), initialOp = 'b'.repeat(32), op = 'c'.repeat(32);
    const existing = [post(mid, initialOp, 0, 4, true), post('666666666666666666', initialOp, 4, 4)];
    const added = [post('888888888888888888', op, 8, 2), post('999999999999999999', op, 10, 3)];
    try {
        for (const message of [...existing, ...added]) f.messages.set(message.id, message);
        await f.createPayload(id, existing[0], { replacePhase: undefined, imageUrls: urls.slice(0, 8), expectedImageUrls: urls.slice(0, 8),
            totalParts: 2, completedParts: 2, messageIds: existing.map(message => message.id), partSizes: [4, 4],
            partRefs: [urls.slice(0, 4).map(url => ({ type: 'url', url })), urls.slice(4, 8).map(url => ({ type: 'url', url }))],
            partSignatures: existing.map(message => cards.fingerprint(message)), partContainsNonImage: [false, false],
            restoreArchive: { sourceStatusId: status, imageUrls: urls }, restoreContinuation: { sourceStatusId: status, nextIndex: 8, targetCount: 13 } });
        const journal = record(op, 'resume', [2, 3], added, { base: 8 }); await f.insertJournal(journal);
        existing[1].content = 'changed'; assert.equal(await f.recover(id, mid, journal, added.at(-1).id), null);
        existing[1].content = ''; assert.ok(await f.recover(id, mid, journal, added.at(-1).id));
        const payload = await f.read(id); assert.deepEqual(payload.imageUrls, urls); assert.deepEqual(payload.partSizes, [4, 4, 2, 3]);
        assert.deepEqual(payload.messageIds, [...existing, ...added].map(message => message.id)); assert.equal(payload.restoreContinuation, undefined);
    } finally { await f.db.close(); }
});
test('first ten: a partial 4+3+3 recovery retains the selected target of ten', { timeout: 60000 }, async () => {
    const f = await fixture(), op = 'b'.repeat(32), first = post(mid, op, 0, 4, true), second = post('666666666666666666', op, 4, 3);
    try {
        f.messages.set(mid, first); f.messages.set(second.id, second); await f.createPayload(id, first);
        const journal = record(op, 'first', [4, 3, 3], [first, second], { target: 10, plannedLast: false }); await f.insertJournal(journal);
        assert.ok(await f.recover(id, mid, journal));
        const payload = await f.read(id); assert.deepEqual(payload.partSizes, [4, 3]);
        assert.deepEqual(payload.restoreContinuation, { sourceStatusId: status, nextIndex: 7, targetCount: 10 });
        assert.deepEqual(payload.restoreArchive.imageUrls, urls);
    } finally { await f.db.close(); }
});

test('first ten: after resuming 8+2, the remaining three stay available for a later explicit action', { timeout: 60000 }, async () => {
    const f = await fixture(), initialOp = 'b'.repeat(32), op = 'c'.repeat(32);
    const first = post(mid, initialOp, 0, 8, true), second = post('666666666666666666', op, 8, 2);
    try {
        for (const message of [first, second]) f.messages.set(message.id, message);
        await f.createPayload(id, first, { replacePhase: undefined, imageUrls: urls.slice(0, 8), expectedImageUrls: urls.slice(0, 8),
            totalParts: 1, completedParts: 1, messageIds: [first.id], partSizes: [8],
            partRefs: [urls.slice(0, 8).map(url => ({ type: 'url', url }))], partSignatures: [cards.fingerprint(first)],
            partContainsNonImage: [false], restoreArchive: { sourceStatusId: status, imageUrls: urls },
            restoreContinuation: { sourceStatusId: status, nextIndex: 8, targetCount: 10 } });
        const journal = record(op, 'resume', [2], [second], { base: 8, target: 10, plannedLast: false });
        await f.insertJournal(journal);
        assert.ok(await f.recover(id, mid, journal));
        const payload = await f.read(id);
        assert.deepEqual(payload.imageUrls, urls.slice(0, 10));
        assert.deepEqual(payload.restoreArchive.imageUrls, urls);
        assert.deepEqual(payload.restoreContinuation, { sourceStatusId: status, nextIndex: 10, targetCount: 13 });
        assert.deepEqual(payload.messageIds, [first.id, second.id]);
    } finally { await f.db.close(); }
});
test('4+4+5: database rollback leaves journal for safe repeated recovery', { timeout: 60000 }, async () => {
    const f = await fixture(), op = 'b'.repeat(32), first = post(mid, op, 0, 4, true), second = post('666666666666666666', op, 4, 4);
    try {
        f.messages.set(mid, first); f.messages.set(second.id, second); await f.createPayload(id, first);
        const journal = record(op, 'here', [4, 4, 5], [first, second], { plannedLast: false }); await f.insertJournal(journal);
        await assert.rejects(cards.withGalleryLock({ galleryId: id, guildId: gid, channelId: cid, messageId: mid }, async lock => {
            assert.ok(await recoverConfirmed(lock, f.interaction, { authorize: async () => true,
                fetchVerifiedSource: async (_source, payload) => payload.imageUrls, hashAttachment: async () => hash }));
            throw Error('simulated transaction failure');
        }, f.db), /simulated transaction failure/);
        assert.equal((await f.read(id)).imageUrls.length, 13);
        assert.ok(await f.recover(id, mid, journal));
        const payload = await f.read(id); assert.deepEqual(payload.partSizes, [4, 4]); assert.equal(payload.restoreContinuation.nextIndex, 8);
    } finally { await f.db.close(); }
});
test('new gallery: two confirmed groups are bound once and preserve the remaining continuation', { timeout: 60000 }, async () => {
    const f = await fixture(), op = 'b'.repeat(32), newId = 'e'.repeat(32), original = post(mid, 'c'.repeat(32), 0, 1, true);
    const first = post('666666666666666666', op, 0, 4, true, newId), second = post('888888888888888888', op, 4, 4);
    try {
        for (const message of [original, first, second]) f.messages.set(message.id, message);
        await f.createPayload(id, original);
        const expectedRefs = urls.map(url => ({ type: 'url', url }));
        const created = { id: newId, lockId: newId, kind: 'twitter-image-grid-v1', sourceStatusId: status, requesterId: uid,
            expectedImageUrls: urls, expectedRefs, initialImageUrls: urls.slice(0, 4), imageUrls: [],
            totalParts: 3, completedParts: 0, messageIds: [], partSizes: [], partRefs: [], partSignatures: [],
            partContainsNonImage: [], partsState: 'pending', isPrimary: true };
        await f.db.queryDatabase('INSERT INTO bot_media_galleries (gallery_id,guild_id,channel_id,message_id,provider_id,payload_json,expires_at_ms) VALUES (?,?,?,?,?,?,?)',
            [newId, gid, cid, null, 'twitter', JSON.stringify(created), Date.now() + 600000]);
        const journal = record(op, 'new', [4, 4, 5], [first, second], { plannedLast: false, newGalleryId: newId, firstFingerprint: cards.fingerprint(original) });
        await f.insertJournal(journal); assert.ok(await f.recover(id, mid, journal));
        const payload = await f.read(newId); assert.deepEqual(payload.messageIds, [first.id, second.id]);
        assert.deepEqual(payload.partSizes, [4, 4]); assert.deepEqual(payload.imageUrls, urls.slice(0, 8));
        assert.deepEqual(payload.restoreContinuation, { sourceStatusId: status, nextIndex: 8, targetCount: 13 });
    } finally { await f.db.close(); }
});

for (const stage of ['root', 'continuation']) for (const field of ['id', 'channelId', 'guildId', 'author']) for (const mode of ['wrong', 'missing']) {
    test(`journal recovery rejects ${mode} ${field} on ${stage}`, { timeout: 60000 }, async () => {
        const f = await fixture(), op = 'b'.repeat(32), first = post(mid, op, 0, 4, true), second = post('666666666666666666', op, 4, 4);
        try {
            f.messages.set(mid, first); f.messages.set(second.id, second); await f.createPayload(id, first);
            const journal = record(op, 'here', [4, 4, 5], [first, second], { plannedLast: false }); await f.insertJournal(journal);
            const original = JSON.stringify(await f.read(id)), target = stage === 'root' ? first : second;
            f.messages.set(target.id, { ...target, [field]: mode === 'missing' ? undefined : field === 'author' ? { id: uid } : '999999999999999999' });
            assert.equal(await f.recover(id, mid, journal), null);
            assert.equal(JSON.stringify(await f.read(id)), original);
            assert.equal((await f.db.queryDatabase('SELECT * FROM bot_twitter_grid_action_intents')).length, 1);
        } finally { await f.db.close(); }
    });
}

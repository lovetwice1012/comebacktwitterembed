'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createTestDatabase } = require('../lib/automation-test-db');
const schema = require('../../src/db_schema'), cards = require('../../src/twitterGridCards');
const inline = require('../../src/twitterGridRestoreInline'), { recoverInline } = require('../../src/twitterGridRestoreInlineRecovery');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (![33621, 33622].includes(port)) throw Error('An explicit isolated test database port is required');
const gid = '111111111111111111', cid = '222222222222222222', bot = '333333333333333333', uid = '444444444444444444', mid = '555555555555555555';
const parentId = 'a'.repeat(32), quoteId = 'b'.repeat(32), operationId = 'c'.repeat(32), sha = 'd'.repeat(64);
const urls = ['https://pbs.twimg.com/media/Q0?format=jpg', 'https://pbs.twimg.com/media/Q1?format=jpg'];
function file(id, name) { return { id, name, contentType: 'image/jpeg', url: `https://cdn.discordapp.com/attachments/${cid}/${id}/${name}` }; }
async function fixture(kind) {
    const db = await createTestDatabase(port), sql = fs.readFileSync(path.join(schema.MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
    await db.queryDatabase(schema._internal.splitSqlStatements(sql).find(s => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(s)));
    const parentFiles = Array.from({ length: kind === 'references' ? 9 : 1 }, (_, i) => file(String(610000000000000000n + BigInt(i)), `parent${i}.jpg`));
    const marker = file('600000000000000002', `tg-${quoteId}.jpg`), attachments = [...parentFiles, marker];
    const parentEmbed = { title: '親の本文', description: '親の説明', url: 'https://x.com/parent/status/101' };
    const quoteEmbed = { title: '引用の本文', description: '引用の説明', url: 'https://x.com/quote/status/202', image: { url: marker.url } };
    const first = { id: mid, channelId: cid, guildId: gid, author: { id: bot }, content: '保持する本文',
        components: [{ type: 1, components: [{ custom_id: `tg:${parentId}:0:open` }, { custom_id: `tg:${quoteId}:0:open` }] }],
        embeds: [parentEmbed, quoteEmbed, { title: '要約', description: '保護' }], attachments: new Map(attachments.map(item => [item.id, item])) };
    const sig = cards.fingerprint(first), stat = cards.fingerprint(first, true), common = { kind: 'twitter-image-grid-v1', lockId: parentId,
        sharedInline: true, partsState: 'complete', completedParts: 1, totalParts: 1, messageIds: [mid], partSignatures: [sig],
        firstStaticSignature: stat, partContainsNonImage: [false], requesterId: uid };
    const parent = { ...common, id: parentId, isPrimary: true, imageUrls: ['https://pbs.twimg.com/media/P0?format=jpg'], partSizes: [1],
        partRefs: [[{ type: 'url', url: 'https://pbs.twimg.com/media/P0?format=jpg' }]], embedStart: 0, embedEnd: 1,
        embedWitness: { hashes: [cards.embedFingerprint(parentEmbed)], attachments: parentFiles.map(v => ({ id: v.id, name: v.name })) } };
    const quote = { ...common, id: quoteId, isPrimary: false, replacePhase: 'done', sourceStatusId: '202', imageUrls: urls,
        partSizes: [2], partRefs: [urls.map(url => ({ type: 'url', url }))], embedStart: 1, embedEnd: 2,
        embedWitness: { hashes: [cards.embedFingerprint(quoteEmbed)], attachments: [] } };
    for (const payload of [parent, quote]) await db.queryDatabase('INSERT INTO bot_media_galleries (gallery_id,guild_id,channel_id,message_id,provider_id,payload_json,expires_at_ms) VALUES (?,?,?,?,?,?,?)',
        [payload.id, gid, cid, mid, 'twitter', JSON.stringify(payload), Date.now() + 600000]);
    const interaction = { guildId: gid, channelId: cid, user: { id: uid }, client: { user: { id: bot } } };
    return { db, first, quote, interaction };
}
const scope = { galleryId: quoteId, guildId: gid, channelId: cid, messageId: mid };
function simulate(first, plan) {
    const retained = [...first.attachments.values()].filter(item => plan.retained.some(entry => entry.id === item.id));
    const added = plan.uploads.map((item, i) => file(String(720000000000000000n + BigInt(i)), item.name)), all = [...retained, ...added];
    const embeds = plan.edit.embeds.map(embed => {
        const copy = JSON.parse(JSON.stringify(embed));
        if (copy.image?.url?.startsWith('attachment://')) { const hit = all.find(item => item.name === copy.image.url.slice(13)); if (hit) copy.image.url = hit.url; }
        return copy;
    });
    return { ...first, embeds, components: plan.edit.components, attachments: new Map(all.map(item => [item.id, item])) };
}
async function setup(f, kind) {
    let plan, after;
    await cards.withGalleryLock(scope, async lock => {
        const snapshot = await inline.inspect({ query: lock.query, readRows: f.db.queryDatabaseIndependent, interaction: f.interaction,
            payload: lock.payload, message: f.first, authorize: async () => true });
        const uploads = urls.map((_, i) => ({ name: `restore-${operationId}-${i}.jpg`, data: Buffer.from('ffd8ff00', 'hex') }));
        plan = kind === 'references' ? await inline.prepareReferenceEdit(snapshot, urls, async (_payload, original) => original) : inline.prepareEdit(snapshot, uploads);
        after = simulate(f.first, plan);
    }, f.db);
    const expected = { content: plan.edit.content, embeds: plan.edit.embeds, components: plan.edit.components, attachments: plan.retained };
    const evidence = { kind: kind === 'references' ? 'inline-reference' : 'inline-upload', expectedFingerprint: cards.fingerprint(expected),
        expectedStatic: cards.fingerprint(expected, true), targetStart: plan.targetStart, targetEnd: plan.targetEnd, retainedIds: plan.retained.map(v => v.id) };
    const recorded = { kind: 'twitter-grid-restore', version: 1, operationId, galleryId: quoteId, lockId: parentId,
        state: 'unknown', mode: 'here', sourceStatusId: '202', imageCount: 2, groupSizes: [2], steps: [{ index: 0, type: 'edit', start: 0, previousId: mid,
            count: 2, state: 'planned', evidence, proofs: urls.map((_, i) => ({ name: `restore-${operationId}-${i}.jpg`, sha256: sha })) }] };
    await f.db.queryDatabase('INSERT INTO bot_twitter_grid_action_intents (gallery_id,guild_id,channel_id,message_id,operation_id,payload_json,updated_at_ms) VALUES (?,?,?,?,?,?,?)',
        [parentId, gid, cid, mid, operationId, JSON.stringify(recorded), Date.now()]);
    return { plan, after, recorded };
}
const args = (f, lock, recorded, after, extra = {}) => ({ lock, interaction: f.interaction, recorded, messages: [after], authorize: async () => true,
    verifySource: async (_status, payload) => payload.imageUrls, hashAttachment: async () => sha, fetchCurrent: async () => after, ...extra });
for (const kind of ['references', 'uploads']) test(`${kind} unknown edit is verified and reconstructs both gallery rows`, { timeout: 60000 }, async () => {
    const f = await fixture(kind);
    try {
        const { after, recorded } = await setup(f, kind);
        await cards.withGalleryLock(scope, async lock => {
            const result = await recoverInline(args(f, lock, recorded, after));
            assert.equal(result.partial, false); assert.deepEqual(result.target.imageUrls, urls);
            const rows = await lock.query('SELECT gallery_id,payload_json FROM bot_media_galleries WHERE gallery_id IN (?,?)', [parentId, quoteId]);
            for (const row of rows) assert.equal(JSON.parse(row.payload_json).partSignatures[0], cards.fingerprint(after));
        }, f.db);
        // Lost cleanup ACK: repeating the verification does not resend anything.
        await cards.withGalleryLock(scope, async lock => { await recoverInline(args(f, lock, recorded, after)); }, f.db);
    } finally { await f.db.close(); }
});
for (const kind of ['references', 'uploads']) test(`${kind} recovery accepts normalized discord.js Message objects`, { timeout: 60000 }, async () => {
    const f = await fixture(kind);
    try {
        const { Client, Message } = require('discord.js'), client = new Client({ intents: [] }); client.user = { id: bot };
        const sourceRaw = { id: mid, channel_id: cid, guild_id: gid, author: { id: bot, username: 'fixture', discriminator: '0' }, content: f.first.content,
            embeds: f.first.embeds, components: [{ type: 1, components: f.first.components[0].components.map(component => ({ type: 2, style: 2, label: 'Grid', ...component })) }],
            attachments: [...f.first.attachments.values()].map(item => ({ id: item.id, filename: item.name, url: item.url, content_type: item.contentType, size: 1 })) };
        const original = new Message(client, sourceRaw); f.first = original; f.interaction.client = client;
        const rows = await f.db.queryDatabase('SELECT gallery_id,payload_json FROM bot_media_galleries WHERE gallery_id IN (?,?)', [parentId, quoteId]);
        for (const row of rows) {
            const payload = JSON.parse(row.payload_json); payload.partSignatures[0] = cards.fingerprint(original);
            payload.firstStaticSignature = cards.fingerprint(original, true);
            await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(payload), row.gallery_id]);
        }
        const setupResult = await setup(f, kind), rawAfter = { ...sourceRaw, embeds: setupResult.after.embeds,
            components: setupResult.plan.edit.components, attachments: [...setupResult.after.attachments.values()].map(item => ({ id: item.id, filename: item.name,
                url: item.url, content_type: item.contentType, size: 1 })) };
        const after = new Message(client, rawAfter);
        await cards.withGalleryLock(scope, async lock => { await recoverInline(args(f, lock, setupResult.recorded, after)); }, f.db);
    } finally { await f.db.close(); }
});
test('invalid permissions, altered content, forged source, and unrelated attachments never update the rows', { timeout: 60000 }, async () => {
    const f = await fixture('references');
    try {
        const { after, recorded } = await setup(f, 'references');
        await cards.withGalleryLock(scope, async lock => {
            for (const extra of [{ authorize: async () => false }, { verifySource: async () => [] },
                { messages: [{ ...after, content: 'altered' }] }, { messages: [{ ...after, author: { id: uid } }] },
                { messages: [{ ...after, attachments: new Map([...after.attachments, ['8', file('8', 'extra.jpg')]]) }] }])
                await assert.rejects(recoverInline(args(f, lock, recorded, after, extra)), /GRID_RESTORE_INLINE_RECOVERY/);
            const rows = await lock.query('SELECT gallery_id,payload_json FROM bot_media_galleries WHERE gallery_id IN (?,?)', [parentId, quoteId]);
            for (const row of rows) assert.equal(JSON.parse(row.payload_json).partSignatures[0], cards.fingerprint(f.first));
        }, f.db);
    } finally { await f.db.close(); }
});
test('recovery rejects a CDN reference for the same attachment in a different channel', { timeout: 60000 }, async () => {
    const f = await fixture('uploads');
    try {
        const { after, recorded } = await setup(f, 'uploads');
        const target = recorded.steps[0].evidence.targetStart;
        const original = after.embeds[target].image.url;
        await cards.withGalleryLock(scope, async lock => {
            for (const forged of [original.replace(cid, '999999999999999999'), original.replace('cdn.discordapp.com', 'evil.example'), `${original}?width=50`]) {
                after.embeds[target].image.url = forged;
                await assert.rejects(recoverInline(args(f, lock, recorded, after)), /GRID_RESTORE_INLINE_RECOVERY/);
            }
            const rows = await lock.query('SELECT gallery_id,payload_json FROM bot_media_galleries WHERE gallery_id IN (?,?)', [parentId, quoteId]);
            for (const row of rows) assert.equal(JSON.parse(row.payload_json).partSignatures[0], cards.fingerprint(f.first));
        }, f.db);
    } finally { await f.db.close(); }
});
test('a database rollback after proof never leaves one sibling updated', { timeout: 60000 }, async () => {
    const f = await fixture('references');
    try {
        const { after, recorded } = await setup(f, 'references');
        await assert.rejects(cards.withGalleryLock(scope, async lock => {
            await recoverInline(args(f, lock, recorded, after)); throw Error('fixture rollback');
        }, f.db), /fixture rollback/);
        const rows = await f.db.queryDatabase('SELECT gallery_id,payload_json FROM bot_media_galleries WHERE gallery_id IN (?,?)', [parentId, quoteId]);
        for (const row of rows) assert.equal(JSON.parse(row.payload_json).partSignatures[0], cards.fingerprint(f.first));
        await cards.withGalleryLock(scope, async lock => { await recoverInline(args(f, lock, recorded, after)); }, f.db);
    } finally { await f.db.close(); }
});
test('shared reference recovery distinguishes current photos from a larger retained archive', { timeout: 60000 }, async () => {
    const f = await fixture('references');
    try {
        const archive = [...urls, 'https://pbs.twimg.com/media/Q2?format=jpg'];
        const changed = { ...f.quote, restoreArchive: { sourceStatusId: '202', imageUrls: archive } };
        await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(changed), quoteId]);
        const { after, recorded } = await setup(f, 'references');
        await cards.withGalleryLock(scope, async lock => {
            const result = await recoverInline(args(f, lock, recorded, after));
            assert.deepEqual(result.target.imageUrls, urls); assert.deepEqual(result.target.restoreArchive.imageUrls, archive);
        }, f.db);
    } finally { await f.db.close(); }
});
test('an upload with wrong bytes, or a message changed during final recheck, cannot be recovered', { timeout: 60000 }, async () => {
    const f = await fixture('uploads');
    try {
        const { after, recorded } = await setup(f, 'uploads');
        await cards.withGalleryLock(scope, async lock => {
            await assert.rejects(recoverInline(args(f, lock, recorded, after, { hashAttachment: async () => '0'.repeat(64) })), /GRID_RESTORE_INLINE_RECOVERY/);
            await assert.rejects(recoverInline(args(f, lock, recorded, after, { fetchCurrent: async () => ({ ...after, content: 'changed after proof' }) })), /GRID_RESTORE_INLINE_RECOVERY/);
            const rows = await lock.query('SELECT gallery_id,payload_json FROM bot_media_galleries WHERE gallery_id IN (?,?)', [parentId, quoteId]);
            for (const row of rows) assert.equal(JSON.parse(row.payload_json).partSignatures[0], cards.fingerprint(f.first));
        }, f.db);
    } finally { await f.db.close(); }
});
test('deadline or late permission loss leaves the journal and both gallery rows intact', { timeout: 60000 }, async () => {
    const f = await fixture('references');
    try {
        const { after, recorded } = await setup(f, 'references');
        await cards.withGalleryLock(scope, async lock => {
            let authorizations = 0;
            await assert.rejects(recoverInline(args(f, lock, recorded, after, { authorize: async () => ++authorizations < 3 })), /GRID_RESTORE_INLINE_RECOVERY/);
            const start = Date.now();
            await assert.rejects(recoverInline(args(f, lock, recorded, after, { deadlineAtMs: start + 40,
                fetchCurrent: async () => { await new Promise(resolve => setTimeout(resolve, 250)); return after; } })), /GRID_RESTORE_INLINE_RECOVERY|GRID_RESTORE_TIMEOUT/);
            assert.ok(Date.now() - start < 1000);
            const rows = await lock.query('SELECT gallery_id,payload_json FROM bot_media_galleries WHERE gallery_id IN (?,?)', [parentId, quoteId]);
            for (const row of rows) assert.equal(JSON.parse(row.payload_json).partSignatures[0], cards.fingerprint(f.first));
            const intents = await f.db.queryDatabaseIndependent('SELECT operation_id FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [parentId]);
            assert.equal(intents[0].operation_id, operationId);
        }, f.db);
    } finally { await f.db.close(); }
});
for (const complete of [false, true]) test(`a split parent recovers ${complete ? 'both confirmed parts' : 'the completed first part only'}`, { timeout: 60000 }, async () => {
    const f = await fixture('uploads');
    try {
        const all = Array.from({ length: 13 }, (_, i) => `https://pbs.twimg.com/media/R${i}?format=jpg`);
        const marker = file('600000000000000001', `tg-${parentId}.jpg`);
        f.first.embeds = [{ title: '親の本文', description: '親の説明', url: 'https://x.com/parent/status/101', image: { url: marker.url } },
            { title: '引用の本文', url: 'https://x.com/quote/status/202', image: { url: urls[0] } },
            { url: 'https://x.com/quote/status/202', image: { url: urls[1] } }];
        f.first.attachments = new Map([[marker.id, marker]]);
        const sig = cards.fingerprint(f.first), stat = cards.fingerprint(f.first, true);
        const rows = await f.db.queryDatabase('SELECT gallery_id,payload_json FROM bot_media_galleries WHERE gallery_id IN (?,?)', [parentId, quoteId]);
        for (const row of rows) {
            const payload = JSON.parse(row.payload_json);
            payload.firstStaticSignature = stat;
            if (row.gallery_id === parentId) Object.assign(payload, { replacePhase: 'done', sourceStatusId: '101', imageUrls: all,
                totalParts: 2, completedParts: 2, messageIds: [mid, '777777777777777777'], partSignatures: [sig, 'f'.repeat(64)], partSizes: [10, 3],
                partContainsNonImage: [false, false], partRefs: [all.slice(0, 10).map(url => ({ type: 'url', url })), all.slice(10).map(url => ({ type: 'url', url }))] });
            else { delete payload.replacePhase; Object.assign(payload, { partSignatures: [sig], embedStart: 1, embedEnd: 3,
                embedWitness: { hashes: f.first.embeds.slice(1).map(cards.embedFingerprint), attachments: [] } }); }
            await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(payload), row.gallery_id]);
        }
        const parentScope = { ...scope, galleryId: parentId }; let plan, after;
        const firstUploads = all.slice(0, 10).map((_, i) => ({ name: `restore-${operationId}-${i}.jpg`, data: Buffer.from('ffd8ff00', 'hex') }));
        await cards.withGalleryLock(parentScope, async lock => {
            const snapshot = await inline.inspect({ query: lock.query, readRows: f.db.queryDatabaseIndependent, interaction: f.interaction,
                payload: lock.payload, message: f.first, authorize: async () => true });
            plan = inline.prepareEdit(snapshot, firstUploads); after = simulate(f.first, plan);
        }, f.db);
        const expected = { content: plan.edit.content, embeds: plan.edit.embeds, components: plan.edit.components, attachments: plan.retained };
        const firstStep = { index: 0, type: 'edit', start: 0, count: 10, previousId: mid, state: complete ? 'confirmed' : 'planned', ...(complete ? { messageId: mid } : {}),
            evidence: { kind: 'inline-upload', expectedFingerprint: cards.fingerprint(expected), expectedStatic: cards.fingerprint(expected, true),
                targetStart: plan.targetStart, targetEnd: plan.targetEnd, retainedIds: plan.retained.map(v => v.id) },
            proofs: firstUploads.map(file => ({ name: file.name, sha256: sha })) };
        const laterFiles = all.slice(10).map((_, i) => file(String(730000000000000000n + BigInt(i)), `restore-${operationId}-${10 + i}.jpg`));
        const continuation = { id: '888888888888888888', channelId: cid, guildId: gid, author: { id: bot }, content: '', embeds: [], components: [],
            attachments: new Map(laterFiles.map(item => [item.id, item])) };
        const laterStep = { index: 1, type: 'send', start: 10, count: 3, previousId: mid, state: 'planned', proofs: laterFiles.map(file => ({ name: file.name, sha256: sha })) };
        const recorded = { kind: 'twitter-grid-restore', version: 1, operationId, galleryId: parentId, lockId: parentId, state: 'unknown', mode: 'here',
            sourceStatusId: '101', imageCount: 13, groupSizes: [10, 3], steps: complete ? [firstStep, laterStep] : [firstStep] };
        await f.db.queryDatabase('INSERT INTO bot_twitter_grid_action_intents (gallery_id,guild_id,channel_id,message_id,operation_id,payload_json,updated_at_ms) VALUES (?,?,?,?,?,?,?)',
            [parentId, gid, cid, mid, operationId, JSON.stringify(recorded), Date.now()]);
        const messages = complete ? [after, continuation] : [after];
        await cards.withGalleryLock(parentScope, async lock => {
            const result = await recoverInline({ lock, interaction: f.interaction, recorded, messages, authorize: async () => true,
                verifySource: async (_status, value) => value.imageUrls, hashAttachment: async () => sha,
                fetchCurrent: async id => messages.find(message => message.id === id) });
            assert.equal(result.partial, !complete); assert.equal(result.target.imageUrls.length, complete ? 13 : 10);
            assert.equal(!!result.target.restoreContinuation, !complete);
            const q = await lock.query('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=?', [quoteId]);
            assert.equal(JSON.parse(q[0].payload_json).partSignatures[0], cards.fingerprint(after));
        }, f.db);
        await cards.withGalleryLock(parentScope, async lock => {
            const result = await recoverInline({ lock, interaction: f.interaction, recorded, messages, authorize: async () => true,
                verifySource: async (_status, value) => value.imageUrls, hashAttachment: async () => sha,
                fetchCurrent: async id => messages.find(message => message.id === id) });
            assert.equal(result.partial, !complete);
        }, f.db);
    } finally { await f.db.close(); }
});

for (const complete of [true]) test('variable 4+4+5 shared parent preserves quote after partial recovery', { timeout: 60000 }, async () => {
    const f = await fixture('uploads');
    try {
        const all = Array.from({ length: 13 }, (_, i) => `https://pbs.twimg.com/media/R${i}?format=jpg`);
        const marker = file('600000000000000001', `tg-${parentId}.jpg`);
        f.first.embeds = [{ title: '親の本文', description: '親の説明', url: 'https://x.com/parent/status/101', image: { url: marker.url } },
            { title: '引用の本文', url: 'https://x.com/quote/status/202', image: { url: urls[0] } },
            { url: 'https://x.com/quote/status/202', image: { url: urls[1] } }];
        f.first.attachments = new Map([[marker.id, marker]]);
        const sig = cards.fingerprint(f.first), stat = cards.fingerprint(f.first, true);
        const rows = await f.db.queryDatabase('SELECT gallery_id,payload_json FROM bot_media_galleries WHERE gallery_id IN (?,?)', [parentId, quoteId]);
        for (const row of rows) {
            const payload = JSON.parse(row.payload_json);
            payload.firstStaticSignature = stat;
            if (row.gallery_id === parentId) Object.assign(payload, { replacePhase: 'done', sourceStatusId: '101', imageUrls: all,
                totalParts: 2, completedParts: 2, messageIds: [mid, '777777777777777777'], partSignatures: [sig, 'f'.repeat(64)], partSizes: [10, 3],
                partContainsNonImage: [false, false], partRefs: [all.slice(0, 10).map(url => ({ type: 'url', url })), all.slice(10).map(url => ({ type: 'url', url }))] });
            else { delete payload.replacePhase; Object.assign(payload, { partSignatures: [sig], embedStart: 1, embedEnd: 3,
                embedWitness: { hashes: f.first.embeds.slice(1).map(cards.embedFingerprint), attachments: [] } }); }
            await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(payload), row.gallery_id]);
        }
        const parentScope = { ...scope, galleryId: parentId }; let plan, after;
        const firstUploads = all.slice(0, 4).map((_, i) => ({ name: `restore-${operationId}-${i}.jpg`, data: Buffer.from('ffd8ff00', 'hex') }));
        await cards.withGalleryLock(parentScope, async lock => {
            const snapshot = await inline.inspect({ query: lock.query, readRows: f.db.queryDatabaseIndependent, interaction: f.interaction,
                payload: lock.payload, message: f.first, authorize: async () => true });
            plan = inline.prepareEdit(snapshot, firstUploads); after = simulate(f.first, plan);
        }, f.db);
        const expected = { content: plan.edit.content, embeds: plan.edit.embeds, components: plan.edit.components, attachments: plan.retained };
        const firstStep = { index: 0, type: 'edit', start: 0, count: 4, previousId: mid, state: complete ? 'confirmed' : 'planned', ...(complete ? { messageId: mid } : {}),
            evidence: { kind: 'inline-upload', expectedFingerprint: cards.fingerprint(expected), expectedStatic: cards.fingerprint(expected, true),
                targetStart: plan.targetStart, targetEnd: plan.targetEnd, retainedIds: plan.retained.map(v => v.id) },
            proofs: firstUploads.map(file => ({ name: file.name, sha256: sha })) };
        const laterFiles = all.slice(4, 8).map((_, i) => file(String(730000000000000000n + BigInt(i)), `restore-${operationId}-${4 + i}.jpg`));
        const continuation = { id: '888888888888888888', channelId: cid, guildId: gid, author: { id: bot }, content: '', embeds: [], components: [],
            attachments: new Map(laterFiles.map(item => [item.id, item])) };
        const laterStep = { index: 1, type: 'send', start: 4, count: 4, previousId: mid, state: 'confirmed', messageId: continuation.id, proofs: laterFiles.map(file => ({ name: file.name, sha256: sha })) };
        const recorded = { kind: 'twitter-grid-restore', version: 1, operationId, galleryId: parentId, lockId: parentId, state: 'in_progress', mode: 'here',
            sourceStatusId: '101', imageCount: 13, groupSizes: [4, 4, 5], targetCount: 13, baseOffset: 0, steps: complete ? [firstStep, laterStep] : [firstStep] };
        await f.db.queryDatabase('INSERT INTO bot_twitter_grid_action_intents (gallery_id,guild_id,channel_id,message_id,operation_id,payload_json,updated_at_ms) VALUES (?,?,?,?,?,?,?)',
            [parentId, gid, cid, mid, operationId, JSON.stringify(recorded), Date.now()]);
        const messages = complete ? [after, continuation] : [after];
        await cards.withGalleryLock(parentScope, async lock => {
            const result = await recoverInline({ lock, interaction: f.interaction, recorded, messages, authorize: async () => true,
                verifySource: async (_status, value) => value.imageUrls, hashAttachment: async () => sha,
                fetchCurrent: async id => messages.find(message => message.id === id) });
            assert.equal(result.partial, true); assert.equal(result.target.imageUrls.length, 8);
            assert.equal(result.target.restoreContinuation.nextIndex, 8);
            const q = await lock.query('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=?', [quoteId]);
            assert.equal(JSON.parse(q[0].payload_json).partSignatures[0], cards.fingerprint(after));
        }, f.db);
        await cards.withGalleryLock(parentScope, async lock => {
            const result = await recoverInline({ lock, interaction: f.interaction, recorded, messages, authorize: async () => true,
                verifySource: async (_status, value) => value.imageUrls, hashAttachment: async () => sha,
                fetchCurrent: async id => messages.find(message => message.id === id) });
            assert.equal(result.partial, true);
        }, f.db);
    } finally { await f.db.close(); }
});

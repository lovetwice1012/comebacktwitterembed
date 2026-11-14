'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createTestDatabase } = require('../lib/automation-test-db');
const schema = require('../../src/db_schema'), cards = require('../../src/twitterGridCards'), restore = require('../../src/twitterGridRestore');
const inline = require('../../src/twitterGridRestoreInline');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (![33621, 33622].includes(port)) throw Error('An explicit isolated test database port is required');
const gid = '111111111111111111', cid = '222222222222222222', bot = '333333333333333333', uid = '444444444444444444', mid = '555555555555555555';
const parentId = 'a'.repeat(32), quoteId = 'b'.repeat(32), operationId = 'c'.repeat(32);
const parentUrls = Array.from({ length: 9 }, (_, i) => `https://pbs.twimg.com/media/P${i}?format=jpg`);
const quoteUrls = ['https://pbs.twimg.com/media/Q0?format=jpg', 'https://pbs.twimg.com/media/Q1?format=jpg'];
function file(id, name, type = 'image/jpeg') { return { id, name, contentType: type, url: `https://cdn.discordapp.com/attachments/${cid}/${id}/${name}` }; }
async function fixture({ parentCombined = false, quoteCombined = true, video = false } = {}) {
    const db = await createTestDatabase(port);
    const sql = fs.readFileSync(path.join(schema.MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
    await db.queryDatabase(schema._internal.splitSqlStatements(sql).find(s => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(s)));
    const parentMarker = file('600000000000000001', `tg-${parentId}.jpg`), quoteMarker = file('600000000000000002', `tg-${quoteId}.jpg`);
    const parentFiles = parentUrls.map((_, i) => file(String(610000000000000000n + BigInt(i)), `parent${i}.jpg`));
    const attachments = [...(parentCombined ? [parentMarker] : parentFiles), ...(quoteCombined ? [quoteMarker] : []), ...(video ? [file('699999999999999999', 'clip.mp4', 'video/mp4')] : [])];
    const parent = { title: '親の本文', description: '親の説明', url: 'https://x.com/parent/status/101', ...(parentCombined ? { image: { url: parentMarker.url } } : {}) };
    const quoted = quoteCombined ? [{ title: '引用の本文', description: '引用の説明', url: 'https://x.com/quote/status/202', image: { url: quoteMarker.url } }]
        : [{ title: '引用の本文', description: '引用の説明', url: 'https://x.com/quote/status/202', image: { url: quoteUrls[0] } },
            { url: 'https://x.com/quote/status/202', image: { url: quoteUrls[1] } }];
    const first = { id: mid, channelId: cid, guildId: gid, author: { id: bot }, content: '保持する本文',
        components: [{ type: 1, components: [{ custom_id: `tg:${parentId}:0:open` }, { custom_id: `tg:${quoteId}:0:open` }] }],
        embeds: [parent, ...quoted, { title: '追加の要約', description: '消さない' }], attachments: new Map(attachments.map(item => [item.id, item])) };
    const signature = cards.fingerprint(first), staticSignature = cards.fingerprint(first, true);
    const common = { kind: 'twitter-image-grid-v1', lockId: parentId, sharedInline: true, partsState: 'complete',
        completedParts: 1, totalParts: 1, messageIds: [mid], partSignatures: [signature], firstStaticSignature: staticSignature,
        partContainsNonImage: [false], requesterId: uid };
    const parentPayload = { ...common, id: parentId, isPrimary: true, ...(parentCombined ? { replacePhase: 'done' } : {}),
        imageUrls: parentUrls, partSizes: [parentUrls.length], partRefs: [parentUrls.map(url => ({ type: 'url', url }))], embedStart: 0, embedEnd: 1,
        embedWitness: { hashes: [cards.embedFingerprint(parent)], attachments: parentCombined ? [] : parentFiles.map(v => ({ id: v.id, name: v.name })) } };
    const quotePayload = { ...common, id: quoteId, isPrimary: false, ...(quoteCombined ? { replacePhase: 'done' } : {}),
        imageUrls: quoteUrls, partSizes: [quoteUrls.length], partRefs: [quoteUrls.map(url => ({ type: 'url', url }))], embedStart: 1, embedEnd: 1 + quoted.length,
        embedWitness: { hashes: quoted.map(cards.embedFingerprint), attachments: [] } };
    for (const item of [parentPayload, quotePayload]) await db.queryDatabase('INSERT INTO bot_media_galleries (gallery_id,guild_id,channel_id,message_id,provider_id,payload_json,expires_at_ms) VALUES (?,?,?,?,?,?,?)',
        [item.id, gid, cid, mid, 'twitter', JSON.stringify(item), Date.now() + 600000]);
    const interaction = { guildId: gid, channelId: cid, attachmentSizeLimit: 25 * 1024 * 1024, user: { id: uid }, client: { user: { id: bot } } };
    return { db, first, interaction, parentPayload, quotePayload, parentFiles };
}
function simulateDiscord(first, plan) {
    const kept = [...first.attachments.values()].filter(item => plan.retained.some(entry => entry.id === item.id));
    const uploaded = plan.uploads.map((item, i) => file(String(720000000000000000n + BigInt(i)), item.name));
    const all = [...kept, ...uploaded];
    const embeds = plan.edit.embeds.map(embed => {
        const copy = JSON.parse(JSON.stringify(embed));
        if (copy.image?.url?.startsWith('attachment://')) {
            const target = all.find(item => item.name === copy.image.url.slice('attachment://'.length));
            if (target) copy.image.url = target.url;
        }
        return copy;
    });
    return { ...first, content: plan.edit.content, components: plan.edit.components, embeds, attachments: new Map(all.map(item => [item.id, item])) };
}

test('a quoted marker must reference the attachment in the same Discord channel', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const original = f.first.embeds[1].image.url;
        const inspect = () => f.db.withDatabaseTransaction(query => inline.inspect({ query, interaction: f.interaction,
            payload: f.quotePayload, message: f.first, authorize: async () => true }));
        assert.ok(await inspect());
        for (const forged of [original.replace(cid, '999999999999999999'), original.replace('cdn.discordapp.com', 'evil.example'), `${original}?width=50`]) {
            f.first.embeds[1].image.url = forged;
            await assert.rejects(inspect(), /GRID_RESTORE_INLINE_UNAVAILABLE/);
        }
    } finally { await f.db.close(); }
});
for (const outcome of ['done', 'editunknown', 'rollback']) test(`the production restoration adapter reconnects a shared quote using reference images: ${outcome}`, { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const settings = { enabled: true, button_disabled: {} };
        for (const id of [parentId, quoteId]) {
            const rows = await f.db.queryDatabase('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=?', [id]);
            const value = JSON.parse(rows[0].payload_json);
            value.settingsHash = cards.safetyHash(settings); value.nsfw = false; value.nsfwContextVersion = 1;
            await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(value), id]);
        }
        const channel = { id: cid, messages: { fetch: async query => query.limit ? new Map([[mid, { id: mid, channelId: cid }]]) : f.first } };
        f.interaction.channel = channel;
        const grid = { freshAccess: async () => ({ channel, member: {}, permissions: { has: () => true }, guild: {} }),
            currentButtonAccess: () => true, mayReplace: () => true, sourcesRemainValid: async () => true };
        let edits = 0;
        const editor = { forMessage: () => ({ edit: async value => {
            edits++;
            const retained = [...f.first.attachments.values()].filter(file => (value.attachments || []).some(item => String(item.id) === file.id));
            const uploaded = (value.files || []).map((item, i) => file(String(810000000000000000n + BigInt(i)), item.name));
            const all = [...retained, ...uploaded];
            f.first.content = value.content; f.first.components = value.components; f.first.attachments = new Map(all.map(item => [item.id, item]));
            f.first.embeds = value.embeds.map(item => { const e = JSON.parse(JSON.stringify(item)); if (e.image?.url?.startsWith('attachment://')) {
                const itemFile = all.find(file => file.name === e.image.url.slice(13)); if (itemFile) e.image.url = itemFile.url;
            } return e; });
            if (outcome === 'editunknown') throw Error('response lost');
            return f.first;
        } }) };
        const storage = { get: async id => { const rows = await f.db.queryDatabase('SELECT * FROM bot_media_galleries WHERE gallery_id=?', [id]); return rows[0] || null; } };
        const sourceDependencies = { resolvePlan: async () => ({ sources: require('../../src/adminSupport/providerSources').REGISTRY.twitter.sources }),
            fetch: async () => ({ ok: true, text: async () => JSON.stringify({ tweetID: '202', tweetURL: 'https://x.com/quote/status/202',
                author: { protected: false }, possibly_sensitive: false, mediaURLs: quoteUrls }) }) };
        if (outcome === 'rollback') {
            const transaction = f.db.withDatabaseTransaction; let failCommit = true;
            f.db.withDatabaseTransaction = work => transaction(async query => { const result = await work(query); if (failCommit) { failCommit = false; throw Error('fixture rollback'); } return result; });
        }
        const adapters = require('../../src/twitterGridRestoreAdapters').createAdapters(f.interaction, quoteId, { db: f.db, grid, storage,
            getSettings: async () => settings, sourceDependencies, editor,
            mediaDependencies: { fetchTwitterMedia: async () => ({ data: Buffer.from('ffd8ff00', 'hex'), format: 'jpeg' }) } });
        if (outcome === 'rollback') await assert.rejects(restore.executeRestore({ mode: 'here', id: quoteId }, adapters), /fixture rollback/);
        else {
            const result = await restore.executeRestore({ mode: 'here', id: quoteId }, adapters);
            assert.equal(result.status, outcome === 'editunknown' ? 'unknown' : 'done');
        }
        if (outcome !== 'done') assert.equal((await adapters.recoverOnly()).status, 'recovered');
        assert.equal(edits, 1); assert.equal(f.first.attachments.size, 9);
        assert.deepEqual(f.first.embeds.slice(1, 3).map(embed => embed.image.url), quoteUrls);
        const rows = await f.db.queryDatabase('SELECT gallery_id,payload_json FROM bot_media_galleries WHERE gallery_id IN (?,?)', [parentId, quoteId]);
        for (const row of rows) assert.equal(JSON.parse(row.payload_json).partSignatures[0], cards.fingerprint(f.first));
    } finally { await f.db.close(); }
});
for (const outcome of ['done', 'editunknown', 'editunknownbad', 'rollback']) test(`the production restoration adapter restores a 13-image parent while keeping the quoted post: ${outcome}`, { timeout: 60000 }, async () => {
    const f = await fixture({ parentCombined: true, quoteCombined: false });
    try {
        const settings = { enabled: true, button_disabled: {} }, urls = Array.from({ length: 13 }, (_, i) => `https://pbs.twimg.com/media/R${i}?format=jpg`);
        for (const id of [parentId, quoteId]) {
            const rows = await f.db.queryDatabase('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=?', [id]);
            let value = JSON.parse(rows[0].payload_json);
            value.settingsHash = cards.safetyHash(settings); value.nsfw = false; value.nsfwContextVersion = 1;
            if (id === parentId) value = { ...value, sourceStatusId: '101', imageUrls: urls, totalParts: 2, completedParts: 2,
                messageIds: [mid, '777777777777777777'], partSignatures: [cards.fingerprint(f.first), 'f'.repeat(64)], partSizes: [10, 3],
                partRefs: [urls.slice(0, 10).map(url => ({ type: 'url', url })), urls.slice(10).map(url => ({ type: 'url', url }))] };
            await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(value), id]);
        }
        let sent = null;
        const channel = { id: cid, messages: { fetch: async query => {
            if (query.around) return new Map([[mid, f.first], ...(sent ? [[sent.id, sent]] : [])]);
            if (query.limit) return new Map([[(sent || f.first).id, sent || f.first]]);
            if (query.message === mid) return f.first;
            if (sent && query.message === sent.id) return sent;
            throw { code: 10008 };
        } } };
        f.interaction.channel = channel;
        const grid = { freshAccess: async () => ({ channel, member: {}, permissions: { has: () => true }, guild: {} }),
            currentButtonAccess: () => true, mayReplace: () => true, sourcesRemainValid: async () => true };
        const editor = { forMessage: () => ({ edit: async value => {
            const retained = [...f.first.attachments.values()].filter(file => (value.attachments || []).some(item => String(item.id) === file.id));
            const uploaded = (value.files || []).map((item, i) => file(String(810000000000000000n + BigInt(i)), item.name));
            const all = [...retained, ...uploaded];
            f.first.content = value.content; f.first.components = value.components; f.first.attachments = new Map(all.map(item => [item.id, item]));
            f.first.embeds = value.embeds.map(item => { const e = JSON.parse(JSON.stringify(item)); if (e.image?.url?.startsWith('attachment://')) {
                const itemFile = all.find(file => file.name === e.image.url.slice(13)); if (itemFile) e.image.url = itemFile.url;
            } return e; });
            if (outcome.startsWith('editunknown')) throw Error('response lost');
            return f.first;
        } }) };
        const sender = { forMessage: () => ({ send: async value => {
            const uploaded = value.files.map((item, i) => file(String(820000000000000000n + BigInt(i)), item.name));
            sent = { id: '888888888888888888', channelId: cid, author: { id: bot }, content: '', embeds: [], components: [], attachments: new Map(uploaded.map(item => [item.id, item])) };
            return sent;
        } }) };
        const storage = { get: async id => { const rows = await f.db.queryDatabase('SELECT * FROM bot_media_galleries WHERE gallery_id=?', [id]); return rows[0] || null; } };
        const sourceDependencies = { resolvePlan: async () => ({ sources: require('../../src/adminSupport/providerSources').REGISTRY.twitter.sources }),
            fetch: async () => ({ ok: true, text: async () => JSON.stringify({ tweetID: '101', tweetURL: 'https://x.com/parent/status/101',
                author: { protected: false }, possibly_sensitive: false, mediaURLs: urls }) }) };
        if (outcome === 'rollback') {
            const transaction = f.db.withDatabaseTransaction; let failCommit = true;
            f.db.withDatabaseTransaction = work => transaction(async query => { const result = await work(query); if (failCommit) { failCommit = false; throw Error('fixture rollback'); } return result; });
        }
        const hash = require('node:crypto').createHash('sha256').update(Buffer.from('ffd8ff00', 'hex')).digest('hex');
        let wrongHash = outcome === 'editunknownbad';
        const adapterDeps = { db: f.db, grid, storage, getSettings: async () => settings, sourceDependencies, editor, sender,
            recoveryDependencies: { hashAttachment: async () => wrongHash ? '0'.repeat(64) : hash },
            mediaDependencies: { fetchTwitterMedia: async () => ({ data: Buffer.from('ffd8ff00', 'hex'), format: 'jpeg' }) } };
        const adapters = require('../../src/twitterGridRestoreAdapters').createAdapters(f.interaction, parentId, adapterDeps);
        if (outcome === 'rollback') await assert.rejects(restore.executeRestore({ mode: 'here', id: parentId }, adapters), /fixture rollback/);
        else {
            const result = await restore.executeRestore({ mode: 'here', id: parentId }, adapters);
            assert.equal(result.status, outcome.startsWith('editunknown') ? 'unknown' : 'done');
        }
        if (outcome !== 'done') {
            if (outcome === 'editunknownbad') {
                await assert.rejects(adapters.recoverOnly(), /GRID_RESTORE_INLINE_RECOVERY/);
                assert.equal((await f.db.queryDatabase('SELECT * FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [parentId])).length, 1);
                wrongHash = false;
            }
            assert.equal((await adapters.recoverOnly()).status, 'recovered');
            if (outcome.startsWith('editunknown')) {
                const resumed = require('../../src/twitterGridRestoreAdapters').createAdapters(f.interaction, parentId, adapterDeps);
                assert.deepEqual(await restore.executeRestore({ mode: 'resume', id: parentId }, resumed), { status: 'done', completed: 1 });
            }
        }
        assert.equal(f.first.attachments.size, 10); assert.equal(sent.attachments.size, 3);
        assert.deepEqual(f.first.embeds.slice(1, 3).map(embed => embed.image.url), quoteUrls);
        const rows = await f.db.queryDatabase('SELECT gallery_id,payload_json FROM bot_media_galleries WHERE gallery_id IN (?,?)', [parentId, quoteId]);
        for (const row of rows) assert.equal(JSON.parse(row.payload_json).partSignatures[0], cards.fingerprint(f.first));
    } finally { await f.db.close(); }
});
for (const choice of ['here', 'new']) test(`when a shared post has limited room, the adapter preserves all images: ${choice}`, { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        for (let i = 0; i < 7; i++) f.first.embeds.push({ title: `他の要約 ${i}`, description: '保持する' });
        const settings = { enabled: true, button_disabled: {} }, before = cards.fingerprint(f.first), beforeStatic = cards.fingerprint(f.first, true);
        for (const id of [parentId, quoteId]) {
            const rows = await f.db.queryDatabase('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=?', [id]);
            const value = JSON.parse(rows[0].payload_json);
            value.settingsHash = cards.safetyHash(settings); value.nsfw = false; value.nsfwContextVersion = 1;
            value.partSignatures[0] = before; value.firstStaticSignature = beforeStatic;
            await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(value), id]);
        }
        let sent = null;
        const channel = { id: cid, messages: { fetch: async query => {
            if (query.around) return new Map([[mid, f.first], ...(sent ? [[sent.id, sent]] : [])]);
            if (query.limit) return new Map([[(sent || f.first).id, sent || f.first]]);
            return query.message === mid ? f.first : sent;
        } } };
        f.interaction.channel = channel;
        const grid = { freshAccess: async () => ({ channel, member: {}, permissions: { has: () => true }, guild: {} }),
            currentButtonAccess: () => true, mayReplace: () => true, sourcesRemainValid: async () => true };
        const sender = { forMessage: () => ({ send: async value => {
            const uploaded = value.files.map((item, i) => file(String(820000000000000000n + BigInt(i)), item.name));
            sent = { id: '888888888888888888', channelId: cid, author: { id: bot }, content: value.content || '', embeds: value.embeds || [],
                components: value.components || [], attachments: new Map(uploaded.map(item => [item.id, item])) };
            return sent;
        } }) };
        const editor = { forMessage: () => ({ edit: async value => {
            const retained = [...f.first.attachments.values()].filter(file => (value.attachments || []).some(item => String(item.id) === file.id));
            const uploaded = (value.files || []).map((item, i) => file(String(810000000000000000n + BigInt(i)), item.name));
            const all = [...retained, ...uploaded];
            f.first.content = value.content; f.first.components = value.components; f.first.attachments = new Map(all.map(item => [item.id, item]));
            f.first.embeds = value.embeds.map(item => { const e = JSON.parse(JSON.stringify(item)); if (e.image?.url?.startsWith('attachment://')) {
                const itemFile = all.find(file => file.name === e.image.url.slice(13)); if (itemFile) e.image.url = itemFile.url;
            } return e; });
            return f.first;
        } }) };
        const storage = { get: async id => { const rows = await f.db.queryDatabase('SELECT * FROM bot_media_galleries WHERE gallery_id=?', [id]); return rows[0] || null; } };
        const sourceDependencies = { resolvePlan: async () => ({ sources: require('../../src/adminSupport/providerSources').REGISTRY.twitter.sources }),
            fetch: async () => ({ ok: true, text: async () => JSON.stringify({ tweetID: '202', tweetURL: 'https://x.com/quote/status/202',
                author: { protected: false }, possibly_sensitive: false, mediaURLs: quoteUrls }) }) };
        const adapters = require('../../src/twitterGridRestoreAdapters').createAdapters(f.interaction, quoteId, { db: f.db, grid, storage,
            getSettings: async () => settings, sourceDependencies, sender, editor,
            mediaDependencies: { fetchTwitterMedia: async () => ({ data: Buffer.from('ffd8ff00', 'hex'), format: 'jpeg' }) } });
        assert.deepEqual(await adapters.inPlaceAvailable(), { status: 'ok', separateOnly: false, rootCapacity: 1 });
        assert.deepEqual(await restore.executeRestore({ mode: choice, id: quoteId }, adapters), { status: 'done', completed: choice === 'here' ? 2 : 1 });
        if (choice === 'new') {
            assert.equal(cards.fingerprint(f.first), before); assert.equal(sent.attachments.size, 2);
            const rows = await f.db.queryDatabase('SELECT gallery_id,payload_json FROM bot_media_galleries WHERE gallery_id NOT IN (?,?)', [parentId, quoteId]);
            assert.equal(rows.length, 1); const created = JSON.parse(rows[0].payload_json);
            assert.deepEqual(created.imageUrls, quoteUrls); assert.equal(created.partsState, 'complete');
            assert.equal(cards.gridIdFromMessage(sent), created.id);
        } else {
            assert.equal(sent.attachments.size, 1); assert.equal(f.first.attachments.size, 10);
            const rows = await f.db.queryDatabase('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=?', [quoteId]);
            const saved = JSON.parse(rows[0].payload_json);
            assert.deepEqual(saved.imageUrls, quoteUrls); assert.deepEqual(saved.partSizes, [1, 1]);
        }
    } finally { await f.db.close(); }
});
test('two shared posts can create separate restore records without cross-post range-lock deadlock', { timeout: 60000 }, async () => {
    const f = await fixture({ parentCombined: true, quoteCombined: true });
    try {
        const parentB = 'c'.repeat(32), quoteB = 'd'.repeat(32), midB = '555555555555555556';
        const parentMarker = file('830000000000000001', `tg-${parentB}.jpg`), quoteMarker = file('830000000000000002', `tg-${quoteB}.jpg`);
        const second = { ...f.first, id: midB, embeds: f.first.embeds.map((embed, i) => i === 0 ? { ...embed, image: { url: parentMarker.url } }
            : i === 1 ? { ...embed, image: { url: quoteMarker.url } } : { ...embed }),
        attachments: new Map([[parentMarker.id, parentMarker], [quoteMarker.id, quoteMarker]]) };
        for (const [original, id] of [[f.parentPayload, parentB], [f.quotePayload, quoteB]]) {
            const value = { ...original, id, lockId: parentB, messageIds: [midB], partSignatures: [cards.fingerprint(second)], firstStaticSignature: cards.fingerprint(second, true) };
            await f.db.queryDatabase('INSERT INTO bot_media_galleries (gallery_id,guild_id,channel_id,message_id,provider_id,payload_json,expires_at_ms) VALUES (?,?,?,?,?,?,?)',
                [id, gid, cid, midB, 'twitter', JSON.stringify(value), Date.now() + 600000]);
        }
        let release, count = 0, notify; const gate = new Promise(resolve => { release = resolve; }), both = new Promise(resolve => { notify = resolve; });
        const task = (id, message, messageId, newId) => cards.withGalleryLock({ galleryId: id, guildId: gid, channelId: cid, messageId }, async lock => {
            await inline.inspect({ query: lock.query, readRows: f.db.queryDatabaseIndependent, interaction: f.interaction, payload: lock.payload, message, authorize: async () => true });
            if (++count === 2) notify(); await gate;
            return f.db.queryDatabaseIndependent('INSERT INTO bot_media_galleries (gallery_id,guild_id,channel_id,provider_id,payload_json,expires_at_ms) VALUES (?,?,?,?,?,?)',
                [newId, gid, cid, 'twitter', '{}', Date.now() + 600000]);
        }, f.db);
        const one = task(quoteId, f.first, mid, 'e'.repeat(32)), two = task(quoteB, second, midB, 'f'.repeat(32));
        await both; release(); let timer;
        try { await Promise.race([Promise.all([one, two]), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('cross-post lock timeout')), 5000); })]); }
        finally { clearTimeout(timer); }
    } finally { await f.db.close(); }
});
for (const choice of ['first', 'rest', 'here', 'rest10']) test(`a capacity-limited parent preserves selected photos and quote: ${choice}`, { timeout: 60000 }, async () => {
    const f = await fixture({ parentCombined: true, quoteCombined: true });
    try {
        for (let i = 0; i < 7; i++) f.first.embeds.push({ title: `他の要約 ${i}`, description: '保持する' });
        const settings = { enabled: true, button_disabled: {} }, urls = Array.from({ length: choice === 'rest10' ? 10 : 13 }, (_, i) => `https://pbs.twimg.com/media/R${i}?format=jpg`);
        for (const id of [parentId, quoteId]) {
            const rows = await f.db.queryDatabase('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=?', [id]);
            let value = JSON.parse(rows[0].payload_json);
            value.settingsHash = cards.safetyHash(settings); value.nsfw = false; value.nsfwContextVersion = 1;
            value.partSignatures[0] = cards.fingerprint(f.first); value.firstStaticSignature = cards.fingerprint(f.first, true);
            if (id === parentId) value = { ...value, sourceStatusId: '101', imageUrls: urls, totalParts: 2, completedParts: 2,
                messageIds: [mid, '777777777777777777'], partSignatures: [cards.fingerprint(f.first), 'f'.repeat(64)], partSizes: [10, 3],
                partRefs: [urls.slice(0, 10).map(url => ({ type: 'url', url })), urls.slice(10).map(url => ({ type: 'url', url }))] };
            await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(value), id]);
        }
        let sent = null, edits = 0, sends = 0, latestId = choice === 'here' ? mid : '999999999999999999'; const history = new Map();
        const channel = { id: cid, messages: { fetch: async query => {
            if (query.around) return new Map([[mid, f.first], ...history]);
            if (query.limit) return new Map([[latestId, { id: latestId, channelId: cid }]]);
            return query.message === mid ? f.first : history.get(query.message);
        } } };
        f.interaction.channel = channel;
        const grid = { freshAccess: async () => ({ channel, member: {}, permissions: { has: () => true }, guild: {} }),
            currentButtonAccess: () => true, mayReplace: () => true, sourcesRemainValid: async () => true };
        const editor = { forMessage: () => ({ edit: async value => {
            edits++; const retained = [...f.first.attachments.values()].filter(file => (value.attachments || []).some(item => String(item.id) === file.id));
            const uploaded = (value.files || []).map((item, i) => file(String(810000000000000000n + BigInt(i)), item.name));
            const all = [...retained, ...uploaded];
            f.first.content = value.content; f.first.components = value.components; f.first.attachments = new Map(all.map(item => [item.id, item]));
            f.first.embeds = value.embeds.map(item => { const e = JSON.parse(JSON.stringify(item)); if (e.image?.url?.startsWith('attachment://')) {
                const itemFile = all.find(file => file.name === e.image.url.slice(13)); if (itemFile) e.image.url = itemFile.url;
            } return e; }); return f.first;
        } }) };
        const sender = { forMessage: () => ({ send: async value => {
            sends++; const uploaded = value.files.map((item, i) => file(String(820000000000000000n + BigInt(sends * 100 + i)), item.name));
            sent = { id: String(888888888888888887n + BigInt(sends)), channelId: cid, author: { id: bot }, content: '', embeds: [], components: [], attachments: new Map(uploaded.map(item => [item.id, item])) };
            latestId = sent.id; history.set(sent.id, sent); return sent;
        } }) };
        const storage = { get: async id => { const rows = await f.db.queryDatabase('SELECT * FROM bot_media_galleries WHERE gallery_id=?', [id]); return rows[0] || null; } };
        const sourceDependencies = { resolvePlan: async () => ({ sources: require('../../src/adminSupport/providerSources').REGISTRY.twitter.sources }),
            fetch: async () => ({ ok: true, text: async () => JSON.stringify({ tweetID: '101', tweetURL: 'https://x.com/parent/status/101',
                author: { protected: false }, possibly_sensitive: false, mediaURLs: urls }) }) };
        const adapters = require('../../src/twitterGridRestoreAdapters').createAdapters(f.interaction, parentId, { db: f.db, grid, storage,
            getSettings: async () => settings, sourceDependencies, editor, sender,
            mediaDependencies: { fetchTwitterMedia: async () => ({ data: Buffer.from('ffd8ff00', 'hex'), format: 'jpeg' }) } });
        assert.deepEqual(await adapters.inPlaceAvailable(), { status: 'ok', separateOnly: false, rootCapacity: 9 });
        let operationResult = await restore.executeRestore({ mode: choice === 'rest10' ? 'rest' : choice, id: parentId }, adapters);
        if (choice === 'first') {
            assert.equal(operationResult.status, 'confirm_split'); assert.deepEqual(operationResult.sizes, [9, 1]); assert.equal(edits, 0); assert.equal(sends, 0);
            operationResult = await restore.executeRestore({ mode: 'first', id: parentId, confirmedPlan: operationResult.planDigest }, adapters);
        }
        assert.deepEqual(operationResult, { status: 'done', completed: ['first', 'rest10'].includes(choice) ? 2 : 3 });
        const rows = await f.db.queryDatabase('SELECT gallery_id,payload_json FROM bot_media_galleries WHERE gallery_id IN (?,?)', [parentId, quoteId]);
        const result = new Map(rows.map(row => [row.gallery_id, JSON.parse(row.payload_json)]));
        assert.deepEqual(result.get(parentId).imageUrls, choice === 'first' ? urls.slice(0, 10) : urls); assert.deepEqual(result.get(parentId).partSizes, ['first', 'rest10'].includes(choice) ? [9, 1] : [9, 1, 3]);
        if (choice === 'first') { assert.equal(result.get(parentId).restoreContinuation.nextIndex, 10); assert.equal(result.get(parentId).restoreContinuation.targetCount, 13); }
        else assert.equal(result.get(parentId).restoreContinuation, undefined);
        assert.equal(result.get(quoteId).partSignatures[0], cards.fingerprint(f.first));
        assert.ok([...f.first.attachments.values()].some(item => item.name === `tg-${quoteId}.jpg`)); assert.equal(sends, ['first', 'rest10'].includes(choice) ? 1 : 2);
    } finally { await f.db.close(); }
});
async function locked(f, id, fn) {
    return cards.withGalleryLock({ galleryId: id, guildId: gid, channelId: cid, messageId: mid }, fn, f.db);
}
test('quoted photos restore as verified X references while nine parent attachments and text survive', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        await locked(f, quoteId, async lock => {
            const snapshot = await inline.inspect({ query: lock.query, interaction: f.interaction, payload: lock.payload, message: f.first, authorize: async () => true });
            const room = inline.capacity(snapshot, quoteUrls.length);
            assert.equal(room.attachmentSlots, 1); assert.equal(room.inlineReferenceMax, 8); assert.equal(room.requiresSeparateMessages, false);
            assert.equal(inline.capacity(snapshot, 20).requiresSeparateMessages, true);
            const plan = await inline.prepareReferenceEdit(snapshot, quoteUrls, async (_payload, urls) => urls);
            const after = simulateDiscord(f.first, plan), targetPayload = inline.referenceManifest(snapshot, plan, after);
            await inline.commit({ query: lock.query, interaction: f.interaction, snapshot, plan, message: after, targetPayload, authorize: async () => true });
            assert.equal(after.attachments.size, 9); assert.equal(after.embeds[0].description, '親の説明');
            assert.ok(after.embeds.some(embed => embed.title === '追加の要約' && embed.description === '消さない'));
            assert.deepEqual(after.embeds.slice(1, 3).map(embed => embed.image.url), quoteUrls);
            const rows = await lock.query('SELECT gallery_id,payload_json FROM bot_media_galleries WHERE gallery_id IN (?,?)', [parentId, quoteId]);
            const groups = new Map(rows.map(row => [row.gallery_id, JSON.parse(row.payload_json)]));
            assert.equal(groups.get(parentId).partSignatures[0], cards.fingerprint(after));
            assert.equal(groups.get(quoteId).partSignatures[0], cards.fingerprint(after));
            assert.equal(groups.get(quoteId).embedStart, 1); assert.equal(groups.get(quoteId).embedEnd, 3);
            assert.ok(require('../../src/components/twitterGrid')._internal.embedWitnessPosition(after, groups.get(parentId).embedWitness));
            assert.ok(require('../../src/components/twitterGrid')._internal.embedWitnessPosition(after, groups.get(quoteId).embedWitness));
        });
    } finally { await f.db.close(); }
});
test('Discord.js Message and component normalization preserve the unchanged siblings', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const { Client, Message } = require('discord.js'), client = new Client({ intents: [] }); client.user = { id: bot };
        const raw = { id: mid, channel_id: cid, guild_id: gid, author: { id: bot, username: 'fixture', discriminator: '0' }, content: f.first.content,
            embeds: f.first.embeds, components: [{ type: 1, components: f.first.components[0].components.map(component => ({ type: 2, style: 2, label: 'Grid', ...component })) }],
            attachments: [...f.first.attachments.values()].map(item => ({ id: item.id, filename: item.name, url: item.url, content_type: item.contentType, size: 1 })) };
        const original = new Message(client, raw), sig = cards.fingerprint(original), staticSig = cards.fingerprint(original, true);
        for (const payload of [f.parentPayload, f.quotePayload]) {
            payload.partSignatures[0] = sig; payload.firstStaticSignature = staticSig;
            await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(payload), payload.id]);
        }
        await locked(f, quoteId, async lock => {
            const snapshot = await inline.inspect({ query: lock.query, interaction: { ...f.interaction, client }, payload: lock.payload, message: original, authorize: async () => true });
            const plan = await inline.prepareReferenceEdit(snapshot, quoteUrls, async (_payload, urls) => urls);
            const kept = raw.attachments.filter(item => plan.retained.some(entry => entry.id === item.id));
            const after = new Message(client, { ...raw, embeds: plan.edit.embeds, components: plan.edit.components, attachments: kept });
            const targetPayload = inline.referenceManifest(snapshot, plan, after);
            await inline.commit({ query: lock.query, interaction: { ...f.interaction, client }, snapshot, plan, message: after, targetPayload, authorize: async () => true });
            assert.equal(after.attachments.size, 9); assert.equal(after.embeds[0].description, '親の説明');
        });
    } finally { await f.db.close(); }
});
test('restoring parent uploads preserves an uncombined quote, its witness, and other attachments', { timeout: 60000 }, async () => {
    const f = await fixture({ parentCombined: true, quoteCombined: false, video: true });
    try {
        await locked(f, parentId, async lock => {
            const snapshot = await inline.inspect({ query: lock.query, interaction: f.interaction, payload: lock.payload, message: f.first, authorize: async () => true });
            const uploads = parentUrls.map((_, i) => ({ name: `restore-${operationId}-${i}.jpg`, data: Buffer.from('ffd8ff00', 'hex') }));
            const plan = inline.prepareEdit(snapshot, uploads), after = simulateDiscord(f.first, plan);
            const targetPayload = restore.restoredManifest(lock.payload, operationId, 'here', [after], parentUrls, '101');
            await inline.commit({ query: lock.query, interaction: f.interaction, snapshot, plan, message: after, targetPayload, authorize: async () => true });
            assert.equal(after.attachments.size, 10); assert.ok([...after.attachments.values()].some(item => item.name === 'clip.mp4'));
            assert.equal(after.embeds[1].description, '引用の説明'); assert.deepEqual(after.embeds.slice(1, 3).map(embed => embed.image.url), quoteUrls);
            const rows = await lock.query('SELECT gallery_id,payload_json FROM bot_media_galleries WHERE gallery_id IN (?,?)', [parentId, quoteId]);
            const groups = new Map(rows.map(row => [row.gallery_id, JSON.parse(row.payload_json)]));
            assert.equal(groups.get(quoteId).partSignatures[0], cards.fingerprint(after));
            assert.ok(require('../../src/components/twitterGrid')._internal.embedWitnessPosition(after, groups.get(quoteId).embedWitness));
        });
    } finally { await f.db.close(); }
});
test('restoring a quote leaves an already-combined parent marker and gallery independently valid', { timeout: 60000 }, async () => {
    const f = await fixture({ parentCombined: true, quoteCombined: true });
    try {
        await locked(f, quoteId, async lock => {
            const snapshot = await inline.inspect({ query: lock.query, interaction: f.interaction, payload: lock.payload, message: f.first, authorize: async () => true });
            const plan = await inline.prepareReferenceEdit(snapshot, quoteUrls, async (_payload, urls) => urls), after = simulateDiscord(f.first, plan);
            const targetPayload = inline.referenceManifest(snapshot, plan, after);
            await inline.commit({ query: lock.query, interaction: f.interaction, snapshot, plan, message: after, targetPayload, authorize: async () => true });
            assert.ok([...after.attachments.values()].some(item => item.name === `tg-${parentId}.jpg`));
            assert.equal(after.embeds[0].title, '親の本文');
            const rows = await lock.query('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=?', [parentId]);
            const parent = JSON.parse(rows[0].payload_json);
            assert.equal(parent.replacePhase, 'done'); assert.equal(parent.partSignatures[0], cards.fingerprint(after));
            assert.equal(parent.firstStaticSignature, cards.fingerprint(after, true));
        });
    } finally { await f.db.close(); }
});
test('reference restoration requires the exact approved source and respects Discord capacity', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        await locked(f, quoteId, async lock => {
            const snapshot = await inline.inspect({ query: lock.query, interaction: f.interaction, payload: lock.payload, message: f.first, authorize: async () => true });
            await assert.rejects(inline.prepareReferenceEdit(snapshot, quoteUrls, async () => null), /GRID_RESTORE_INLINE_UNAVAILABLE/);
            await assert.rejects(inline.prepareReferenceEdit(snapshot, [quoteUrls[1], quoteUrls[0]], async (_payload, urls) => urls), /GRID_RESTORE_INLINE_UNAVAILABLE/);
            assert.throws(() => inline.prepareEdit(snapshot, quoteUrls.map((_, i) => ({ name: `restore-${operationId}-${i}.jpg`, data: Buffer.from('a') }))), /GRID_RESTORE_INLINE_UNAVAILABLE/);
        });
    } finally { await f.db.close(); }
});
test('foreign authors, revoked permissions, duplicate markers and video embeds fail closed', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        await locked(f, quoteId, async lock => {
            const call = (message, authorize = async () => true) => inline.inspect({ query: lock.query, interaction: f.interaction, payload: lock.payload, message, authorize });
            await assert.rejects(call({ ...f.first, author: { id: uid } }), /GRID_RESTORE_INLINE_UNAVAILABLE/);
            await assert.rejects(call(f.first, async () => false), /GRID_RESTORE_INLINE_UNAVAILABLE/);
            const dup = { ...f.first, embeds: [...f.first.embeds, f.first.embeds[1]] };
            await assert.rejects(call(dup), /GRID_RESTORE_INLINE_UNAVAILABLE/);
            const bad = { ...f.first, embeds: [{ ...f.first.embeds[0], video: { url: 'https://video.invalid/a.mp4' } }, ...f.first.embeds.slice(1)] };
            await assert.rejects(call(bad), /GRID_RESTORE_INLINE_UNAVAILABLE/);
            await assert.rejects(inline.inspect({ query: lock.query, interaction: { ...f.interaction, client: {} }, payload: lock.payload,
                message: { ...f.first, author: {} }, authorize: async () => true }), /GRID_RESTORE_INLINE_UNAVAILABLE/);
        });
    } finally { await f.db.close(); }
});
test('an old sibling without a provable witness is never rewritten', { timeout: 60000 }, async () => {
    const f = await fixture({ video: true });
    try {
        const parent = { ...f.parentPayload, embedWitness: null };
        await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(parent), parentId]);
        await assert.rejects(locked(f, quoteId, async lock => inline.inspect({ query: lock.query, interaction: f.interaction,
            payload: lock.payload, message: f.first, authorize: async () => true })), /GRID_RESTORE_INLINE_UNAVAILABLE/);
    } finally { await f.db.close(); }
});
test('changed source or unexpected attachments abort both sibling updates', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        await locked(f, quoteId, async lock => {
            const snapshot = await inline.inspect({ query: lock.query, interaction: f.interaction, payload: lock.payload, message: f.first, authorize: async () => true });
            const plan = await inline.prepareReferenceEdit(snapshot, quoteUrls, async (_payload, urls) => urls), after = simulateDiscord(f.first, plan);
            const targetPayload = inline.referenceManifest(snapshot, plan, after);
            after.embeds[0].description = 'changed parent';
            await assert.rejects(inline.commit({ query: lock.query, interaction: f.interaction, snapshot, plan, message: after, targetPayload, authorize: async () => true }), /GRID_RESTORE_INLINE_UNAVAILABLE/);
            const rows = await lock.query('SELECT gallery_id,payload_json FROM bot_media_galleries WHERE gallery_id IN (?,?)', [parentId, quoteId]);
            for (const row of rows) assert.equal(JSON.parse(row.payload_json).partSignatures[0], cards.fingerprint(f.first));
        });
    } finally { await f.db.close(); }
});
test('a failure after the first sibling write rolls back every gallery row', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        await assert.rejects(locked(f, quoteId, async lock => {
            const snapshot = await inline.inspect({ query: lock.query, interaction: f.interaction, payload: lock.payload, message: f.first, authorize: async () => true });
            const plan = await inline.prepareReferenceEdit(snapshot, quoteUrls, async (_payload, urls) => urls), after = simulateDiscord(f.first, plan);
            const targetPayload = inline.referenceManifest(snapshot, plan, after); let writes = 0;
            const query = async (sql, args) => /^UPDATE bot_media_galleries/.test(sql) && ++writes === 2 ? { affectedRows: 0 } : lock.query(sql, args);
            await inline.commit({ query, interaction: f.interaction, snapshot, plan, message: after, targetPayload, authorize: async () => true });
        }), /GRID_RECORD_CONFLICT/);
        const rows = await f.db.queryDatabase('SELECT gallery_id,payload_json FROM bot_media_galleries WHERE gallery_id IN (?,?)', [parentId, quoteId]);
        for (const row of rows) assert.equal(JSON.parse(row.payload_json).partSignatures[0], cards.fingerprint(f.first));
    } finally { await f.db.close(); }
});
test('concurrent restoration is serialized and the second cannot reuse the removed marker', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        let live = f.first, release, entered; const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
        const first = locked(f, quoteId, async lock => {
            const snapshot = await inline.inspect({ query: lock.query, interaction: f.interaction, payload: lock.payload, message: live, authorize: async () => true });
            const plan = await inline.prepareReferenceEdit(snapshot, quoteUrls, async (_payload, urls) => urls), after = simulateDiscord(live, plan);
            const targetPayload = inline.referenceManifest(snapshot, plan, after); entered(); await gate;
            await inline.commit({ query: lock.query, interaction: f.interaction, snapshot, plan, message: after, targetPayload, authorize: async () => true }); live = after;
        });
        await ready;
        const second = locked(f, quoteId, async lock => inline.inspect({ query: lock.query, interaction: f.interaction, payload: lock.payload, message: live, authorize: async () => true }));
        release(); await first;
        await assert.rejects(second, /GRID_RESTORE_INLINE_UNAVAILABLE/);
    } finally { await f.db.close(); }
});
test('a partially restored parent resumes remaining photos without changing its quote or sibling witness', { timeout: 60000 }, async () => {
    const f = await fixture({ parentCombined: true, quoteCombined: false });
    try {
        const all = Array.from({ length: 13 }, (_, i) => `https://pbs.twimg.com/media/R${i}?format=jpg`);
        const parent = { ...f.parentPayload, imageUrls: all, totalParts: 2, completedParts: 2,
            messageIds: [mid, '777777777777777777'], partSignatures: [cards.fingerprint(f.first), 'f'.repeat(64)], partSizes: [10, 3],
            partContainsNonImage: [false, false], partRefs: [all.slice(0, 10).map(url => ({ type: 'url', url })), all.slice(10).map(url => ({ type: 'url', url }))] };
        await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(parent), parentId]);
        let first;
        await locked(f, parentId, async lock => {
            const snapshot = await inline.inspect({ query: lock.query, interaction: f.interaction, payload: lock.payload, message: f.first, authorize: async () => true });
            const uploads = all.slice(0, 10).map((_, i) => ({ name: `restore-${operationId}-${i}.jpg`, data: Buffer.from('ffd8ff00', 'hex') }));
            const plan = inline.prepareEdit(snapshot, uploads); first = simulateDiscord(f.first, plan);
            const targetPayload = restore.restoredManifest(lock.payload, operationId, 'first', [first], all, '101');
            targetPayload.restoreContinuation = { sourceStatusId: '101', nextIndex: 10 };
            await inline.commit({ query: lock.query, interaction: f.interaction, snapshot, plan, message: first, targetPayload, authorize: async () => true });
        });
        await locked(f, parentId, async lock => {
            const snapshot = await inline.inspectPartial({ query: lock.query, interaction: f.interaction, payload: lock.payload, message: first, authorize: async () => true });
            const resumeId = 'd'.repeat(32), uploads = all.slice(10).map((_, i) => ({ name: `restore-${resumeId}-${10 + i}.jpg` }));
            const actual = uploads.map((item, i) => file(String(730000000000000000n + BigInt(i)), item.name));
            const continuation = { id: '888888888888888888', channelId: cid, guildId: gid, author: { id: bot }, content: '', embeds: [], components: [],
                attachments: new Map(actual.map(item => [item.id, item])) };
            for (const altered of [{ content: 'unrelated' }, { embeds: [{ title: 'unrelated' }] }, { components: [{ type: 1, components: [] }] }]) {
                await assert.rejects(inline.commitResume({ query: lock.query, interaction: f.interaction, snapshot, first, continuation: { ...continuation, ...altered },
                    operationId: resumeId, uploads, authorize: async () => true }), /GRID_RESTORE_INLINE_UNAVAILABLE/);
            }
            const changed = { ...first, embeds: [{ ...first.embeds[0], description: 'changed' }, ...first.embeds.slice(1)] };
            await assert.rejects(inline.commitResume({ query: lock.query, interaction: f.interaction, snapshot, first: changed, continuation,
                operationId: resumeId, uploads, authorize: async () => true }), /GRID_RESTORE_INLINE_UNAVAILABLE/);
            const next = await inline.commitResume({ query: lock.query, interaction: f.interaction, snapshot, first, continuation,
                operationId: resumeId, uploads, authorize: async () => true });
            assert.deepEqual(next.imageUrls, all); assert.equal(next.restoreContinuation, undefined);
            assert.equal(first.embeds[1].description, '引用の説明');
            const rows = await lock.query('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=?', [quoteId]);
            assert.equal(JSON.parse(rows[0].payload_json).partSignatures[0], cards.fingerprint(first));
        });
    } finally { await f.db.close(); }
});

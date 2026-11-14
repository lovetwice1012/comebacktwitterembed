'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createTestDatabase } = require('../lib/automation-test-db');
const schema = require('../../src/db_schema'), cards = require('../../src/twitterGridCards');
const grid = require('../../src/components/twitterGrid'), restore = require('../../src/twitterGridRestore');
const { createAdapters } = require('../../src/twitterGridRestoreAdapters');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (![33621, 33622].includes(port)) throw Error('An explicit isolated test database port is required');
const gid = '111111111111111111', cid = '222222222222222222', bot = '333333333333333333', uid = '444444444444444444';
const mid = '555555555555555555', tail = '777777777777777777', galleryId = 'a'.repeat(32), statusId = '1234567890123456789';
const urls = Array.from({ length: 13 }, (_, i) => `https://pbs.twimg.com/media/P${i}?format=jpg`);
const marker = `tg-${galleryId}.jpg`;
function file(id, name) { return { id, name, contentType: 'image/jpeg', url: `https://cdn.discordapp.com/attachments/${cid}/${id}/${name}` }; }
async function fixture() {
    const db = await createTestDatabase(port), migration = fs.readFileSync(path.join(schema.MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
    await db.queryDatabase(schema._internal.splitSqlStatements(migration).find(sql => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(sql)));
    await db.queryDatabase(fs.readFileSync(path.join(schema.MIGRATIONS_DIR, '20261113_add_twitter_grid_action_intents.sql'), 'utf8'));
    let next = 660000000000000000n, originalEdits = 0, restoreEdits = 0, uncertain = false;
    const first = { id: mid, channelId: cid, guildId: gid, author: { id: bot }, content: '', components: [],
        embeds: [{ title: '投稿', url: `https://x.com/example/status/${statusId}`, image: { url: `https://cdn.discordapp.com/attachments/${cid}/600000000000000001/${marker}` } }],
        attachments: new Map([['600000000000000001', file('600000000000000001', marker)]]) };
    const apply = value => {
        const retained = [...first.attachments.values()].filter(item => (value.attachments || []).some(ref => String(ref.id) === item.id));
        const added = (value.files || []).map(item => file(String(++next), item.name));
        first.content = value.content || ''; first.components = value.components || first.components;
        first.attachments = new Map([...retained, ...added].map(item => [item.id, item]));
        first.embeds = (value.embeds || []).map(embed => {
            const copy = JSON.parse(JSON.stringify(embed));
            if (copy.image?.url?.startsWith('attachment://')) { const hit = added.find(item => item.name === copy.image.url.slice(13)); if (hit) copy.image.url = hit.url; }
            return copy;
        });
        return first;
    };
    first.edit = async value => { originalEdits++; return apply(value); };
    const settings = { enabled: true, button_disabled: {}, twitter_grid_replace_permission: 'restricted' };
    const payload = { id: galleryId, lockId: galleryId, kind: 'twitter-image-grid-v1', replacePhase: 'done', sourceStatusId: statusId, imageUrls: urls,
        expectedImageUrls: urls, totalParts: 2, completedParts: 2, partsState: 'complete', messageIds: [mid, tail], partSizes: [10, 3],
        partRefs: [urls.slice(0, 10).map(url => ({ type: 'url', url })), urls.slice(10).map(url => ({ type: 'url', url }))],
        partContainsNonImage: [false, false], partSignatures: [cards.fingerprint(first), 'f'.repeat(64)], firstStaticSignature: cards.fingerprint(first, true),
        requesterId: uid, nsfw: false, settingsHash: cards.safetyHash(settings) };
    await db.queryDatabase('INSERT INTO bot_media_galleries (gallery_id,guild_id,channel_id,message_id,provider_id,payload_json,expires_at_ms) VALUES (?,?,?,?,?,?,?)',
        [galleryId, gid, cid, mid, 'twitter', JSON.stringify(payload), Date.now() + 600000]);
    const channel = { id: cid, guildId: gid, messages: { fetch: async query => {
        if (query.limit === 1) return new Map([['999999999999999999', { id: '999999999999999999', channelId: cid, guildId: gid }]]);
        if (query.message === mid) return first;
        throw Object.assign(new Error('deleted'), { code: 10008 });
    } } };
    const interaction = { guildId: gid, channelId: cid, channel, attachmentSizeLimit: 25 * 1024 * 1024, user: { id: uid }, client: { user: { id: bot } } };
    const access = { channel, member: { _roles: [] }, permissions: { has: () => true }, guild: { ownerId: uid } };
    const storage = { get: async id => { const rows = await db.queryDatabase('SELECT * FROM bot_media_galleries WHERE gallery_id=?', [id]); return rows[0] || null; } };
    const sourceDependencies = { resolvePlan: async () => ({ sources: require('../../src/adminSupport/providerSources').REGISTRY.twitter.sources }),
        fetch: async () => ({ ok: true, text: async () => JSON.stringify({ tweetID: statusId, tweetURL: `https://x.com/example/status/${statusId}`,
            author: { protected: false }, possibly_sensitive: false, mediaURLs: urls }) }) };
    const hash = require('node:crypto').createHash('sha256').update(Buffer.from('ffd8ff00', 'hex')).digest('hex');
    const editor = { forMessage: () => ({ edit: async value => { restoreEdits++; apply(value); if (uncertain) { uncertain = false; throw Error('lost response'); } return first; } }) };
    const dependencies = (database = db) => ({ db: database, storage, getSettings: async () => settings, getAccess: async () => access, sourceDependencies, editor,
        recoveryDependencies: { hashAttachment: async () => hash }, mediaDependencies: { fetchTwitterMedia: async () => ({ data: Buffer.from('ffd8ff00', 'hex'), format: 'jpeg' }) } });
    async function load() { const rows = await db.queryDatabase('SELECT * FROM bot_media_galleries WHERE gallery_id=?', [galleryId]); return { ...rows[0], payload: JSON.parse(rows[0].payload_json) }; }
    return { db, first, channel, interaction, settings, access, dependencies, load, setUncertain: () => { uncertain = true; }, get restoreEdits() { return restoreEdits; }, get originalEdits() { return originalEdits; } };
}
for (const failure of ['none', 'unknown', 'rollback']) test(`13 -> first 10 -> recombine -> restore 10 retains the original archive: ${failure}`, { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        let adapters = createAdapters(f.interaction, galleryId, f.dependencies());
        assert.deepEqual(await restore.executeRestore({ mode: 'first', id: galleryId, owner: uid, interaction: f.interaction }, adapters), { status: 'done', completed: 1 });
        let row = await f.load(); assert.deepEqual(row.payload.imageUrls, urls.slice(0, 10)); assert.deepEqual(row.payload.restoreArchive.imageUrls, urls);
        const combined = await grid._internal.replacePublic(f.interaction, row, { data: Buffer.from('image'), filename: 'twitter-grid.jpg' },
            { db: f.db, getSettings: async () => f.settings, freshAccess: async () => f.access });
        assert.equal(combined, 'done'); row = await f.load(); assert.equal(row.payload.replacePhase, 'done');
        assert.deepEqual(row.payload.imageUrls, urls.slice(0, 10)); assert.deepEqual(row.payload.restoreArchive.imageUrls, urls);
        if (failure === 'unknown') f.setUncertain();
        let database = f.db;
        if (failure === 'rollback') {
            let injected = false;
            database = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(async query => {
                const value = await work(query); if (!injected && f.restoreEdits >= 2) { injected = true; throw Error('fixture rollback'); } return value;
            }) };
        }
        adapters = createAdapters(f.interaction, galleryId, f.dependencies(database));
        if (failure === 'rollback') await assert.rejects(restore.executeRestore({ mode: 'here', id: galleryId, owner: uid, interaction: f.interaction }, adapters), /fixture rollback/);
        else {
            const result = await restore.executeRestore({ mode: 'here', id: galleryId, owner: uid, interaction: f.interaction }, adapters);
            assert.equal(result.status, failure === 'unknown' ? 'unknown' : 'done');
        }
        if (failure !== 'none') assert.equal((await createAdapters(f.interaction, galleryId, f.dependencies()).recoverOnly()).status, 'recovered');
        row = await f.load(); assert.deepEqual(row.payload.imageUrls, urls.slice(0, 10)); assert.deepEqual(row.payload.restoreArchive.imageUrls, urls);
        assert.equal(f.restoreEdits, 2, 'the second restore is never sent twice');
        assert.equal((await f.db.queryDatabase('SELECT * FROM bot_twitter_grid_action_intents')).length, 0);
    } finally { await f.db.close(); }
});
test('shared reference restoration retains a larger verified source archive', () => {
    const inline = require('../../src/twitterGridRestoreInline'), full = urls.slice(0, 3), visible = full.slice(0, 2);
    const snapshot = { scope: { messageId: mid }, payload: { id: galleryId, lockId: galleryId, kind: 'twitter-image-grid-v1', sourceStatusId: statusId,
        imageUrls: visible, restoreArchive: { sourceStatusId: statusId, imageUrls: full } } };
    const plan = { kind: 'references', urls: visible, retained: [] };
    const after = { id: mid, content: '', embeds: [], components: [], attachments: new Map() };
    const result = inline.referenceManifest(snapshot, plan, after);
    assert.deepEqual(result.imageUrls, visible); assert.deepEqual(result.restoreArchive.imageUrls, full);
});

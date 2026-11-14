'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DiscordAPIError } = require('discord.js');
const { readFileSync } = require('node:fs');
const { createTestDatabase } = require('../lib/automation-test-db');
const cards = require('../../src/twitterGridCards');
const restore = require('../../src/twitterGridRestore');
const { createAdapters } = require('../../src/twitterGridRestoreAdapters');
const schema = require('../../src/db_schema');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (![33621, 33622].includes(port)) throw Error('An explicit isolated test database port is required');

for (const scenario of ['here', 'first', 'firstlater', 'rest', 'new', 'largehere', 'largefirst', 'largenew', 'new413first', 'new413later', 'limitexceeded', 'firstfail', 'firstfailbad', 'newfail', 'restacceptedfail', 'restreadtimeout', 'newacceptedfail', 'newfirstacceptedfail', 'restfirstacceptedfail', 'restpartial', 'newpartial', 'restdenied', 'restresumefail', 'newresumefail', 'editrace', 'sendrace', 'permissionrace', 'editjournalfail', 'sendjournalfail', 'recover', 'recoverbad', 'recovertimeout', 'cleanupfail',
    'hidden:here', 'hidden:first', 'hidden:firstlater', 'hidden:rest', 'hidden:new', 'hidden:firstfail', 'hidden:recover',
    ...['initial', 'reauthorize'].flatMap(stage => ['id', 'channel', 'guild', 'author'].flatMap(field => ['wrong', 'missing'].map(value => `identity:${stage}:${field}:${value}`)))]) test(`shared gallery lock and durable journal restore mode ${scenario}`, { timeout: 60000 }, async () => {
    const hidden = scenario.startsWith('hidden:'), mode = hidden ? scenario.slice('hidden:'.length) : scenario;
    const db = await createTestDatabase(port);
    try {
        const migration = readFileSync(require('node:path').join(schema.MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
        await db.queryDatabase(schema._internal.splitSqlStatements(migration).find(sql => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(sql)));
        await db.queryDatabase(readFileSync(require('node:path').join(schema.MIGRATIONS_DIR, '20261113_add_twitter_grid_action_intents.sql'), 'utf8'));
        const id = 'a'.repeat(32), guildId = '111111111111111111', channelId = '222222222222222222', botId = '333333333333333333';
        const userId = '444444444444444444', messageId = '555555555555555555', markerId = '666666666666666666', statusId = '1234567890123456789';
        const large = mode.startsWith('large') || mode === 'limitexceeded', urls = Array.from({ length: large ? 20 : 13 }, (_, i) => `https://pbs.twimg.com/media/P${i}?format=jpg`), marker = `tg-${id}.jpg`;
        const makeFile = (attachmentId, name) => ({ id: attachmentId, name, contentType: 'image/jpeg', url: `https://cdn.discordapp.com/attachments/${channelId}/${attachmentId}/${name}` });
        const first = { id: messageId, channelId, guildId, author: { id: botId }, content: '', components: [
            { type: 1, components: [{ type: 2, style: 4, label: '削除', custom_id: `delete:sl1:${id}` }] },
            { type: 1, components: [cards.gridButton(id, 'ja')] }],
            embeds: [{ url: `https://x.com/example/status/${statusId}`, image: { url: `https://cdn.discordapp.com/attachments/${channelId}/${markerId}/${marker}` } }],
            attachments: new Map([[markerId, makeFile(markerId, marker)]]) };
        // Real Discord GET omits a file referenced by an Embed from this list.
        if (hidden) first.attachments.clear();
        const settings = { enabled: true, button_disabled: {} };
        const payload = { id, lockId: id, kind: 'twitter-image-grid-v1', sourceStatusId: statusId, replacePhase: 'done', imageUrls: urls,
            expectedImageUrls: urls, completedParts: 2, totalParts: 2, partsState: 'complete', messageIds: [messageId, '777777777777777777'],
            partSizes: [10, urls.length - 10], partRefs: [urls.slice(0, 10).map(url => ({ type: 'url', url })), urls.slice(10).map(url => ({ type: 'url', url }))],
            partSignatures: [cards.fingerprint(first), 'f'.repeat(64)], firstStaticSignature: cards.fingerprint(first, true),
            settingsHash: cards.safetyHash(settings), nsfw: false, requesterId: userId };
        await db.queryDatabase('INSERT INTO bot_media_galleries (gallery_id,guild_id,channel_id,message_id,provider_id,payload_json,expires_at_ms) VALUES (?,?,?,?,?,?,?)',
            [id, guildId, channelId, messageId, 'twitter', JSON.stringify(payload), Date.now() + 600000]);
        let latestId = mode === 'here' || mode === 'largehere' ? messageId : '999999999999999999'; const history = new Map();
        let identityFetches = 0;
        const channel = { id: channelId, messages: { fetch: async query => {
            if (query.around) return new Map([[messageId, first], ...history]);
            if (query.limit === 1) return new Map([[latestId, { id: latestId, channelId, guildId }]]);
            if (query.limit) return history;
            if (query.message === messageId) {
                identityFetches++;
                if (mode.startsWith('identity:')) {
                    const [, stage, field, value] = mode.split(':');
                    if (stage === 'initial' || identityFetches >= 2) {
                        const key = field === 'channel' ? 'channelId' : field === 'guild' ? 'guildId' : field;
                        return { ...first, [key]: value === 'missing' ? undefined : field === 'author' ? { id: '999999999999999999' } : '999999999999999999' };
                    }
                }
                return first;
            }
            if (history.has(query.message)) return history.get(query.message);
            throw { code: 10008 };
        } } };
        const interaction = { guildId, channelId, channel, attachmentSizeLimit: (mode === 'limitexceeded' ? 8 : 25) * 1024 * 1024, user: { id: userId }, client: { user: { id: botId } } };
        let accessAllowed = true;
        const grid = { freshAccess: async () => accessAllowed ? ({ channel, member: {}, permissions: { has: () => true }, guild: {} }) : null, currentButtonAccess: () => true,
            mayReplace: () => true, sourcesRemainValid: async () => true };
        const sourceDependencies = { resolvePlan: async () => ({ sources: require('../../src/adminSupport/providerSources').REGISTRY.twitter.sources }),
            fetch: async () => ({ ok: true, text: async () => JSON.stringify({ tweetID: statusId, tweetURL: `https://x.com/example/status/${statusId}`,
                author: { protected: false }, possibly_sensitive: false, mediaURLs: urls }) }) };
        let edits = 0, sends = 0;
        const editor = { forMessage: () => ({ edit: async value => {
            edits++; first.content = value.content; first.embeds = value.embeds; first.components = value.components;
            first.attachments = new Map(value.files.map((file, i) => { const fileId = String(BigInt(markerId) + BigInt(i + 1)); return [fileId, makeFile(fileId, file.name)]; }));
            if (mode.startsWith('firstfail') || mode === 'restfirstacceptedfail') throw Error('response lost');
            if (mode === 'restdenied') accessAllowed = false;
            return first;
        } }) };
        const sender = { forMessage: () => ({ send: async value => {
            sends++;
            if (mode === 'new413first' && sends === 1 || mode === 'new413later' && sends === 2) throw new DiscordAPIError({ message: 'too large' }, 0, 413, 'POST', '/fixture', {});
            const sentId = String(888888888888888887n + BigInt(sends));
            if (mode === 'newfail' && sends === 2) throw Error('response lost');
            latestId = sentId;
            const sent = { id: sentId, channelId, guildId, createdTimestamp: Date.now(), author: { id: botId }, content: value.content || '', embeds: value.embeds || [], components: value.components || [], attachments: new Map(value.files.map((file, i) => {
                const fileId = String(BigInt(markerId) + BigInt(100 + sends * 20 + i)); return [fileId, makeFile(fileId, file.name)];
            })) };
            history.set(sentId, sent);
            if (mode === 'restacceptedfail' || mode === 'restreadtimeout' || mode === 'newacceptedfail' && sends === 2) throw Error('response lost');
            if (mode === 'newfirstacceptedfail' && sends === 1) throw Error('first response lost');
            if (mode === 'restresumefail' && sends === 1 || mode === 'newresumefail' && sends === 2) throw Error('resume response lost');
            return sent;
        } }) };
        const storage = { get: async galleryId => {
            const rows = await db.queryDatabase('SELECT * FROM bot_media_galleries WHERE gallery_id=?', [galleryId]);
            return rows[0] || null;
        } };
        if (mode.startsWith('recover')) {
            const transaction = db.withDatabaseTransaction; let failCommit = true;
            db.withDatabaseTransaction = work => transaction(async query => {
                const result = await work(query);
                if (failCommit) { failCommit = false; throw Error('fixture rollback'); }
                return result;
            });
        }
        if (mode === 'cleanupfail') {
            const independent = db.queryDatabaseIndependent; let failCleanup = true;
            db.queryDatabaseIndependent = (sql, params) => {
                if (failCleanup && /^DELETE FROM bot_twitter_grid_action_intents/.test(sql)) { failCleanup = false; throw Error('cleanup failed'); }
                return independent(sql, params);
            };
        }
        if (['editrace', 'sendrace', 'permissionrace'].includes(mode)) {
            const independent = db.queryDatabaseIndependent; let changed = false;
            db.queryDatabaseIndependent = async (sql, params) => {
                const result = await independent(sql, params);
                if (!changed && /^UPDATE bot_twitter_grid_action_intents SET payload_json=/.test(sql)) {
                    const step = JSON.parse(params[0]).steps.at(-1);
                    if (step?.state === 'planned' && (mode === 'sendrace' ? step.type === 'send' : step.type === 'edit')) {
                        changed = true;
                        if (mode === 'permissionrace') accessAllowed = false; else first.content = 'changed during journal write';
                    }
                }
                return result;
            };
        }
        let failJournalWrites = mode === 'editjournalfail' || mode === 'sendjournalfail';
        if (failJournalWrites) {
            const independent = db.queryDatabaseIndependent;
            db.queryDatabaseIndependent = async (sql, params) => {
                if (failJournalWrites && /^UPDATE bot_twitter_grid_action_intents SET payload_json=/.test(sql)) {
                    const record = JSON.parse(params[0]), last = record.steps.at(-1);
                    if (record.state === 'unknown' || last?.state === 'confirmed' && (mode === 'editjournalfail' ? last.type === 'edit' : last.type === 'send'))
                        throw Error('fixture journal outage');
                }
                return independent(sql, params);
            };
        }
        let badHash = mode === 'recoverbad' || mode === 'firstfailbad';
        let failMedia = ['restpartial', 'newpartial', 'restresumefail', 'newresumefail'].includes(mode), downloadCount = 0;
        const mediaData = large ? Buffer.alloc(9 * 1024 * 1024) : Buffer.from('ffd8ff00', 'hex');
        if (large) Buffer.from('ffd8ff', 'hex').copy(mediaData);
        const hash = require('node:crypto').createHash('sha256').update(Buffer.from('ffd8ff00', 'hex')).digest('hex');
        const recoveryDependencies = { hashAttachment: async () => badHash ? '0'.repeat(64) : hash };
        if (mode === 'recovertimeout') { recoveryDependencies.now = () => 1000; recoveryDependencies.deadlineAtMs = 1000;
            recoveryDependencies.fetchVerifiedSource = async (_source, value) => value.imageUrls; }
        const adapters = createAdapters(interaction, id, { db, grid, storage, getSettings: async () => settings, sourceDependencies, editor, sender, recoveryDependencies,
            mediaDependencies: { fetchTwitterMedia: async () => { if (failMedia && ++downloadCount === 24) throw Error('download failed'); return { data: mediaData, format: 'jpeg' }; } } });
        const selectedMode = mode === 'largehere' ? 'here' : mode === 'largefirst' || mode === 'limitexceeded' || mode === 'firstlater' ? 'first' : mode === 'largenew' ? 'new'
            : mode.startsWith('firstfail') || mode.startsWith('recover') || ['cleanupfail', 'editrace', 'permissionrace', 'editjournalfail'].includes(mode) ? 'first'
            : mode === 'new413first' || mode === 'new413later' || mode === 'newfail' || mode === 'newacceptedfail' || mode === 'newfirstacceptedfail' || mode === 'newpartial' || mode === 'newresumefail' ? 'new'
                : mode === 'restacceptedfail' || mode === 'restreadtimeout' || mode === 'restfirstacceptedfail' || mode === 'restpartial' || mode === 'restdenied' || mode === 'restresumefail' || mode === 'sendrace' || mode === 'sendjournalfail' ? 'rest' : mode;
        if (mode.startsWith('identity:')) {
            const before = (await db.queryDatabase('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=?', [id]))[0].payload_json;
            const result = await restore.executeRestore({ mode: 'first', id, owner: userId, interaction }, adapters);
            assert.notEqual(result.status, 'done'); assert.equal(edits, 0); assert.equal(sends, 0);
            assert.equal((await db.queryDatabase('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=?', [id]))[0].payload_json, before);
            return;
        }
        if (mode.startsWith('recover') || mode === 'cleanupfail') {
            await assert.rejects(restore.executeRestore({ mode: selectedMode, id, owner: userId, interaction }, adapters), mode === 'cleanupfail' ? /cleanup failed/ : /fixture rollback/);
            if (mode === 'recoverbad') assert.equal((await adapters.recoverOnly()).status, 'blocked');
            if (mode === 'recovertimeout') {
                assert.equal((await adapters.recoverOnly()).status, 'blocked');
                assert.equal((await db.queryDatabase('SELECT * FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [id])).length, 1);
                delete recoveryDependencies.deadlineAtMs; delete recoveryDependencies.now; delete recoveryDependencies.fetchVerifiedSource;
            }
            badHash = false;
            assert.equal((await adapters.recoverOnly()).status, 'recovered');
            const rows = await db.queryDatabase('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=?', [id]);
            assert.deepEqual(JSON.parse(rows[0].payload_json).imageUrls, urls.slice(0, 10));
            assert.equal((await db.queryDatabase('SELECT * FROM bot_twitter_grid_action_intents')).length, 0);
            assert.equal(edits, 1); return;
        }
        let result = await restore.executeRestore({ mode: selectedMode, id, owner: userId, interaction }, adapters);
        if (mode === 'new413first' || mode === 'new413later') {
            assert.deepEqual(result, { status: 'done', completed: 3 });
            assert.equal(edits, 0); assert.equal(sends, 4);
            const all = await db.queryDatabase('SELECT gallery_id,payload_json FROM bot_media_galleries');
            const created = all.find(row => row.gallery_id !== id);
            assert.ok(created);
            const gallery = JSON.parse(created.payload_json);
            assert.deepEqual(gallery.partSizes, mode === 'new413first' ? [5, 5, 3] : [10, 2, 1]);
            assert.deepEqual(gallery.imageUrls, urls); assert.equal(gallery.partsState, 'complete');
            assert.equal((await db.queryDatabase('SELECT * FROM bot_twitter_grid_action_intents')).length, 0);
            return;
        }
        if (mode === 'firstlater') {
            assert.deepEqual(result, { status: 'done', completed: 1 }); assert.equal(sends, 0);
            const before = JSON.parse((await db.queryDatabase('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=?', [id]))[0].payload_json);
            assert.equal(before.restoreContinuation.nextIndex, 10);
            const next = createAdapters(interaction, id, { db, grid, storage, getSettings: async () => settings, sourceDependencies, editor, sender,
                mediaDependencies: { fetchTwitterMedia: async () => ({ data: mediaData, format: 'jpeg' }) } });
            assert.deepEqual(await restore.executeRestore({ mode: 'resume', id, owner: userId, interaction }, next), { status: 'done', completed: 1 });
            const saved = JSON.parse((await db.queryDatabase('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=?', [id]))[0].payload_json);
            assert.deepEqual(saved.imageUrls, urls); assert.equal(saved.restoreContinuation, undefined); assert.equal(edits, 1); assert.equal(sends, 1); return;
        }
        if (mode === 'limitexceeded') {
            assert.deepEqual(result, { status: 'image_too_large', fileLimit: 8 * 1024 * 1024 });
            assert.equal(edits, 0); assert.equal(sends, 0);
            assert.equal((await db.queryDatabase('SELECT * FROM bot_twitter_grid_action_intents')).length, 0); return;
        }
        if (mode === 'largefirst') {
            assert.equal(result.status, 'confirm_split'); assert.deepEqual(result.sizes, [8, 2]); assert.equal(edits, 0); assert.equal(sends, 0);
            result = await restore.executeRestore({ mode: selectedMode, id, owner: userId, interaction, confirmedPlan: result.planDigest }, adapters);
        }
        if (large) {
            assert.equal(result.status, 'done'); assert.equal(result.completed, mode === 'largefirst' ? 2 : 4);
            assert.equal(edits, mode === 'largenew' ? 0 : 1); assert.equal(sends, mode === 'largefirst' ? 1 : mode === 'largenew' ? 4 : 3);
            const all = await db.queryDatabase('SELECT gallery_id,payload_json FROM bot_media_galleries');
            const changed = all.find(row => mode === 'largenew' ? row.gallery_id !== id : row.gallery_id === id);
            const record = JSON.parse(changed.payload_json);
            assert.deepEqual(record.partSizes, mode === 'largefirst' ? [8, 2] : [8, 2, 8, 2]);
            assert.deepEqual(record.imageUrls, mode === 'largefirst' ? urls.slice(0, 10) : urls);
            return;
        }
        if (mode === 'restreadtimeout') {
            assert.equal(result.status, 'unknown'); let release;
            const waiting = new Promise(resolve => { release = resolve; }), realFetch = channel.messages.fetch;
            channel.messages.fetch = query => query.limit > 1 ? waiting : realFetch(query);
            recoveryDependencies.deadlineAtMs = Date.now() + 25;
            assert.equal((await adapters.recoverOnly()).status, 'blocked');
            const available = await cards.withGalleryLock({ galleryId: id, guildId, channelId, messageId }, async () => true, db);
            assert.equal(available, true);
            assert.equal((await db.queryDatabase('SELECT * FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [id])).length, 1);
            release(history); await new Promise(resolve => setImmediate(resolve));
            assert.equal((await db.queryDatabase('SELECT * FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [id])).length, 1);
            delete recoveryDependencies.deadlineAtMs; channel.messages.fetch = realFetch;
            assert.equal((await adapters.recoverOnly()).status, 'recovered'); assert.equal(sends, 1); return;
        }
        if (mode === 'editjournalfail' || mode === 'sendjournalfail') {
            assert.equal(result.status, 'unknown');
            const journal = await db.queryDatabase('SELECT payload_json FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [id]);
            const saved = JSON.parse(journal[0].payload_json);
            assert.equal(saved.state, 'in_progress'); assert.equal(saved.steps.at(-1).state, 'planned');
            failJournalWrites = false;
            assert.equal((await adapters.recoverOnly()).status, 'recovered');
            assert.equal(edits, 1); assert.equal(sends, mode === 'sendjournalfail' ? 1 : 0);
            return;
        }
        if (['editrace', 'sendrace', 'permissionrace'].includes(mode)) {
            assert.equal(result.status, mode === 'sendrace' ? 'partial' : 'denied');
            assert.equal(edits, mode === 'sendrace' ? 1 : 0); assert.equal(sends, 0);
            if (mode !== 'permissionrace') assert.equal(first.content, 'changed during journal write');
            const journal = await db.queryDatabase('SELECT payload_json FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [id]);
            if (mode === 'sendrace') {
                assert.equal(journal.length, 1); assert.equal(JSON.parse(journal[0].payload_json).steps.length, 1);
            } else assert.equal(journal.length, 0);
            return;
        }
        if (['restpartial', 'newpartial', 'restdenied', 'restresumefail', 'newresumefail', 'newfirstacceptedfail', 'restfirstacceptedfail'].includes(mode)) {
            if (mode === 'newfirstacceptedfail' || mode === 'restfirstacceptedfail') assert.equal(result.status, 'unknown');
            else assert.deepEqual(result, { status: 'partial', completed: 1 });
            failMedia = false; accessAllowed = true;
            assert.equal((await adapters.recoverOnly()).status, 'recovered');
            const all = await db.queryDatabase('SELECT gallery_id,message_id,payload_json FROM bot_media_galleries');
            const newMode = mode === 'newpartial' || mode === 'newresumefail' || mode === 'newfirstacceptedfail';
            const partialRow = all.find(row => newMode ? row.gallery_id !== id : row.gallery_id === id);
            const partial = JSON.parse(partialRow.payload_json);
            assert.deepEqual(partial.imageUrls, urls.slice(0, 10)); assert.equal(partial.restoreContinuation.nextIndex, 10);
            const resumed = createAdapters(interaction, partialRow.gallery_id, { db, grid, storage, getSettings: async () => settings, sourceDependencies, editor, sender,
                recoveryDependencies: { hashAttachment: async () => hash },
                mediaDependencies: { fetchTwitterMedia: async () => ({ data: Buffer.from('ffd8ff00', 'hex'), format: 'jpeg' }) } });
            const resumeResult = await restore.executeRestore({ mode: 'resume', id: partialRow.gallery_id, owner: userId, interaction }, resumed);
            if (mode.endsWith('resumefail')) {
                assert.equal(resumeResult.status, 'unknown');
                assert.equal((await resumed.recoverOnly()).status, 'recovered');
            } else assert.deepEqual(resumeResult, { status: 'done', completed: 1 });
            const refreshed = await db.queryDatabase('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=?', [partialRow.gallery_id]);
            const completed = JSON.parse(refreshed[0].payload_json);
            assert.deepEqual(completed.imageUrls, urls); assert.equal(completed.restoreContinuation, undefined);
            assert.equal(edits, newMode ? 0 : 1); assert.equal(sends, newMode ? 2 : 1);
            return;
        }
        if (mode.startsWith('firstfail') || mode === 'newfail' || mode.endsWith('acceptedfail')) {
            assert.equal(result.status, 'unknown');
            const retry = await restore.executeRestore({ mode: selectedMode, id, owner: userId, interaction }, adapters);
            assert.equal(retry.status, mode === 'firstfail' || mode.endsWith('acceptedfail') ? 'recovered' : 'blocked');
            assert.equal(edits, mode.startsWith('firstfail') || mode === 'restacceptedfail' ? 1 : 0);
            assert.equal(sends, mode === 'newfail' || mode === 'newacceptedfail' ? 2 : mode === 'restacceptedfail' ? 1 : 0);
            const journal = await db.queryDatabase('SELECT payload_json FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [id]);
            if (mode === 'firstfail' || mode.endsWith('acceptedfail')) assert.equal(journal.length, 0);
            else assert.equal(JSON.parse(journal[0].payload_json).state, 'unknown');
            if (mode === 'firstfailbad') {
                badHash = false;
                assert.equal((await adapters.recoverOnly()).status, 'recovered');
                assert.equal(edits, 1);
            }
            return;
        }
        assert.deepEqual(result, { status: 'done', completed: mode === 'first' ? 1 : 2 });
        const rows = await db.queryDatabase('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=?', [id]);
        const saved = JSON.parse(rows[0].payload_json);
        assert.equal(edits, mode === 'new' ? 0 : 1); assert.equal(sends, mode === 'first' ? 0 : mode === 'new' ? 2 : 1);
        if (mode === 'new') {
            assert.equal(saved.replacePhase, 'done');
            const created = await db.queryDatabase('SELECT gallery_id,payload_json,expires_at_ms FROM bot_media_galleries WHERE gallery_id<>?', [id]);
            assert.equal(created.length, 1); const newGallery = JSON.parse(created[0].payload_json);
            assert.equal(newGallery.partsState, 'complete'); assert.deepEqual(newGallery.imageUrls, urls); assert.deepEqual(newGallery.partSizes, [10, 3]);
            assert.equal(Number(created[0].expires_at_ms), Number.MAX_SAFE_INTEGER);
            const newFirst = history.get(newGallery.messageIds[0]);
            const action = newFirst.components.flatMap(row => row.components).find(item => String(item.custom_id || '').startsWith('delete:sl1:'));
            assert.equal(cards.locatorIdFromAction(action.custom_id), created[0].gallery_id);
        } else {
            assert.deepEqual(saved.imageUrls, mode === 'first' ? urls.slice(0, 10) : urls); assert.deepEqual(saved.restoreArchive.imageUrls, urls);
        }
        assert.equal((await db.queryDatabase('SELECT * FROM bot_twitter_grid_action_intents')).length, 0);
    } finally { await db.close(); }
});

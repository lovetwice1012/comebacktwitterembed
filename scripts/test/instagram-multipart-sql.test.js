'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');
const { createTestDatabase } = require('../lib/automation-test-db');
const gallery = require('../../src/mediaGallery'), multipart = require('../../src/instagramMultipart');
const schema = require('../../src/db_schema');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (port !== 33621 || process.env.NODE_ENV !== 'test') throw new Error('Explicit isolated database port 33621 is required');

test('Instagram split delivery records and deletes all messages; a partial failure can be retried', { timeout: 120000 }, async () => {
    const db = await createTestDatabase(port);
    try {
        const sql = readFileSync(require('node:path').join(schema.MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
        await db.queryDatabase(schema._internal.splitSqlStatements(sql).find(value => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(value)));
        const guildId = '111111111111111111', channelId = '222222222222222222', bot = '333333333333333333', owner = '444444444444444444';
        const storage = gallery.createStore(db), messages = new Map(), deleted = [];
        let number = 0, failRoot = true;
        const send = async payload => {
            const id = String(555555555555555550n + BigInt(++number));
            const sent = { id, guildId, channelId, author: { id: bot }, content: payload.content || '', embeds: payload.embeds || [],
                components: payload.components || [], attachments: new Map(payload.files.map((file, index) => {
                    const item = { id: String(BigInt(id) * 100n + BigInt(index)), name: file.name, contentType: 'image/jpeg' };
                    return [item.id, item];
                })) };
            sent.delete = async () => { if (id.endsWith('1') && failRoot) { failRoot = false; throw Error('synthetic failure'); } deleted.push(id); messages.delete(id); };
            messages.set(id, sent); return sent;
        };
        const filename = require.resolve('../../src/providers/_dispatcher'), actual = createRequire(filename), mod = { exports: {} };
        const mocks = { '../adminSupport/telemetry': { event() {}, errorData: e => e, serializable: x => x },
            '../errorTracking': { recordError() {}, recordMetric() {}, recordAnalyticsEvent() {} }, '../state': { incrementProcessedCounters() {} },
            '../settings': { checkComponentIncludesDisabledButtonAndIfFindDeleteIt: async rows => rows },
            '../sharedPostHistory': { run: (_m, steps, _c, work) => work(steps) }, '../mediaGallery': { prepare: async step => ({ step }), report() {} },
            '../personalLinks/cards': { prepare: async step => ({ step }) }, '../twitterGridCards': { prepare: async step => ({ step }) },
            './twitter/singleAttemptSender': { forMessage: () => ({ send }) },
            './instagram/attachment-preflight': { prepare: async () => null },
            '../instagramMultipart': { prepare: (step, message, context) => multipart.prepare(step, message, context, storage),
                record: (group, step, sent, scope) => multipart.record(group, step, sent, scope, storage, db) } };
        compileFunction(readFileSync(filename, 'utf8'), ['require', 'module', 'exports', 'console'], { filename })(
            id => Object.hasOwn(mocks, id) ? mocks[id] : actual(id), mod, mod.exports, { log() {}, warn() {}, error() {} });
        const channel = { id: channelId, send, messages: { fetch: async ({ message }) => {
            if (!messages.has(message)) throw Object.assign(Error('unknown'), { code: 10008 }); return messages.get(message);
        } } };
        const source = { guildId, channelId, guild: { id: guildId }, channel, author: { id: owner }, client: { user: { id: bot } } };
        const files = Array.from({ length: 11 }, (_, index) => ({ attachment: `https://example.com/${index}.jpg`, name: `${index}.jpg` }));
        const steps = [{ files: files.slice(0, 10), instagramGalleryParts: 2, embeds: [{ url: 'https://www.instagram.com/p/ABC/', description: 'caption' }],
            components: [{ type: 1, components: [{ type: 2, custom_id: 'delete:instagram' }] }] },
        { files: files.slice(10), requiresPreviousSuccess: true, send: 'channel' }];
        const sent = await mod.exports.runSendSteps(source, steps, 'instagram', { presentationSettings: {} });
        assert.equal(sent.outcome, 'F'); assert.equal(messages.size, 2);
        const first = messages.get('555555555555555551'), customId = first.components[0].components[0].custom_id;
        const row = await storage.get(customId.split(':')[2], guildId, channelId);
        assert.equal(row.payload.partsState, 'complete');
        assert.deepEqual(row.payload.messageIds, ['555555555555555551', '555555555555555552']);
        const interaction = { guildId, channelId, channel, client: { user: { id: bot } }, user: { id: owner }, message: first, customId, locale: 'ja', editReply: async () => {} };
        const dependencies = { db, getSettings: async () => ({}), freshAccess: async () => ({ channel, member: { _roles: [] }, permissions: { has: () => true } }) };
        await assert.rejects(multipart.remove(interaction, dependencies), /synthetic failure/);
        assert.deepEqual(deleted, ['555555555555555552']);
        const retried = await Promise.allSettled([multipart.remove(interaction, dependencies), multipart.remove(interaction, dependencies)]);
        assert.equal(retried.filter(item => item.status === 'fulfilled').length, 1);
        assert.equal(retried.filter(item => item.status === 'rejected').length, 1);
        assert.deepEqual(deleted, ['555555555555555552', '555555555555555551']);
        assert.equal(messages.size, 0);
    } finally { await db.close(); }
});

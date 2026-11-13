'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');
const { createTestDatabase } = require('../lib/automation-test-db');
const cards = require('../../src/twitterGridCards'), gallery = require('../../src/mediaGallery');

const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (port !== 33621) throw new Error('Explicit isolated database port 33621 required');
const guildId = '333333333333333333', channelId = '444444444444444444';
const owner = '111111111111111111', bot = '222222222222222222';

async function setup(send, media = null) {
    const db = await createTestDatabase(port), schema = require('../../src/db_schema');
    const sql = readFileSync(require('node:path').join(schema.MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
    await db.queryDatabase(schema._internal.splitSqlStatements(sql).find(statement => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(statement)));
    const storage = gallery.createStore(db), saved = [], post = [];
    const wrapper = {
        prepare: async (step, message, context, _storage, following) => {
            const output = await cards.prepare(step, message, context, storage, following);
            if (output.grids) saved.push(...output.grids);
            return output;
        },
        bind: (grid, sent, _storage, _db, part) => cards.bind(grid, sent, storage, db, part),
        append: (grid, part, sent) => cards.append(grid, part, sent, db),
        finish: grid => cards.finish(grid, db),
        markIncomplete: (grid, state) => cards.markIncomplete(grid, state, db),
        discardUnbound: grids => cards.discardUnbound(grids, db),
    };
    const filename = require.resolve('../../src/providers/_dispatcher'), actual = createRequire(filename), mod = { exports: {} };
    const mocks = {
        '../adminSupport/telemetry': { event() {}, errorData: e => e, serializable: x => x },
        '../errorTracking': { recordError() {}, recordMetric() {}, recordAnalyticsEvent() {} },
        '../settings': { checkComponentIncludesDisabledButtonAndIfFindDeleteIt: async rows => rows },
        '../state': { incrementProcessedCounters() {} }, '../sharedPostHistory': { run: (_m, steps, _c, work) => work(steps) },
        '../mediaGallery': { prepare: async step => ({ step }), report() {} }, '../personalLinks/cards': { prepare: async step => ({ step }) },
        '../twitterGridCards': wrapper,
        './twitter/singleAttemptSender': { forMessage: () => ({ send }) },
        ...(media ? { './twitter/safeMedia': media } : {}),
    };
    compileFunction(readFileSync(filename, 'utf8'), ['require', 'module', 'exports', 'console'], { filename })(
        id => Object.hasOwn(mocks, id) ? mocks[id] : actual(id), mod, mod.exports, { log() {}, warn() {}, error() {} });
    const message = { guildId, channelId, guild: { id: guildId }, author: { id: owner },
        channel: { id: channelId, nsfw: false, send }, delete: async () => post.push('delete'), suppressEmbeds: async () => post.push('suppress') };
    return { db, storage, saved, post, run: steps => mod.exports.runSendSteps(message, steps, 'twitter', { presentationSettings: { enabled: true } }) };
}
function sourceSteps(urls) {
    return [{ files: urls.slice(0, 10), embeds: [{ title: 'fixture' }], send: 'channel', deleteSource: true,
        twitterGrid: { imageUrls: urls.slice(0, 10), sequence: 0, totalParts: 2, embedStart: 0, embedEnd: 1 } },
    { files: urls.slice(10), send: 'channel', requiresPreviousSuccess: true,
        twitterGrid: { imageUrls: urls.slice(10), sequence: 1, totalParts: 2 } }];
}

test('real DB grid is complete only after every 413-split physical message is acknowledged', { timeout: 60000 }, async () => {
    let n = 0; const accepted = [], attempts = [];
    const send = async payload => {
        attempts.push(payload.files.length);
        if (payload.files.length > 5) throw { status: 413 };
        const id = String(555555555555555550n + BigInt(++n));
        const result = { id, channelId, author: { id: bot }, content: payload.content || '', embeds: payload.embeds || [],
            components: payload.components || [], attachments: new Map(payload.files.map((url, i) => [String(i), { id: `${id}${i}`, name: `p${i}.jpg`, contentType: 'image/jpeg', url }])) };
        accepted.push(result); return result;
    };
    const f = await setup(send), urls = Array.from({ length: 20 }, (_, i) => `https://pbs.twimg.com/media/photo${i}.jpg`);
    try {
        const result = await f.run(sourceSteps(urls));
        assert.equal(result.outcome, 'F'); assert.deepEqual(attempts, [10, 5, 5, 10, 5, 5]);
        assert.equal(accepted.length, 4); assert.deepEqual(f.post, ['delete']);
        const row = await f.storage.get(f.saved.at(-1).id, guildId, channelId);
        assert.equal(row.payload.partsState, 'complete'); assert.equal(row.payload.completedParts, 4);
        assert.deepEqual(row.payload.partSizes, [5, 5, 5, 5]); assert.deepEqual(row.payload.imageUrls, urls);
        assert.deepEqual(row.payload.messageIds, accepted.map(message => message.id));
        assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM bot_media_galleries WHERE message_id IS NULL'))[0].n), 0);
    } finally { await f.db.close(); }
});

test('a failure after one accepted split leaves the source and records an incomplete grid', { timeout: 60000 }, async () => {
    let attempts = 0, first;
    const send = async payload => {
        attempts++;
        if (payload.files.length > 5) throw { status: 413 };
        if (first) throw { status: 403, code: 50013 };
        first = { id: '555555555555555551', channelId, author: { id: bot }, content: '', embeds: payload.embeds || [],
            components: payload.components || [], attachments: new Map() };
        return first;
    };
    const f = await setup(send), urls = Array.from({ length: 20 }, (_, i) => `https://pbs.twimg.com/media/photo${i}.jpg`);
    try {
        const result = await f.run(sourceSteps(urls));
        assert.equal(result.outcome, 'P'); assert.equal(attempts, 3); assert.deepEqual(f.post, []);
        const row = await f.storage.get(f.saved.at(-1).id, guildId, channelId);
        assert.equal(row.payload.partsState, 'failed'); assert.equal(row.payload.imageUrls.length, 5);
    } finally { await f.db.close(); }
});

test('unknown delivery after an accepted split is never retried and is recorded as unknown', { timeout: 60000 }, async () => {
    let attempts = 0, first;
    const send = async payload => {
        attempts++;
        if (payload.files.length > 5) throw { status: 413 };
        if (first) throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
        first = { id: '555555555555555551', channelId, author: { id: bot }, content: '', embeds: payload.embeds || [],
            components: payload.components || [], attachments: new Map() };
        return first;
    };
    const f = await setup(send), urls = Array.from({ length: 20 }, (_, i) => `https://pbs.twimg.com/media/photo${i}.jpg`);
    try {
        const result = await f.run(sourceSteps(urls));
        assert.equal(result.outcome, 'U'); assert.equal(attempts, 3); assert.deepEqual(f.post, []);
        const row = await f.storage.get(f.saved.at(-1).id, guildId, channelId);
        assert.equal(row.payload.partsState, 'delivery_unknown'); assert.equal(row.payload.imageUrls.length, 5);
    } finally { await f.db.close(); }
});

test('413 split can start with video-only output without losing later photos or marking videos removable', { timeout: 60000 }, async () => {
    let n = 0; const accepted = [];
    const send = async payload => {
        if (payload.files.length > 5) throw { status: 413 };
        const id = String(555555555555555550n + BigInt(++n));
        const result = { id, channelId, author: { id: bot }, content: '', embeds: payload.embeds || [], components: payload.components || [],
            attachments: new Map(payload.files.map((url, i) => [String(i), { id: `${id}${i}`, name: `file${i}`, contentType: url.includes('video.twimg.com') ? 'video/mp4' : 'image/jpeg', url }])) };
        accepted.push(result); return result;
    };
    const f = await setup(send), videos = Array.from({ length: 5 }, (_, i) => `https://video.twimg.com/ext_tw_video/${i}/clip.mp4`);
    const photos = Array.from({ length: 15 }, (_, i) => `https://pbs.twimg.com/media/photo${i}.jpg`);
    const steps = [{ files: [...videos, ...photos.slice(0, 5)], embeds: [{ title: 'fixture' }], send: 'channel',
        twitterGrid: { imageUrls: photos.slice(0, 5), sequence: 0, totalParts: 2, embedStart: 0, embedEnd: 1 } },
    { files: photos.slice(5), send: 'channel', requiresPreviousSuccess: true,
        twitterGrid: { imageUrls: photos.slice(5), sequence: 1, totalParts: 2 } }];
    try {
        const result = await f.run(steps), row = await f.storage.get(f.saved.at(-1).id, guildId, channelId);
        assert.equal(result.outcome, 'F'); assert.equal(row.payload.partsState, 'complete');
        assert.deepEqual(row.payload.partSizes, [0, 5, 5, 5]);
        assert.deepEqual(row.payload.partContainsNonImage, [true, false, false, false]);
        assert.deepEqual(row.payload.imageUrls, photos);
        assert.deepEqual(row.payload.messageIds, accepted.map(message => message.id));
    } finally { await f.db.close(); }
});

test('a video-only middle split remains outside the complete photo group and is never a replacement target', { timeout: 60000 }, async () => {
    let n = 0; const accepted = [];
    const send = async payload => {
        if (payload.files.length > 5) throw { status: 413 };
        const id = String(555555555555555550n + BigInt(++n));
        const result = { id, channelId, author: { id: bot }, content: '', embeds: payload.embeds || [], components: payload.components || [],
            attachments: new Map(payload.files.map((url, i) => [String(i), { id: `${id}${i}`, name: `file${i}`, contentType: url.includes('video.twimg.com') ? 'video/mp4' : 'image/jpeg', url }])) };
        accepted.push(result); return result;
    };
    const f = await setup(send), videos = Array.from({ length: 5 }, (_, i) => `https://video.twimg.com/ext_tw_video/${i}/clip.mp4`);
    const photos = Array.from({ length: 15 }, (_, i) => `https://pbs.twimg.com/media/photo${i}.jpg`);
    const steps = [{ files: [...photos.slice(0, 5), ...videos], embeds: [{ title: 'fixture' }], send: 'channel',
        twitterGrid: { imageUrls: photos.slice(0, 5), sequence: 0, totalParts: 2, embedStart: 0, embedEnd: 1 } },
    { files: photos.slice(5), send: 'channel', requiresPreviousSuccess: true,
        twitterGrid: { imageUrls: photos.slice(5), sequence: 1, totalParts: 2 } }];
    try {
        const result = await f.run(steps), row = await f.storage.get(f.saved.at(-1).id, guildId, channelId);
        assert.equal(result.outcome, 'F'); assert.equal(row.payload.partsState, 'complete');
        assert.deepEqual(row.payload.imageUrls, photos);
        assert.deepEqual(row.payload.messageIds, [accepted[0].id, accepted[2].id, accepted[3].id]);
        assert.ok(!row.payload.messageIds.includes(accepted[1].id));
    } finally { await f.db.close(); }
});

test('real DB manifest stays complete across local size splits and Discord 413 subdivisions', { timeout: 60000 }, async () => {
    const bytes = Buffer.alloc(9 * 1024 * 1024), accepted = []; let n = 0;
    const media = { MAX_MEDIA_BYTES: 25 * 1024 * 1024,
        validateTwitterMediaUrl: url => ({ url: new URL(url), kind: 'photo' }),
        fetchTwitterMedia: async () => ({ data: bytes, kind: 'photo', format: 'jpeg' }) };
    const send = async payload => {
        if (payload.files.reduce((sum, file) => sum + file.attachment.length, 0) > 25 * 1024 * 1024) throw { status: 413 };
        const id = String(555555555555555550n + BigInt(++n));
        const result = { id, channelId, author: { id: bot }, content: '', embeds: payload.embeds || [], components: payload.components || [],
            attachments: new Map(payload.files.map((file, i) => [String(i), { id: `${id}${i}`, name: file.name, contentType: 'image/jpeg', url: file.fallbackUrl }])) };
        accepted.push(result); return result;
    };
    const f = await setup(send, media), urls = Array.from({ length: 20 }, (_, i) => `https://pbs.twimg.com/media/photo${i}.jpg`);
    const steps = sourceSteps(urls); steps.forEach(step => { step.safeTwitterMedia = true; });
    try {
        const result = await f.run(steps), row = await f.storage.get(f.saved.at(-1).id, guildId, channelId);
        assert.equal(result.outcome, 'F'); assert.deepEqual(f.post, ['delete']);
        assert.ok(accepted.length > 2); assert.equal(row.payload.partsState, 'complete');
        assert.equal(row.payload.completedParts, accepted.length); assert.deepEqual(row.payload.imageUrls, urls);
        assert.deepEqual(row.payload.messageIds, accepted.map(message => message.id));
    } finally { await f.db.close(); }
});

test('413 split keeps inline quote and parent image manifests separate and complete', { timeout: 60000 }, async () => {
    let n = 0; const accepted = [];
    const send = async payload => {
        if (payload.files.length > 5) throw { status: 413 };
        const id = String(555555555555555550n + BigInt(++n));
        const result = { id, channelId, author: { id: bot }, content: '', embeds: payload.embeds || [], components: payload.components || [],
            attachments: new Map(payload.files.map((url, i) => [String(i), { id: `${id}${i}`, name: `p${i}.jpg`, contentType: 'image/jpeg', url }])) };
        accepted.push(result); return result;
    };
    const f = await setup(send), urls = Array.from({ length: 20 }, (_, i) => `https://pbs.twimg.com/media/photo${i}.jpg`);
    const quoted = ['https://pbs.twimg.com/media/quoteA.jpg', 'https://pbs.twimg.com/media/quoteB.jpg'];
    const steps = sourceSteps(urls);
    steps[0].embeds.push(...quoted.map(url => ({ image: { url } })));
    steps[0].twitterGridSharedInline = true;
    steps[0].twitterGridInline = [{ imageUrls: quoted, sequence: 0, totalParts: 1, embedStart: 1, embedEnd: 3 }];
    try {
        const result = await f.run(steps);
        assert.equal(result.outcome, 'F');
        const rows = await f.db.queryDatabase('SELECT payload_json FROM bot_media_galleries WHERE message_id IS NOT NULL');
        assert.equal(rows.length, 2);
        const values = rows.map(row => JSON.parse(row.payload_json)), primary = values.find(value => value.isPrimary), quote = values.find(value => !value.isPrimary);
        assert.equal(primary.partsState, 'complete'); assert.deepEqual(primary.imageUrls, urls); assert.equal(primary.completedParts, 4);
        assert.equal(quote.partsState, 'complete'); assert.deepEqual(quote.imageUrls, quoted); assert.equal(quote.completedParts, 1);
        assert.equal(quote.messageIds[0], accepted[0].id); assert.deepEqual([quote.embedStart, quote.embedEnd], [1, 3]);
    } finally { await f.db.close(); }
});

test('unbound grid rows are removed only after known unpublished failures or no-button fallback', { timeout: 60000 }, async () => {
    for (const scenario of ['denied', 'fallback', 'unknown']) {
        let calls = 0;
        const send = async payload => {
            calls++;
            if (scenario === 'denied') throw { status: 403, code: 50013 };
            if (scenario === 'unknown') throw Object.assign(new Error('response lost'), { code: 'ECONNRESET' });
            if (payload.files?.length) throw { status: 413 };
            return { id: '555555555555555551', channelId, author: { id: bot }, content: payload.content || '', embeds: payload.embeds || [], components: payload.components || [], attachments: new Map() };
        };
        const f = await setup(send), urls = ['https://pbs.twimg.com/media/a.jpg', 'https://pbs.twimg.com/media/b.jpg'];
        const steps = [{ files: [urls[0]], embeds: [{ title: 'fixture' }, { image: { url: urls[1] } }], send: 'channel', deleteSource: true,
            twitterGrid: { imageUrls: urls, sequence: 0, totalParts: 1, embedStart: 0, embedEnd: 2 } }];
        try {
            const result = await f.run(steps);
            const rows = await f.db.queryDatabase('SELECT message_id FROM bot_media_galleries');
            assert.equal(rows.length, scenario === 'unknown' ? 1 : 0, scenario);
            if (scenario === 'unknown') { assert.equal(rows[0].message_id, null); assert.equal(result.outcome, 'U'); assert.deepEqual(f.post, []); }
            if (scenario === 'denied') { assert.equal(result.outcome, 'E'); assert.deepEqual(f.post, []); }
            if (scenario === 'fallback') { assert.equal(result.outcome, 'D'); assert.equal(calls, 2); }
        } finally { await f.db.close(); }
    }
});

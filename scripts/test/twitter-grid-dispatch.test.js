'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');

function fixture(send, grid, media, telemetry, singleAttempt) {
    const filename = require.resolve('../../src/providers/_dispatcher'), actual = createRequire(filename), mod = { exports: {} }, post = [];
    const mocks = {
        '../adminSupport/telemetry': telemetry || { event() {}, errorData: v => v, serializable: v => v },
        '../errorTracking': { recordError() {}, recordMetric() {}, recordAnalyticsEvent() {} },
        '../state': { incrementProcessedCounters() {} }, '../settings': { checkComponentIncludesDisabledButtonAndIfFindDeleteIt: async rows => rows },
        '../sharedPostHistory': { run: (_m, steps, _c, run) => run(steps) }, '../mediaGallery': { prepare: async step => ({ step }), report() {} },
        '../personalLinks/cards': { prepare: async step => ({ step }) }, '../twitterGridCards': grid,
        './twitter/singleAttemptSender': singleAttempt === undefined ? { forMessage: () => ({ send }) } : singleAttempt,
        ...(media ? { './twitter/safeMedia': media } : {}),
    };
    compileFunction(readFileSync(filename, 'utf8'), ['require','module','exports','console'], { filename })(id => mocks[id] || actual(id), mod, mod.exports, { warn() {}, log() {} });
    const message = { guildId: '3', channelId: '4', channel: { send }, reply: send, delete: async () => post.push('delete'), suppressEmbeds: async () => post.push('suppress') };
    return { run: steps => mod.exports.runSendSteps(message, steps, 'twitter', {}), post };
}
test('dependent image continuation is not sent and source is not cleaned after its parent fails', async () => {
    let calls = 0; const noGrid = { prepare: async step => ({ step }) };
    const f = fixture(async () => { calls++; throw { status: 403, code: 50013 }; }, noGrid);
    const out = await f.run([{ files: ['https://pbs.twimg.com/media/one'], deleteSource: true }, { files: ['https://pbs.twimg.com/media/two'], requiresPreviousSuccess: true }]);
    assert.equal(calls, 1); assert.deepEqual(f.post, []); assert.equal(out.outcome, 'E');
});
function mockMedia(fetch) {
    return { MAX_MEDIA_BYTES: 25 * 1024 * 1024, validateTwitterMediaUrl: url => {
        const parsed = new URL(url);
        if (!['pbs.twimg.com', 'video.twimg.com'].includes(parsed.hostname)) throw Object.assign(Error('unsafe'), { code: 'TWITTER_MEDIA_UNSAFE_URL' });
        return { url: parsed, kind: parsed.hostname === 'video.twimg.com' ? 'video' : 'photo' };
    }, fetchTwitterMedia: async (url, options) => {
        const result = await fetch(url, options), parsed = new URL(url);
        const format = result.format || (parsed.hostname === 'video.twimg.com' ? 'mp4' : parsed.searchParams.get('format') || 'jpeg');
        return { ...result, format: format === 'jpg' ? 'jpeg' : format };
    } };
}

test('a definite Discord 413 splits X attachments without losing order or repeating the embed', async () => {
    const accepted = [], attempts = [];
    const f = fixture(async payload => {
        attempts.push(payload);
        if ((payload.files || []).length > 5) throw { status: 413 };
        accepted.push(payload); return { id: String(accepted.length) };
    }, { prepare: async step => ({ step }) });
    const urls = Array.from({ length: 20 }, (_, index) => `https://pbs.twimg.com/media/p${index}.jpg`);
    const result = await f.run([
        { files: urls.slice(0, 10), content: 'Post', embeds: [{ title: 'Post' }], send: 'channel', deleteSource: true },
        { files: urls.slice(10), send: 'channel', requiresPreviousSuccess: true },
    ]);
    assert.deepEqual(accepted.map(payload => payload.files.length), [5, 5, 5, 5]);
    assert.deepEqual(accepted.flatMap(payload => payload.files), urls);
    assert.equal(accepted[0].content, 'Post'); assert.equal(accepted[0].embeds[0].title, 'Post');
    assert.ok(accepted.slice(1).every(payload => !payload.content && !payload.embeds));
    assert.equal(attempts.length, 6); assert.equal(result.outcome, 'F'); assert.deepEqual(f.post, ['delete']);
});

test('ambiguous errors, including a SyntaxError carrying status 413, never trigger split retries', async () => {
    for (const error of [Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }), Object.assign(new SyntaxError('bad response'), { status: 413 })]) {
        let calls = 0;
        const f = fixture(async () => { calls++; throw error; }, { prepare: async step => ({ step }) });
        const result = await f.run([{ files: ['https://pbs.twimg.com/media/a.jpg', 'https://pbs.twimg.com/media/b.jpg'], deleteSource: true }]);
        assert.equal(calls, 1); assert.equal(result.outcome, 'U'); assert.deepEqual(f.post, []);
    }
});

test('413 subdivisions reuse already verified Fx bytes instead of downloading again', async () => {
    let fetched = 0; const accepted = [];
    const media = mockMedia(async url => { fetched++; return { data: Buffer.from(url), kind: 'photo' }; });
    const f = fixture(async payload => {
        if ((payload.files || []).length > 3) throw { status: 413 };
        accepted.push(payload); return { id: String(accepted.length) };
    }, { prepare: async step => ({ step }) }, media);
    const urls = Array.from({ length: 10 }, (_, index) => `https://pbs.twimg.com/media/p${index}?format=jpg`);
    const result = await f.run([{ files: urls, safeTwitterMedia: true }]);
    assert.equal(fetched, 10); assert.equal(result.outcome, 'F');
    assert.deepEqual(accepted.flatMap(payload => payload.files.map(file => file.attachment.toString())), urls);
});

test('413 retry telemetry never calls Buffer.toJSON or retains attachment bytes', async () => {
    const snapshots = [], bytes = Buffer.alloc(1024, 7);
    Object.defineProperty(bytes, 'toJSON', { value: () => { throw new Error('must not expand Buffer into an array'); } });
    const telemetry = { event() {}, errorData: value => value, serializable(value) {
        const out = JSON.parse(JSON.stringify(value)); snapshots.push(out); return out;
    } };
    const media = mockMedia(async () => ({ data: bytes, kind: 'photo', format: 'jpeg' }));
    const f = fixture(async payload => {
        if (payload.files?.length > 1) throw { status: 413 };
        return { id: 'sent' };
    }, { prepare: async step => ({ step }) }, media, telemetry);
    const result = await f.run([{ files: ['https://pbs.twimg.com/media/a?format=jpg', 'https://pbs.twimg.com/media/b?format=jpg'], safeTwitterMedia: true }]);
    assert.equal(result.outcome, 'F');
    const binaries = snapshots.flatMap(snapshot => snapshot.files || []).map(file => file?.attachment).filter(value => value?.type === 'binary');
    assert.ok(binaries.length >= 2); assert.ok(binaries.every(value => value.omitted === true && value.byteLength === 1024 && /^[a-f0-9]{64}$/.test(value.sha256)));
});

test('attachment telemetry preserves redaction, typed binary metadata, circular handling and the sent object', async () => {
    const real = require('../../src/adminSupport/telemetry'), snapshots = [], bytes = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4);
    const file = { attachment: bytes, name: 'fixture.png', token: 'fixture-secret' }, embed = { title: 'fixture' };
    embed.self = embed;
    const telemetry = { event() {}, errorData: value => value, serializable(value) {
        const out = real.serializable(value); snapshots.push(out); return out;
    } };
    const f = fixture(async payload => { assert.equal(payload.files[0], file); return { id: 'sent' }; }, { prepare: async step => ({ step }) }, null, telemetry);
    const result = await f.run([{ files: [file], embeds: [embed] }]);
    assert.equal(result.outcome, 'F');
    assert.equal(snapshots[0].files[0].token, undefined);
    assert.deepEqual({ type: snapshots[0].files[0].attachment.type, omitted: snapshots[0].files[0].attachment.omitted, byteLength: snapshots[0].files[0].attachment.byteLength },
        { type: 'binary', omitted: true, byteLength: 3 });
    assert.equal(snapshots[0].files[0].attachment.sha256, require('node:crypto').createHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex'));
    assert.equal(snapshots[0].embeds[0].self, '[circular]');
});

test('attachment telemetry preserves class toJSON semantics and circular file fields', async () => {
    const real = require('../../src/adminSupport/telemetry'), bytes = Buffer.from([1, 2, 3]), snapshots = [];
    let calls = 0;
    class File {
        constructor() { this.attachment = bytes; this.name = 'fixture.png'; }
        toJSON(key) { calls++; assert.equal(key, '0'); return { attachment: this.attachment, name: this.name, extra: 'from-json' }; }
    }
    const file = new File(), cyclic = { attachment: bytes, name: 'cyclic.png' }; cyclic.self = cyclic;
    const expectedClass = real.serializable({ files: [file] }); assert.equal(calls, 1);
    const expectedCycle = real.serializable({ files: [cyclic] });
    const telemetry = { event() {}, errorData: value => value, serializable(value) { const out = real.serializable(value); snapshots.push(out); return out; } };
    let sends = 0;
    const f = fixture(async payload => {
        assert.equal(payload.files[0], sends++ === 0 ? file : cyclic);
        return { id: String(sends) };
    }, { prepare: async step => ({ step }) }, null, telemetry);
    await f.run([{ files: [file] }]); await f.run([{ files: [cyclic] }]);
    assert.equal(calls, 2, 'toJSON is called exactly once by each serialization');
    assert.deepEqual(snapshots[0], expectedClass); assert.deepEqual(snapshots[1], expectedCycle);
});

test('a file toJSON returning itself is invoked once and preserves original serializer output', async () => {
    const real = require('../../src/adminSupport/telemetry'), snapshots = [], bytes = Buffer.from([1, 2, 3]);
    let calls = 0;
    const file = { attachment: bytes, name: 'fixture.png', token: 'fixture-secret', toJSON(key) { calls++; assert.equal(key, '0'); return this; } };
    const expected = real.serializable({ files: [file] }); assert.equal(calls, 1);
    const telemetry = { event() {}, errorData: value => value, serializable(value) { const out = real.serializable(value); snapshots.push(out); return out; } };
    const f = fixture(async payload => { assert.equal(payload.files[0], file); return { id: 'sent' }; }, { prepare: async step => ({ step }) }, null, telemetry);
    const result = await f.run([{ files: [file] }]);
    assert.equal(result.outcome, 'F'); assert.equal(calls, 2); assert.deepEqual(snapshots[0], expected);
});

test('non-Fx attachment metadata retains the original nested toJSON receiver', async () => {
    const real = require('../../src/adminSupport/telemetry'), snapshots = [], nested = { toJSON() { return this === nested ? 'original' : 'copy'; } };
    const file = { attachment: Buffer.from([1, 2, 3]), metadata: nested }, expected = real.serializable({ files: [file] });
    const telemetry = { event() {}, errorData: value => value, serializable(value) { const out = real.serializable(value); snapshots.push(out); return out; } };
    const f = fixture(async payload => { assert.equal(payload.files[0], file); return { id: 'sent' }; }, { prepare: async step => ({ step }) }, null, telemetry);
    await f.run([{ files: [file] }]);
    assert.deepEqual(snapshots[0], expected); assert.equal(snapshots[0].files[0].metadata, 'original');
});

test('a throwing file toJSON never reaches Discord or cleans up the source', async () => {
    let sends = 0; const file = { attachment: Buffer.from([1]), toJSON() { throw new Error('fixture failure'); } };
    const real = require('../../src/adminSupport/telemetry');
    const telemetry = { event() {}, errorData: value => value, serializable: real.serializable };
    const f = fixture(async () => { sends++; return { id: 'unexpected' }; }, { prepare: async step => ({ step }) }, null, telemetry);
    const result = await f.run([{ files: [file], deleteSource: true }]);
    assert.equal(sends, 0); assert.equal(result.outcome, 'E'); assert.deepEqual(f.post, []);
});

test('definite pre-submit batch overflow splits before posting and keeps every photo ordered', async () => {
    const bytes = Buffer.alloc(9 * 1024 * 1024), accepted = [], attempts = [];
    const media = mockMedia(async () => ({ data: bytes, kind: 'photo', format: 'jpeg' }));
    const f = fixture(async payload => {
        const size = (payload.files || []).reduce((n, file) => n + file.attachment.length, 0);
        attempts.push(size);
        if (size > 25 * 1024 * 1024) throw { status: 413 };
        accepted.push(payload); return { id: String(accepted.length) };
    }, { prepare: async step => ({ step }) }, media);
    const urls = Array.from({ length: 10 }, (_, index) => `https://pbs.twimg.com/media/p${index}?format=jpg`);
    const result = await f.run([{ files: urls, safeTwitterMedia: true, deleteSource: true }]);
    assert.equal(result.outcome, 'F'); assert.deepEqual(f.post, ['delete']);
    assert.ok(accepted.length > 2); assert.deepEqual(accepted.flatMap(payload => payload.files.map(file => file.fallbackUrl)), urls);
    assert.ok(attempts.every(size => size <= 45 * 1024 * 1024), 'the overflowing 90 MiB batch never entered Discord');
    assert.ok(result.attempts.some(item => item.error?.code === 'TWITTER_MEDIA_BATCH_TOO_LARGE' && item.outcome === 'failed'));
});

test('other local media failures never trigger a batch split', async () => {
    for (const code of ['TWITTER_MEDIA_FETCH_FAILED', 'TWITTER_MEDIA_FORMAT', 'TWITTER_MEDIA_UNSAFE_URL', 'TWITTER_MEDIA_TOO_LARGE']) {
        let fetches = 0; const posted = [];
        const media = mockMedia(async () => { fetches++; throw Object.assign(new Error(code), { code }); });
        const f = fixture(async payload => { posted.push(payload); return { id: 'fallback' }; }, { prepare: async step => ({ step }) }, media);
        const urls = Array.from({ length: 10 }, (_, index) => `https://pbs.twimg.com/media/p${index}?format=jpg`);
        const result = await f.run([{ files: urls, safeTwitterMedia: true }]);
        assert.equal(result.plannedSteps, 1, code); assert.equal(posted.length, 1, code);
        assert.equal(posted[0].files, undefined, code); assert.equal(result.outcome, 'D', code);
        assert.ok(fetches <= 3, code);
    }
});

test('a concurrent invalid media error takes precedence over a local batch-size overflow', async () => {
    const bytes = Buffer.alloc(9 * 1024 * 1024), posted = [];
    const media = mockMedia(async url => {
        if (url.includes('/p9?')) { await new Promise(resolve => setTimeout(resolve, 20)); throw Object.assign(new Error('bad format'), { code: 'TWITTER_MEDIA_FORMAT' }); }
        return { data: bytes, kind: 'photo', format: 'jpeg' };
    });
    const f = fixture(async payload => { posted.push(payload); return { id: 'fallback' }; }, { prepare: async step => ({ step }) }, media);
    const urls = Array.from({ length: 10 }, (_, index) => `https://pbs.twimg.com/media/p${index}?format=jpg`);
    const result = await f.run([{ files: urls, safeTwitterMedia: true }]);
    assert.equal(result.plannedSteps, 1); assert.equal(posted.length, 1);
    assert.equal(posted[0].files, undefined); assert.equal(result.outcome, 'D');
});

test('a same-named error from an already-started Discord submission is never treated as local overflow', async () => {
    let posts = 0;
    const media = mockMedia(async url => ({ data: Buffer.from(url), kind: 'photo', format: 'jpeg' }));
    const f = fixture(async () => { posts++; throw Object.assign(new Error('connection lost'), { code: 'TWITTER_MEDIA_BATCH_TOO_LARGE' }); },
        { prepare: async step => ({ step }) }, media);
    const result = await f.run([{ files: ['https://pbs.twimg.com/media/a?format=jpg', 'https://pbs.twimg.com/media/b?format=jpg'], safeTwitterMedia: true, deleteSource: true }]);
    assert.equal(posts, 1); assert.equal(result.outcome, 'U'); assert.deepEqual(f.post, []);
});
test('Fx twenty photos use bounded prepared buffers and preserve attachment order over two posts', async () => {
    const payloads = [], noGrid = { prepare: async step => ({ step }) };
    const media = mockMedia(async url => { await new Promise(r => setTimeout(r, Number(url.match(/photo(\d+)/)[1]) % 3)); return { data: Buffer.from(url), kind: 'photo' }; });
    const f = fixture(async payload => { payloads.push(payload); return { id: String(payloads.length) }; }, noGrid, media);
    const photos = Array.from({ length: 20 }, (_, i) => `https://pbs.twimg.com/media/photo${i}?format=jpg`);
    const result = await f.run([{ files: photos.slice(0, 10), safeTwitterMedia: true, send: 'channel' }, { files: photos.slice(10), safeTwitterMedia: true, send: 'channel', requiresPreviousSuccess: true }]);
    assert.equal(result.outcome, 'F'); assert.equal(payloads.length, 2);
    assert.deepEqual(payloads.flatMap(p => p.files.map(f => f.attachment.toString())), photos);
    assert.ok(payloads.every(p => p.files.length === 10 && p.files.every(f => Buffer.isBuffer(f.attachment))));
});
test('Fx redirect rejection or size failure falls back to validated source links without duplicate submission', async () => {
    for (const code of ['TWITTER_MEDIA_REDIRECT', 'TWITTER_MEDIA_TOO_LARGE']) {
        const sent = [], noGrid = { prepare: async step => ({ step }) };
        const media = mockMedia(async () => { throw Object.assign(Error(code), { code }); });
        const f = fixture(async payload => { sent.push(structuredClone(payload)); return { id: '1' }; }, noGrid, media);
        const url = 'https://pbs.twimg.com/media/one?format=jpg';
        const out = await f.run([{ files: [url], safeTwitterMedia: true, deleteSource: true }]);
        assert.equal(sent.length, 1); assert.equal(sent[0].content, url); assert.equal(sent[0].files, undefined);
        assert.equal(out.outcome, 'D'); assert.deepEqual(f.post, ['delete']);
    }
});
test('Fx rejects an untrusted host without sending it or deleting the source', async () => {
    const sent = [], media = mockMedia(async () => assert.fail('unsafe media must not be fetched'));
    const f = fixture(async payload => { sent.push(payload); return { id: '1' }; }, { prepare: async step => ({ step }) }, media);
    const out = await f.run([{ files: ['https://127.0.0.1/private'], embeds: [{ title: 'Post' }], safeTwitterMedia: true, deleteSource: true }]);
    assert.equal(sent.length, 1); assert.equal(sent[0].content, undefined); assert.deepEqual(f.post, []); assert.equal(out.outcome, 'D');
});
test('after an uncertain Discord submission prepared Fx files are never automatically resubmitted', async () => {
    let attempts = 0; const media = mockMedia(async url => ({ data: Buffer.from(url), kind: 'photo' }));
    const f = fixture(async () => { attempts++; throw new SyntaxError('response truncated'); }, { prepare: async step => ({ step }) }, media);
    const out = await f.run([{ files: ['https://pbs.twimg.com/media/one?format=jpg'], safeTwitterMedia: true, deleteSource: true }]);
    assert.equal(attempts, 1); assert.equal(out.outcome, 'U'); assert.deepEqual(f.post, []);
});
test('Fx preparation preserves spoiler filenames and non-Fx providers retain their original payloads', async () => {
    const sent = [], media = mockMedia(async url => ({ data: Buffer.from(url), kind: 'photo' }));
    const f = fixture(async payload => { sent.push(payload); return { id: String(sent.length) }; }, { prepare: async step => ({ step }) }, media);
    await f.run([{ files: [{ attachment: 'https://pbs.twimg.com/media/one?format=jpg', spoiler: true }], safeTwitterMedia: true }]);
    assert.match(sent[0].files[0].name, /^SPOILER_/); assert.equal(sent[0].files[0].spoiler, true);
    await f.run([{ files: ['https://legacy.example/photo.jpg'] }]); assert.equal(sent[1].files[0], 'https://legacy.example/photo.jpg');
});
test('Fx AVIF and MP4 retain their correct extensions and do not change media order', async () => {
    const sent = [], noGrid = { prepare: async step => ({ step }) };
    const media = mockMedia(async url => ({ data: Buffer.from(url), kind: url.includes('video.twimg.com') ? 'video' : 'photo' }));
    const f = fixture(async payload => { sent.push(payload); return { id: '1' }; }, noGrid, media);
    const urls = ['https://pbs.twimg.com/media/a?format=avif', 'https://video.twimg.com/ext_tw_video/1/pu/vid/clip.mp4', 'https://pbs.twimg.com/media/b?format=png'];
    await f.run([{ files: urls, safeTwitterMedia: true }]);
    assert.deepEqual(sent[0].files.map(file => file.attachment.toString()), urls);
    assert.deepEqual(sent[0].files.map(file => file.name), ['twitter-media-1.avif', 'twitter-media-2.mp4', 'twitter-media-3.png']);
});
test('Fx invalid image format is rejected before fetching and never exposed through fallback', async () => {
    const sent = [], noGrid = { prepare: async step => ({ step }) }, safe = require('../../src/providers/twitter/safeMedia');
    const media = { ...safe, fetchTwitterMedia: async () => assert.fail('invalid format must not be fetched') };
    const f = fixture(async payload => { sent.push(payload); return { id: '1' }; }, noGrid, media);
    const result = await f.run([{ files: ['https://pbs.twimg.com/media/a?format=exe'], embeds: [{ title: 'Post' }], safeTwitterMedia: true, deleteSource: true }]);
    assert.equal(sent.length, 1); assert.equal(sent[0].content, undefined); assert.deepEqual(f.post, []); assert.equal(result.outcome, 'D');
});
test('Fx names use detected bytes rather than an absent or misleading URL extension', async () => {
    const sent = [], noGrid = { prepare: async step => ({ step }) };
    const media = mockMedia(async () => ({ data: Buffer.from('fake valid bytes from validator'), kind: 'photo', format: 'avif' }));
    const f = fixture(async payload => { sent.push(payload); return { id: '1' }; }, noGrid, media);
    await f.run([{ files: [{ attachment: 'https://pbs.twimg.com/media/a?format=jpg', name: 'SPOILER_photo.jpg' }, 'https://pbs.twimg.com/media/b'], safeTwitterMedia: true }]);
    assert.deepEqual(sent[0].files.map(file => file.name), ['SPOILER_photo.avif', 'twitter-media-2.avif']);
});
test('real safe fetch detects decoded PNG despite a JPEG URL and rejects forged JPEG bytes', async () => {
    const { Readable } = require('node:stream'), sharp = require('sharp'), safe = require('../../src/providers/twitter/safeMedia');
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer();
    let body = png; const media = { ...safe, fetchTwitterMedia: (url, options) => safe.fetchTwitterMedia(url, { ...options,
        fetch: async () => ({ status: 200, ok: true, body: Readable.from([body]), headers: { get: () => null } }) }) };
    const sent = [], noGrid = { prepare: async step => ({ step }) };
    const f = fixture(async payload => { sent.push(payload); return { id: String(sent.length) }; }, noGrid, media);
    const url = 'https://pbs.twimg.com/media/a?format=jpg';
    await f.run([{ files: [url], safeTwitterMedia: true }]); assert.equal(sent[0].files[0].name, 'twitter-media-1.png');
    body = Buffer.from('ffd8ffe000000000', 'hex'); await f.run([{ files: [url], safeTwitterMedia: true }]);
    assert.equal(sent[1].files, undefined); assert.equal(sent[1].content, url);
});
test('Fx rejects a video masquerading as a photo before Discord submission', async () => {
    const sent = [], noGrid = { prepare: async step => ({ step }) };
    const media = mockMedia(async () => ({ data: Buffer.from('video'), kind: 'photo', format: 'mp4' }));
    const f = fixture(async payload => { sent.push(payload); return { id: '1' }; }, noGrid, media);
    const url = 'https://pbs.twimg.com/media/a?format=jpg';
    await f.run([{ files: [url], safeTwitterMedia: true }]);
    assert.equal(sent.length, 1); assert.equal(sent[0].files, undefined); assert.equal(sent[0].content, url);
});
test('Fx media preparation has a global batch concurrency limit', async () => {
    let release, started, active = 0, peak = 0, starts = 0;
    const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { started = resolve; });
    const media = mockMedia(async url => { active++; peak = Math.max(peak, active); if (++starts === 2) started(); await gate; active--; return { data: Buffer.from(url), kind: 'photo' }; });
    let id = 0; const f = fixture(async () => ({ id: String(++id) }), { prepare: async step => ({ step }) }, media);
    const jobs = Array.from({ length: 3 }, (_, i) => f.run([{ files: [`https://pbs.twimg.com/media/photo${i}?format=jpg`], safeTwitterMedia: true }]));
    await ready; await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(starts, 2);
    release(); await Promise.all(jobs); assert.equal(starts, 3); assert.equal(peak, 2);
});
test('Fx buffer admission stays reserved while Discord responses are pending and releases after completion', async () => {
    let release, bothStarted, fetched = 0, sends = 0;
    const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { bothStarted = resolve; });
    const media = mockMedia(async url => { fetched++; return { data: Buffer.from(url), kind: 'photo' }; });
    const f = fixture(async () => { if (++sends === 2) bothStarted(); await gate; return { id: String(sends) }; }, { prepare: async step => ({ step }) }, media);
    const jobs = Array.from({ length: 3 }, (_, i) => f.run([{ files: [`https://pbs.twimg.com/media/lease${i}?format=jpg`], safeTwitterMedia: true }]));
    await ready; await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fetched, 2, 'the third batch cannot allocate buffers while the first two sends are in flight');
    release(); await Promise.all(jobs); assert.equal(fetched, 3);
});
test('Fx buffer admission is released after ambiguous Discord failures', async () => {
    let release, bothStarted, fetched = 0, sends = 0;
    const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { bothStarted = resolve; });
    const media = mockMedia(async url => { fetched++; return { data: Buffer.from(url), kind: 'photo' }; });
    const f = fixture(async () => { if (++sends === 2) bothStarted(); await gate; throw Object.assign(new Error('lost response'), { code: 'ECONNRESET' }); }, { prepare: async step => ({ step }) }, media);
    const jobs = Array.from({ length: 3 }, (_, i) => f.run([{ files: [`https://pbs.twimg.com/media/fail${i}?format=jpg`], safeTwitterMedia: true }]));
    await ready; await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(fetched, 2);
    release(); const results = await Promise.all(jobs);
    assert.equal(fetched, 3); assert.ok(results.every(result => result.outcome === 'U'));
});
test('grid is bound only after the first post succeeds and completed only after the second succeeds', async () => {
    const calls = [], item = { id: 'grid', totalParts: 2 };
    const logic = { prepare: async step => step.twitterGrid?.sequence === 0 ? { step, grids: [item] } : { step },
        bind: async (_, sent) => { calls.push(['bind', sent.id]); return true; }, append: async (_, part, sent) => { calls.push(['append', part.sequence, sent.id]); return true; } };
    let count = 0; const f = fixture(async () => ({ id: String(++count) }), logic);
    await f.run([{ files: ['https://pbs.twimg.com/media/one'], send: 'channel', twitterGrid: { sequence: 0, imageUrls: ['https://pbs.twimg.com/media/one'] } }, { files: ['https://pbs.twimg.com/media/two'], send: 'channel', twitterGrid: { sequence: 1, imageUrls: ['https://pbs.twimg.com/media/two'] }, requiresPreviousSuccess: true }]);
    assert.deepEqual(calls, [['bind', '1'], ['append', 1, '2']]);
});
test('continuation failure distinguishes definite rejection, uncertain delivery and file fallback', async () => {
    for (const scenario of ['denied', 'unknown', 'fallback']) {
        const states = [], item = { id: 'grid', totalParts: 2 };
        const logic = { prepare: async step => step.twitterGrid?.sequence === 0 ? { step, grids: [item] } : { step },
            bind: async () => true, append: async () => assert.fail('no undelivered part can be appended'), markIncomplete: async (_, state) => states.push(state) };
        let calls = 0;
        const f = fixture(async payload => {
            calls++;
            if (calls === 1) return { id: '1' };
            if (scenario === 'denied') throw { status: 403, code: 50013 };
            if (scenario === 'unknown') throw Object.assign(new Error('connection closed'), { code: 'ECONNRESET' });
            if (payload.files) throw { status: 413 };
            return { id: 'fallback' };
        }, logic);
        await f.run([{ files: ['https://pbs.twimg.com/media/one'], send: 'channel', twitterGrid: { sequence: 0, imageUrls: ['https://pbs.twimg.com/media/one'] } },
            { files: ['https://pbs.twimg.com/media/two'], send: 'channel', twitterGrid: { sequence: 1, imageUrls: ['https://pbs.twimg.com/media/two'] }, requiresPreviousSuccess: true }]);
        assert.deepEqual(states, [scenario === 'unknown' ? 'delivery_unknown' : 'failed']);
        assert.equal(calls, scenario === 'fallback' ? 3 : 2);
    }
});
test('confirmed continuation with failed persistence marks record status unknown without resending', async () => {
    for (const throws of [false, true]) {
        const states = [], item = { id: 'grid', totalParts: 2 };
        const logic = { prepare: async step => step.twitterGrid?.sequence === 0 ? { step, grids: [item] } : { step }, bind: async () => true,
            append: async () => { if (throws) throw Error('connection lost'); return false; }, markIncomplete: async (_, state) => { states.push(state); throw Error('database unavailable'); } };
        let calls = 0; const f = fixture(async () => ({ id: String(++calls) }), logic);
        const result = await f.run([{ files: ['https://pbs.twimg.com/media/one'], send: 'channel', twitterGrid: { sequence: 0, imageUrls: ['https://pbs.twimg.com/media/one'] } },
            { files: ['https://pbs.twimg.com/media/two'], send: 'channel', twitterGrid: { sequence: 1, imageUrls: ['https://pbs.twimg.com/media/two'] }, requiresPreviousSuccess: true }]);
        assert.deepEqual(states, ['record_unknown']); assert.equal(calls, 2); assert.equal(result.sent.length, 2);
    }
});
test('a failed first-part completion record is unknown and never resends the acknowledged message', async () => {
    const states = [], item = { id: 'grid', isPrimary: true, totalParts: 1 };
    const logic = { prepare: async step => ({ step, grids: [item] }), bind: async () => true,
        finish: async () => { throw Error('DB acknowledgement lost'); }, markIncomplete: async (_, state) => { states.push(state); return true; } };
    let calls = 0; const f = fixture(async () => ({ id: String(++calls) }), logic);
    const result = await f.run([{ files: ['https://pbs.twimg.com/media/a', 'https://pbs.twimg.com/media/b'],
        twitterGrid: { sequence: 0, totalParts: 1, imageUrls: ['https://pbs.twimg.com/media/a', 'https://pbs.twimg.com/media/b'] } }]);
    assert.equal(calls, 1); assert.equal(result.sent.length, 1); assert.deepEqual(states, ['record_unknown']);
});
test('attachment fallback removes the grid button and never binds undelivered images', async () => {
    const payloads = [], calls = [];
    const logic = { prepare: async step => ({ step, grids: [{ id: 'grid', totalParts: 1 }] }), bind: async () => { calls.push('bind'); } };
    const f = fixture(async payload => { payloads.push(structuredClone(payload)); if (payload.files) throw { status: 413 }; return { id: 'fallback' }; }, logic);
    await f.run([{ files: ['https://pbs.twimg.com/media/one'], components: [{ type: 1, components: [{ type: 2, custom_id: 'tg:secret:0:open' }] }] }]);
    assert.equal(payloads.length, 2); assert.deepEqual(payloads[1].components, []); assert.deepEqual(calls, []);
});

test('only certainly unpublished unbound grid records are discarded', async () => {
    for (const scenario of ['denied', 'fallback', 'unknown']) {
        let posts = 0, discards = 0;
        const item = { id: 'grid', totalParts: 1 }, logic = {
            prepare: async step => ({ step, grids: [item] }),
            discardUnbound: async grids => { assert.deepEqual(grids, [item]); discards++; },
            bind: async () => assert.fail('no grid-bearing post was confirmed'),
        };
        const f = fixture(async payload => {
            posts++;
            if (scenario === 'denied') throw { status: 403, code: 50013 };
            if (scenario === 'unknown') throw Object.assign(new Error('response lost'), { code: 'ECONNRESET' });
            if (payload.files?.length) throw { status: 413 };
            return { id: 'fallback' };
        }, logic);
        const result = await f.run([{ files: ['https://pbs.twimg.com/media/a'],
            components: [{ type: 1, components: [{ type: 2, custom_id: 'tg:secret:0:open' }] }] }]);
        assert.equal(discards, scenario === 'unknown' ? 0 : 1, scenario);
        assert.equal(posts, scenario === 'fallback' ? 2 : 1, scenario);
        if (scenario === 'unknown') assert.equal(result.outcome, 'U');
    }
});

test('when a single-attempt sender cannot be verified no X multi-file post is attempted', async () => {
    let posts = 0;
    const f = fixture(async () => { posts++; throw { status: 413 }; }, { prepare: async step => ({ step }) }, null, null,
        { forMessage: () => null });
    const result = await f.run([{ files: ['https://pbs.twimg.com/media/a', 'https://pbs.twimg.com/media/b'], deleteSource: true }]);
    assert.equal(posts, 0); assert.equal(result.plannedSteps, 1); assert.equal(result.outcome, 'E'); assert.deepEqual(f.post, []);
});

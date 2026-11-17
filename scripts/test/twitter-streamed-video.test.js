'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { REST, DefaultRestOptions } = require('discord.js');
const { prepare, _internal } = require('../../src/providers/twitter/streamedVideo');
const { createSingleAttemptSender } = require('../../src/providers/twitter/singleAttemptSender')._internal;
const VIDEO = 'https://video.twimg.com/ext_tw_video/1/pu/vid/abc.mp4?tag=12';
function response(data, length = data.length) { return { ok: true, status: 200, headers: { get: name => name === 'content-length' ? String(length) : name === 'content-type' ? 'video/mp4' : null }, body: Readable.from([data]) }; }

test('streamed video stages exact bytes in a private file and cleans up', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-stream-test-'));
    try {
        const data = Buffer.from('video-fixture');
        const item = await prepare([VIDEO], { tmpdir: root, fetch: async () => response(data) });
        assert.ok(item); assert.deepEqual(Buffer.from(await item.blob.arrayBuffer()), data);
        assert.equal((await fs.readdir(root)).length, 1);
        await item.cleanup(); assert.deepEqual(await fs.readdir(root), []);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('invalid, truncated and unsupported sources safely return to normal acquisition', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-stream-test-'));
    try {
        assert.equal(await prepare(['https://example.test/video.mp4'], { tmpdir: root, fetch: () => assert.fail('unsupported') }), null);
        assert.equal(await prepare([VIDEO], { tmpdir: root, fetch: async () => response(Buffer.from('abc'), 4) }), null);
        assert.equal(await prepare([VIDEO], { tmpdir: root, fetch: async () => { throw new Error('offline'); } }), null);
        assert.deepEqual(await fs.readdir(root), []);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('small and large video admission are independent and saturation never waits', () => {
    const large = Array.from({ length: 4 }, () => _internal.reserve(_internal.SMALL_LIMIT + 1));
    assert.ok(large.every(Boolean)); assert.equal(_internal.reserve(_internal.SMALL_LIMIT + 1), null);
    const small = _internal.reserve(1024); assert.equal(typeof small, 'function');
    small(); for (const release of large) release();
});

test('real Discord REST transport sends file-backed multipart, reply and metadata once', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-stream-test-'));
    let posts = 0, requestBody;
    const channelId = '333333333333333333', sourceId = '444444444444444444', sentId = '555555555555555555';
    const server = createServer(async (req, res) => {
        posts++; const chunks = []; for await (const chunk of req) chunks.push(chunk); requestBody = Buffer.concat(chunks).toString();
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: sentId, channel_id: channelId }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const item = await prepare([VIDEO], { tmpdir: root, fetch: async () => response(Buffer.from('fixture-video-bytes')) });
        const client = { token: 'fixture', options: { jsonTransformer: value => value, failIfNotExists: true }, rest: { options: { ...DefaultRestOptions } } };
        const channel = { id: channelId, client, messages: { cache: new Map(), resolveId: v => v?.id || v, _add: v => v } };
        const sender = createSingleAttemptSender({ prepareVideo: async () => item, restFactory: options => new REST({ ...options, api: `http://127.0.0.1:${server.address().port}` }) });
        const result = await sender.forMessage({ id: sourceId, channel, client }, 'reply-source').send({ content: 'hello', files: [VIDEO], allowedMentions: { parse: [] } });
        assert.equal(result.id, sentId); assert.equal(posts, 1);
        assert.match(requestBody, /fixture-video-bytes/); assert.match(requestBody, /"content":"hello"/);
        assert.match(requestBody, new RegExp(`"message_id":"${sourceId}"`));
        assert.deepEqual(await fs.readdir(root), []);
    } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
});

test('stale cleanup removes only our old dead-process file without following links', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-sweep-test-'));
    try {
        const old = path.join(root, 'cbte-video-123456-abcdef'), live = path.join(root, 'cbte-video-111111-ghijkl');
        await fs.mkdir(old); await fs.mkdir(live); await fs.writeFile(path.join(old, 'video'), 'old'); await fs.writeFile(path.join(live, 'video'), 'live');
        const timestamp = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); await fs.utimes(old, timestamp, timestamp); await fs.utimes(live, timestamp, timestamp);
        await fs.writeFile(path.join(root, 'other'), 'untouched');
        await _internal.removeStale(root, { isAlive: pid => pid === 111111 });
        assert.deepEqual((await fs.readdir(root)).sort(), ['cbte-video-111111-ghijkl', 'other']);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an uncertain Discord upload is attempted only once and removes staged media', async () => {
    let posts = 0, cleanups = 0;
    const client = { token: 'fixture', options: { jsonTransformer: value => value }, rest: { options: { ...DefaultRestOptions } } };
    const channel = { id: '333333333333333333', client, messages: { cache: new Map(), resolveId: v => v?.id || v, _add: v => v } };
    const sender = createSingleAttemptSender({ prepareVideo: async () => ({ blob: new Blob(['data']), name: 'x.mp4', cleanup: async () => { cleanups++; } }),
        restFactory: () => ({ setToken() {}, async post() { posts++; throw Object.assign(new Error('lost'), { code: 'ECONNRESET' }); } }) });
    await assert.rejects(sender.forMessage({ id: '444444444444444444', channel, client }, 'channel').send({ files: [VIDEO] }), { code: 'ECONNRESET' });
    assert.equal(posts, 1); assert.equal(cleanups, 1);
});

test('large file-backed multipart reaches a separate server intact', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-stream-bench-'));
    const size = Number(process.env.CBTE_STREAM_BENCH_MB || 64) * 1024 * 1024, chunk = Buffer.alloc(256 * 1024, 0x61);
    const baseline = process.memoryUsage().arrayBuffers; let peak = baseline;
    const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().arrayBuffers); }, 2);
    const channelId = '333333333333333333', sentId = '555555555555555555';
    const code = `const http=require('node:http'); const s=http.createServer(async(req,res)=>{let n=0;for await(const c of req)n+=c.length;res.writeHead(n>=${size}?200:400,{'content-type':'application/json'});res.end(JSON.stringify({id:'${sentId}',channel_id:'${channelId}'}));});s.listen(0,'127.0.0.1',()=>console.log(s.address().port));`;
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
        const port = await new Promise((resolve, reject) => { child.stdout.once('data', value => resolve(Number(String(value).trim()))); child.once('error', reject); child.once('exit', code => reject(new Error(`server exited ${code}`))); });
        const stream = Readable.from((async function* () { for (let i = 0; i < size / chunk.length; i++) yield chunk; })());
        const staged = await prepare([VIDEO], { tmpdir: root, fetch: async () => ({ ok: true, status: 200, headers: { get: k => k === 'content-length' ? String(size) : null }, body: stream }) });
        assert.ok(staged);
        const client = { token: 'fixture', options: { jsonTransformer: value => value }, rest: { options: { ...DefaultRestOptions, timeout: 30000 } } };
        const channel = { id: channelId, client, messages: { cache: new Map(), resolveId: v => v?.id || v, _add: v => v } };
        const sender = createSingleAttemptSender({ prepareVideo: async () => staged, restFactory: opts => new REST({ ...opts, api: `http://127.0.0.1:${port}` }) });
        await sender.forMessage({ id: '444444444444444444', channel, client }, 'channel').send({ files: [VIDEO] });
        t.diagnostic(`sender arrayBuffer peak delta: ${peak - baseline} bytes for ${size} bytes`);
        assert.equal(staged.blob.size, size);
        assert.deepEqual(await fs.readdir(root), []);
    } finally { clearInterval(sampler); child.kill(); await fs.rm(root, { recursive: true, force: true }); }
});

test('streamed multipart keeps embeds, buttons, flags and attachment descriptions', async () => {
    const channelId = '333333333333333333', sentId = '555555555555555555'; let payload;
    const client = { token: 'fixture', options: { jsonTransformer: value => value }, rest: { options: { ...DefaultRestOptions } } };
    const channel = { id: channelId, client, messages: { cache: new Map(), resolveId: v => v?.id || v, _add: v => v } };
    const sender = createSingleAttemptSender({ prepareVideo: async () => ({ blob: new Blob(['video']), name: 'clip.mp4', cleanup: async () => {} }),
        restFactory: () => ({ setToken() {}, async post(_route, request) { payload = JSON.parse(request.body.get('payload_json')); return { id: sentId, channel_id: channelId }; } }) });
    const button = { type: 1, components: [{ type: 2, style: 1, custom_id: 'delete:twitter', label: 'Delete' }] };
    await sender.forMessage({ id: '444444444444444444', channel, client }, 'channel').send({ files: [{ attachment: VIDEO, name: 'clip.mp4', description: 'description' }], embeds: [{ title: 'post' }], components: [button], flags: 4096 });
    assert.equal(payload.embeds[0].title, 'post'); assert.equal(payload.components[0].components[0].custom_id, 'delete:twitter');
    assert.equal(payload.flags, 4096); assert.equal(payload.attachments[0].description, 'description');
});


test('an unavailable staging directory falls back without creating a file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-unavailable-test-'));
    try {
        const item = await prepare([VIDEO], { tmpdir: path.join(root, 'missing'), fetch: async () => response(Buffer.from('test')) });
        assert.equal(item, null); assert.deepEqual(await fs.readdir(root), []);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('insufficient free space falls back immediately and releases the size slot', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-low-space-test-'));
    try {
        const item = await prepare([VIDEO], { tmpdir: root, fetch: async () => response(Buffer.from('test')), statfs: async () => ({ bavail: 1, bsize: 4096 }) });
        assert.equal(item, null); assert.deepEqual(await fs.readdir(root), []);
        const held = Array.from({ length: 16 }, () => _internal.reserve(1024));
        assert.ok(held.every(Boolean)); for (const release of held) release();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

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
        assert.equal(await prepare(['data:video/mp4,unsupported'], { tmpdir: root, fetch: () => assert.fail('unsupported') }), null);
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

test('multiple mixed provider URLs and buffers stream in original order', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-multipart-test-'));
    try {
        const first = 'https://images.example.test/a.jpg', second = 'https://media.example.test/b.mp4';
        const values = [Buffer.from('image-one'), Buffer.from('video-two'), Buffer.from('local-three')];
        const staged = await prepare([first, { attachment: second, name: 'second.mp4' }, { attachment: values[2], name: 'third.bin' }], {
            tmpdir: root, fetch: async url => response(url === first ? values[0] : values[1]),
        });
        assert.ok(staged); assert.equal(staged.files.length, 3);
        assert.deepEqual(staged.files.map(item => item.name), ['a.jpg', 'second.mp4', 'third.bin']);
        for (let i = 0; i < values.length; i++) assert.deepEqual(Buffer.from(await staged.files[i].blob.arrayBuffer()), values[i]);
        await staged.cleanup(); assert.deepEqual(await fs.readdir(root), []);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('trusted public URL redirects stage the final resource once', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-redirect-test-'));
    try {
        const first = 'https://media.example.test/redirect', destination = 'https://cdn.example.test/final.mp4', calls = [];
        const staged = await prepare([first], { tmpdir: root, fetch: async url => { calls.push(url); return url === first
            ? { status: 302, headers: { get: () => destination }, body: Readable.from([]) }
            : response(Buffer.from('redirected')); } });
        assert.ok(staged); assert.deepEqual(calls, [first, destination]);
        assert.equal(Buffer.from(await staged.blob.arrayBuffer()).toString(), 'redirected');
        await staged.cleanup();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('failure during a later part discards staged files before falling back', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-part-fail-test-'));
    try {
        let calls = 0;
        const staged = await prepare(['https://images.example.test/one.jpg', 'https://images.example.test/two.jpg'], {
            tmpdir: root, fetch: async () => { calls++; if (calls === 2) throw new Error('fixture failure'); return response(Buffer.from('first')); },
        });
        assert.equal(staged, null); assert.equal(calls, 2); assert.deepEqual(await fs.readdir(root), []);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('multi-attachment multipart retains attachment order, names and controls', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-multipart-rest-'));
    let posted = '';
    const channelId = '333333333333333333', sentId = '555555555555555555';
    const server = createServer(async (req, res) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); posted = Buffer.concat(chunks).toString(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: sentId, channel_id: channelId })); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const urls = ['https://images.example.test/a.jpg', 'https://media.example.test/b.mp4'];
        const staged = await prepare(urls, { tmpdir: root, fetch: async url => response(Buffer.from(url.endsWith('a.jpg') ? 'FIRST_BYTES' : 'SECOND_BYTES')) });
        const client = { token: 'fixture', options: { jsonTransformer: value => value }, rest: { options: { ...DefaultRestOptions } } };
        const channel = { id: channelId, client, messages: { cache: new Map(), resolveId: v => v?.id || v, _add: v => v } };
        const sender = createSingleAttemptSender({ prepareVideo: async () => staged, restFactory: opts => new REST({ ...opts, api: `http://127.0.0.1:${server.address().port}` }) });
        await sender.forMessage({ id: '444444444444444444', channel, client }, 'channel').send({ content: 'post', files: urls, components: [{ type: 1, components: [{ type: 2, style: 1, custom_id: 'delete:twitter', label: 'Delete' }] }] });
        assert.ok(posted.indexOf('FIRST_BYTES') < posted.indexOf('SECOND_BYTES'));
        assert.match(posted, /name="files\[0\]"; filename="a.jpg"/); assert.match(posted, /name="files\[1\]"; filename="b.mp4"/);
        assert.match(posted, /delete:twitter/); assert.deepEqual(await fs.readdir(root), []);
    } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
});

test('normal providers use the existing shared REST manager and fallback sender', async () => {
    const channelId = '333333333333333333', sentId = '555555555555555555'; let posts = 0, fallback = 0, tokenMutations = 0;
    const shared = { options: { ...DefaultRestOptions }, setToken() { tokenMutations++; }, async post(_route, request) { posts++; assert.equal(request.passThroughBody, true); return { id: sentId, channel_id: channelId }; } };
    const client = { token: 'fixture', options: { jsonTransformer: value => value }, rest: shared };
    const channel = { id: channelId, client, messages: { cache: new Map(), resolveId: v => v?.id || v, _add: v => v } };
    const options = { sharedRest: true, fallback: async () => { fallback++; return { id: sentId }; } };
    const source = { id: '444444444444444444', channel, client };
    const stream = createSingleAttemptSender({ prepareVideo: async () => ({ files: [{ blob: new Blob(['content']), name: 'file.jpg' }], cleanup: async () => {} }) });
    assert.equal((await stream.forMessage(source, 'channel', null, options).send({ files: ['https://images.example.test/a.jpg'] })).id, sentId);
    assert.equal(posts, 1); assert.equal(fallback, 0); assert.equal(tokenMutations, 0);
    const bypass = createSingleAttemptSender({ prepareVideo: async () => null });
    assert.equal((await bypass.forMessage(source, 'channel', null, options).send({ files: ['https://images.example.test/a.jpg'] })).id, sentId);
    assert.equal(posts, 1); assert.equal(fallback, 1); assert.equal(tokenMutations, 0);
});

test('concurrent downloads finishing out of order retain their original attachment order', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-order-test-'));
    let releaseFirst, beginSecond;
    const gate = new Promise(resolve => { releaseFirst = resolve; });
    const secondStarted = new Promise(resolve => { beginSecond = resolve; });
    try {
        const one = 'https://images.example.test/first.jpg', two = 'https://media.example.test/second.mp4';
        const pending = prepare([one, two], { tmpdir: root, fetch: async url => {
            if (url === one) { await gate; return response(Buffer.from('FIRST')); }
            beginSecond(); return response(Buffer.from('SECOND'));
        } });
        await secondStarted; releaseFirst();
        const staged = await pending;
        assert.deepEqual(staged.files.map(item => item.name), ['first.jpg', 'second.mp4']);
        assert.equal(Buffer.from(await staged.files[0].blob.arrayBuffer()).toString(), 'FIRST');
        assert.equal(Buffer.from(await staged.files[1].blob.arrayBuffer()).toString(), 'SECOND');
        await staged.cleanup();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('stale recovery removes all owned multipart files and preserves unrelated directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-multipart-sweep-'));
    try {
        const old = path.join(root, 'cbte-video-123456-abcdef'), other = path.join(root, 'cbte-video-222222-ghijkl');
        await fs.mkdir(old); await fs.mkdir(other);
        await fs.writeFile(path.join(old, 'part-0'), 'one'); await fs.writeFile(path.join(old, 'part-1'), 'two');
        await fs.writeFile(path.join(other, 'not-ours'), 'keep');
        const t = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); await fs.utimes(old, t, t); await fs.utimes(other, t, t);
        await _internal.removeStale(root, { isAlive: () => false });
        assert.deepEqual(await fs.readdir(root), ['cbte-video-222222-ghijkl']);
        assert.equal(await fs.readFile(path.join(other, 'not-ours'), 'utf8'), 'keep');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('shared REST retries a rate-limited multipart without losing staged file content', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-shared-retry-'));
    const channelId = '333333333333333333', sentId = '555555555555555555'; let requests = 0;
    const bodies = [];
    const server = createServer(async (req, res) => {
        requests++; const chunks = []; for await (const chunk of req) chunks.push(chunk); bodies.push(Buffer.concat(chunks).toString());
        if (requests === 1) { res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0.01' }); res.end(JSON.stringify({ message: 'rate limited', retry_after: 0.01, global: false })); }
        else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: sentId, channel_id: channelId })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const staged = await prepare([VIDEO], { tmpdir: root, fetch: async () => response(Buffer.from('retry-payload')) });
        const rest = new REST({ api: `http://127.0.0.1:${server.address().port}` }); rest.setToken('fixture');
        const client = { token: 'fixture', options: { jsonTransformer: value => value }, rest };
        const channel = { id: channelId, client, messages: { cache: new Map(), resolveId: v => v?.id || v, _add: v => v } };
        const sender = createSingleAttemptSender({ prepareVideo: async () => staged });
        const result = await sender.forMessage({ id: '444444444444444444', channel, client }, 'channel', null,
            { sharedRest: true, fallback: () => assert.fail('unexpected fallback') }).send({ files: [VIDEO] });
        assert.equal(result.id, sentId); assert.equal(requests, 2);
        assert.ok(bodies.every(body => body.includes('retry-payload'))); assert.deepEqual(await fs.readdir(root), []);
    } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
});

test('invalid message body releases staged files before any Discord request', async () => {
    let posts = 0, cleaned = 0;
    const client = { token: 'fixture', options: { jsonTransformer: () => { throw new Error('invalid embed'); } }, rest: { options: { ...DefaultRestOptions } } };
    const channel = { id: '333333333333333333', client, messages: { cache: new Map(), resolveId: v => v?.id || v, _add: v => v } };
    const sender = createSingleAttemptSender({ prepareVideo: async () => ({ files: [{ blob: new Blob(['data']), name: 'one.bin' }], cleanup: async () => { cleaned++; } }),
        restFactory: () => ({ setToken() {}, async post() { posts++; } }) });
    await assert.rejects(sender.forMessage({ id: '444444444444444444', channel, client }, 'channel').send({ files: [VIDEO], embeds: [{ title: 'fixture' }] }), /invalid embed/);
    assert.equal(posts, 0); assert.equal(cleaned, 1);
});

test('a cleanup error preserves a confirmed Discord result and emits a warning', async () => {
    const channelId = '333333333333333333', sentId = '555555555555555555'; let posts = 0, warnings = 0;
    const client = { token: 'fixture', options: { jsonTransformer: value => value }, rest: { options: { ...DefaultRestOptions } } };
    const channel = { id: channelId, client, messages: { cache: new Map(), resolveId: v => v?.id || v, _add: v => v } };
    const sender = createSingleAttemptSender({ prepareVideo: async () => ({ blob: new Blob(['data']), name: 'x.mp4', cleanup: async () => { throw new Error('cleanup fixture'); } }),
        restFactory: () => ({ setToken() {}, async post() { posts++; return { id: sentId, channel_id: channelId }; } }) });
    const savedWarn = console.warn; console.warn = () => { warnings++; };
    try {
        const sent = await sender.forMessage({ id: '444444444444444444', channel, client }, 'channel').send({ files: [VIDEO] });
        assert.equal(sent.id, sentId); assert.equal(posts, 1); assert.equal(warnings, 1);
    } finally { console.warn = savedWarn; }
});

test('a redirect using an unsupported protocol never starts another download', async () => {
    let calls = 0;
    const staged = await prepare([VIDEO], { fetch: async () => { calls++; return { status: 302, headers: { get: () => 'ftp://media.example.test/item' }, body: Readable.from([]) }; } });
    assert.equal(staged, null); assert.equal(calls, 1);
});

test('decoded compressed responses do not mistake wire length for file length', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-encoded-test-'));
    try {
        const content = Buffer.from('decoded-media-content');
        const staged = await prepare([VIDEO], { tmpdir: root, fetch: async () => ({ ok: true, status: 200,
            headers: { get: name => name === 'content-length' ? '4' : name === 'content-encoding' ? 'gzip' : null }, body: Readable.from([content]) }) });
        assert.ok(staged); assert.deepEqual(Buffer.from(await staged.blob.arrayBuffer()), content); await staged.cleanup();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('URL admission rejects non-public address literals before network access', () => {
    assert.throws(() => _internal.publicUrl('http://[fe80::1]/image.png'));
    assert.throws(() => _internal.publicUrl('https://[::1]/image.png'));
});

test('public HTTP media uses the streaming path without changing its filename', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-http-test-'));
    try {
        const url = 'http://media.example.test/example.png';
        const staged = await prepare([url], { tmpdir: root, fetch: async value => { assert.equal(value, url); return response(Buffer.from('fixture')); } });
        assert.ok(staged); assert.equal(staged.files[0].name, 'example.png');
        assert.equal(Buffer.from(await staged.files[0].blob.arrayBuffer()).toString(), 'fixture');
        await staged.cleanup();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('spoiler filenames remain unchanged when multiple buffered attachments are staged', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-spoiler-test-'));
    try {
        const files = [{ attachment: Buffer.from('a'), name: 'SPOILER_first.png' }, { attachment: Buffer.from('b'), name: 'second.png' }];
        const staged = await prepare(files, { tmpdir: root });
        assert.ok(staged); assert.deepEqual(staged.files.map(file => file.name), ['SPOILER_first.png', 'second.png']);
        await staged.cleanup();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('streamed bare signed URLs use the pathname as the attachment filename', () => {
    const signed = 'https://images.example.test/path/photo.jpg?stp=dst-jpg&token=fixture#part';
    const item = _internal.eligible([signed]);
    assert.equal(item[0].name, 'photo.jpg');
    assert.equal(item[0].url.search, '?stp=dst-jpg&token=fixture');
});

test('streamed multipart keeps the signed request URL while uploading a clean image name', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-signed-name-'));
    try {
        const signed = 'https://images.example.test/photo.jpg?stp=dst-jpg&sig=fixture';
        let requested;
        const staged = await prepare([signed], { tmpdir: root, fetch: async url => { requested = url; return response(Buffer.from('image-bytes')); } });
        assert.equal(requested, signed); assert.equal(staged.files[0].name, 'photo.jpg');
        const form = new FormData(); form.append('files[0]', staged.files[0].blob, staged.files[0].name);
        assert.equal(form.get('files[0]').name, 'photo.jpg');
        assert.equal(Buffer.from(await form.get('files[0]').arrayBuffer()).toString(), 'image-bytes');
        await staged.cleanup(); assert.deepEqual(await fs.readdir(root), []);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

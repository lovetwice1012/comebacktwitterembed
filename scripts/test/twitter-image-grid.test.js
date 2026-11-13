'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const sharp = require('sharp');
const { composeTwitterImageGrid, _internal } = require('../../src/components/twitter-image-grid');

const urls = count => Array.from({ length: count }, (_, index) => `https://pbs.twimg.com/media/item${index}?format=jpg&name=orig`);
function response(status, data, headers = {}) {
    return { status, ok: status >= 200 && status < 300, headers: { get: key => headers[key.toLowerCase()] ?? null }, body: Readable.from(data ? [data] : []) };
}
async function solid(r, g, b, width = 16, height = 16) {
    return sharp({ create: { width, height, channels: 3, background: { r, g, b } } }).png().toBuffer();
}
function pixel(data, width, x, y) { const offset = (y * width + x) * 3; return [...data.subarray(offset, offset + 3)]; }

test('20 images are kept in order in an actual PNG grid', async () => {
    const samples = await Promise.all([solid(255, 0, 0), solid(0, 255, 0), solid(0, 0, 255)]);
    const seen = [];
    const result = await composeTwitterImageGrid(urls(20), { columns: 5, cellWidth: 128, cellHeight: 128, format: 'png' }, {
        fetch: async url => { const index = Number(new URL(url).pathname.match(/item(\d+)/)[1]); seen.push(index); return response(200, samples[index % 3]); },
    });
    assert.equal(seen.length, 20);
    assert.equal(result.columns, 5); assert.equal(result.rows, 4); assert.equal(result.width, 640); assert.equal(result.height, 512);
    assert.equal(result.contentType, 'image/png'); assert.equal(result.filename, 'twitter-grid.png');
    const raw = await sharp(result.data).removeAlpha().raw().toBuffer();
    for (let i = 0; i < 20; i++) assert.deepEqual(pixel(raw, 640, (i % 5) * 128 + 64, Math.floor(i / 5) * 128 + 64), [[255, 0, 0], [0, 255, 0], [0, 0, 255]][i % 3]);
});

test('20 actual static AVIF photos are combined in their original order', async () => {
    const samples = await Promise.all(['#ff0000', '#00ff00', '#0000ff'].map(background =>
        sharp({ create: { width: 16, height: 16, channels: 3, background } }).avif({ quality: 100 }).toBuffer()));
    let downloaded = 0;
    const result = await composeTwitterImageGrid(urls(20), { columns: 5, cellWidth: 128, cellHeight: 128, format: 'png' }, {
        fetch: async url => { downloaded++; const index = Number(new URL(url).pathname.match(/item(\d+)/)[1]); return response(200, samples[index % 3]); },
    });
    const raw = await sharp(result.data).removeAlpha().raw().toBuffer();
    assert.equal(downloaded, 20);
    for (let i = 0; i < 20; i++) {
        const color = pixel(raw, result.width, (i % 5) * 128 + 64, Math.floor(i / 5) * 128 + 64);
        assert(color[i % 3] > 220, `image ${i} retained its dominant channel`);
        assert(color[(i + 1) % 3] < 35 && color[(i + 2) % 3] < 35);
    }
});

test('only bounded AVIF file types are recognized; video, GIF and image sequences are not flattened', async () => {
    const staticAvif = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#f00' } }).avif().toBuffer();
    assert.equal(_internal.imageFormat(staticAvif), 'avif');
    const boxSize = staticAvif.readUInt32BE(0), ext = Buffer.alloc(16);
    ext.writeUInt32BE(1, 0); ext.write('ftyp', 4); ext.writeBigUInt64BE(BigInt(boxSize + 8), 8);
    assert.equal(_internal.imageFormat(Buffer.concat([ext, staticAvif.subarray(8)])), 'avif');
    const sequence = Buffer.from(staticAvif); sequence.write('avis', 8);
    for (const value of [sequence, Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex'), Buffer.from('47494638396101000100800000', 'hex')])
        await assert.rejects(composeTwitterImageGrid(urls(1), {}, { fetch: async () => response(200, value) }), { code: 'IMAGE_GRID_FORMAT' });
    const badSize = Buffer.from(staticAvif); badSize.writeUInt32BE(4097, 0);
    assert.throws(() => _internal.imageFormat(badSize), { code: 'IMAGE_GRID_FORMAT' });
    const raw = Buffer.alloc(16 * 32 * 3);
    for (let i = 0; i < 16 * 32; i++) raw[i * 3 + (i < 16 * 16 ? 0 : 2)] = 255;
    const animation = await sharp(raw, { raw: { width: 16, height: 32, channels: 3, pageHeight: 16 } }).webp({ delay: [100, 100], loop: 0 }).toBuffer();
    assert.equal((await sharp(animation).metadata()).pages, 2);
    await assert.rejects(composeTwitterImageGrid(urls(1), {}, { fetch: async () => response(200, animation) }), { code: 'IMAGE_GRID_FORMAT' });
});

test('contain preserves the whole image and cover fills the tile; padding and spacing are configurable', async () => {
    const source = await solid(255, 0, 0, 32, 16);
    const fetch = async () => response(200, source);
    const contain = await composeTwitterImageGrid(urls(2), { columns: 2, cellWidth: 128, cellHeight: 128, gap: 8, background: '#0000ff', format: 'png' }, { fetch });
    assert.equal(contain.width, 264); assert.equal(contain.height, 128);
    const pixels = await sharp(contain.data).removeAlpha().raw().toBuffer();
    assert.deepEqual(pixel(pixels, 264, 64, 8), [0, 0, 255]);
    assert.deepEqual(pixel(pixels, 264, 64, 64), [255, 0, 0]);
    assert.deepEqual(pixel(pixels, 264, 131, 64), [0, 0, 255]);
    const cover = await composeTwitterImageGrid(urls(1), { cellWidth: 128, cellHeight: 128, fit: 'cover', format: 'png' }, { fetch });
    const covered = await sharp(cover.data).removeAlpha().raw().toBuffer();
    assert.deepEqual(pixel(covered, 128, 64, 8), [255, 0, 0]);
});

test('EXIF orientation is applied before fitting the image', async () => {
    const source = await sharp({ create: { width: 32, height: 16, channels: 3, background: '#ff0000' } }).jpeg({ quality: 100 }).withMetadata({ orientation: 6 }).toBuffer();
    const result = await composeTwitterImageGrid(urls(1), { cellWidth: 128, cellHeight: 128, format: 'png' }, { fetch: async () => response(200, source) });
    const raw = await sharp(result.data).removeAlpha().raw().toBuffer();
    const edge = pixel(raw, 128, 8, 64), center = pixel(raw, 128, 64, 64);
    assert(edge.every(channel => channel > 245)); assert(center[0] > 240 && center[1] < 15 && center[2] < 15);
});

test('horizontal and vertical 20-image arrangements stay within canvas bounds', () => {
    for (const columns of [1, 20]) {
        const layout = _internal.geometry(20, _internal.gridOptions({ columns, cellWidth: 2048, cellHeight: 2048, gap: 64 }, 20));
        assert.equal(layout.columns, columns); assert.equal(layout.rows, 20 / columns);
        assert(layout.width <= 8192 && layout.height <= 8192);
        assert(layout.width * layout.height <= 16_000_000); assert.equal(layout.scaled, true);
    }
});

test('canvas pixel and dimension limits hold across all image counts and column counts', () => {
    for (let count = 1; count <= 20; count++) for (let columns = 1; columns <= 20; columns++) {
        const options = _internal.gridOptions({ columns, cellWidth: 2048, cellHeight: 2048, gap: 64 }, count);
        const layout = _internal.geometry(count, options);
        assert(layout.width > 0 && layout.width <= 8192); assert(layout.height > 0 && layout.height <= 8192);
        assert(layout.width * layout.height <= 16_000_000); assert(layout.columns * layout.rows >= count);
    }
});

test('URLs, options and counts fail before requests, including private and deceptive hosts', async () => {
    let requests = 0; const fetch = async () => { requests++; return response(200, await solid(0, 0, 0)); };
    for (const input of [[], urls(21), ['http://pbs.twimg.com/media/item1'], ['https://pbs.twimg.com.attacker.invalid/media/item1'],
        ['https://127.0.0.1/media/item1'], ['https://pbs.twimg.com@127.0.0.1/media/item1'], ['https://cdn.discordapp.com/not-an-attachment']])
        await assert.rejects(composeTwitterImageGrid(input, {}, { fetch }));
    for (const options of [{ columns: 0 }, { cellWidth: Infinity }, { cellHeight: 2049 }, { gap: -1 }, { format: 'svg' },
        { background: 'red' }, { quality: 100 }, { maxOutputBytes: 1 }, { fit: 'stretch' }])
        await assert.rejects(composeTwitterImageGrid(urls(1), options, { fetch }), { code: 'IMAGE_GRID_OPTIONS' });
    assert.equal(requests, 0);
    assert.equal(_internal.validateUrl('https://pbs.twimg.com/media/abc123.jpg:orig').hostname, 'pbs.twimg.com');
    assert.equal(_internal.validateUrl('https://cdn.discordapp.com/attachments/123/456/photo.png?ex=123').hostname, 'cdn.discordapp.com');
});

test('redirects are validated again and may not escape approved image hosts', async () => {
    let requests = 0;
    await assert.rejects(composeTwitterImageGrid(urls(1), {}, { fetch: async () => { requests++; return response(302, null, { location: 'http://127.0.0.1/private' }); } }), { code: 'IMAGE_GRID_URL' });
    assert.equal(requests, 1);
    const image = await solid(1, 2, 3); requests = 0;
    const output = await composeTwitterImageGrid(urls(1), { cellWidth: 128, cellHeight: 128 }, { fetch: async () => ++requests === 1
        ? response(302, null, { location: 'https://pbs.twimg.com/media/valid?format=jpg' }) : response(200, image) });
    assert.equal(requests, 2); assert.equal(output.contentType, 'image/jpeg');
    requests = 0;
    await assert.rejects(composeTwitterImageGrid(urls(1), {}, { fetch: async () => { requests++; return response(302, null, { location: 'https://pbs.twimg.com/media/valid' }); } }), { code: 'IMAGE_GRID_DOWNLOAD' });
    assert.equal(requests, 4);
});

test('failed, excessive or non-image data never produces a partial composite', async () => {
    const valid = await solid(1, 2, 3);
    for (const fetch of [async () => response(404), async () => response(200, Buffer.from('not an image')),
        async () => response(200, valid, { 'content-length': String(20 * 1024 * 1024 + 1) }), async () => { throw new Error('network'); }])
        await assert.rejects(composeTwitterImageGrid(urls(2), {}, { fetch }), error => /^IMAGE_GRID_/.test(error.code));
});

test('streamed input is bounded even without a Content-Length header', async () => {
    const chunk = Buffer.alloc(1024 * 1024); Buffer.from('89504e470d0a1a0a', 'hex').copy(chunk);
    const fetch = async () => ({ status: 200, ok: true, headers: { get: () => null }, body: Readable.from(Array(21).fill(chunk)) });
    await assert.rejects(composeTwitterImageGrid(urls(1), {}, { fetch }), { code: 'IMAGE_GRID_INPUT_SIZE' });
});

test('an image at the 20 MiB input limit is processed, while the next byte is rejected', async () => {
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).jpeg().toBuffer();
    const atLimit = Buffer.alloc(20 * 1024 * 1024); jpeg.copy(atLimit);
    const result = await composeTwitterImageGrid(urls(1), { cellWidth: 128, cellHeight: 128 }, { fetch: async () => response(200, atLimit) });
    assert.equal((await sharp(result.data).metadata()).width, 128);
    const overLimit = Buffer.concat([atLimit, Buffer.from([0])]);
    await assert.rejects(composeTwitterImageGrid(urls(1), {}, { fetch: async () => response(200, overLimit) }), { code: 'IMAGE_GRID_INPUT_SIZE' });
});

test('aggregate streamed input is capped at twenty times the individual limit', async () => {
    const chunk = Buffer.alloc(1024 * 1024); Buffer.from('89504e470d0a1a0a', 'hex').copy(chunk);
    const fetch = async () => ({ status: 200, ok: true, headers: { get: () => null }, body: Readable.from(Array(2).fill(chunk)) });
    await assert.rejects(_internal.fetchImage(urls(1)[0], fetch, new AbortController().signal, { bytes: 399 * 1024 * 1024 }), { code: 'IMAGE_GRID_INPUT_SIZE' });
});

test('oversized decoded images are rejected even when the compressed download is small', async () => {
    const jpeg = Buffer.from(await sharp({ create: { width: 2, height: 2, channels: 3, background: '#f00' } }).jpeg().toBuffer());
    const index = jpeg.findIndex((value, i) => value === 0xff && [0xc0, 0xc2].includes(jpeg[i + 1]));
    assert(index >= 0); jpeg.writeUInt16BE(10000, index + 5); jpeg.writeUInt16BE(10000, index + 7);
    const metadata = await sharp(jpeg, { limitInputPixels: false }).metadata();
    assert.equal(metadata.width * metadata.height, 100_000_000);
    await assert.rejects(composeTwitterImageGrid(urls(1), {}, { fetch: async () => response(200, jpeg) }), { code: 'IMAGE_GRID_FORMAT' });
    const avif = Buffer.from(await sharp({ create: { width: 16, height: 16, channels: 3, background: '#f00' } }).avif().toBuffer());
    const ispe = avif.indexOf(Buffer.from('ispe')); assert(ispe >= 0);
    avif.writeUInt32BE(10000, ispe + 8); avif.writeUInt32BE(10000, ispe + 12);
    await assert.rejects(composeTwitterImageGrid(urls(1), {}, { fetch: async () => response(200, avif) }), { code: 'IMAGE_GRID_FORMAT' });
});

test('actual HTTP transport refuses a permitted host resolving to a private address', async () => {
    const dns = require('node:dns'); let requested = '';
    const lookup = mock.method(dns, 'lookup', (hostname, _options, callback) => {
        requested = hostname; callback(null, [{ address: '127.0.0.1', family: 4 }]);
    });
    try {
        await assert.rejects(composeTwitterImageGrid(urls(1)), { code: 'IMAGE_GRID_DOWNLOAD' });
        assert.equal(requested, 'pbs.twimg.com');
    } finally { lookup.mock.restore(); }
});

test('a missing native addon fails only the requested composition before any network request', async () => {
    const Module = require('node:module'), original = Module._load; let calls = 0;
    const loader = mock.method(Module, '_load', function (request, ...args) {
        if (request === 'sharp') throw new Error('fixture addon unavailable');
        return original.call(this, request, ...args);
    });
    try {
        await assert.rejects(composeTwitterImageGrid(urls(1), {}, { fetch: async () => { calls++; } }), { code: 'IMAGE_GRID_UNAVAILABLE' });
        assert.equal(calls, 0);
    } finally { loader.mock.restore(); }
});

test('failure aborts further downloads and waits for all in-flight work before finishing', async () => {
    const image = await solid(1, 2, 3); let entered = 0, done = false;
    let allEntered, triggerFailure, unblock;
    const enteredPromise = new Promise(resolve => { allEntered = resolve; });
    const failureGate = new Promise(resolve => { triggerFailure = resolve; });
    const blocked = new Promise(resolve => { unblock = resolve; });
    const work = composeTwitterImageGrid(urls(20), { cellWidth: 128, cellHeight: 128 }, { fetch: async url => {
        const index = Number(new URL(url).pathname.match(/item(\d+)/)[1]);
        if (++entered === 2) allEntered();
        if (index === 0) { await failureGate; return response(503); }
        await blocked; return response(200, image);
    } }).finally(() => { done = true; });
    await enteredPromise; triggerFailure();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(done, false); assert.equal(entered, 2);
    unblock(); await assert.rejects(work, { code: 'IMAGE_GRID_DOWNLOAD' });
    assert.equal(entered, 2);
});

test('a failure after several resized inputs cancels remaining work and never returns a partial image', async () => {
    const image = await solid(1, 2, 3); const seen = []; let capturedSignal;
    await assert.rejects(composeTwitterImageGrid(urls(20), { cellWidth: 128, cellHeight: 128 }, { fetch: async (url, options) => {
        const index = Number(new URL(url).pathname.match(/item(\d+)/)[1]);
        seen.push(index); capturedSignal = options.signal;
        if (index === 5) return response(503);
        return response(200, image);
    } }), { code: 'IMAGE_GRID_DOWNLOAD' });
    assert(seen.includes(5)); assert(seen.length < 20); assert.equal(capturedSignal.aborted, true);
});

test('at most two image compositions can download concurrently', async () => {
    const image = await solid(1, 2, 3); let entered = 0, bothStarted, unblock;
    const started = new Promise(resolve => { bothStarted = resolve; });
    const blocked = new Promise(resolve => { unblock = resolve; });
    const fetch = async () => { if (++entered === 2) bothStarted(); await blocked; return response(200, image); };
    const jobs = Array.from({ length: 3 }, () => composeTwitterImageGrid(urls(1), { cellWidth: 128, cellHeight: 128 }, { fetch }));
    await started; await new Promise(resolve => setImmediate(resolve)); assert.equal(entered, 2);
    unblock(); await Promise.all(jobs); assert.equal(entered, 3);
});

test('WebP output is a real decodable image, and pbs requests pin validated DNS to their socket', async () => {
    const source = await solid(11, 22, 33); let lookup;
    const result = await composeTwitterImageGrid(urls(1), { format: 'webp', cellWidth: 128, cellHeight: 128 }, { fetch: async (_url, options) => {
        lookup = options.agent.options.lookup; return response(200, source);
    } });
    assert.equal(lookup, require('../../src/providers/autoWatch/publicDns').lookup);
    assert.equal(result.contentType, 'image/webp');
    assert.equal((await sharp(result.data).metadata()).format, 'webp');
});

test('twenty real 9 MiB JPEGs are resized as a bounded pipeline rather than retained as source buffers', { timeout: 90000 }, async t => {
    let raw = require('node:crypto').randomBytes(3600 * 2800 * 3);
    const jpeg = await sharp(raw, { raw: { width: 3600, height: 2800, channels: 3 } }).jpeg({ quality: 95, mozjpeg: true }).toBuffer();
    raw = null;
    assert(jpeg.length >= 9 * 1024 * 1024 && jpeg.length < 20 * 1024 * 1024, `fixture JPEG was ${jpeg.length} bytes`);
    let fetched = 0, reading = 0, maximumReading = 0;
    const rss = () => { try { return process.memoryUsage().rss; } catch { return null; } };
    const baseline = rss(); let peak = baseline;
    const timer = baseline === null ? null : setInterval(() => { const value = rss(); if (value !== null) peak = Math.max(peak, value); }, 5);
    try {
        const result = await composeTwitterImageGrid(urls(20), { columns: 5, cellWidth: 128, cellHeight: 128, format: 'jpeg' }, { fetch: async () => {
            fetched++; reading++; maximumReading = Math.max(maximumReading, reading);
            return { status: 200, ok: true, headers: { get: () => null }, body: Readable.from((async function* () {
                try { yield jpeg; } finally { reading--; }
            })()) };
        } });
        const last = rss(); if (peak !== null && last !== null) peak = Math.max(peak, last);
        assert.equal(fetched, 20); assert(maximumReading <= 2);
        assert.equal(result.columns, 5); assert.equal(result.rows, 4);
        assert.equal((await sharp(result.data).metadata()).width, 640);
        // Include JPEG decode, image-library cache and V8/Buffer allocation;
        // this is a process-local fixture, not a production capacity claim.
        if (peak !== null && baseline !== null) {
            const increase = peak - baseline;
            t.diagnostic(`JPEG bytes=${jpeg.length}; peak process RSS increase=${increase}`);
            assert(increase < 512 * 1024 * 1024, `unexpected process RSS increase: ${increase}`);
        } else t.diagnostic(`JPEG bytes=${jpeg.length}; RSS unavailable in this environment`);
    } finally { if (timer) clearInterval(timer); }
});

test('output byte budget is enforced without omitting any source images', async () => {
    const random = require('node:crypto').randomBytes(128 * 128 * 3);
    const image = await sharp(random, { raw: { width: 128, height: 128, channels: 3 } }).png().toBuffer();
    let downloaded = 0;
    const result = await composeTwitterImageGrid(urls(20), { columns: 5, cellWidth: 128, cellHeight: 128, quality: 95, maxOutputBytes: 256 * 1024 }, {
        fetch: async () => { downloaded++; return response(200, image); },
    });
    assert.equal(downloaded, 20); assert(result.data.length <= 256 * 1024); assert.equal(result.adapted, true);
});

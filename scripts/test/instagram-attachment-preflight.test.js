'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPreparer, _internal } = require('../../src/providers/instagram/attachment-preflight');

const file = (name = 'instagram-1.jpg', url = 'https://scontent.cdninstagram.com/image.jpg?sig=private') => ({ attachment: url, name, description: 'description' });
const addresses = async () => [{ address: '8.8.8.8', family: 4 }];
const response = (status = 200, body = Buffer.from('image'), headers = {}) => ({
    status, ok: status >= 200 && status < 300, headers: { get: key => headers[key] ?? (key === 'content-type' ? 'image/jpeg' : null) },
    body: { destroy() {} }, buffer: async () => body,
});

test('transient acquisition failure retries before preserving ordered attachments and metadata', async () => {
    let calls = 0;
    const prepare = createPreparer({ lookup: addresses, fetchImpl: async () => { calls++; if (calls === 1) throw Object.assign(new Error('private signed URL'), { code: 'ETIMEDOUT' }); return response(); } });
    const original = [file(), file('instagram-2.jpg')];
    const prepared = await prepare(original), result = prepared.files;
    assert.equal(calls, 3); assert.equal(result.length, 2); assert.ok(Buffer.isBuffer(result[0].attachment));
    assert.equal(result[0].fallbackUrl, original[0].attachment); assert.equal(result[0].description, 'description'); prepared.release();
    assert.equal(typeof original[0].attachment, 'string');
});

test('permanent failures do not submit or leak URLs', async () => {
    for (const cause of [Object.assign(new Error('secret'), { status: 403 }), Object.assign(new Error('secret'), { status: 429 })]) {
        let calls = 0;
        const prepare = createPreparer({ lookup: addresses, fetchImpl: async () => { calls++; if (cause.status) return response(cause.status); throw cause; } });
        await assert.rejects(prepare([file()]), error => error.code === 'INSTAGRAM_ATTACHMENT_PREPARE_FAILED' && !JSON.stringify(error).includes('secret'));
        assert.equal(calls, 1);
    }
});

test('two transient connection failures fall back to the existing Discord path before submission', async () => {
    let calls = 0;
    const prepare = createPreparer({ lookup: addresses, fetchImpl: async () => { calls++; throw Object.assign(new Error('secret'), { code: 'ETIMEDOUT' }); } });
    assert.equal(await prepare([file()]), null); assert.equal(calls, 2);
});

test('an incomplete batch never returns partial files', async () => {
    let calls = 0;
    const prepare = createPreparer({ lookup: addresses, fetchImpl: async () => { if (++calls === 2) return response(403); return response(); } });
    await assert.rejects(prepare([file(), file('instagram-2.jpg')]), { code: 'INSTAGRAM_ATTACHMENT_PREPARE_FAILED' });
    assert.equal(calls, 2);
});

test('pinned DNS supplies both modern all-address and legacy lookup callback shapes', async () => {
    const prepare = createPreparer({ lookup: addresses, fetchImpl: async (_url, { agent }) => {
        await new Promise((resolve, reject) => agent.options.lookup('ignored', { all: true }, (error, records) => {
            try { assert.ifError(error); assert.deepEqual(records, [{ address: '8.8.8.8', family: 4 }]); resolve(); } catch (e) { reject(e); }
        }));
        await new Promise((resolve, reject) => agent.options.lookup('ignored', {}, (error, address, family) => {
            try { assert.ifError(error); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); resolve(); } catch (e) { reject(e); }
        }));
        return response();
    } });
    const result = await prepare([file()]); assert.equal(result.files.length, 1); result.release();
});

test('validated IPv4 and IPv6 addresses support Happy Eyeballs and retry rotation', async () => {
    const records = [{ address: '2001:4860:4860::8888', family: 6 }, { address: '8.8.8.8', family: 4 }], seen = [];
    const prepare = createPreparer({ lookup: async () => records, fetchImpl: async (_url, { agent }) => {
        const selected = await new Promise(resolve => agent.options.lookup('ignored', { all: true }, (_error, values) => resolve(values)));
        seen.push(selected);
        if (seen.length === 1) throw Object.assign(new Error('connection failed'), { code: 'ETIMEDOUT' });
        return response();
    } });
    const result = await prepare([file()]); result.release();
    assert.deepEqual(seen, [records, [records[1], records[0]]]);
});

test('slow connection aborts twice within the total deadline', async () => {
    let calls = 0;
    const prepare = createPreparer({ lookup: addresses, totalDeadlineMs: 100, attemptDeadlineMs: 10, fetchImpl: async (_url, { signal }) => {
        calls++;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
    } });
    assert.equal(await prepare([file()]), null); assert.equal(calls, 2);
});

test('unsafe redirect overrides another image transient fallback even when it resolves later', async () => {
    let calls = 0;
    const prepare = createPreparer({ lookup: addresses, fetchImpl: async url => {
        calls++;
        if (new URL(url).pathname === '/a.jpg') throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
        await new Promise(resolve => setTimeout(resolve, 15));
        return response(302, Buffer.alloc(0), { location: 'https://127.0.0.1/private' });
    } });
    await assert.rejects(prepare([file('instagram-1.jpg', 'https://scontent.cdninstagram.com/a.jpg'), file('instagram-2.jpg', 'https://scontent.cdninstagram.com/b.jpg')]), { code: 'INSTAGRAM_ATTACHMENT_PREPARE_FAILED' });
    assert.equal(calls, 3);
});

test('private DNS and redirects outside Instagram CDNs never issue an unsafe request', async () => {
    let calls = 0;
    const privatePrepare = createPreparer({ lookup: async () => [{ address: '127.0.0.1', family: 4 }], fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(privatePrepare([file()]), { code: 'INSTAGRAM_ATTACHMENT_PREPARE_FAILED' }); assert.equal(calls, 0);
    const redirectPrepare = createPreparer({ lookup: addresses, fetchImpl: async () => { calls++; return response(302, Buffer.alloc(0), { location: 'https://example.com/unsafe' }); } });
    await assert.rejects(redirectPrepare([file()]), { code: 'INSTAGRAM_ATTACHMENT_PREPARE_FAILED' }); assert.equal(calls, 1);
});

test('each permitted redirect is resolved and pinned independently', async () => {
    let lookups = 0, requests = 0;
    const prepare = createPreparer({ lookup: async () => { lookups++; return addresses(); }, fetchImpl: async () => ++requests === 1
        ? response(302, Buffer.alloc(0), { location: 'https://video.fbcdn.net/image.jpg' }) : response() });
    const result = await prepare([file()]); assert.equal(result.files.length, 1); result.release();
    assert.equal(lookups, 2); assert.equal(requests, 2);
});

test('stalled DNS fails within the total deadline without attempting a request', async () => {
    let requests = 0, lookups = 0;
    const prepare = createPreparer({ lookup: () => { lookups++; return new Promise(() => {}); }, totalDeadlineMs: 100, attemptDeadlineMs: 10, fetchImpl: async () => { requests++; return response(); } });
    await assert.rejects(prepare([file()]), { code: 'INSTAGRAM_ATTACHMENT_PREPARE_FAILED' }); assert.equal(requests, 0); assert.equal(lookups, 2);
});

test('transient DNS failure is retried; rejected private addresses are not', async () => {
    let lookups = 0, requests = 0;
    const prepare = createPreparer({ lookup: async () => { if (++lookups === 1) throw Object.assign(new Error('dns'), { code: 'EAI_AGAIN' }); return addresses(); }, fetchImpl: async () => { requests++; return response(); } });
    const ready = await prepare([file(), file('instagram-2.jpg')]); ready.release();
    assert.equal(lookups, 2); assert.equal(requests, 2);
    lookups = 0;
    const privatePrepare = createPreparer({ lookup: async () => { lookups++; return [{ address: '127.0.0.1', family: 4 }]; }, fetchImpl: async () => { throw Error('must not request'); } });
    await assert.rejects(privatePrepare([file()]), { code: 'INSTAGRAM_ATTACHMENT_PREPARE_FAILED' }); assert.equal(lookups, 1);
});

test('mixed/video and unsupported URLs retain their existing send path without prefetch', async () => {
    const prepare = createPreparer({ lookup: () => { throw Error('must not fetch'); }, fetchImpl: () => { throw Error('must not fetch'); } });
    assert.equal(await prepare([file('instagram-1.mp4')]), null);
    assert.equal(await prepare([file('instagram-1.jpg', 'https://example.com/image.jpg')]), null);
    for (const files of [[file('instagram-1.jpg', 'https://user:pass@scontent.cdninstagram.com/image.jpg')], [file('instagram-1.jpg', 'https://127.0.0.1/image.jpg')]]) await assert.rejects(prepare(files), { code: 'INSTAGRAM_ATTACHMENT_PREPARE_FAILED' });
    assert.equal(_internal.instagramCdn('https://evilcdninstagram.com/image.jpg'), null);
});

test('a late unsafe source is validated before a transient failure can fall back', async () => {
    let requests = 0;
    const prepare = createPreparer({ lookup: async host => host.startsWith('bad.') ? [{ address: '127.0.0.1', family: 4 }] : addresses(), fetchImpl: async () => { requests++; throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); } });
    const files = Array.from({ length: 4 }, (_, index) => file(`instagram-${index + 1}.jpg`, `https://${index === 3 ? 'bad' : 'good'}.cdninstagram.com/image.jpg`));
    await assert.rejects(prepare(files), { code: 'INSTAGRAM_ATTACHMENT_PREPARE_FAILED' }); assert.equal(requests, 0);
});

test('unsafe DNS and transient DNS failure in the same batch cannot fall back', async () => {
    let requests = 0, retryCount = 0;
    const prepare = createPreparer({ lookup: async host => {
        if (host.startsWith('bad.')) return [{ address: '127.0.0.1', family: 4 }];
        retryCount++; throw Object.assign(new Error('dns'), { code: 'EAI_AGAIN' });
    }, fetchImpl: async () => { requests++; return response(); } });
    await assert.rejects(prepare([file('instagram-1.jpg', 'https://retry.cdninstagram.com/a.jpg'), file('instagram-2.jpg', 'https://bad.cdninstagram.com/b.jpg')]), { code: 'INSTAGRAM_ATTACHMENT_PREPARE_FAILED' });
    assert.equal(retryCount, 2); assert.equal(requests, 0);
});

test('unsupported response type and oversized images retain existing Discord fallback behavior', async () => {
    const prepareBad = createPreparer({ lookup: addresses, fetchImpl: async () => response(200, Buffer.from('html'), { 'content-type': 'text/html' }) });
    assert.equal(await prepareBad([file()]), null);
    const prepareLarge = createPreparer({ lookup: addresses, fetchImpl: async () => response(200, Buffer.alloc(_internal.MAX_FILE_BYTES + 1)) });
    assert.equal(await prepareLarge([file()]), null);
});

test('aggregate byte budget leaves large batches to the existing Discord policy', async () => {
    const part = Buffer.alloc(_internal.MAX_FILE_BYTES);
    const prepare = createPreparer({ lookup: addresses, fetchImpl: async () => response(200, part) });
    assert.equal(await prepare(Array.from({ length: 5 }, (_, index) => file(`instagram-${index + 1}.jpg`))), null);
});

test('batch fetching is bounded and concurrent, preserving original image order', async () => {
    let active = 0, maxActive = 0;
    const prepare = createPreparer({ lookup: addresses, fetchImpl: async () => {
        active++; maxActive = Math.max(active, maxActive);
        await new Promise(resolve => setTimeout(resolve, 10)); active--;
        return response();
    } });
    const out = await prepare(Array.from({ length: 6 }, (_, index) => file(`instagram-${index + 1}.jpg`)));
    assert.equal(maxActive, 3); assert.deepEqual(out.files.map(item => item.name), Array.from({ length: 6 }, (_, index) => `instagram-${index + 1}.jpg`)); out.release();
});

test('global admission bounds active preparations and leaves excess requests to existing path', async () => {
    const releases = [];
    const prepare = createPreparer({ lookup: addresses, fetchImpl: async () => { await new Promise(resolve => releases.push(resolve)); return response(); } });
    const a = prepare([file()]), b = prepare([file()]);
    assert.equal(await prepare([file()]), null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(releases.length, 2); for (const release of releases) release();
    const aa = await a, bb = await b; assert.equal(aa.files.length, 1); assert.equal(bb.files.length, 1);
    // Completion of the fetch alone does not release memory admission.
    assert.equal(await prepare([file()]), null);
    aa.release(); aa.release(); bb.release();
});

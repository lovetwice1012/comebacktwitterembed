'use strict';

const { test, mock, before } = require('node:test');
const assert = require('node:assert/strict');
const dns = require('node:dns');
const { Readable } = require('node:stream');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');
const { validateTwitterMediaUrl, fetchTwitterMedia, detectTwitterMediaFormat } = require('../../src/providers/twitter/safeMedia');

const photo = 'https://pbs.twimg.com/media/HW8UTKLW4AEsitH.jpg?name=orig';
const video = 'https://video.twimg.com/amplify_video/2082186248727281665/vid/avc1/3840x2160/fixture.mp4?tag=29';
let jpeg;
before(async () => { jpeg = await require('sharp')({ create: { width: 2, height: 2, channels: 3, background: '#f00' } }).jpeg().toBuffer(); });
function response(status, chunks = [], headers = {}) {
    return { status, ok: status >= 200 && status < 300, body: Readable.from(chunks),
        headers: { get: key => headers[key.toLowerCase()] ?? null } };
}
function isolatedMedia(sharp) {
    const filename = require.resolve('../../src/providers/twitter/safeMedia'), actual = createRequire(filename), mod = { exports: {} };
    compileFunction(readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename: `${filename}.fixture.cjs` })(
        id => id === 'sharp' ? sharp() : actual(id), mod, mod.exports);
    return mod.exports;
}

test('Twitter media validation accepts real CDN photo/video shapes and rejects spoofing and unsafe query paths', () => {
    assert.equal(validateTwitterMediaUrl(photo, 'photo').kind, 'photo');
    assert.equal(validateTwitterMediaUrl('https://pbs.twimg.com/media/ABC?format=jpg&name=4096x4096').kind, 'photo');
    assert.equal(validateTwitterMediaUrl('https://pbs.twimg.com/media/ABC?format=avif&name=orig').kind, 'photo');
    assert.equal(validateTwitterMediaUrl(video, 'video').kind, 'video');
    assert.equal(validateTwitterMediaUrl('https://video.twimg.com/tweet_video/fixture.mp4').kind, 'video');
    const rejected = [
        'https://127.0.0.1/media/photo.jpg', 'http://pbs.twimg.com/media/photo.jpg',
        'https://pbs.twimg.com.attacker.test/media/photo.jpg', 'https://pbs.twimg.com./media/photo.jpg',
        'https://pbs.twimg.com@127.0.0.1/media/photo.jpg', 'https://user:pass@pbs.twimg.com/media/photo.jpg',
        'https://pbs.twimg.com:444/media/photo.jpg', 'https://pbs.twimg.com/media/photo.jpg#fragment',
        'https://pbs.twimg.com/media/%2e%2e/private', 'https://pbs.twimg.com/media/a%2fb.jpg',
        'https://pbs.twimg.com/media/photo.jpg?redirect=https://127.0.0.1',
        'https://pbs.twimg.com/media/photo.jpg?name=orig&name=small',
        'https://video.twimg.com/redirect/private.mp4', 'https://video.twimg.com/ext_tw_video/1/private.m3u8',
        'https://twidata.sprink.cloud/data/222222222222222222/123/media-0-photo.jpg',
        'http://localhost:3088/data/222222222222222222/123/media-0-photo.jpg',
    ];
    for (const value of rejected) assert.throws(() => validateTwitterMediaUrl(value), { code: 'TWITTER_MEDIA_UNSAFE_URL' }, value);
    assert.throws(() => validateTwitterMediaUrl(video, 'photo'), { code: 'TWITTER_MEDIA_UNSAFE_URL' });
    assert.throws(() => validateTwitterMediaUrl(photo, 'video'), { code: 'TWITTER_MEDIA_UNSAFE_URL' });
});

test('redirects are manual, bounded and revalidated before a second request', async () => {
    for (const location of ['https://127.0.0.1/private', 'https://pbs.twimg.com.attacker.test/media/a.jpg', video]) {
        const calls = [];
        await assert.rejects(fetchTwitterMedia(photo, { fetch: async (url, options) => {
            calls.push(url); assert.equal(options.redirect, 'manual'); return response(302, [], { location });
        } }), { code: 'TWITTER_MEDIA_UNSAFE_URL' });
        assert.deepEqual(calls, [photo]);
    }
    const calls = [];
    const result = await fetchTwitterMedia(photo, { fetch: async (url, options) => {
        calls.push(url); assert.equal(options.redirect, 'manual');
        return calls.length === 1 ? response(302, [], { location: '/media/other.jpg?name=orig' })
            : response(200, [jpeg], { 'content-type': 'image/jpeg' });
    } });
    assert.deepEqual(result.data, jpeg); assert.equal(result.kind, 'photo'); assert.equal(result.format, 'jpeg');
    assert.equal(calls.length, 2);
    let count = 0;
    await assert.rejects(fetchTwitterMedia(photo, { fetch: async () => { count++; return response(302, [], { location: photo }); } }), { code: 'TWITTER_MEDIA_REDIRECT' });
    assert.equal(count, 4);
});

test('the socket lookup itself rejects private or mixed DNS answers and uses its validated public result', async () => {
    for (const records of [[{ address: '127.0.0.1', family: 4 }],
        [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]]) {
        const lookup = mock.method(dns, 'lookup', (_host, _opts, callback) => callback(null, records));
        try {
            await assert.rejects(fetchTwitterMedia(photo, { fetch: async (url, options) => {
                await new Promise((resolve, reject) => options.agent.options.lookup(new URL(url).hostname, {}, (err, addr) => err ? reject(err) : resolve(addr)));
                return response(200, [Buffer.from('unexpected')]);
            } }), { code: 'TWITTER_MEDIA_FETCH_FAILED' });
        } finally { lookup.mock.restore(); }
    }
    let calls = 0;
    const lookup = mock.method(dns, 'lookup', (_host, _opts, callback) => {
        calls++; callback(null, [{ address: calls === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]);
    });
    try {
        let pinned;
        const result = await fetchTwitterMedia(photo, { fetch: async (url, options) => {
            pinned = await new Promise((resolve, reject) => options.agent.options.lookup(new URL(url).hostname, {}, (err, addr) => err ? reject(err) : resolve(addr)));
            return response(200, [jpeg]);
        } });
        assert.equal(pinned, '8.8.8.8'); assert.equal(calls, 1); assert.deepEqual(result.data, jpeg);
    } finally { lookup.mock.restore(); }
});

test('only real image signatures and MP4 containers matching the declared media kind are returned', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex'), webp = Buffer.from('524946460000000057454250', 'hex');
    const gif = Buffer.from('GIF89a'), avif = Buffer.from('000000186674797061766966000000006d69663161766966', 'hex');
    const mp4 = Buffer.from('000000186674797069736f6d0000000069736f6d69736f34', 'hex');
    for (const [data, kind, expected] of [[jpeg, 'photo', 'jpeg'], [png, 'photo', 'png'], [webp, 'photo', 'webp'],
        [gif, 'photo', 'gif'], [avif, 'photo', 'avif'], [mp4, 'video', 'mp4']])
        assert.equal(detectTwitterMediaFormat(data, kind), expected);
    for (const [data, kind] of [[Buffer.from('<html>403</html>'), 'photo'], [jpeg, 'video'], [mp4, 'photo'], [avif, 'video'],
        [Buffer.from('000000186674797062616421000000006261642162616421', 'hex'), 'video']])
        assert.throws(() => detectTwitterMediaFormat(data, kind), { code: 'TWITTER_MEDIA_FORMAT' });
    await assert.rejects(fetchTwitterMedia(photo, { fetch: async () => response(200, [Buffer.from('<html>error</html>')]) }), { code: 'TWITTER_MEDIA_FORMAT' });
    await assert.rejects(fetchTwitterMedia(photo, { fetch: async () => response(200, [Buffer.from('ffd8ffe000000000', 'hex')]) }), { code: 'TWITTER_MEDIA_FORMAT' },
        'a JPEG-looking signature without decodable image data cannot be uploaded');
    const actual = await fetchTwitterMedia(video, { fetch: async () => response(200, [mp4], { 'content-type': 'application/octet-stream' }) });
    assert.equal(actual.format, 'mp4');
});

test('download size, empty responses, network errors and timeout fail before upload', async () => {
    await assert.rejects(fetchTwitterMedia(photo, { maxBytes: 3, fetch: async () => response(200, [], { 'content-length': '4' }) }), { code: 'TWITTER_MEDIA_TOO_LARGE' });
    await assert.rejects(fetchTwitterMedia(photo, { maxBytes: 3, fetch: async () => response(200, [Buffer.from('12'), Buffer.from('34')]) }), { code: 'TWITTER_MEDIA_TOO_LARGE' });
    await assert.rejects(fetchTwitterMedia(photo, { fetch: async () => response(200) }), { code: 'TWITTER_MEDIA_FETCH_FAILED' });
    await assert.rejects(fetchTwitterMedia(photo, { fetch: async () => { throw new Error('network'); } }), { code: 'TWITTER_MEDIA_FETCH_FAILED' });
    await assert.rejects(fetchTwitterMedia(photo, { timeoutMs: 20, fetch: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }) }), { code: 'TWITTER_MEDIA_TIMEOUT' });
});

test('missing native decoder and forged image signatures fail without submitting bytes', async () => {
    const isolated = isolatedMedia(() => { throw new Error('native binding missing'); });
    await assert.rejects(isolated.fetchTwitterMedia(photo, { fetch: async () => response(200, [jpeg]) }), { code: 'TWITTER_MEDIA_DECODER_UNAVAILABLE' });
    await assert.rejects(fetchTwitterMedia(photo, { fetch: async () => response(200, [Buffer.from('89504e470d0a1a0a00000000', 'hex')]) }),
        { code: 'TWITTER_MEDIA_FORMAT' });
});

test('image decode work is globally bounded and excess requests fail closed', async () => {
    let active = 0, maximum = 0, releaseGate, twoStarted;
    const gate = new Promise(resolve => { releaseGate = resolve; });
    const ready = new Promise(resolve => { twoStarted = resolve; });
    const isolated = isolatedMedia(() => () => ({ resize() { return this; }, raw() { return this; }, async toBuffer() {
        active++; maximum = Math.max(maximum, active); if (active === 2) twoStarted();
        await gate; active--; return Buffer.from([0]);
    } }));
    const jobs = Array.from({ length: 11 }, () => isolated.fetchTwitterMedia(photo, { fetch: async () => response(200, [jpeg]) })
        .then(() => 'ok', cause => cause.code));
    await ready;
    await new Promise(resolve => setTimeout(resolve, 20));
    releaseGate();
    const outcomes = await Promise.all(jobs);
    assert.equal(maximum, 2); assert.equal(outcomes.filter(value => value === 'ok').length, 10);
    assert.equal(outcomes.filter(value => value === 'TWITTER_MEDIA_BUSY').length, 1);
});

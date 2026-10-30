'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');
const filename = require.resolve('../../src/niconicoApi');
function apiWith(fetch) {
    const mod = { exports: {} }, original = createRequire(filename);
    compileFunction(readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(
        id => id === 'node-fetch' ? fetch : original(id), mod, mod.exports);
    return mod.exports;
}
const videoId = 'sm9';
function modern(id = videoId) {
    return { meta: { status: 200 }, data: { response: { $watchV4: { data: {
        client: { watchId: id, watchTrackId: 'track-1' },
        video: { id, title: '日本語 & "title"', description: '<b>説明</b>', count: { view: 17 }, thumbnail: { ogp: 'https://example.test/image.jpg' } },
        media: { accessRightKey: 'fixture-key', contents: { videos: [{ id: 'video', isAvailable: true }], audios: [{ id: 'audio', isAvailable: true }] } },
        metadata: { jsonLd: { owner: { id: '4', type: 'user', name: '作者', iconUrl: 'https://example.test/icon.jpg' } } },
        tags: { items: [{ name: 'テスト' }] },
    } } } } };
}
function page(data) {
    const encoded = JSON.stringify(data).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return `<html><head><meta content="${encoded}" name="server-response" /></head></html>`;
}
const headers = cookies => ({ raw: () => ({ 'set-cookie': cookies || [] }) });

test('watch HTTP 400 falls back to the current page data and keeps the playback cookie for HLS', async () => {
    const calls = [];
    const api = apiWith(async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith('?responseType=json')) return { ok: false, status: 400, headers: headers() };
        if (url === 'https://www.nicovideo.jp/watch/sm9') return { ok: true, status: 200, url, headers: headers(['domand_bid=fixture; Path=/']), text: async () => page(modern()) };
        assert.match(url, /access-rights\/hls/); assert.match(options.headers.Cookie, /domand_bid=fixture/);
        assert.equal(options.headers['X-Access-Right-Key'], 'fixture-key');
        assert.deepEqual(JSON.parse(options.body), { outputs: [['video', 'audio']] });
        return { ok: true, status: 201, headers: headers(), json: async () => ({ data: { contentUrl: 'https://delivery.domand.nicovideo.jp/test.m3u8' } }) };
    });
    const jar = new Map(), data = await api.fetchWatchData(videoId, jar);
    assert.equal(data.video.title, '日本語 & "title"'); assert.equal(data.owner.nickname, '作者');
    assert.equal(data.tag.items[0].name, 'テスト');
    assert.deepEqual(api.pickBestDomandOutput(data).ids, ['video', 'audio']);
    assert.equal(await api.createHlsContentUrl(data, [['video', 'audio']], jar), 'https://delivery.domand.nicovideo.jp/test.m3u8');
    assert.equal(calls.length, 3);
});

test('restricted and rate-limited responses do not try another route', async () => {
    for (const status of [401, 403, 429, 500]) {
        let calls = 0;
        const api = apiWith(async () => { calls++; return { ok: false, status, headers: headers() }; });
        await assert.rejects(api.fetchWatchData(videoId), { status }); assert.equal(calls, 1);
    }
});

test('an absent, malformed, wrong-video or redirected page cannot masquerade as the requested video', async () => {
    for (const [html, finalUrl] of [['<html>login</html>', 'https://www.nicovideo.jp/watch/sm9'],
        [page(modern('sm10')), 'https://www.nicovideo.jp/watch/sm9'],
        ['<meta name="server-response" content="{invalid}">', 'https://www.nicovideo.jp/watch/sm9'],
        [page(modern()), 'https://elsewhere.example/watch/sm9']]) {
        const api = apiWith(async url => url.endsWith('?responseType=json')
            ? { ok: false, status: 400, headers: headers() }
            : { ok: true, status: 200, url: finalUrl, text: async () => html, headers: headers() });
        await assert.rejects(api.fetchWatchData(videoId));
    }
});

test('legacy JSON, modern JSON, and a channel owner remain supported', () => {
    const api = apiWith(async () => { throw Error('no network'); });
    const old = { meta: { status: 200 }, data: { response: { video: { id: videoId, title: 'old' }, media: { domand: { accessRightKey: 'legacy' } } } } };
    assert.equal(api._internal.normalizeWatchResponse(old, videoId).media.domand.accessRightKey, 'legacy');
    const value = modern(); value.data.response.$watchV4.data.metadata.jsonLd.owner = { id: 'ch123', type: 'channel', name: '放送局' };
    assert.equal(api._internal.normalizeWatchResponse(value, videoId).channel.id, 'ch123');
    assert.equal(api._internal.normalizeWatchResponse(modern('sm10'), videoId), null);
});

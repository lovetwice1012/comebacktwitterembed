'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { readJsonProjection, readHtmlProjection } = require('../../src/providers/autoWatch/streaming');

function response(parts) {
    return { body: Readable.from(parts, { objectMode: false }), text: () => assert.fail('A real stream must not be buffered with text().') };
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('JSON projection ignores arbitrarily large unselected strings and preserves selected metadata', async () => {
    async function* parts() {
        yield '{"unused":"';
        for (let index = 0; index < 1024; index++) yield 'x'.repeat(32768);
        yield '","data":{"user":{"id":"42","stream":null}},"errors":[]}';
    }
    const value = await readJsonProjection(response(parts()), [['data', 'user', 'id'], ['data', 'user', 'stream', 'id'], ['errors', '*', 'message']]);
    assert.deepEqual(plain(value), { data: { user: { id: '42', stream: null } }, errors: [] });
});

test('JSON projection preserves array roots, wildcard nulls, empty maps and recursive paths', async () => {
    assert.deepEqual(plain(await readJsonProjection(response(['[]']), [['*', 'id']])), []);
    const input = '{"body":{"illusts":{"123":null},"manga":{}},"nested":{"channelId":"UCexample"}}';
    assert.deepEqual(plain(await readJsonProjection(response(input.split('')), [['body', 'illusts', '*', 'title'], ['body', 'manga', '*', 'title'], ['**', 'channelId']])),
        { body: { illusts: { 123: null }, manga: {} }, nested: { channelId: 'UCexample' } });
});

test('JSON projection skips prototype keys and preserves long selected strings without rejecting body size', async () => {
    const input = '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"safe":"' + 'z'.repeat(100000) + '"}';
    const value = await readJsonProjection(response([input]), [['**']]);
    assert.equal(value.safe.length, 100000);
    assert.equal(Object.hasOwn(value, '__proto__'), false);
    assert.equal(Object.hasOwn(value, 'constructor'), false);
    assert.equal({}.polluted, undefined);
});

test('HTML projection discards huge scripts and handles hydration markers and UTF-8 across chunk boundaries', async () => {
    async function* parts() {
        yield '<html><script>var asset = "';
        for (let index = 0; index < 300; index++) yield 'x'.repeat(32768);
        yield '";</script><script>var ytInitial'; yield 'Data = {"unused":"';
        for (let index = 0; index < 300; index++) yield 'x'.repeat(32768);
        yield '","nested":{"channelId":"UCexample","title":"';
        const bytes = Buffer.from('日本語');
        for (const byte of bytes) yield Buffer.from([byte]);
        yield '"}};</script></html>';
    }
    const html = await readHtmlProjection(response(parts()), { markers: ['ytInitialData'], paths: [['**', 'channelId'], ['nested', 'title']] });
    assert.match(html, /ytInitialData = /);
    assert.match(html, /UCexample/);
    assert.match(html, /日本語/);
    assert.equal(html.includes('unused'), false);
    assert(html.length < 200);
});

test('HTML projection preserves selected script attributes and ordinary metadata markup', async () => {
    const html = '<h2>Albums</h2><a href="/album/id">Name</a><img src="data:image/x;base64,huge">' +
        '<script id="__NEXT_DATA__" type="application/json">{"props":{"name":"Artist"},"other":"drop"}</script>' +
        '<script type="application/ld+json">{"@type":"MusicAlbum","name":"Album"}</script>';
    const projected = await readHtmlProjection(response(html.split('')), { markers: ['__NEXT_DATA__', 'application/ld+json'],
        paths: [['props', 'name'], ['@type'], ['name']], preserveHtml: true });
    assert.match(projected, /<h2>Albums<\/h2>/);
    assert.match(projected, /id="__NEXT_DATA__"/);
    assert.match(projected, /type="application\/ld\+json"/);
    assert.equal(projected.includes('<img'), false);
    assert.equal(projected.includes('"other"'), false);
});

test('malformed JSON, incomplete hydration and body errors retain their failure contracts', async () => {
    await assert.rejects(readJsonProjection(response(['{"id":']), [['id']]), { code: 'AUTO_WATCH_INVALID_RESPONSE' });
    await assert.rejects(readHtmlProjection(response(['<script>ytInitialData = {"id":']), { markers: ['ytInitialData'], paths: [['id']] }), { code: 'AUTO_WATCH_INVALID_RESPONSE' });
    const failure = Object.assign(new Error('body deadline'), { code: 'ABORT_ERR' });
    async function* failed() { yield '{"unused":"'; throw failure; }
    await assert.rejects(readJsonProjection(response(failed()), [['id']]), error => error === failure);
});

test('optional malformed hydration scripts cannot hide valid ordinary content', async () => {
    for (const script of ['{bad}', '{"name":']) {
        const input = '<h2>Albums</h2><script type="application/ld+json">' + script + '</script><a href="/album/id">Release</a>';
        const html = await readHtmlProjection(response(input.split('')), { markers: ['application/ld+json'], paths: [['name']],
            preserveHtml: true, ignoreInvalidScripts: true });
        assert.match(html, /<h2>Albums<\/h2>/);
        // A malformed unterminated script is HTML content up to its closing tag;
        // the reader must recover there and preserve subsequent real cards.
        assert.match(html, /Release<\/a>/);
    }
});

test('excessive relevant structure fails transiently without confusing it with a page size cap', async () => {
    const tooDeep = '['.repeat(65) + '0' + ']'.repeat(65);
    await assert.rejects(readJsonProjection(response([tooDeep]), [['**']]), { code: 'AUTO_WATCH_RESOURCE_PRESSURE', retryAfterMs: 60000 });
});

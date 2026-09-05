'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fetch = require('node-fetch');
const { withDeadline } = require('../../src/providerFetch');

async function withServer(handler, work) {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try { await work(`http://127.0.0.1:${server.address().port}`); }
    finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}

test('provider deadline aborts a server that never sends response headers', async () => {
    await withServer(() => {}, async url => {
        await assert.rejects(withDeadline(fetch, 150)(url), { name: 'AbortError' });
    });
});

test('provider deadline remains active after headers and closes a stalled body socket', async () => {
    let closed;
    const closedPromise = new Promise(resolve => { closed = resolve; });
    await withServer((_request, response) => {
        response.on('close', closed);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{');
    }, async url => {
        const response = await withDeadline(fetch, 300)(url);
        await assert.rejects(response.json(), { name: 'AbortError' });
        await closedPromise;
    });
});

test('provider deadline preserves caller cancellation and successful response content', async () => {
    await withServer((_request, response) => response.end('{"ok":true}'), async url => {
        assert.deepEqual(await (await withDeadline(fetch)(url)).json(), { ok: true });
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(withDeadline(fetch)(url, { signal: controller.signal }), { name: 'AbortError' });
    });
});

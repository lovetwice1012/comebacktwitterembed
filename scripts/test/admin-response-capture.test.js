'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const realFetch = require('node-fetch');
const telemetry = require('../../src/adminSupport/telemetry');
const { withDeadline } = require('../../src/providerFetch');

async function withServer(handler, work) {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try { return await work(`http://127.0.0.1:${server.address().port}`); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('a production traced provider rejecting response.ok still retains the complete HTTP error body', async () => {
    const body = JSON.stringify({ message: 'Not Found', documentation_url: 'https://fixture.invalid/docs' });
    await withServer((_request, response) => { response.writeHead(404, { 'Content-Type': 'application/json' }); response.end(body); }, async url => {
        const events = [], httpAttempts = [];
        await telemetry.run({ events, httpAttempts }, async () => {
            await assert.rejects((async () => {
                const response = await withDeadline(realFetch, 2000)(url);
                if (!response.ok) throw new Error(`upstream ${response.status}`);
            })(), /upstream 404/);
        });
        const attempt = httpAttempts[0];
        assert.equal(attempt.status, 404);
        assert.equal(attempt.bodyState, 'complete');
        assert.equal(attempt.body, body);
        assert.equal(attempt.bytes, Buffer.byteLength(body));
        assert.equal(attempt.captureReason, 'non_success_response');
        assert.equal(attempt.timeoutMs, 2000);
        assert.ok(Number.isFinite(attempt.durationMs));
        assert.ok(events.some(event => event.kind === 'completed' && event.details.body === body));
    });
});
test('bounded error-body capture does not truncate the provider stream or stall on an unread tee branch', async t => {
    const previous = process.env.ADMIN_HTTP_EVIDENCE_BYTES;
    process.env.ADMIN_HTTP_EVIDENCE_BYTES = '1024';
    t.after(() => { if (previous === undefined) delete process.env.ADMIN_HTTP_EVIDENCE_BYTES; else process.env.ADMIN_HTTP_EVIDENCE_BYTES = previous; });
    const body = 'x'.repeat(256 * 1024);
    await withServer((_request, response) => { response.writeHead(502, { 'Content-Type': 'text/plain' }); response.end(body); }, async url => {
        const httpAttempts = [];
        await telemetry.run({ events: [], httpAttempts }, async () => {
            const response = await withDeadline(realFetch, 3000)(url);
            assert.equal(httpAttempts[0].body.length, 1024);
            assert.equal(httpAttempts[0].truncated, true);
            assert.equal(await response.text(), body);
            assert.equal(httpAttempts[0].bytes, body.length);
            assert.equal(httpAttempts[0].savedBytes, 1024);
        });
    });
});
test('error-body capture obeys the original deadline and retains partial bytes without hiding the abort', async () => {
    await withServer((_request, response) => { response.writeHead(503, { 'Content-Type': 'application/json' }); response.write('{"partial":'); }, async url => {
        const httpAttempts = [];
        await telemetry.run({ events: [], httpAttempts }, async () => {
            const started = Date.now();
            const response = await withDeadline(realFetch, 150)(url);
            assert.ok(Date.now() - started < 2000);
            assert.equal(httpAttempts[0].body, '{"partial":');
            assert.equal(httpAttempts[0].bodyState, 'failed');
            assert.equal(httpAttempts[0].bytesComplete, false);
            assert.equal(httpAttempts[0].error.name, 'AbortError');
            await assert.rejects(response.text(), { name: 'AbortError' });
        });
    });
});
test('unused successful diagnostic responses are captured when inspection finalizes after an exception', async () => {
    await withServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('unused successful response'); }, async url => {
        const httpAttempts = [];
        await telemetry.run({ preview: true, events: [], httpAttempts, captureFinalizers: new Set() }, async () => {
            try { await withDeadline(realFetch)(url); throw new Error('formatter rejected response metadata'); }
            catch (error) { assert.match(error.message, /formatter rejected/); }
            finally { await telemetry.settle(); }
        });
        assert.equal(httpAttempts[0].body, 'unused successful response');
        assert.equal(httpAttempts[0].bodyState, 'complete');
        assert.equal(httpAttempts[0].captureReason, 'unused_diagnostic_response');
    });
});
test('actual GitHub URL inspector preserves a nonexistent repository API reply when the provider rejects status', async () => {
    const body = '{"message":"Not Found","status":"404"}';
    await withServer((_request, response) => { response.writeHead(404, { 'Content-Type': 'application/json' }); response.end(body); }, async localUrl => {
        const fetchPath = require.resolve('node-fetch');
        const originalFetch = require.cache[fetchPath];
        const mockFetch = Object.assign((_url, options) => realFetch(localUrl, options), { Response: realFetch.Response });
        require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: mockFetch };
        const loader = require('../../src/providers/_loader');
        loader._resetForTest();
        try {
            const { inspect } = require('../../src/adminSupport/inspect');
            const result = await inspect({ url: 'https://github.com/fixture-owner/nonexistent-repository', settingsOverrides: { enabled: true } }, 'github-error-body');
            const attempt = result.httpAttempts.find(item => item.status === 404);
            assert.ok(attempt);
            assert.equal(result.outcome, 'failed');
            assert.equal(attempt.body, body);
            assert.equal(attempt.bodyState, 'complete');
            assert.equal(attempt.bytes, Buffer.byteLength(body));
            assert.ok(Number.isFinite(attempt.durationMs));
        } finally { require.cache[fetchPath] = originalFetch; loader._resetForTest(); }
    });
});

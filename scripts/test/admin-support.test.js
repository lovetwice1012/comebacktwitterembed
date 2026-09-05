'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { execute } = require('../../src/adminSupport/worker');
const { payloadFromStep, id } = require('../../src/adminSupport/discord');
const telemetry = require('../../src/adminSupport/telemetry');
const { withDeadline } = require('../../src/providerFetch');
const nodeFetch = require('node-fetch');

const tweet = { tweetURL: 'https://twitter.com/a/status/123', text: 'A complete fixture',
    user_name: 'Test', user_screen_name: 'test', replies: 0, retweets: 0, likes: 0,
    date: '2024-01-01T00:00:00Z', mediaURLs: [] };
function replayInput(extra = {}) {
    return { url: tweet.tweetURL, settings: { enabled: true, legacy_mode: true },
        httpAttempts: [{ url: 'https://api.vxtwitter.com/a/status/123', status: 200,
            headers: { 'content-type': 'application/json' }, body: JSON.stringify(tweet) }], ...extra };
}
test('URL replay executes the real Twitter formatter without notification or Discord effects', async () => {
    const data = await execute({ type: 'url.reparse', actionId: 'replay-test', input: replayInput() });
    assert.equal(data.outcome, 'preview_generated');
    assert.equal(data.steps.length, 1);
    assert.equal(data.httpAttempts[0].replayed, true);
    assert.equal(data.plannedEffects[0].type, 'external_notification');
    assert.match(data.context.unevaluated[0], /Offline replay/);
    assert.ok(data.steps[0].embeds.some(embed => JSON.stringify(embed).includes(tweet.text)));
});
test('offline replay never falls back to network when HTTP evidence is missing', async () => {
    const data = await execute({ type: 'url.reparse', input: replayInput({
        guildId: '123456789012345678', channelId: '123456789012345679', httpAttempts: [],
    }) });
    assert.equal(data.outcome, 'failed');
    assert.equal(data.httpAttempts.length, 0);
    assert.ok(data.events.some(event => event.details?.error?.code === 'REPLAY_EVIDENCE_MISSING'));
});
test('banned word preview records the actual matching rule without creating a deletion timer', async () => {
    const data = await execute({ type: 'url.reparse', input: replayInput({ settings: { enabled: true, legacy_mode: true, bannedWords: ['fixture'] } }) });
    assert.equal(data.outcome, 'skipped');
    assert.equal(data.reason, 'banned_word');
    assert.equal(data.steps.length, 0);
    assert.ok(data.plannedEffects.some(effect => effect.type === 'banned_word_notice_and_source_delete'));
});
test('failure notices do not convert content retrieval failure into success', async () => {
    const input = replayInput({ settings: { enabled: true, failure_display_policy: 'error_message' },
        httpAttempts: [{ url: 'https://api.vxtwitter.com/a/status/123', status: 200, headers: {}, body: 'not JSON' }] });
    const data = await execute({ type: 'url.reparse', input });
    assert.equal(data.outcome, 'failed');
    assert.ok(data.events.some(event => event.kind === 'failed'));
});
test('replay keeps original message text for source-deletion conditions', async () => {
    const data = await execute({ type: 'url.reparse', input: replayInput({
        messageContent: `Please check ${tweet.tweetURL}`, settings: { enabled: true, legacy_mode: true, deletemessageifonlypostedtweetlink: true },
    }) });
    assert.ok(data.steps.every(step => !step.deleteSource));
});
test('Discord IDs stay strings and mentions default to none', () => {
    assert.equal(id('123456789012345678'), '123456789012345678');
    assert.throws(() => id(123456789012345678));
    assert.throws(() => id('../../secrets'));
    assert.deepEqual(payloadFromStep({ content: '@everyone test' }, {}).allowed_mentions, { parse: [], replied_user: false });
    assert.throws(() => payloadFromStep({ content: 'x'.repeat(2001) }, {}), /limit/);
});
test('queued work preserves the receiving message trace when a different request releases capacity', async () => {
    const { WorkQueue } = require('../../src/workQueue');
    const queue = new WorkQueue({ concurrency: 1 });
    let release;
    const first = telemetry.run({ trace_id: 'first-message' }, () => queue.run(() => new Promise(resolve => { release = resolve; })));
    await new Promise(resolve => setImmediate(resolve));
    const second = telemetry.run({ trace_id: 'second-message' }, () => queue.run(() => telemetry.current().trace_id));
    release();
    await first;
    assert.equal(await second, 'second-message');
});
test('HTTP evidence preserves failed status, response body and parse cause without a second body reader', async () => {
    const server = http.createServer((_request, response) => {
        response.writeHead(502, { 'Content-Type': 'text/html', 'Retry-After': '10' });
        response.end('<html>upstream failed</html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const events = [], httpAttempts = [];
        await telemetry.run({ preview: true, events, httpAttempts }, async () => {
            const response = await withDeadline(nodeFetch)(`http://127.0.0.1:${server.address().port}`);
            await assert.rejects(response.json(), SyntaxError);
        });
        assert.equal(httpAttempts[0].status, 502);
        assert.equal(httpAttempts[0].body, '<html>upstream failed</html>');
        assert.equal(httpAttempts[0].headers['retry-after'], '10');
        assert.equal(httpAttempts[0].bodyState, 'complete');
        assert.ok(events.some(event => event.stage === 'parse' && event.kind === 'failed'));
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('spool recovers dead pending/active segments and isolates a live producer and corrupt final line', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-spool-test-'));
    const recovered = [];
    const server = http.createServer(async (request, response) => {
        let body = ''; for await (const chunk of request) body += chunk;
        recovered.push(...JSON.parse(body).events); response.end('{"ok":true}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const liveName = `${process.pid}-live.active`;
    await fs.writeFile(path.join(directory, liveName), '{"event_id":"live"}\n');
    await fs.writeFile(path.join(directory, '99999999-dead.pending'), '{"event_id":"old-pending"}\n');
    await fs.writeFile(path.join(directory, '99999998-dead.active'), '{"event_id":"old-active"}\n{"broken":');
    const worker = new Worker(path.resolve('src/adminSupport/telemetrySpool.js'), {
        workerData: { root: directory, bootId: 'new-boot' }, env: { ...process.env, ADMIN_AGENT_TOKEN: 'fixture-only', ADMIN_AGENT_URL: `http://127.0.0.1:${server.address().port}` },
    });
    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Spool ingestion timeout')), 5000);
            worker.on('error', reject);
            worker.on('message', () => { if (recovered.length >= 3) { clearTimeout(timeout); resolve(); } });
        });
        assert.ok(recovered.some(event => event.event_id === 'old-pending'));
        assert.ok(recovered.some(event => event.event_id === 'old-active'));
        assert.ok(recovered.some(event => event.kind === 'recording.gap'));
        assert.equal(await fs.readFile(path.join(directory, liveName), 'utf8'), '{"event_id":"live"}\n');
        assert.ok((await fs.readdir(directory)).some(name => name.endsWith('.corrupt')));
    } finally {
        await worker.terminate(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        await fs.rm(directory, { recursive: true, force: true });
    }
});

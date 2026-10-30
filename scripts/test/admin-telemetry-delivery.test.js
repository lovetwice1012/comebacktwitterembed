'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { Worker } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const telemetry = require('../../src/adminSupport/telemetry');
const { MAX_EVENT_BYTES, agentEncodedBytes, boundEvent } = require('../../src/adminSupport/telemetryPayload');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
    const deadline = Date.now() + 10000;
    while (!check()) { if (Date.now() > deadline) assert.fail('Telemetry fixture deadline'); await delay(10); }
}

test('attachments keep hashes and lengths without serializing media bytes into events', () => {
    const bytes = Buffer.alloc(3 * 1024 * 1024, 255);
    const result = telemetry.serializable({ files: [{ attachment: bytes, name: 'clip.mp4' }], view: new Uint8Array([1, 2, 3]) });
    assert.equal(result.files[0].attachment.byteLength, bytes.length);
    assert.equal(result.files[0].attachment.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(result.files[0].attachment.omitted, true);
    assert.equal(result.view.byteLength, 3);
    assert(Buffer.byteLength(JSON.stringify(result)) < 1000);
    assert.equal(bytes.length, 3 * 1024 * 1024, 'original send payload remains intact');
});

test('event limits account for receiving Go JSON escaping and preserve trace identity with explicit omissions', () => {
    for (const body of ['a'.repeat(MAX_EVENT_BYTES + 1), '<'.repeat(Math.ceil(MAX_EVENT_BYTES / 6))]) {
        const input = { event_id: 'bounded-event', kind: 'completed', trace_id: 'trace', sequence: 3, details: { body } };
        const result = boundEvent(input);
        assert.equal(result.event_id, input.event_id);
        assert.equal(result.trace_id, 'trace');
        assert.equal(result.sequence, 3);
        assert.equal(result.details.truncation.reason, 'event_size_limit');
        assert.equal(result.details.truncation.sha256, createHash('sha256').update(JSON.stringify(input)).digest('hex'));
        assert(agentEncodedBytes(JSON.stringify(result)) < MAX_EVENT_BYTES);
    }
    const input = { kind: 'heartbeat', details: { ready: true } };
    assert.equal(boundEvent(input), input);
});

test('oversized event keeps useful small details and replaces only the large field', () => {
    const event = { event_id: 'large', kind: 'request.completed', url: 'https://example.test/post',
        outcome: 'E', details: { reason: 'upstream rejected', http: { status: 403, body: 'x'.repeat(MAX_EVENT_BYTES + 1) } } };
    const bounded = boundEvent(event, 'original.jsonl');
    assert.equal(bounded.url, event.url);
    assert.equal(bounded.details.reason, 'upstream rejected');
    assert.equal(bounded.details.http.status, 403);
    assert.equal(bounded.details.http.body.omitted, true);
    assert.equal(bounded.details.truncation.archiveFile, 'original.jsonl');
    assert(agentEncodedBytes(JSON.stringify(bounded)) < MAX_EVENT_BYTES);
});

async function fixture(work, initial) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-telemetry-recovery-'));
    const received = [], health = [];
    let status = 503, worker;
    const server = http.createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const events = JSON.parse(Buffer.concat(chunks).toString()).events;
        const code = events.some(row => agentEncodedBytes(JSON.stringify(row)) > 8 * 1024 * 1024) ? 503 : status;
        received.push({ events, status: code }); res.statusCode = code; res.end('{"ok":true}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    async function start() {
        worker = new Worker(path.resolve(__dirname, '../../src/adminSupport/telemetrySpool.js'), {
            workerData: { root, bootId: 'fixture' }, env: { ...process.env, ADMIN_AGENT_TOKEN: 'fixture-only',
                ADMIN_AGENT_URL: `http://127.0.0.1:${server.address().port}` },
        });
        worker.on('message', message => { if (message.type === 'health') health.push(message); });
        await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    }
    try {
        if (initial) await fs.writeFile(path.join(root, `${process.pid}-fixture-initial.pending`), initial);
        await start();
        await work({ root, received, health, setStatus(value) { status = value; },
            post(row) { worker.postMessage({ type: 'event', row }); },
            flush() { worker.postMessage({ type: 'flush' }); },
            async restart() { await worker.terminate(); await start(); } });
    } finally {
        if (worker) await worker.terminate(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        await fs.rm(root, { recursive: true, force: true });
    }
}

test('legacy oversized events preserve original bytes, survive retry/restart, and allow the following heartbeat', { timeout: 15000 }, async () => {
    const original = JSON.stringify({ event_id: 'legacy', sequence: 1, kind: 'completed', details: { body: 'x'.repeat(9 * 1024 * 1024) } }) + '\n'
        + JSON.stringify({ event_id: 'heartbeat', sequence: 2, kind: 'heartbeat' }) + '\n';
    await fixture(async f => {
        await until(() => f.received.length > 0);
        await until(() => f.health.some(h => h.deliveryError));
        await delay(130);
        assert.match(f.health.at(-1).deliveryError, /503/);
        assert.match(f.health.at(-1).error, /503/, 'fsync must not clear an unresolved ingest failure');
        const before = (await fs.readdir(f.root)).filter(name => name.startsWith('oversized-'));
        assert.equal(before.length, 1);
        assert.equal(await fs.readFile(path.join(f.root, before[0]), 'utf8'), original);
        f.setStatus(200); await f.restart();
        await until(() => f.health.some(h => h.lastDeliverySuccessAtMs && !h.deliveryError && h.pendingBytes === 0));
        const accepted = f.received.filter(item => item.status === 200).flatMap(item => item.events);
        assert(accepted.some(row => row.event_id === 'heartbeat'));
        const recovered = accepted.find(row => row.event_id === 'legacy');
        assert.equal(recovered.details.truncation.archiveFile, before[0]);
        assert.deepEqual((await fs.readdir(f.root)).filter(name => name.startsWith('oversized-')), before);
        assert.equal(await fs.readFile(path.join(f.root, before[0]), 'utf8'), original);
        assert.equal(f.health.at(-1).pendingBytes, 0);
        assert(f.health.at(-1).archiveBytes > 0);
    }, original);
});

test('new oversized events are bounded before persistence and normal events continue after ingestion recovery', { timeout: 15000 }, async () => {
    await fixture(async f => {
        f.post({ event_id: 'new-large', sequence: 1, kind: 'completed', details: { body: 'x'.repeat(9 * 1024 * 1024) } });
        f.post({ event_id: 'new-heartbeat', sequence: 2, kind: 'heartbeat' }); f.flush();
        await until(() => f.health.some(row => row.deliveryError)); await delay(100);
        assert(f.health.at(-1).error);
        f.setStatus(200); f.flush();
        await until(() => f.health.some(row => row.lastDeliverySuccessAtMs && !row.error && row.pendingBytes === 0));
        const accepted = f.received.filter(row => row.status === 200).flatMap(row => row.events);
        assert(accepted.some(row => row.event_id === 'new-heartbeat'));
        assert.equal(accepted.find(row => row.event_id === 'new-large').details.truncation.reason, 'event_size_limit');
        assert.deepEqual(await fs.readdir(f.root), []);
    });
});

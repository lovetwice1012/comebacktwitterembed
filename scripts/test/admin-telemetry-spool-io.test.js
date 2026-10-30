'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { createRequire } = require('node:module');
const filename = path.resolve(__dirname, '../../src/adminSupport/telemetrySpool.js');
const source = fs.readFileSync(filename, 'utf8'), localRequire = createRequire(filename);

function fixture(t, initial) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cbte-telemetry-io-'));
    const descriptors = new Set(), messages = [], batches = [];
    const descriptorPaths = new Map();
    let listener, env, partial = null, failTruncate = false, failSync = false, archiveFailure = null, maxWrite = Infinity;
    const diskError = () => Object.assign(new Error('fixture storage unavailable'), { code: 'ENOSPC' });
    const filesystem = { ...fs,
        openSync(...args) { const fd = fs.openSync(...args); descriptors.add(fd); descriptorPaths.set(fd, args[0]); return fd; },
        closeSync(fd) { fs.closeSync(fd); descriptors.delete(fd); descriptorPaths.delete(fd); },
        writeSync(fd, buffer, offset, length) {
            if (partial === 0) { partial = null; throw diskError(); }
            const selected = Math.min(length, partial ?? Infinity, maxWrite);
            const count = fs.writeSync(fd, buffer, offset, selected);
            if (partial !== null) partial -= count;
            return count;
        },
        ftruncateSync(...args) { if (failTruncate) throw diskError(); return fs.ftruncateSync(...args); },
        writeFileSync(fd, bytes, ...args) {
            if (archiveFailure === 'write' && descriptorPaths.get(fd)?.endsWith('.partial')) {
                fs.writeSync(fd, bytes.subarray(0, 17)); throw Object.assign(new Error('fixture partial archive write'), { code: 'EIO' });
            }
            return fs.writeFileSync(fd, bytes, ...args);
        },
        fsyncSync(...args) {
            if (failSync) throw diskError();
            if (archiveFailure === 'sync' && descriptorPaths.get(args[0])?.endsWith('.partial')) throw Object.assign(new Error('fixture archive sync failure'), { code: 'EIO' });
            return fs.fsyncSync(...args);
        },
    };
    function closeDescriptors() { for (const fd of descriptors) { fs.closeSync(fd); descriptors.delete(fd); descriptorPaths.delete(fd); } }
    function start() {
        env = { ADMIN_AGENT_TOKEN: '', ADMIN_AGENT_URL: 'http://fixture.invalid' };
        const module = { exports: {} };
        const context = vm.createContext({ Buffer, module, exports: module.exports, Date, JSON, Promise, AbortSignal,
            process: { pid: process.pid, platform: process.platform, env, kill: process.kill },
            setInterval: () => ({ unref() {} }),
            fetch: async (_url, request) => { batches.push(...JSON.parse(request.body).events); return { ok: true, text: async () => '' }; },
            require(name) {
                if (name === 'worker_threads') return { workerData: { root, bootId: 'same-producer' }, parentPort: {
                    postMessage: message => messages.push(message), on: (_event, handler) => { listener = handler; },
                } };
                return name === 'fs' ? filesystem : localRequire(name);
            },
        });
        vm.runInContext(source, context, { filename });
    }
    t.after(() => { closeDescriptors(); assert.equal(path.dirname(root), os.tmpdir()); assert(path.basename(root).startsWith('cbte-telemetry-io-')); fs.rmSync(root, { recursive: true, force: true }); });
    const initialFile = initial ? path.join(root, `${process.pid}-same-producer-initial.pending`) : null;
    if (initialFile) fs.writeFileSync(initialFile, initial);
    start();
    return {
        root, initialFile, messages, batches, post(row) { listener({ type: 'event', row }); },
        failPartial(bytes, rollback) { partial = bytes; failTruncate = rollback === 'truncate'; failSync = rollback === 'sync'; },
        failArchive(operation) { archiveFailure = operation; },
        recover() { failTruncate = false; failSync = false; archiveFailure = null; }, shortWrites(bytes) { maxWrite = bytes; },
        restart() { closeDescriptors(); failTruncate = false; failSync = false; partial = null; start(); },
        async flush() { env.ADMIN_AGENT_TOKEN = 'fixture'; listener({ type: 'flush' }); await new Promise(resolve => setImmediate(resolve)); },
        health() { return messages.filter(message => message.type === 'health').at(-1); },
    };
}
const row = sequence => ({ event_id: `event-${sequence}`, sequence, kind: 'heartbeat', occurredAt: '2099-01-01T00:00:00.000Z', details: { ready: true } });

test('a partial append error rolls back only rejected bytes and preserves both neighboring events and quota accounting', async t => {
    const f = fixture(t); f.post(row(1)); f.failPartial(10); f.post(row(2)); f.post(row(3)); await f.flush();
    assert.deepEqual(f.batches.map(event => event.event_id).sort(), ['event-1', 'event-3']);
    assert.deepEqual(f.messages.filter(message => message.type === 'rejected').map(message => message.sequence), [2]);
    assert.equal(f.health().durableSequence, 3); assert.equal(f.health().pendingBytes, 0); assert.equal(f.health().diskBytes, 0);
    assert.deepEqual(fs.readdirSync(f.root), []);
});

for (const operation of ['truncate', 'sync']) test(`a failed ${operation} rollback fences later writes until the original tail is durably repaired`, async t => {
    const f = fixture(t); f.post(row(1)); f.failPartial(10, operation); f.post(row(2)); f.post(row(3));
    assert.deepEqual(f.messages.filter(message => message.type === 'rejected').map(message => message.sequence), [2, 3]);
    assert.equal(f.health().pendingSequence, 1); assert.equal(f.health().durableSequence, 0); assert(f.health().persistenceError);
    const active = fs.readdirSync(f.root).find(name => name.endsWith('.active'));
    assert(!fs.readFileSync(path.join(f.root, active), 'utf8').includes('event-3'));
    f.recover(); f.post(row(4)); await f.flush();
    assert.deepEqual(f.batches.map(event => event.event_id).sort(), ['event-1', 'event-4']);
    assert.equal(f.health().durableSequence, 4); assert.equal(f.health().pendingBytes, 0); assert.equal(f.health().diskBytes, 0); assert.equal(f.health().error, null);
});

test('a replacement worker isolates its old partial active line before accepting another event under the same process and boot', async t => {
    const f = fixture(t); f.post(row(1)); f.failPartial(10, 'truncate'); f.post(row(2)); f.restart(); f.post(row(3)); await f.flush();
    assert.deepEqual(f.batches.filter(event => event.kind === 'heartbeat').map(event => event.event_id).sort(), ['event-1', 'event-3']);
    assert.equal(f.batches.filter(event => event.kind === 'recording.gap').length, 1);
    assert.equal(f.health().pendingBytes, 0); assert(f.health().archiveBytes > 0);
    const files = fs.readdirSync(f.root); assert.equal(files.length, 1); assert(files[0].endsWith('.corrupt'));
    assert.equal(f.health().diskBytes, fs.statSync(path.join(f.root, files[0])).size);
});

test('short writes are completed without duplicating, truncating or rejecting a valid event', async t => {
    const f = fixture(t); f.shortWrites(7); f.post(row(1)); await f.flush();
    assert.deepEqual(f.batches, [row(1)]); assert.equal(f.messages.filter(message => message.type === 'rejected').length, 0);
    assert.equal(f.health().pendingBytes, 0); assert.equal(f.health().diskBytes, 0);
});

test('atomic archive publication preserves the pending original through write/fsync failure and an exact retry', async t => {
    const { MAX_EVENT_BYTES } = require('../../src/adminSupport/telemetryPayload');
    const original = Buffer.from(JSON.stringify({ ...row(1), kind: 'completed', details: { body: 'x'.repeat(MAX_EVENT_BYTES + 1) } }) + '\n' + JSON.stringify(row(2)) + '\n');
    for (const operation of ['write', 'sync']) await t.test(operation, async t => {
        const f = fixture(t, original); f.failArchive(operation); await f.flush();
        assert.match(f.health().deliveryError, operation === 'write' ? /partial archive write/ : /archive sync failure/);
        assert.equal(f.batches.length, 0); assert.deepEqual(fs.readFileSync(f.initialFile), original);
        assert.equal(fs.readdirSync(f.root).filter(name => name.endsWith('.jsonl') || name.endsWith('.partial')).length, 0, 'an incomplete archive must never occupy the published name');
        assert.equal(f.health().pendingBytes, original.length); assert.equal(f.health().diskBytes, original.length);
        f.recover(); await f.flush();
        assert.deepEqual(f.batches.map(event => event.event_id), ['event-1', 'event-2']);
        const archived = f.batches[0].details.truncation.archiveFile;
        assert.match(archived, /^replayed-[a-f0-9]{64}\.jsonl$/); assert.deepEqual(fs.readFileSync(path.join(f.root, archived)), original);
        assert.deepEqual(f.batches[1], row(2), 'the following heartbeat is unmodified');
        assert.equal(fs.existsSync(f.initialFile), false); assert.deepEqual(fs.readdirSync(f.root), [archived]);
        assert.equal(f.health().pendingBytes, 0); assert.equal(f.health().archiveBytes, original.length); assert.equal(f.health().diskBytes, original.length); assert.equal(f.health().error, null);
    });
});

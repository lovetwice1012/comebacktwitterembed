'use strict';

// Only this worker thread touches the write-ahead log. The Bot event loop never
// fsyncs. ACKs expose the exact durable sequence (up to a 50 ms batching window).
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = workerData.root;
const prefix = `${process.pid}-${workerData.bootId}`;
const active = path.join(root, `${prefix}.active`);
const maxBytes = Number(process.env.ADMIN_TELEMETRY_MAX_BYTES) || 512 * 1024 * 1024;
let dirty = false, durableSequence = 0, pendingSequence = 0, diskBytes = 0, flushing = false, fd;
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
for (const name of fs.readdirSync(root)) {
    const file = path.join(root, name);
    diskBytes += fs.statSync(file).size;
    if (!name.endsWith('.active') && !name.endsWith('.pending')) continue;
    const pid = Number(name.split('-')[0]);
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); alive = true; } catch {} }
    if (!alive) fs.renameSync(file, path.join(root, `${prefix}-recovered-${crypto.randomUUID()}.pending`));
}
function report(error) { parentPort.postMessage({ type: 'health', durableSequence, pendingSequence, diskBytes, error: error?.message || null }); }
function sync() {
    if (dirty && fd !== undefined) { fs.fsyncSync(fd); dirty = false; durableSequence = pendingSequence; }
    report();
}
function append(row) {
    const bytes = Buffer.from(JSON.stringify(row) + '\n');
    if (diskBytes + bytes.length > maxBytes) throw new Error('Telemetry spool quota reached; new evidence could not be persisted.');
    if (fd === undefined) fd = fs.openSync(active, 'a', 0o600);
    fs.writeSync(fd, bytes);
    diskBytes += bytes.length; dirty = true; pendingSequence = row.sequence;
}
async function flush() {
    if (flushing || !process.env.ADMIN_AGENT_TOKEN) return;
    flushing = true;
    try {
        sync();
        if (fd !== undefined) {
            fs.closeSync(fd); fd = undefined;
            fs.renameSync(active, path.join(root, `${prefix}-${Date.now()}-${crypto.randomUUID()}.pending`));
        }
        // Own only this producer's segments (including explicitly recovered dead
        // producers). Never rename, read or unlink a live producer's active log.
        for (const name of fs.readdirSync(root).filter(item => item.startsWith(prefix) && item.endsWith('.pending')).slice(0, 12)) {
            const file = path.join(root, name), bytes = fs.readFileSync(file);
            const rows = [], invalid = [];
            for (const [index, line] of bytes.toString('utf8').split('\n').entries()) {
                if (!line) continue;
                try { rows.push(JSON.parse(line)); } catch { invalid.push({ line: index + 1, raw: line }); }
            }
            if (invalid.length) {
                fs.writeFileSync(`${file}.corrupt`, JSON.stringify(invalid), { mode: 0o600 });
                rows.push({ event_id: crypto.randomUUID(), kind: 'recording.gap', stage: 'recording',
                    occurred_at: new Date().toISOString(), trigger_type: 'system', details: { reason: 'incomplete_or_corrupt_spool_record', segment: name, lines: invalid.map(item => item.line) } });
            }
            for (let offset = 0; offset < rows.length;) {
                const batch = []; let size = 0;
                while (offset < rows.length && batch.length < 32) {
                    const rowSize = Buffer.byteLength(JSON.stringify(rows[offset]));
                    if (batch.length && size + rowSize > 6 * 1024 * 1024) break;
                    size += rowSize; batch.push(rows[offset++]);
                }
                const response = await fetch(`${process.env.ADMIN_AGENT_URL || 'http://127.0.0.1:30988'}/v1/events`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Agent-Token': process.env.ADMIN_AGENT_TOKEN },
                    body: JSON.stringify({ events: batch }), signal: AbortSignal.timeout(5000),
                });
                if (!response.ok) throw new Error(`Agent ingestion HTTP ${response.status}`);
                await response.text();
            }
            fs.unlinkSync(file); diskBytes = Math.max(0, diskBytes - bytes.length);
        }
        report();
    } catch (error) { report(error); } finally { flushing = false; }
}
parentPort.on('message', message => {
    try {
        if (message.type === 'event') append(message.row);
        if (message.type === 'flush') void flush();
        if (message.type === 'stop') {
            sync();
            void flush().finally(() => { if (fd !== undefined) { fs.closeSync(fd); fd = undefined; } parentPort.postMessage({ type: 'stopped' }); });
        }
    } catch (error) { parentPort.postMessage({ type: 'rejected', sequence: message.row?.sequence, error: error.message }); report(error); }
});
setInterval(() => { try { sync(); } catch (error) { report(error); } }, 50).unref();
setInterval(() => void flush(), 5000).unref();
void flush();

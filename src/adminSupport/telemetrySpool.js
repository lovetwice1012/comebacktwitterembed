'use strict';

// Only this worker thread touches the write-ahead log. The Bot event loop never
// fsyncs. ACKs expose the exact durable sequence (up to a 50 ms batching window).
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MAX_EVENT_BYTES, agentEncodedBytes, boundEvent } = require('./telemetryPayload');
const root = workerData.root;
const prefix = `${process.pid}-${workerData.bootId}`;
const active = path.join(root, `${prefix}.active`);
const maxBytes = Number(process.env.ADMIN_TELEMETRY_MAX_BYTES) || 512 * 1024 * 1024;
let dirty = false, durableSequence = 0, pendingSequence = 0, diskBytes = 0, pendingBytes = 0, flushing = null, fd;
let incompleteAppend = null;
let persistenceError = null, deliveryError = null, lastDeliverySuccessAtMs = null, lastDeliveryFailureAtMs = null;
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
for (const name of fs.readdirSync(root)) {
    const file = path.join(root, name);
    const size = fs.statSync(file).size;
    diskBytes += size;
    if (!name.endsWith('.active') && !name.endsWith('.pending')) continue;
    pendingBytes += size;
    const pid = Number(name.split('-')[0]);
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); alive = true; } catch {} }
    // A replacement worker keeps this process/boot identity. Its predecessor
    // may have died halfway through a line; never append to that old tail.
    if (!alive || file === active) fs.renameSync(file, path.join(root, `${prefix}-recovered-${crypto.randomUUID()}.pending`));
}
function report() {
    parentPort.postMessage({ type: 'health', durableSequence, pendingSequence, diskBytes, pendingBytes,
        archiveBytes: diskBytes - pendingBytes, persistenceError, deliveryError,
        lastDeliverySuccessAtMs, lastDeliveryFailureAtMs, error: persistenceError || deliveryError });
}
function failed(error, phase) {
    if (phase === 'delivery') { deliveryError = error.message; lastDeliveryFailureAtMs = Date.now(); }
    else persistenceError = error.message;
    report();
}
function restoreCompleteTail() {
    if (!incompleteAppend) return;
    // Only bytes from the rejected append are removed. Earlier complete
    // records remain intact. If either operation fails, retain the fence and
    // reject subsequent appends until rollback can be made durable.
    // Windows append-only handles cannot be truncated. Use a temporary
    // read/write handle while retaining the fenced writer's append position.
    const repair = fs.openSync(active, 'r+');
    try {
        fs.ftruncateSync(repair, incompleteAppend.offset);
        fs.fsyncSync(repair);
    } finally { fs.closeSync(repair); }
    diskBytes -= incompleteAppend.written;
    pendingBytes -= incompleteAppend.written;
    incompleteAppend = null;
}
function sync() {
    restoreCompleteTail();
    if (dirty && fd !== undefined) { fs.fsyncSync(fd); dirty = false; durableSequence = pendingSequence; persistenceError = null; }
    report();
}
function append(row) {
    restoreCompleteTail();
    const bytes = Buffer.from(JSON.stringify(boundEvent(row)) + '\n');
    // Preserved incident archives are reported separately. They must not hold
    // the live delivery queue at its limit after successful recovery.
    if (pendingBytes + bytes.length > maxBytes) throw new Error('Telemetry spool quota reached; new evidence could not be persisted.');
    if (fd === undefined) fd = fs.openSync(active, 'a', 0o600);
    const offset = fs.fstatSync(fd).size;
    let written = 0;
    try {
        while (written < bytes.length) {
            const count = fs.writeSync(fd, bytes, written, bytes.length - written);
            if (!count) throw new Error('Telemetry spool write made no progress.');
            written += count; diskBytes += count; pendingBytes += count;
        }
    } catch (error) {
        incompleteAppend = { offset, written };
        try { restoreCompleteTail(); } catch { /* Keep the fence until recovery succeeds. */ }
        throw error;
    }
    dirty = true; pendingSequence = row.sequence;
}
function preserve(name, bytes) {
    const file = path.join(root, name);
    const temporary = `${file}.${crypto.randomUUID()}.partial`;
    let archive, created = false, failure;
    try {
        archive = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(archive, bytes); fs.fsyncSync(archive);
        fs.closeSync(archive); archive = undefined;
        // Publish only complete archives; a failed/partial write must not
        // occupy the immutable archive name and prevent later recovery.
        try { fs.linkSync(temporary, file); created = true; }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            if (!fs.readFileSync(file).equals(bytes)) throw new Error('Telemetry archive does not match its original segment.');
        }
        if (created) diskBytes += bytes.length;
        if (process.platform !== 'win32') {
            const directory = fs.openSync(root, 'r');
            try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
        }
    } catch (error) { failure = error; }
    try { if (archive !== undefined) fs.closeSync(archive); } catch (error) { failure ||= error; }
    try { fs.unlinkSync(temporary); }
    catch (error) {
        if (error.code !== 'ENOENT') {
            failure ||= error;
            try { diskBytes += fs.statSync(temporary).size; } catch { /* Report the cleanup failure even if metadata is unavailable. */ }
        }
    }
    if (failure) throw failure;
}
function isHistoricalHeartbeat(row) {
    if (!['heartbeat', 'bot.heartbeat', 'runtime.heartbeat'].includes(row.kind)) return false;
    const occurred = Date.parse(row.occurredAt || row.occurred_at || '');
    return !Number.isFinite(occurred) || occurred < Date.now() - 2 * 60 * 1000;
}
async function deliver() {
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
            let rows = [];
            const invalid = [];
            for (const [index, line] of bytes.toString('utf8').split('\n').entries()) {
                if (!line) continue;
                try {
                    const row = JSON.parse(line);
                    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid event record');
                    rows.push(row);
                } catch { invalid.push({ line: index + 1, raw: line }); }
            }
            if (invalid.length) {
                preserve(`${name}.corrupt`, Buffer.from(JSON.stringify(invalid)));
                rows.push({ event_id: crypto.createHash('sha256').update(bytes).update('corrupt').digest('hex'), kind: 'recording.gap', stage: 'recording',
                    occurred_at: new Date().toISOString(), trigger_type: 'system', details: { reason: 'incomplete_or_corrupt_spool_record', segment: name, lines: invalid.map(item => item.line) } });
            }
            const oldHeartbeat = rows.some(isHistoricalHeartbeat);
            const oversized = rows.some(row => agentEncodedBytes(JSON.stringify(row)) > MAX_EVENT_BYTES);
            if (oldHeartbeat || oversized) {
                // Keep the original bytes durably before sending a bounded
                // event with the same identity. A restart reuses this archive.
                // Replayed old heartbeats must not replace current liveness.
                const archive = `replayed-${crypto.createHash('sha256').update(bytes).digest('hex')}.jsonl`;
                preserve(archive, bytes);
                rows = rows.map(row => {
                    if (isHistoricalHeartbeat(row)) {
                        const details = row.details && typeof row.details === 'object' && !Array.isArray(row.details) ? row.details : {};
                        row = { ...row, triggerType: 'diagnostic', trigger_type: 'diagnostic',
                            details: { ...details, replay: { historicalHeartbeat: true,
                                originalTriggerType: row.triggerType || row.trigger_type || null, archiveFile: archive } } };
                    }
                    return boundEvent(row, archive);
                });
            }
            for (let offset = 0; offset < rows.length;) {
                const batch = []; let size = 0;
                while (offset < rows.length && batch.length < 32) {
                    const rowSize = agentEncodedBytes(JSON.stringify(rows[offset]));
                    if (batch.length && size + rowSize > MAX_EVENT_BYTES) break;
                    size += rowSize; batch.push(rows[offset++]);
                }
                const response = await fetch(`${process.env.ADMIN_AGENT_URL || 'http://127.0.0.1:30988'}/v1/events`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Agent-Token': process.env.ADMIN_AGENT_TOKEN },
                    body: JSON.stringify({ events: batch }), signal: AbortSignal.timeout(5000),
                });
                if (!response.ok) throw new Error(`Agent ingestion HTTP ${response.status}`);
                await response.text();
            }
            fs.unlinkSync(file); diskBytes = Math.max(0, diskBytes - bytes.length); pendingBytes = Math.max(0, pendingBytes - bytes.length);
            lastDeliverySuccessAtMs = Date.now(); deliveryError = null;
        }
        report();
    } catch (error) { failed(error, 'delivery'); }
}
function flush() {
    if (flushing) return flushing;
    if (!process.env.ADMIN_AGENT_TOKEN) return Promise.resolve();
    flushing = deliver().finally(() => { flushing = null; });
    return flushing;
}
parentPort.on('message', message => {
    try {
        if (message.type === 'event') append(message.row);
        if (message.type === 'flush') void flush();
        if (message.type === 'stop') {
            sync();
            void flush().finally(() => { if (fd !== undefined) { fs.closeSync(fd); fd = undefined; } parentPort.postMessage({ type: 'stopped' }); });
        }
    } catch (error) { parentPort.postMessage({ type: 'rejected', sequence: message.row?.sequence, error: error.message }); failed(error, 'persistence'); }
});
setInterval(() => { try { sync(); } catch (error) { failed(error, 'persistence'); } }, 50).unref();
setInterval(() => void flush(), 5000).unref();
void flush();

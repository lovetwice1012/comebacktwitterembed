'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createEdgeWnsTransport } = require('../../src/automation/edge-wns-transport');
function fixture(options = {}) {
    const socket = new EventEmitter(); socket.destroyed = false; socket.sent = [];
    socket.write = (bytes, callback) => { socket.sent.push(Buffer.from(bytes)); if (options.write) return options.write(callback); queueMicrotask(() => callback()); return true; };
    socket.destroy = () => { if (!socket.destroyed) { socket.destroyed = true; socket.emit('close'); } };
    const transport = createEdgeWnsTransport({ socketFactory: () => socket, timeoutMs: 100, ...(options.signal ? { signal: options.signal } : {}) });
    return { socket, transport };
}
const frame = Buffer.from('NFY 1 WNS\\NOTIF 3\r\nabc');
test('receives fragmented and adjacent frames and writes on the same bounded socket', async () => {
    const { socket, transport } = fixture(); socket.emit('secureConnect'); await transport.connect();
    const first = transport.next(); socket.emit('data', frame.subarray(0, 8)); socket.emit('data', Buffer.concat([frame.subarray(8), frame]));
    assert.deepEqual(await first, frame); assert.deepEqual(await transport.next(), frame);
    await transport.send(frame); assert.deepEqual(socket.sent, [frame]); transport.close(); assert.equal(socket.destroyed, true);
    await assert.rejects(transport.next(), { code: 'X_EDGE_WNS_STOPPED' });
});
test('malformed frames and excess queued frames close the socket; idle timeouts remain usable', async () => {
    for (const input of [Buffer.from('bad\n'), Buffer.from('X 0\r\n'.repeat(17))]) {
        const { socket, transport } = fixture(); socket.emit('secureConnect'); await transport.connect(); socket.emit('data', input);
        assert.equal(socket.destroyed, true); await assert.rejects(transport.next(), error => ['X_EDGE_WNS_FRAME_INVALID', 'X_EDGE_WNS_BACKPRESSURE'].includes(error.code));
    }
    const { socket, transport } = fixture(); socket.emit('secureConnect'); await transport.connect();
    await assert.rejects(transport.next(10), { code: 'X_EDGE_WNS_RECEIVE_TIMEOUT' }); assert.equal(socket.destroyed, false);
    socket.emit('data', frame); assert.deepEqual(await transport.next(), frame); transport.close();
});
test('an idle timeout retains a partially received frame for the next read', async () => {
    const { socket, transport } = fixture(); socket.emit('secureConnect'); await transport.connect();
    socket.emit('data', frame.subarray(0, 12));
    await assert.rejects(transport.next(10), { code: 'X_EDGE_WNS_RECEIVE_TIMEOUT' });
    socket.emit('data', frame.subarray(12)); assert.deepEqual(await transport.next(), frame); transport.close();
});
test('close and socket errors promptly reject pending reads and writes', async () => {
    const read = fixture(); read.socket.emit('secureConnect'); await read.transport.connect();
    const waiting = read.transport.next(); read.socket.emit('error', new Error('private socket detail'));
    await assert.rejects(waiting, error => error.code === 'X_EDGE_WNS_SOCKET_FAILED' && !error.message.includes('private socket detail'));
    let callback; const write = fixture({ write: done => { callback = done; return true; } }); write.socket.emit('secureConnect'); await write.transport.connect();
    const pending = write.transport.send(frame); write.transport.close(); await assert.rejects(pending, { code: 'X_EDGE_WNS_STOPPED' }); callback();
});
test('concurrent reads or writes fail closed and abort the in-flight operation', async () => {
    const read = fixture(); read.socket.emit('secureConnect'); await read.transport.connect();
    const first = read.transport.next(), rejected = assert.rejects(first, { code: 'X_EDGE_WNS_TRANSPORT_STATE_INVALID' });
    await assert.rejects(read.transport.next(), { code: 'X_EDGE_WNS_TRANSPORT_STATE_INVALID' }); await rejected;
    const write = fixture({ write: () => true }); write.socket.emit('secureConnect'); await write.transport.connect();
    const pending = write.transport.send(frame), stopped = assert.rejects(pending, { code: 'X_EDGE_WNS_TRANSPORT_STATE_INVALID' });
    await assert.rejects(write.transport.send(frame), { code: 'X_EDGE_WNS_TRANSPORT_STATE_INVALID' }); await stopped;
});
test('connection timeout and cancellation do not expose connection details', async () => {
    const timeout = fixture(); await assert.rejects(timeout.transport.connect(), { code: 'X_EDGE_WNS_CONNECT_TIMEOUT' }); assert(timeout.socket.destroyed);
    const controller = new AbortController(), cancelled = fixture({ signal: controller.signal });
    controller.abort(); await assert.rejects(cancelled.transport.connect(), { code: 'X_EDGE_WNS_STOPPED' }); assert(cancelled.socket.destroyed);
});

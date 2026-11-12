'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createChromeMcsTransport } = require('../../src/automation/chrome-mcs-transport');
const { encodeFrame } = require('../../src/automation/chrome-mcs-framing');
class FakeSocket extends EventEmitter {
    constructor() { super(); this.writes = []; this.destroyed = false; queueMicrotask(() => this.emit('secureConnect')); }
    write(data, callback) { this.writes.push(data); queueMicrotask(() => callback()); }
    pause() {} resume() {} destroy() { this.destroyed = true; }
}
test('MCS transport handles fragmented and concatenated frames and writes binary', async () => {
    const socket = new FakeSocket(), transport = createChromeMcsTransport({ timeoutMs: 1000, createSocket: () => socket });
    await transport.connect();
    const wire = Buffer.concat([encodeFrame(3, Buffer.from('login'), { first: true }), encodeFrame(1, Buffer.alloc(0))]);
    for (const byte of wire) socket.emit('data', Buffer.from([byte]));
    assert.deepEqual(await transport.read(100), { tag: 3, payload: Buffer.from('login') });
    assert.deepEqual(await transport.read(100), { tag: 1, payload: Buffer.alloc(0) });
    await transport.send(Buffer.from([1, 2])); assert.deepEqual(socket.writes[0], Buffer.from([1, 2]));
    assert.equal(await transport.read(5), undefined);
    await transport.close(); assert(socket.destroyed);
});
test('MCS transport fails closed on invalid framing and abort', async () => {
    for (const attack of [Buffer.from([40])]) {
        const socket = new FakeSocket(), transport = createChromeMcsTransport({ timeoutMs: 1000, createSocket: () => socket });
        await transport.connect(); socket.emit('data', attack);
        await assert.rejects(transport.read(100), e => ['X_PUSH_PROTOCOL_INVALID', 'X_PUSH_BACKPRESSURE'].includes(e.code));
        assert(socket.destroyed);
    }
    const socket = new FakeSocket(), transport = createChromeMcsTransport({ timeoutMs: 1000, createSocket: () => socket });
    await transport.connect(); const reading = transport.read(1000); transport.abort('X_PUSH_LEASE_LOST');
    await assert.rejects(reading, e => e.code === 'X_PUSH_LEASE_LOST');
});
test('pending writes reject immediately on socket error, remote close or explicit shutdown', async () => {
    for (const mode of ['error', 'remote-close', 'shutdown']) {
        const socket = new FakeSocket(), callbacks = [];
        socket.write = (_data, callback) => { callbacks.push(callback); return true; };
        const transport = createChromeMcsTransport({ timeoutMs: 1000, createSocket: () => socket });
        await transport.connect();
        const first = transport.send(Buffer.from('one')), second = transport.send(Buffer.from('two'));
        const code = mode === 'error' ? 'X_PUSH_SOCKET_FAILED' : 'X_PUSH_SOCKET_CLOSED';
        const rejected = Promise.all([assert.rejects(first, { code }), assert.rejects(second, { code })]);
        if (mode === 'error') socket.emit('error', new Error('private detail'));
        else if (mode === 'remote-close') socket.emit('close');
        else await transport.close();
        await rejected;
        // A callback arriving after socket termination must not resettle a send.
        for (const callback of callbacks) callback();
        await transport.close();
    }
});
test('one write error rejects all pending writes and retains the safe error', async () => {
    const socket = new FakeSocket(), callbacks = [];
    socket.write = (_data, callback) => { callbacks.push(callback); return true; };
    const transport = createChromeMcsTransport({ timeoutMs: 1000, createSocket: () => socket });
    await transport.connect();
    const first = transport.send(Buffer.from('one')), second = transport.send(Buffer.from('two'));
    const rejected = Promise.all([assert.rejects(first, { code: 'X_PUSH_SOCKET_FAILED' }), assert.rejects(second, { code: 'X_PUSH_SOCKET_FAILED' })]);
    callbacks[0](new Error('private detail')); await rejected; callbacks[1](); await transport.close();
});
test('a stalled write times out and closes the socket', async () => {
    const socket = new FakeSocket(); socket.write = () => true;
    const transport = createChromeMcsTransport({ timeoutMs: 25, createSocket: () => socket });
    await transport.connect(); await assert.rejects(transport.send(Buffer.from('one')), { code: 'X_PUSH_SEND_TIMEOUT' });
    assert(socket.destroyed); await transport.close();
});
test('only completed frames buffered before a disconnect can be recovered once', async () => {
    for (const mode of ['close', 'error']) {
        const socket = new FakeSocket(), transport = createChromeMcsTransport({ timeoutMs: 1000, createSocket: () => socket });
        await transport.connect();
        socket.emit('data', Buffer.concat([encodeFrame(3, Buffer.from('login'), { first: true }),
            encodeFrame(8, Buffer.from('owned')), encodeFrame(8, Buffer.from('other'))]));
        assert.equal((await transport.read(100)).tag, 3);
        if (mode === 'close') socket.emit('close'); else socket.emit('error', new Error('secret'));
        await assert.rejects(transport.read(100), { code: mode === 'close' ? 'X_PUSH_SOCKET_CLOSED' : 'X_PUSH_SOCKET_FAILED' });
        const frames = transport.takeBufferedAfterDisconnect();
        assert.deepEqual(frames.map(frame => frame.payload.toString()), ['owned', 'other']);
        assert.deepEqual(transport.takeBufferedAfterDisconnect(), []);
        frames.forEach(frame => frame.payload.fill(0)); await transport.close();
    }
    const socket = new FakeSocket(), transport = createChromeMcsTransport({ timeoutMs: 1000, createSocket: () => socket });
    await transport.connect(); socket.emit('data', encodeFrame(3, Buffer.from('login'), { first: true }));
    transport.abort('X_PUSH_LEASE_LOST'); assert.deepEqual(transport.takeBufferedAfterDisconnect(), []);
    await transport.close();
});
test('a 1024-frame read is buffered and resumes after draining below the low water mark', async () => {
    const socket = new FakeSocket(); let pauses = 0, resumes = 0;
    socket.pause = () => { pauses++; }; socket.resume = () => { resumes++; };
    const transport = createChromeMcsTransport({ timeoutMs: 1000, createSocket: () => socket });
    await transport.connect(); socket.emit('data', encodeFrame(3, Buffer.from('login'), { first: true }));
    await transport.read(100);
    socket.emit('data', Buffer.concat(Array.from({ length: 1024 }, (_, i) => encodeFrame(8, Buffer.from(`frame-${i}`)))));
    assert.equal(pauses, 1); assert.equal(resumes, 0);
    for (let i = 0; i < 1024; i++) {
        const frame = await transport.read(100); assert.equal(frame.payload.toString(), `frame-${i}`); frame.payload.fill(0);
    }
    assert.equal(resumes, 1); await transport.close();
});
test('backpressure retains only the bounded completed prefix and clears excess frames', async () => {
    const socket = new FakeSocket(), transport = createChromeMcsTransport({ timeoutMs: 1000, createSocket: () => socket });
    await transport.connect(); socket.emit('data', encodeFrame(3, Buffer.from('login'), { first: true }));
    await transport.read(100);
    socket.emit('data', Buffer.concat(Array.from({ length: 1024 }, (_, i) => encodeFrame(8, Buffer.from(`frame-${i}`)))));
    socket.emit('data', Buffer.concat(Array.from({ length: 17 }, (_, i) => encodeFrame(8, Buffer.from(`frame-${i + 1024}`)))));
    await assert.rejects(transport.read(100), { code: 'X_PUSH_BACKPRESSURE' });
    const frames = transport.takeBufferedAfterDisconnect();
    assert.equal(frames.length, 1040); assert.equal(frames[0].payload.toString(), 'frame-0');
    assert.equal(frames.at(-1).payload.toString(), 'frame-1039');
    frames.forEach(frame => frame.payload.fill(0)); await transport.close();
});
test('large payload bursts remain bounded by bytes as well as frame count', async () => {
    const socket = new FakeSocket(); let paused = 0; socket.pause = () => { paused++; };
    const transport = createChromeMcsTransport({ timeoutMs: 1000, createSocket: () => socket });
    await transport.connect(); socket.emit('data', encodeFrame(3, Buffer.from('login'), { first: true }));
    await transport.read(100);
    const frame = encodeFrame(8, Buffer.alloc(65536, 0x42));
    socket.emit('data', Buffer.concat([frame, frame, frame]));
    assert.equal(paused, 1);
    socket.emit('data', Buffer.concat([frame, frame, frame]));
    socket.emit('data', frame);
    socket.emit('data', encodeFrame(8, Buffer.from([0x43])));
    await assert.rejects(transport.read(100), { code: 'X_PUSH_BACKPRESSURE' });
    const frames = transport.takeBufferedAfterDisconnect();
    assert.equal(frames.length, 7); assert.equal(frames.reduce((sum, item) => sum + item.payload.length, 0), 458752);
    frames.forEach(item => item.payload.fill(0)); await transport.close();
});
test('one maximal read after a partial frame fits the bounded queue without loss', async () => {
    const socket = new FakeSocket(); let pauses = 0; socket.pause = () => { pauses++; };
    const transport = createChromeMcsTransport({ timeoutMs: 1000, createSocket: () => socket });
    await transport.connect(); socket.emit('data', encodeFrame(3, Buffer.from('login'), { first: true }));
    await transport.read(100);
    const nearHigh = encodeFrame(8, Buffer.alloc(65535, 0x11));
    socket.emit('data', Buffer.concat([nearHigh, nearHigh]));
    assert.equal(pauses, 0);
    const partial = encodeFrame(8, Buffer.alloc(65536, 0x22));
    socket.emit('data', partial.subarray(0, partial.length - 1));
    assert.equal(pauses, 0);
    const next = encodeFrame(8, Buffer.alloc(65536, 0x33));
    const last = encodeFrame(8, Buffer.alloc(65519, 0x44));
    const maximalRead = Buffer.concat([partial.subarray(partial.length - 1), next, next, next, last]);
    assert.equal(maximalRead.length, 262144);
    socket.emit('data', maximalRead); assert.equal(pauses, 1);
    socket.emit('close');
    await assert.rejects(transport.read(100), { code: 'X_PUSH_SOCKET_CLOSED' });
    const frames = transport.takeBufferedAfterDisconnect();
    assert.deepEqual(frames.map(frame => frame.payload.length), [65535, 65535, 65536, 65536, 65536, 65536, 65519]);
    assert.equal(frames.reduce((sum, frame) => sum + frame.payload.length, 0), 458733);
    frames.forEach(frame => frame.payload.fill(0)); await transport.close();
});
test('a malformed suffix in one TLS read retains the already completed prefix only', async () => {
    const socket = new FakeSocket(), transport = createChromeMcsTransport({ timeoutMs: 1000, createSocket: () => socket });
    await transport.connect(); socket.emit('data', encodeFrame(3, Buffer.from('login'), { first: true }));
    await transport.read(100);
    socket.emit('data', Buffer.concat([encodeFrame(8, Buffer.from('one')), encodeFrame(8, Buffer.from('two')), Buffer.from([255])]));
    await assert.rejects(transport.read(100), { code: 'X_PUSH_PROTOCOL_INVALID' });
    const frames = transport.takeBufferedAfterDisconnect();
    assert.deepEqual(frames.map(frame => frame.payload.toString()), ['one', 'two']);
    frames.forEach(frame => frame.payload.fill(0)); await transport.close();
});

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
test('MCS transport fails closed on invalid framing, flood and abort', async () => {
    for (const attack of [Buffer.from([40]), Buffer.concat([Buffer.from([41]), ...Array(17).fill(Buffer.from([1, 0]))])]) {
        const socket = new FakeSocket(), transport = createChromeMcsTransport({ timeoutMs: 1000, createSocket: () => socket });
        await transport.connect(); socket.emit('data', attack);
        await assert.rejects(transport.read(100), e => ['X_PUSH_PROTOCOL_INVALID', 'X_PUSH_BACKPRESSURE'].includes(e.code));
        assert(socket.destroyed);
    }
    const socket = new FakeSocket(), transport = createChromeMcsTransport({ timeoutMs: 1000, createSocket: () => socket });
    await transport.connect(); const reading = transport.read(1000); transport.abort('X_PUSH_LEASE_LOST');
    await assert.rejects(reading, e => e.code === 'X_PUSH_LEASE_LOST');
});

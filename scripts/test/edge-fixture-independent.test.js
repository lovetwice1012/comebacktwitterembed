'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { syntheticReconnectSignature } = require('../../experiments/chrome-push/edge-fixture-signature.cjs');
const { selectSyntheticHandshake, independentSyntheticReconnect } = require('../../experiments/chrome-push/edge-fixture-independent.cjs');
const key = Buffer.alloc(32, 7), token = 'synthetic-token', nonce = '1'.repeat(32);
const productConstants = { key: Buffer.from('0123456789abcdef'), id: Buffer.from('fedcba9876543210') };
const frame = (header, body) => Buffer.from(`${header} ${Buffer.byteLength(body)}\r\n${body}`);
function fixture() {
    const signature = syntheticReconnectSignature(key, token, nonce).toString('base64');
    return Buffer.concat([frame('CNT 1 CON', '<connect/>'), frame('ATH 2 CON\\DEVICE', '<device/>'),
        frame('BND 3 CON\\WNS 123', `<wns><reconnect-token>${token}</reconnect-token><nonce>${nonce}</nonce><signature>${signature}</signature></wns>`),
        frame('PUT 4 WNS\\CHALLENGE 123', '<challenge><appId>fedcba9876543210</appId><response>00000000000000000000000000000000</response></challenge>')]);
}
test('synthetic handshake selection handles arbitrary chunks and rejects ambiguity', () => {
    const data = fixture();
    for (let i = 0; i <= data.length; i++) {
        const selected = selectSyntheticHandshake([data.subarray(0, i), data.subarray(i)]);
        assert.equal(Object.keys(selected).sort().join(','), 'ath,bnd,challenge,cnt');
        for (const value of Object.values(selected)) value.fill(0);
    }
    assert.throws(() => selectSyntheticHandshake([data.subarray(0, -1)]), /PROBE_FRAMES_INVALID/);
    assert.throws(() => selectSyntheticHandshake([data, frame('CNT 5 CON', '<connect/>')]), /PROBE_FRAMES_INVALID/);
});
test('independent fixture only reports a notification after ciphertext and plaintext checks', async () => {
    const frames = selectSyntheticHandshake([fixture()]); let writes = 0;
    const socket = new EventEmitter();
    socket.write = (_buffer, callback) => {
        writes++;
        const response = writes === 1 ? frame('CNT 1 CON', '<connect/>') : writes === 2 ? frame('ATH 2 CON', '')
            : writes === 3 ? frame('BND 3 CON', '<wns><reconnect-token>x</reconnect-token><nonce>x</nonce></wns>') : frame('PUT 4 WNS', '');
        queueMicrotask(() => { callback(); socket.emit('data', response); }); return true;
    };
    socket.destroy = () => socket.emit('close');
    const connect = () => { queueMicrotask(() => socket.emit('secureConnect')); return socket; };
    const sendNotification = async () => {
        queueMicrotask(() => socket.emit('data', frame('NFY 5 WNS\\NOTIF 1', 'Content-Encoding: aes128gcm\r\n\r\nsynthetic-cipher')));
        return Buffer.from('synthetic-cipher');
    };
    try {
        const result = await independentSyntheticReconnect({ frames, key, token, connect, timeoutMs: 1000, sendNotification, productConstants,
            decryptNotification: async cipher => cipher.toString() === 'synthetic-cipher' });
        assert.equal(writes, 4); assert.equal(result.challengeResponse, true); assert.equal(result.notificationReceived, true);
        assert.equal(result.matchesSentCiphertext, true); assert.equal(result.payloadDecrypted, true);
    } finally { for (const value of Object.values(frames)) value.fill(0); }
});
test('independent fixture uses a fresh nonce and handles split server frames', async () => {
    const frames = selectSyntheticHandshake([fixture()]); let writes = 0, sentBind;
    const socket = new EventEmitter();
    socket.write = (buffer, callback) => {
        writes++;
        if (writes === 3) sentBind = Buffer.from(buffer);
        const response = writes === 1 ? frame('CNT 1 CON', '<connect/>') : writes === 2 ? frame('ATH 2 CON', '')
            : frame('BND 3 CON', '<wns><reconnect-token>synthetic</reconnect-token><nonce>synthetic</nonce></wns>');
        queueMicrotask(() => { callback(); socket.emit('data', response.subarray(0, 7)); socket.emit('data', response.subarray(7)); });
        return true;
    };
    socket.destroy = () => { socket.emit('close'); };
    const connect = () => { queueMicrotask(() => socket.emit('secureConnect')); return socket; };
    try {
        assert.deepEqual(await independentSyntheticReconnect({ frames, key, token, connect, timeoutMs: 1000 }),
            { cntResponse: true, athResponse: true, bindResponse: true, hasReconnectToken: true, hasNonce: true });
        assert.equal(writes, 3); assert(!sentBind.includes(Buffer.from(`<nonce>${nonce}</nonce>`)));
    } finally { sentBind?.fill(0); for (const value of Object.values(frames)) value.fill(0); }
});

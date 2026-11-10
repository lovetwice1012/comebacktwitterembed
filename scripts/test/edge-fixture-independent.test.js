'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { syntheticReconnectSignature } = require('../../experiments/chrome-push/edge-fixture-signature.cjs');
const { selectSyntheticHandshake, describeSyntheticHandshake, syntheticPrelude, syntheticClientMetadata, syntheticHandshake, independentSyntheticReconnect } = require('../../experiments/chrome-push/edge-fixture-independent.cjs');
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
test('handshake description reports structure without printing values', () => {
    const input = frame('CNT 1 CON', 'MS-CV: private-synthetic\r\nUnlisted: private-synthetic\r\n\r\n<connect><ver>123</ver><nonce>private-synthetic</nonce></connect>');
    const shape = describeSyntheticHandshake({ cnt: input });
    assert.deepEqual(shape.cnt.headers, ['ms-cv', 'other']);
    assert.deepEqual(shape.cnt.leaves.map(item => item.tag), ['ver', 'nonce']);
    assert.equal(JSON.stringify(shape).includes('private-synthetic'), false);
});
test('generated synthetic prelude has consistent frame lengths and no supplied subscription data', () => {
    const frames = syntheticPrelude();
    try {
        for (const value of Object.values(frames)) {
            const end = value.indexOf('\r\n'), header = value.subarray(0, end).toString('ascii').split(' ');
            assert.equal(Number(header.at(-1)), value.length - end - 2);
            assert.equal(value.includes(Buffer.from(token)), false);
        }
    } finally { for (const value of Object.values(frames)) value.fill(0); }
});
test('synthetic client metadata is bounded and can build frames without the original template', () => {
    const metadata = { channel: '123', protocolVersion: '1.0', clientName: 'Synthetic client', clientVersion: '1.2.3.4' };
    const frames = syntheticHandshake(key, token, productConstants, metadata);
    try {
        assert.deepEqual(syntheticClientMetadata(frames.bnd), metadata);
        assert.throws(() => syntheticHandshake(key, token, productConstants, { ...metadata, clientName: 'bad<xml' }), /PROBE_DIRECT_CONFIG_INVALID/);
        assert.throws(() => syntheticClientMetadata(frames.bnd.subarray(0, -1)), /PROBE_DIRECT_CONFIG_INVALID/);
        assert.throws(() => syntheticHandshake(key, token, { ...productConstants, id: Buffer.alloc(16, 0xc1) }, metadata), /PROBE_DIRECT_CONFIG_INVALID/);
    } finally { for (const value of Object.values(frames)) value.fill(0); }
});
test('independent fixture only reports a notification after ciphertext and plaintext checks', async () => {
    let writes = 0, sentBind;
    const socket = new EventEmitter();
    socket.write = (buffer, callback) => {
        writes++;
        if (writes === 3) sentBind = Buffer.from(buffer);
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
        const result = await independentSyntheticReconnect({ frames: null, key, token, connect, timeoutMs: 1000, sendNotification, productConstants, generatedHandshake: true,
            decryptNotification: async cipher => cipher.toString() === 'synthetic-cipher' });
        assert.equal(writes, 4); assert.equal(result.challengeResponse, true); assert.equal(result.notificationReceived, true);
        assert.equal(result.matchesSentCiphertext, true); assert.equal(result.payloadDecrypted, true);
        assert(sentBind.includes(Buffer.from(`<reconnect-token>${token}</reconnect-token>`)));
    } finally { sentBind?.fill(0); }
});
test('independent fixture uses a fresh nonce and handles split server frames', async () => {
    const frames = selectSyntheticHandshake([fixture()]); let writes = 0, sentBind, receivedToken, borrowedToken;
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
        assert.deepEqual(await independentSyntheticReconnect({ frames, key, token, connect, timeoutMs: 1000,
            onRotatedToken: value => { borrowedToken = value; receivedToken = Buffer.from(value); } }),
            { cntResponse: true, athResponse: true, bindResponse: true, hasReconnectToken: true, hasNonce: true, reconnectTokenUnchanged: false });
        assert.equal(writes, 3); assert(!sentBind.includes(Buffer.from(`<nonce>${nonce}</nonce>`)));
        assert.equal(receivedToken.toString('ascii'), 'synthetic'); assert(borrowedToken.every(byte => byte === 0));
    } finally { sentBind?.fill(0); receivedToken?.fill(0); for (const value of Object.values(frames)) value.fill(0); }
});
test('synthetic direct receiver acknowledges only after verification and accepts a follow-up', async () => {
    let writes = 0, sends = 0, ack;
    const socket = new EventEmitter();
    socket.write = (buffer, callback) => {
        writes++;
        if (writes === 5) { ack = Buffer.from(buffer); queueMicrotask(callback); return true; }
        const response = writes === 1 ? frame('CNT 1 CON', '<connect/>') : writes === 2 ? frame('ATH 2 CON', '')
            : writes === 3 ? frame('BND 3 CON', '<wns><reconnect-token>synthetic</reconnect-token><nonce>synthetic</nonce></wns>') : frame('PUT 4 WNS', '');
        queueMicrotask(() => { callback(); socket.emit('data', response); }); return true;
    };
    socket.destroy = () => socket.emit('close');
    const connect = () => { queueMicrotask(() => socket.emit('secureConnect')); return socket; };
    const sendNotification = async () => {
        sends++; const text = `synthetic-cipher-${sends}`;
        queueMicrotask(() => socket.emit('data', frame('NFY 5 WNS\\NOTIF A1', `Msg-Id: fixture-${sends}\r\nContent-Encoding: aes128gcm\r\n\r\n${text}`)));
        return Buffer.from(text);
    };
    try {
        const result = await independentSyntheticReconnect({ frames: null, key, token, connect, timeoutMs: 1000, sendNotification,
            productConstants, generatedHandshake: true, ackAndFollowup: true, decryptNotification: async () => true });
        assert.equal(result.ackWritten, true); assert.equal(result.followupReceived, true);
        assert.equal(result.followupMatches, true); assert.equal(result.followupDecrypted, true);
        assert(ack.includes(Buffer.from('Msg-Id: fixture-1'))); assert.equal(sends, 2);
    } finally { ack?.fill(0); }
});
test('single synthetic ACK is not sent when decryption fails', async () => {
    let writes = 0;
    const socket = new EventEmitter();
    socket.write = (_buffer, callback) => {
        writes++;
        const response = writes === 1 ? frame('CNT 1 CON', '<connect/>') : writes === 2 ? frame('ATH 2 CON', '')
            : writes === 3 ? frame('BND 3 CON', '<wns><reconnect-token>synthetic</reconnect-token><nonce>synthetic</nonce></wns>') : frame('PUT 4 WNS', '');
        queueMicrotask(() => { callback(); socket.emit('data', response); }); return true;
    };
    socket.destroy = () => socket.emit('close');
    const connect = () => { queueMicrotask(() => socket.emit('secureConnect')); return socket; };
    const result = await independentSyntheticReconnect({ frames: null, key, token, connect, timeoutMs: 1000, productConstants, generatedHandshake: true, ackSingle: true,
        sendNotification: async () => { queueMicrotask(() => socket.emit('data', frame('NFY 5 WNS\\NOTIF A1', 'Msg-Id: synthetic\r\nContent-Encoding: aes128gcm\r\n\r\ncipher'))); return Buffer.from('cipher'); },
        decryptNotification: async () => false });
    assert.equal(result.payloadDecrypted, false); assert.equal(result.ackWritten, undefined); assert.equal(writes, 4);
});
test('single synthetic ACK is not sent when receipt persistence fails', async () => {
    let writes = 0, decrypts = 0;
    const socket = new EventEmitter();
    socket.write = (_buffer, callback) => {
        writes++;
        const response = writes === 1 ? frame('CNT 1 CON', '<connect/>') : writes === 2 ? frame('ATH 2 CON', '')
            : writes === 3 ? frame('BND 3 CON', '<wns><reconnect-token>synthetic</reconnect-token><nonce>synthetic</nonce></wns>') : frame('PUT 4 WNS', '');
        queueMicrotask(() => { callback(); socket.emit('data', response); }); return true;
    };
    socket.destroy = () => socket.emit('close');
    const connect = () => { queueMicrotask(() => socket.emit('secureConnect')); return socket; };
    await assert.rejects(independentSyntheticReconnect({ frames: null, key, token, connect, timeoutMs: 1000, productConstants, generatedHandshake: true, ackSingle: true,
        sendNotification: async () => { queueMicrotask(() => socket.emit('data', frame('NFY 5 WNS\\NOTIF A1', 'Msg-Id: synthetic\r\nContent-Encoding: aes128gcm\r\n\r\ncipher'))); return Buffer.from('cipher'); },
        decryptNotification: async () => { decrypts++; return true; }, onTargetCiphertext: async () => { throw new Error('synthetic-durable-write-failed'); } }), /synthetic-durable-write-failed/);
    assert.equal(writes, 4); assert.equal(decrypts, 0);
});
test('synthetic receiver stops before challenge if token capture fails', async () => {
    const frames = selectSyntheticHandshake([fixture()]); let writes = 0, borrowed;
    const socket = new EventEmitter();
    socket.write = (_buffer, callback) => {
        writes++;
        const response = writes === 1 ? frame('CNT 1 CON', '<connect/>') : writes === 2 ? frame('ATH 2 CON', '')
            : frame('BND 3 CON', '<wns><reconnect-token>synthetic</reconnect-token><nonce>synthetic</nonce></wns>');
        queueMicrotask(() => { callback(); socket.emit('data', response); }); return true;
    };
    socket.destroy = () => socket.emit('close');
    const connect = () => { queueMicrotask(() => socket.emit('secureConnect')); return socket; };
    try {
        await assert.rejects(independentSyntheticReconnect({ frames, key, token, connect, timeoutMs: 1000,
            onRotatedToken: value => { borrowed = value; throw new Error('synthetic-storage-failure'); } }), /synthetic-storage-failure/);
        assert.equal(writes, 3); assert(borrowed.every(byte => byte === 0));
    } finally { for (const value of Object.values(frames)) value.fill(0); }
});
test('synthetic direct receiver discards the other channel before decrypting the target', async () => {
    let writes = 0, decrypts = 0, foreignAck;
    const socket = new EventEmitter();
    socket.write = (buffer, callback) => {
        writes++;
        if (writes === 5) { foreignAck = Buffer.from(buffer); queueMicrotask(callback); return true; }
        const response = writes === 1 ? frame('CNT 1 CON', '<connect/>') : writes === 2 ? frame('ATH 2 CON', '')
            : writes === 3 ? frame('BND 3 CON', '<wns><reconnect-token>synthetic</reconnect-token><nonce>synthetic</nonce></wns>') : frame('PUT 4 WNS', '');
        queueMicrotask(() => { callback(); socket.emit('data', response); }); return true;
    };
    socket.destroy = () => socket.emit('close');
    const connect = () => { queueMicrotask(() => socket.emit('secureConnect')); return socket; };
    const send = (channel, body) => async () => {
        queueMicrotask(() => socket.emit('data', frame('NFY 5 WNS\\NOTIF A1', `Channel: ${channel}\r\nMsg-Id: synthetic\r\nContent-Encoding: aes128gcm\r\n\r\n${body}`)));
        return Buffer.from(body);
    };
    try {
        const result = await independentSyntheticReconnect({ frames: null, key, token, connect, timeoutMs: 1000, productConstants, generatedHandshake: true,
            expectedChannel: Buffer.from('1;target'), sendOtherNotification: send('1;other', 'other-cipher'), sendNotification: send('1;target', 'target-cipher'),
            decryptNotification: async cipher => { decrypts++; return cipher.toString() === 'target-cipher'; } });
        assert.equal(result.otherDiscardedBeforeDecrypt, true); assert.equal(result.otherAckWritten, true);
        assert.equal(result.notificationReceived, true); assert.equal(result.payloadDecrypted, true); assert.equal(decrypts, 1);
        assert(foreignAck.subarray(0, 24).toString('ascii').startsWith('ACK 5 WNS\\NOTIF'));
    } finally { foreignAck?.fill(0); }
});
test('ambiguous foreign channel is neither acknowledged nor decrypted', async () => {
    let writes = 0, decrypts = 0, targetSends = 0;
    const socket = new EventEmitter();
    socket.write = (_buffer, callback) => {
        writes++;
        const response = writes === 1 ? frame('CNT 1 CON', '<connect/>') : writes === 2 ? frame('ATH 2 CON', '')
            : writes === 3 ? frame('BND 3 CON', '<wns><reconnect-token>synthetic</reconnect-token><nonce>synthetic</nonce></wns>') : frame('PUT 4 WNS', '');
        queueMicrotask(() => { callback(); socket.emit('data', response); }); return true;
    };
    socket.destroy = () => socket.emit('close');
    const connect = () => { queueMicrotask(() => socket.emit('secureConnect')); return socket; };
    await assert.rejects(independentSyntheticReconnect({ frames: null, key, token, connect, timeoutMs: 1000, productConstants, generatedHandshake: true,
        expectedChannel: Buffer.from('1;target'), sendOtherNotification: async () => {
            queueMicrotask(() => socket.emit('data', frame('NFY 5 WNS\\NOTIF A1', 'Channel: 1;target\r\nChannel: 1;other\r\nMsg-Id: synthetic\r\n\r\nother-cipher')));
            return Buffer.from('other-cipher');
        }, sendNotification: async () => { targetSends++; return Buffer.from('target-cipher'); }, decryptNotification: async () => { decrypts++; return true; } }),
    /PROBE_ROUTING_INVALID/);
    assert.equal(writes, 4); assert.equal(targetSends, 0); assert.equal(decrypts, 0);
});
test('offline observation happens before a new synthetic notification is sent', async () => {
    let writes = 0, sends = 0, observedAtSend, borrowed;
    const socket = new EventEmitter();
    const notification = body => frame('NFY 5 WNS\\NOTIF A1', `Content-Encoding: aes128gcm\r\n\r\n${body}`);
    socket.write = (_buffer, callback) => {
        writes++;
        const response = writes === 1 ? frame('CNT 1 CON', '<connect/>') : writes === 2 ? frame('ATH 2 CON', '')
            : writes === 3 ? frame('BND 3 CON', '<wns><reconnect-token>synthetic</reconnect-token><nonce>synthetic</nonce></wns>') : frame('PUT 4 WNS', '');
        queueMicrotask(() => { callback(); socket.emit('data', response); if (writes === 4) socket.emit('data', notification('offline-cipher')); });
        return true;
    };
    socket.destroy = () => socket.emit('close');
    const connect = () => { queueMicrotask(() => socket.emit('secureConnect')); return socket; };
    const sendNotification = async () => {
        sends++; observedAtSend = true; queueMicrotask(() => socket.emit('data', notification('fresh-cipher'))); return Buffer.from('fresh-cipher');
    };
    const result = await independentSyntheticReconnect({ frames: null, key, token, connect, timeoutMs: 1000, productConstants, generatedHandshake: true,
        observePrior: { offlineCipher: Buffer.from('offline-cipher'), priorCipher: Buffer.from('old-cipher'), windowMs: 100 },
        sendNotification, decryptNotification: async cipher => cipher.toString() === 'fresh-cipher', onTargetCiphertext: value => { borrowed = value; } });
    assert.deepEqual(result.beforeNewSend, { offlineNotification: true, priorNotificationReplay: false, otherFrames: 0 });
    assert.equal(result.payloadDecrypted, true); assert.equal(sends, 1); assert.equal(observedAtSend, true);
    assert(borrowed.every(byte => byte === 0));
});
test('invalid offline observation does not open a connection', async () => {
    let connects = 0;
    await assert.rejects(independentSyntheticReconnect({ frames: null, key, token, generatedHandshake: true, productConstants,
        connect: () => { connects++; throw new Error('unexpected-connection'); },
        observePrior: { offlineCipher: Buffer.alloc(1), priorCipher: Buffer.alloc(1), windowMs: 30001 } }), { code: 'PROBE_DIRECT_CONFIG_INVALID' });
    assert.equal(connects, 0);
});

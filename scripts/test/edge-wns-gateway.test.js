'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runEdgeWnsGateway } = require('../../src/automation/edge-wns-gateway');
const { createEdgeWnsTransport } = require('../../src/automation/edge-wns-transport');
const { EventEmitter } = require('node:events');
const lease = { subscriptionId: '33333333-3333-4333-8333-333333333333', ownerUserId: '123456789', revision: 1 };
function envelope(command, body = '') { const payload = Buffer.from(`MS-CV: synthetic\r\n\r\n${body}`); return Buffer.concat([Buffer.from(`${command} ${payload.length}\r\n`), payload]); }
function notification(site, id = 'synthetic-id') { const body = Buffer.from(`Channel: ${site}\r\nMsg-Id: ${id}\r\nContent-Encoding: aes128gcm\r\n\r\ncipher`); return Buffer.concat([Buffer.from(`NFY 5 WNS\\NOTIF ${body.length}\r\n`), body]); }
function harness(overrides = {}) {
    const controller = new AbortController(), calls = [], received = [], savedToken = Buffer.from('previous-token'); let inbox;
    const queue = [envelope('CNT 1 CON', '<connect/>'), envelope('ATH 2 CON'),
        envelope('BND 3 CON', '<wns><ver>1.0</ver><nonce>synthetic-nonce</nonce><reconnect-token>rotated-token</reconnect-token></wns>'), envelope('PUT 4 WNS'), notification('other'), notification('target')];
    const transport = { async connect() { calls.push('connect'); }, async send(bytes) { calls.push(`send:${bytes.subarray(0, bytes.indexOf(' ')).toString()}`); },
        async next() { if (!queue.length) throw Object.assign(new Error('idle'), { code: 'X_EDGE_WNS_RECEIVE_TIMEOUT' }); return queue.shift(); }, close() { calls.push('close'); } };
    const store = { async readWnsTokenState(_lease, { authorize }) { await authorize(); calls.push('read-state'); return { generation: 2, token: savedToken }; },
        async saveWnsTokenState(_lease, { authorize, token, expectedGeneration }) { await authorize(); calls.push(`save:${expectedGeneration}`); assert.equal(token.toString(), 'rotated-token'); return { generation: expectedGeneration + 1 }; },
        async assertLease(_lease, { authorize }) { await authorize(); calls.push('guard'); },
        async recordFrame(_lease, entry, { authorize }) { await authorize(); calls.push('persist'); inbox = { ...lease, ...entry, id: '1', duplicate: false }; return inbox; },
        async getInbox() { return inbox; }, ...overrides.store };
    const credentials = { agent: { os: 'Test OS', osVersion: '1', architecture: 'x64', locale: 'en' },
        client: { channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic client', clientVersion: '1.2.3.4' },
        deviceKey: Buffer.alloc(32, 7), reconnectToken: Buffer.from('initial-token'), productKey: Buffer.from('0123456789abcdef'),
        productId: Buffer.from('fedcba9876543210'), siteChannel: Buffer.from('target') };
    const options = { store, lease, vault: {}, authorize: async () => {}, credentials, signal: controller.signal,
        transportFactory: () => transport, onReady: async () => calls.push('ready'), onReceived: async value => { received.push(value); controller.abort(); }, ...overrides.options };
    return { options, controller, calls, received, savedToken, queue };
}
test('recovers encrypted token generation and routes only the owned receipt', async () => {
    const h = harness(); assert.deepEqual(await runEdgeWnsGateway(h.options), { state: 'stopped' });
    assert(h.savedToken.every(byte => byte === 0)); assert(h.calls.indexOf('save:2') < h.calls.indexOf('send:PUT'));
    assert.equal(h.calls.filter(value => value === 'persist').length, 1); assert.equal(h.received.length, 1);
    assert.equal(h.received[0].inbox.ownerUserId, lease.ownerUserId); assert(h.calls.includes('ready'));
});
test('failed token save aborts before challenge and preserves the original safe error', async () => {
    const h = harness({ store: { saveWnsTokenState: async () => { throw Object.assign(new Error('safe'), { code: 'X_PUSH_LEASE_LOST' }); } } });
    await assert.rejects(runEdgeWnsGateway(h.options), { code: 'X_PUSH_LEASE_LOST' }); assert(!h.calls.includes('send:PUT')); assert(h.savedToken.every(byte => byte === 0));
});
test('abort during a delayed state read clears returned bytes and never opens a transport', async () => {
    let release, began; const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { began = resolve; });
    const token = Buffer.from('private-test-token');
    const h = harness({ store: { readWnsTokenState: async () => { began(); await gate; return { generation: 1, token }; } } });
    const work = runEdgeWnsGateway(h.options); await entered; h.controller.abort(); release();
    assert.deepEqual(await work, { state: 'stopped' }); assert(token.every(byte => byte === 0)); assert(!h.calls.includes('connect'));
});
test('rejects a mismatched inbox owner without invoking delivery', async () => {
    const h = harness({ store: { getInbox: async () => ({ ...lease, ownerUserId: 'other', id: '1' }) } });
    await assert.rejects(runEdgeWnsGateway(h.options), { code: 'X_EDGE_WNS_RECEIPT_INVALID' }); assert.equal(h.received.length, 0);
});
test('network disconnect drains already-buffered owned receipts without acknowledging them', async () => {
    const saved = [], sent = [], socket = new EventEmitter(); let disconnected = false;
    socket.write = (data, done) => {
        const name = data.subarray(0, data.indexOf(' ')).toString('ascii'); sent.push(name);
        const response = name === 'CNT' ? envelope('CNT 1 CON', '<connect/>') : name === 'ATH' ? envelope('ATH 2 CON')
            : name === 'BND' ? envelope('BND 3 CON', '<wns><ver>1.0</ver><nonce>fixture</nonce><reconnect-token>rotated-token</reconnect-token></wns>')
                : envelope('PUT 4 WNS');
        queueMicrotask(() => { done(); socket.emit('data', response); }); return true;
    };
    socket.destroy = () => { if (!disconnected) { disconnected = true; socket.emit('close'); } };
    const h = harness({ store: { async recordFrame(_lease, entry, { authorize }) { await authorize(); saved.push(entry); return { ...lease, ...entry, id: String(saved.length), duplicate: false }; } },
        options: { credentials: { agent: { os: 'Test', osVersion: '1', architecture: 'x64', locale: 'en' },
            client: { channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic', clientVersion: '1.2.3.4' }, deviceKey: Buffer.alloc(32, 7),
            reconnectToken: Buffer.from('initial'), siteChannel: Buffer.from('target'), authenticationMode: 'bound' },
        transportFactory: ({ signal }) => { const transport = createEdgeWnsTransport({ socketFactory: () => socket, signal, timeoutMs: 1000 }); queueMicrotask(() => socket.emit('secureConnect')); return transport; },
        onReady: async () => { socket.emit('data', Buffer.concat([notification('target', 'first'), notification('other'), notification('target', 'second')])); socket.emit('close'); },
        onReceived: async () => { throw new Error('drained rows must use recovery'); } } });
    await assert.rejects(runEdgeWnsGateway(h.options), { code: 'X_EDGE_WNS_SOCKET_CLOSED' });
    assert.equal(saved.length, 2); assert(!sent.includes('ACK')); assert.equal(h.received.length, 0);
});
test('malformed input and bounded queue overflow preserve earlier owned receipts', async () => {
    for (const mode of ['malformed', 'overflow']) {
        const saved = [], sent = [], socket = new EventEmitter(); let disconnected = false;
        socket.write = (data, done) => {
            const name = data.subarray(0, data.indexOf(' ')).toString('ascii'); sent.push(name);
            const response = name === 'CNT' ? envelope('CNT 1 CON', '<connect/>') : name === 'ATH' ? envelope('ATH 2 CON')
                : envelope('BND 3 CON', '<wns><ver>1.0</ver><nonce>fixture</nonce><reconnect-token>rotated-token</reconnect-token></wns>');
            queueMicrotask(() => { done(); socket.emit('data', response); }); return true;
        };
        socket.destroy = () => { if (!disconnected) { disconnected = true; socket.emit('close'); } };
        const h = harness({ store: { async recordFrame(_lease, entry, { authorize }) { await authorize(); saved.push(entry); return { ...lease, ...entry, id: String(saved.length), duplicate: false }; } },
            options: { credentials: { agent: { os: 'Test', osVersion: '1', architecture: 'x64', locale: 'en' },
                client: { channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic', clientVersion: '1.2.3.4' }, deviceKey: Buffer.alloc(32, 7),
                reconnectToken: Buffer.from('initial'), siteChannel: Buffer.from('target'), authenticationMode: 'bound' },
                transportFactory: ({ signal }) => { const transport = createEdgeWnsTransport({ socketFactory: () => socket, signal, timeoutMs: 1000 }); queueMicrotask(() => socket.emit('secureConnect')); return transport; },
                onReady: async () => {
                    const count = mode === 'malformed' ? 2 : 1040;
                    const frames = Array.from({ length: count }, (_, i) => notification('target', `msg-${i}`));
                    socket.emit('data', Buffer.concat(frames.slice(0, 1024)));
                    if (frames.length > 1024) socket.emit('data', Buffer.concat(frames.slice(1024)));
                    socket.emit('data', mode === 'malformed' ? Buffer.from('bad\n') : notification('target', 'over-limit'));
                }, onReceived: async () => { throw new Error('drained receipts must use recovery'); } } });
        await assert.rejects(runEdgeWnsGateway(h.options), { code: mode === 'malformed' ? 'X_EDGE_WNS_FRAME_INVALID' : 'X_EDGE_WNS_BACKPRESSURE' });
        assert.equal(saved.length, mode === 'malformed' ? 2 : 1040);
        assert.equal(new Set(saved.map(entry => entry.version)).size, saved.length);
        assert(!sent.includes('ACK'));
    }
});
test('revocation or cancellation prevents a disconnect drain', async () => {
    for (const mode of ['revoked', 'cancelled']) {
        const saved = [], socket = new EventEmitter(); let disconnected = false, revoked = false;
        socket.write = (data, done) => {
            const name = data.subarray(0, data.indexOf(' ')).toString('ascii');
            const response = name === 'CNT' ? envelope('CNT 1 CON', '<connect/>') : name === 'ATH' ? envelope('ATH 2 CON')
                : envelope('BND 3 CON', '<wns><ver>1.0</ver><nonce>fixture</nonce><reconnect-token>rotated-token</reconnect-token></wns>');
            queueMicrotask(() => { done(); socket.emit('data', response); }); return true;
        };
        socket.destroy = () => { if (!disconnected) { disconnected = true; socket.emit('close'); } };
        const h = harness({ store: { async recordFrame(_lease, entry, { authorize }) { await authorize(); saved.push(entry); return { ...lease, ...entry, id: '1', duplicate: false }; } },
            options: { credentials: { agent: { os: 'Test', osVersion: '1', architecture: 'x64', locale: 'en' },
                client: { channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic', clientVersion: '1.2.3.4' }, deviceKey: Buffer.alloc(32, 7),
                reconnectToken: Buffer.from('initial'), siteChannel: Buffer.from('target'), authenticationMode: 'bound' },
                authorize: async () => { if (revoked) throw Object.assign(new Error('revoked'), { code: 'X_PUSH_ROLLOUT_WITHDRAWN' }); },
                transportFactory: ({ signal }) => { const transport = createEdgeWnsTransport({ socketFactory: () => socket, signal, timeoutMs: 1000 }); queueMicrotask(() => socket.emit('secureConnect')); return transport; },
                onReady: async () => { socket.emit('data', notification('target')); socket.emit('close'); if (mode === 'revoked') revoked = true; else h.controller.abort(); } } });
        if (mode === 'revoked') await assert.rejects(runEdgeWnsGateway(h.options), { code: 'X_PUSH_ROLLOUT_WITHDRAWN' });
        else assert.deepEqual(await runEdgeWnsGateway(h.options), { state: 'stopped' });
        assert.equal(saved.length, 0);
    }
});
test('failed acknowledgement preserves its committed receipt and drains following buffered receipts', async () => {
    const saved = [], socket = new EventEmitter(); let disconnected = false;
    socket.write = (data, done) => {
        const name = data.subarray(0, data.indexOf(' ')).toString('ascii');
        if (name === 'ACK') { socket.emit('error', new Error('fixture disconnect')); return false; }
        const response = name === 'CNT' ? envelope('CNT 1 CON', '<connect/>') : name === 'ATH' ? envelope('ATH 2 CON')
            : envelope('BND 3 CON', '<wns><ver>1.0</ver><nonce>fixture</nonce><reconnect-token>rotated-token</reconnect-token></wns>');
        queueMicrotask(() => { done(); socket.emit('data', response); }); return true;
    };
    socket.destroy = () => { if (!disconnected) { disconnected = true; socket.emit('close'); } };
    const h = harness({ store: { async recordFrame(_lease, entry, { authorize }) { await authorize(); saved.push(entry); return { ...lease, ...entry, id: String(saved.length), duplicate: false }; } },
        options: { credentials: { agent: { os: 'Test', osVersion: '1', architecture: 'x64', locale: 'en' },
            client: { channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic', clientVersion: '1.2.3.4' }, deviceKey: Buffer.alloc(32, 7),
            reconnectToken: Buffer.from('initial'), siteChannel: Buffer.from('target'), authenticationMode: 'bound' },
            transportFactory: ({ signal }) => { const transport = createEdgeWnsTransport({ socketFactory: () => socket, signal, timeoutMs: 1000 }); queueMicrotask(() => socket.emit('secureConnect')); return transport; },
            onReady: async () => { socket.emit('data', Buffer.concat([notification('target', 'first'), notification('target', 'second'), notification('target', 'third')])); },
            onReceived: async () => { throw new Error('receipts must use recovery'); } } });
    await assert.rejects(runEdgeWnsGateway(h.options), { code: 'X_EDGE_WNS_ACK_FAILED' });
    assert.equal(saved.length, 3); assert.equal(new Set(saved.map(entry => entry.version)).size, 3);
});

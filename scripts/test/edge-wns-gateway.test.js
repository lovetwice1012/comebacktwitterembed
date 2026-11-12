'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runEdgeWnsGateway } = require('../../src/automation/edge-wns-gateway');
const { createEdgeWnsTransport } = require('../../src/automation/edge-wns-transport');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const { createFrameDecoder } = require('../../src/automation/edge-wns-framing');
const lease = { subscriptionId: '33333333-3333-4333-8333-333333333333', ownerUserId: '123456789', revision: 1 };
function envelope(command, body = '') { const payload = Buffer.from(`MS-CV: synthetic\r\n\r\n${body}`); return Buffer.concat([Buffer.from(`${command} ${payload.length}\r\n`), payload]); }
function notification(site, id = 'synthetic-id') { const body = Buffer.from(`Channel: ${site}\r\nMsg-Id: ${id}\r\nContent-Encoding: aes128gcm\r\n\r\ncipher`); return Buffer.concat([Buffer.from(`NFY 5 WNS\\NOTIF ${body.length}\r\n`), body]); }
function harness(overrides = {}) {
    const localLease = overrides.lease || lease;
    const controller = new AbortController(), calls = [], received = [], savedToken = Buffer.from('previous-token'); let inbox;
    const queue = [envelope('CNT 1 CON', '<connect/>'), envelope('ATH 2 CON'),
        envelope('BND 3 CON', '<wns><ver>1.0</ver><nonce>synthetic-nonce</nonce><reconnect-token>rotated-token</reconnect-token></wns>'), envelope('PUT 4 WNS'), notification('other'), notification('target')];
    const frames = [];
    const transport = { async connect() { calls.push('connect'); }, async send(bytes) { frames.push(Buffer.from(bytes)); calls.push(`send:${bytes.subarray(0, bytes.indexOf(' ')).toString()}`); },
        async next() { if (!queue.length) throw Object.assign(new Error('idle'), { code: 'X_EDGE_WNS_RECEIVE_TIMEOUT' }); return queue.shift(); }, close() { calls.push('close'); } };
    const store = { async readWnsTokenState(_lease, { authorize }) { await authorize(); calls.push('read-state'); return { generation: 2, token: savedToken }; },
        async saveWnsTokenState(_lease, { authorize, token, expectedGeneration }) { await authorize(); calls.push(`save:${expectedGeneration}`); assert.equal(token.toString(), 'rotated-token'); return { generation: expectedGeneration + 1 }; },
        async assertLease(_lease, { authorize }) { await authorize(); calls.push('guard'); },
        async recordFrame(_lease, entry, { authorize }) { await authorize(); calls.push('persist'); inbox = { ...localLease, ...entry, id: '1', duplicate: false }; return inbox; },
        async getInbox() { return inbox; }, ...overrides.store };
    const credentials = { agent: { os: 'Test OS', osVersion: '1', architecture: 'x64', locale: 'en' },
        client: { channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic client', clientVersion: '1.2.3.4' },
        deviceKey: Buffer.alloc(32, 7), reconnectToken: Buffer.from('initial-token'), productKey: Buffer.from('0123456789abcdef'),
        productId: Buffer.from('fedcba9876543210'), siteChannel: Buffer.from('target') };
    const options = { store, lease: localLease, vault: {}, authorize: async () => {}, credentials, signal: controller.signal,
        transportFactory: () => transport, onReady: async () => calls.push('ready'), onReceived: async value => { received.push(value); controller.abort(); }, ...overrides.options };
    return { options, controller, calls, received, savedToken, queue, frames };
}
test('one process isolates 1000 simulated Edge receivers', { timeout: 30000 }, async () => {
    const count = 1000, sessions = Array.from({ length: count }, (_, index) => {
        const identity = { subscriptionId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
            ownerUserId: String(100000000000000000n + BigInt(index)), revision: 1 };
        const h = harness({ lease: identity });
        if (index % 2) h.options.credentials.connectVersion = '2';
        return { identity, h };
    });
    try {
        const results = await Promise.all(sessions.map(({ h }) => runEdgeWnsGateway(h.options)));
        assert(results.every(result => result.state === 'stopped'));
        for (const { identity, h } of sessions) {
            assert.equal(h.received.length, 1);
            assert.equal(h.received[0].lease.subscriptionId, identity.subscriptionId);
            assert.equal(h.received[0].inbox.ownerUserId, identity.ownerUserId);
            assert.equal(h.calls.filter(call => call === 'persist').length, 1);
            assert(h.calls.indexOf('persist') < h.calls.lastIndexOf('send:ACK'));
        }
    } finally { for (const { h } of sessions) { h.controller.abort(); h.frames.forEach(frame => frame.fill(0)); } }
});
test('one process handles 1000 isolated Edge sessions over loopback sockets', { timeout: 60000 }, async () => {
    const serverSockets = new Set(), readySockets = [], socketErrors = new Map(); let accepted = 0;
    const server = net.createServer(socket => {
        serverSockets.add(socket); accepted++; socket.once('close', () => serverSockets.delete(socket)); socket.on('error', () => {});
        const decoder = createFrameDecoder();
        socket.on('data', chunk => {
            try {
                for (const frame of decoder.push(chunk)) {
                    const command = frame.subarray(0, frame.indexOf(' ')).toString('ascii');
                    if (command === 'CNT') socket.write(envelope('CNT 1 CON', '<connect/>'));
                    else if (command === 'ATH') socket.write(envelope('ATH 2 CON'));
                    else if (command === 'BND') {
                        socket.write(envelope('BND 3 CON', '<wns><ver>1.0</ver><nonce>synthetic-nonce</nonce><reconnect-token>rotated-token</reconnect-token></wns>'));
                        readySockets.push(socket);
                        if (readySockets.length === 1000) for (const ready of readySockets) ready.write(notification('target'));
                    }
                    frame.fill(0);
                }
            } catch { socket.destroy(); }
        });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, backlog: 2048 }, resolve); });
    const port = server.address().port;
    const sessions = Array.from({ length: 1000 }, (_, index) => {
        const identity = { subscriptionId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
            ownerUserId: String(100000000000000000n + BigInt(index)), revision: 1 };
        const h = harness({ lease: identity });
        delete h.options.credentials.productKey; delete h.options.credentials.productId;
        h.options.credentials.authenticationMode = 'bound';
        if (index % 2) h.options.credentials.connectVersion = '2';
        h.options.transportFactory = ({ signal }) => createEdgeWnsTransport({ signal, timeoutMs: 30000, socketFactory: () => {
            // Loopback fixture only: no TLS is claimed by this socket test.
            const socket = net.connect({ host: '127.0.0.1', port });
            socket.on('error', error => { const code = /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'OTHER';
                socketErrors.set(code, (socketErrors.get(code) || 0) + 1); });
            socket.once('connect', () => socket.emit('secureConnect'));
            return socket;
        } });
        return { identity, h };
    });
    try {
        const running = [];
        for (let index = 0; index < sessions.length; index += 64) {
            for (const { h } of sessions.slice(index, index + 64))
                running.push(runEdgeWnsGateway(h.options).then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason })));
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const settled = await Promise.all(running);
        const rejected = settled.filter(result => result.status === 'rejected');
        assert.equal(rejected.length, 0, `loopback sessions failed: ${JSON.stringify(Object.fromEntries(socketErrors))}`);
        const results = settled.map(result => result.value);
        assert.equal(accepted, sessions.length);
        assert(results.every(result => result.state === 'stopped'));
        for (const { identity, h } of sessions) {
            assert.equal(h.received.length, 1);
            assert.equal(h.received[0].inbox.subscriptionId, identity.subscriptionId);
            assert.equal(h.received[0].inbox.ownerUserId, identity.ownerUserId);
            assert.equal(h.calls.filter(call => call === 'persist').length, 1);
        }
    } finally {
        for (const { h } of sessions) h.controller.abort();
        for (const socket of serverSockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    }
});
test('gateway preserves version 2 and rejects unknown versions before connecting', async () => {
    const h = harness(); h.options.credentials.connectVersion = '2';
    try { assert.deepEqual(await runEdgeWnsGateway(h.options), { state: 'stopped' });
        assert(h.frames[0].includes(Buffer.from('<connect><ver>2</ver>')));
    } finally { h.frames.forEach(frame => frame.fill(0)); }
    const invalid = harness(); invalid.options.credentials.connectVersion = '3';
    await assert.rejects(runEdgeWnsGateway(invalid.options), { code: 'X_EDGE_WNS_GATEWAY_CONFIG_INVALID' });
    assert(!invalid.calls.includes('connect'));
});
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
test('failure to persist disconnected buffered receipts is reported safely after partial recovery', async () => {
    for (const mode of ['database', 'timeout', 'conflict']) {
        const saved = [], sent = [], socket = new EventEmitter(); let disconnected = false;
        socket.write = (data, done) => {
            const name = data.subarray(0, data.indexOf(' ')).toString('ascii'); sent.push(name);
            const response = name === 'CNT' ? envelope('CNT 1 CON', '<connect/>') : name === 'ATH' ? envelope('ATH 2 CON')
                : envelope('BND 3 CON', '<wns><ver>1.0</ver><nonce>fixture</nonce><reconnect-token>rotated-token</reconnect-token></wns>');
            queueMicrotask(() => { done(); socket.emit('data', response); }); return true;
        };
        socket.destroy = () => { if (!disconnected) { disconnected = true; socket.emit('close'); } };
        const h = harness({ store: { async recordFrame(_lease, entry, { authorize }) {
            await authorize();
            if (saved.length) {
                if (mode === 'timeout') throw Object.assign(new Error('sensitive timeout detail'), { code: 'X_PUSH_STORE_TIMEOUT' });
                if (mode === 'database') throw Object.assign(new Error('private database details'), { code: 'ER_SECRET_DETAILS' });
                return { ...lease, ...entry, ownerUserId: 'wrong-owner', id: '2', duplicate: false };
            }
            saved.push(entry); return { ...lease, ...entry, id: '1', duplicate: false };
        } }, options: { credentials: { agent: { os: 'Test', osVersion: '1', architecture: 'x64', locale: 'en' },
            client: { channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic', clientVersion: '1.2.3.4' }, deviceKey: Buffer.alloc(32, 7),
            reconnectToken: Buffer.from('initial'), siteChannel: Buffer.from('target'), authenticationMode: 'bound' },
            transportFactory: ({ signal }) => { const transport = createEdgeWnsTransport({ socketFactory: () => socket, signal, timeoutMs: 1000 }); queueMicrotask(() => socket.emit('secureConnect')); return transport; },
            onReady: async () => { socket.emit('data', Buffer.concat([notification('target', 'first'), notification('target', 'second')])); socket.emit('close'); },
            onReceived: async () => assert.fail('buffer recovery is not immediate delivery') } });
        const expected = mode === 'timeout' ? 'X_PUSH_STORE_TIMEOUT' : 'X_PUSH_BUFFERED_RECOVERY_FAILED';
        await assert.rejects(runEdgeWnsGateway(h.options), error => error.code === expected && error.message === expected);
        assert.equal(saved.length, 1, mode); assert(!sent.includes('ACK'), mode); assert.equal(h.received.length, 0, mode);
    }
});
test('disconnect during bound handshake saves only authenticated buffered notifications after token commit', async () => {
    for (const mode of ['valid', 'invalid-bind', 'token-failure', 'record-failure', 'record-failure-second', 'revoked', 'revoked-after-token', 'before-bind', 'challenge']) {
        const saved = [], sent = [], socket = new EventEmitter(); let disconnected = false, tokenSaved = false, revoked = false;
        socket.write = (data, done) => {
            const name = data.subarray(0, data.indexOf(' ')).toString('ascii'); sent.push(name);
            if (name === (mode === 'before-bind' ? 'ATH' : 'BND')) {
                queueMicrotask(() => {
                    const bind = mode === 'invalid-bind' ? envelope('BND 3 CON', '<wns><ver>1.0</ver></wns>')
                        : envelope('BND 3 CON', '<wns><ver>1.0</ver><nonce>fixture</nonce><reconnect-token>rotated-token</reconnect-token></wns>');
                    socket.emit('data', Buffer.concat([bind, notification('target', 'early-one'), notification('other'), notification('target', 'early-two')]));
                    if (mode === 'revoked') revoked = true;
                    socket.emit('close');
                });
                return true;
            }
            const response = name === 'CNT' ? envelope('CNT 1 CON', '<connect/>') : envelope('ATH 2 CON');
            queueMicrotask(() => { done(); socket.emit('data', response); }); return true;
        };
        socket.destroy = () => { if (!disconnected) { disconnected = true; socket.emit('close'); } };
        const credentials = { agent: { os: 'Test', osVersion: '1', architecture: 'x64', locale: 'en' },
            client: { channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic', clientVersion: '1.2.3.4' }, deviceKey: Buffer.alloc(32, 7),
            reconnectToken: Buffer.from('initial'), siteChannel: Buffer.from('target'), ...(mode === 'challenge'
                ? { productKey: Buffer.from('0123456789abcdef'), productId: Buffer.from('fedcba9876543210') } : { authenticationMode: 'bound' }) };
        const h = harness({ store: {
            async saveWnsTokenState(_lease, { authorize, expectedGeneration }) {
                await authorize(); if (mode === 'token-failure') throw new Error('synthetic DB failure'); tokenSaved = true;
                if (mode === 'revoked-after-token') revoked = true;
                return { generation: expectedGeneration + 1 };
            },
            async recordFrame(_lease, entry, { authorize }) {
                await authorize(); assert(tokenSaved);
                if (mode === 'record-failure' || mode === 'record-failure-second' && saved.length === 1) throw new Error('private database details');
                saved.push(entry); return { ...lease, ...entry, id: String(saved.length), duplicate: false };
            },
        }, options: { credentials, authorize: async () => { if (revoked) throw Object.assign(new Error('revoked'), { code: 'X_PUSH_ROLLOUT_WITHDRAWN' }); },
            transportFactory: ({ signal }) => { const transport = createEdgeWnsTransport({ socketFactory: () => socket, signal, timeoutMs: 1000 }); queueMicrotask(() => socket.emit('secureConnect')); return transport; },
            onReady: async () => assert.fail('closed connection must not become ready'), onReceived: async () => assert.fail('buffered rows must use recovery') } });
        const expected = mode.startsWith('revoked') ? 'X_PUSH_ROLLOUT_WITHDRAWN'
            : ['invalid-bind', 'token-failure', 'record-failure', 'record-failure-second'].includes(mode) ? 'X_PUSH_BUFFERED_RECOVERY_FAILED' : 'X_EDGE_WNS_SOCKET_CLOSED';
        await assert.rejects(runEdgeWnsGateway(h.options), error => error.code === expected && !error.message.includes('private database details'));
        assert.equal(saved.length, mode === 'valid' ? 2 : mode === 'record-failure-second' ? 1 : 0, mode);
        assert.equal(tokenSaved, ['valid', 'record-failure', 'record-failure-second', 'revoked-after-token'].includes(mode), mode);
        assert(!sent.includes('ACK'), mode);
    }
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

'use strict';

// Opt-in local socket experiment. This uses neither TLS, FCM, X, browser
// credentials nor a database. It does not establish production capacity.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { performance } = require('node:perf_hooks');
const { createXPushRuntime } = require('../../src/automation/x-push-runtime');
const { createChromeMcsTransport } = require('../../src/automation/chrome-mcs-transport');
const { createChromeMcsSession } = require('../../src/automation/chrome-mcs-session');
const { encodeFrame, createFrameDecoder } = require('../../src/automation/chrome-mcs-framing');

const b = (number, value) => Buffer.concat([Buffer.from([number * 8 + 2, Buffer.byteLength(value)]), Buffer.from(value)]);
const pair = (key, value) => b(7, Buffer.concat([b(1, key), b(2, value)]));
const timeout = (promise, milliseconds) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SCALE_FIXTURE_TIMEOUT')), milliseconds); })])
        .finally(() => clearTimeout(timer));
};

test('one process handles 1000 isolated MCS sessions on local synthetic sockets',
    { skip: process.env.CBTE_SYNTHETIC_SCALE !== '1', timeout: 120000 }, async t => {
        const count = 1000, sockets = new Map(), committed = new Map(), notified = new Set(), acknowledgments = new Set(), errors = [];
        const server = net.createServer(socket => {
            let hello = Buffer.alloc(0), id = null;
            const decoder = createFrameDecoder();
            socket.on('error', () => errors.push('server-socket'));
            socket.on('data', chunk => {
                try {
                    if (id === null) {
                        const need = 4 - hello.length, head = chunk.subarray(0, need);
                        hello = Buffer.concat([hello, head]); chunk = chunk.subarray(head.length);
                        if (hello.length < 4) return;
                        id = hello.readUInt32BE();
                        if (id >= count || sockets.has(id)) throw new Error('invalid synthetic identity');
                        sockets.set(id, socket);
                    }
                    if (!chunk.length) return;
                    for (const frame of decoder.push(chunk)) {
                        if (frame.tag === 2) socket.write(encodeFrame(3, b(1, 'ok'), { first: true }));
                        else if (frame.tag === 7) acknowledgments.add(id);
                        else throw new Error('unexpected synthetic frame');
                    }
                } catch { errors.push('server-protocol'); socket.destroy(); }
            });
        });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const port = server.address().port, rows = Array.from({ length: count }, (_, id) => ({
            id: String(id).padStart(6, '0'), owner_user_id: '222222222222222222', revision: 1,
        }));
        const ready = new Set(), baseline = process.memoryUsage().rss, start = performance.now();
        const gateway = { store: {}, async run(input) {
            const id = Number(input.subscriptionId), local = net.createConnection({ host: '127.0.0.1', port });
            local.once('connect', () => local.emit('secureConnect')); // synthetic TLS-ready event, no TLS is used
            const transport = createChromeMcsTransport({ timeoutMs: 30000, createSocket: () => local });
            const abort = () => transport.abort('X_PUSH_STOPPED');
            input.signal.addEventListener('abort', abort, { once: true });
            try {
                await transport.connect();
                const hello = Buffer.alloc(4); hello.writeUInt32BE(id); await transport.send(hello);
                const pending = new Set();
                const session = createChromeMcsSession({ credentials: { deviceId: String(id + 1), securityToken: '2', clientVersion: '140.0' },
                    route: { expectedCategory: 'com.chrome.windows', expectedAppId: `app-${id}`, expectedSender: 'sender' },
                    store: { pending: async () => [...pending], confirm: async ids => ids.forEach(value => pending.delete(value)),
                        commit: async message => {
                            assert.equal(message.persistentId, `msg-${id}`);
                            assert.equal(committed.has(id), false); committed.set(id, message.persistentId); pending.add(message.persistentId);
                            return { id: message.persistentId };
                        } },
                    send: bytes => transport.send(bytes), onReceipt: async receipt => {
                        assert.equal(receipt.id, `msg-${id}`); notified.add(id);
                    } });
                await session.start();
                const response = await transport.read(30000); await session.receive(response); ready.add(id);
                while (!input.signal.aborted) {
                    const frame = await transport.read(1000);
                    if (frame) await session.receive(frame);
                }
                session.close();
            } catch (error) { if (!input.signal.aborted) errors.push(String(error?.code || 'client-failed')); }
            finally { input.signal.removeEventListener('abort', abort); await transport.close(); }
            return { state: 'stopped' };
        } };
        const runtime = createXPushRuntime({ queryDatabase: async () => [] }, {}, { enabled: true, gateway, router: {},
            rolloutMode: 'public', assertAllowed() {}, maxConnections: count, pageSize: 50,
            listCandidates: async cursor => rows.filter(row => row.id > cursor).slice(0, 50),
            listActiveSessions: async ids => { const selected = new Set(ids); return rows.filter(row => selected.has(row.id)); } });
        try {
            for (let i = 0; i < count / 50; i++) {
                await runtime.tick();
                // Ramp up in bounded pages; this test measures concurrent
                // sessions, not the OS listener's connection-burst backlog.
                const target = (i + 1) * 50;
                await timeout((async () => { while (ready.size < target && !errors.length) await new Promise(resolve => setTimeout(resolve, 10)); })(), 10000);
                assert.equal(errors.length, 0, errors.slice(0, 3).join(','));
            }
            await timeout((async () => { while (ready.size !== count && !errors.length) await new Promise(resolve => setTimeout(resolve, 20)); })(), 30000);
            assert.equal(errors.length, 0, errors.slice(0, 3).join(',')); assert.equal(runtime.status().sessions, count); assert.equal(ready.size, count);
            for (const [id, socket] of sockets) {
                const payload = Buffer.concat([b(3, 'sender'), b(5, 'com.chrome.windows'), pair('subtype', `app-${id}`),
                    pair('content-encoding', 'aes128gcm'), b(9, `msg-${id}`), Buffer.from([0xaa, 1, 1, 42])]);
                socket.write(encodeFrame(8, payload));
            }
            await timeout((async () => { while ((notified.size !== count || acknowledgments.size !== count) && !errors.length)
                await new Promise(resolve => setTimeout(resolve, 20)); })(), 30000);
            assert.equal(errors.length, 0, errors.slice(0, 3).join(',')); assert.equal(committed.size, count); assert.equal(notified.size, count); assert.equal(acknowledgments.size, count);
            t.diagnostic(`1000 local TCP/MCS sessions; elapsed=${Math.round(performance.now() - start)}ms; rssDelta=${process.memoryUsage().rss - baseline} bytes; pid=${process.pid}; no TLS, FCM, or database`);
        } finally {
            await runtime.stop();
            for (const socket of sockets.values()) socket.destroy();
            await new Promise(resolve => server.close(resolve));
        }
    });

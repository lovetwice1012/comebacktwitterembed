'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runEdgeWnsGateway } = require('../../src/automation/edge-wns-gateway');
const lease = { subscriptionId: '33333333-3333-4333-8333-333333333333', ownerUserId: '123456789', revision: 1 };
function envelope(command, body = '') { const payload = Buffer.from(`MS-CV: synthetic\r\n\r\n${body}`); return Buffer.concat([Buffer.from(`${command} ${payload.length}\r\n`), payload]); }
function notification(site) { const body = Buffer.from(`Channel: ${site}\r\nMsg-Id: synthetic-id\r\nContent-Encoding: aes128gcm\r\n\r\ncipher`); return Buffer.concat([Buffer.from(`NFY 5 WNS\\NOTIF ${body.length}\r\n`), body]); }
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

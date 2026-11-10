'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEdgeWnsReceiver } = require('../../src/automation/edge-wns-receiver');
const lease = { subscriptionId: '33333333-3333-4333-8333-333333333333', ownerUserId: '123456789', revision: 1 };
const channel = Buffer.from('target-channel');
function frame(site = 'target-channel', id = 'synthetic-id', body = 'synthetic-ciphertext') {
    const data = Buffer.from(`Channel: ${site}\r\nMsg-Id: ${id}\r\nContent-Encoding: aes128gcm\r\n\r\n${body}`);
    return Buffer.concat([Buffer.from(`NFY 9 WNS\\NOTIF ${data.length}\r\n`), data]);
}
function harness(overrides = {}) {
    const calls = [], acks = [];
    const store = {
        async recordFrame(_lease, entry, { authorize }) { calls.push('persist'); await authorize(); return { ...lease, ...entry, headers: entry.headers, id: '1', duplicate: false }; },
        async assertLease(_lease, { authorize }) { calls.push('fence'); await authorize(); }, ...overrides,
    };
    const receiver = createEdgeWnsReceiver({ store, lease, channel, authorize: async () => { calls.push('authorize'); },
        sendAck: async value => { calls.push('ack'); acks.push(Buffer.from(value)); } });
    return { receiver, store, calls, acks };
}
test('persists encrypted target before fenced ACK and clears the outgoing ACK buffer', async () => {
    let sent; const h = harness();
    const receiver = createEdgeWnsReceiver({ store: h.store, lease, channel, authorize: async () => {}, sendAck: async bytes => { sent = bytes; } });
    assert.deepEqual(await receiver.receive(frame(), 5), { state: 'persisted', inboxId: '1', duplicate: false });
    assert.deepEqual(h.calls, ['persist', 'fence']); assert(sent.every(byte => byte === 0));
    receiver.close(); await assert.rejects(receiver.receive(frame(), 6), { code: 'X_EDGE_WNS_RECEIVER_STOPPED' });
});
test('does not persist or return another site payload', async () => {
    const h = harness(); assert.deepEqual(await h.receiver.receive(frame('other-site', 'other-id', 'FOREIGN-SENTINEL'), 5), { state: 'discarded' });
    assert.deepEqual(h.calls, ['fence', 'authorize', 'ack']); assert.equal(h.acks.length, 1);
    assert(!h.acks[0].toString().includes('FOREIGN-SENTINEL'));
});
test('disconnect drain persists owned frames and discards foreign frames without ACK', async () => {
    const h = harness();
    assert.deepEqual(await h.receiver.receive(frame('other-site'), 1, { acknowledge: false }), { state: 'discarded' });
    assert.deepEqual(await h.receiver.receive(frame(), 1, { acknowledge: false }), { state: 'persisted', inboxId: '1', duplicate: false });
    assert.equal(h.calls.filter(value => value === 'persist').length, 1); assert.equal(h.acks.length, 0); h.receiver.close();
});
test('conflicting duplicate, failed ACK and revoked lease stop the session without a later ACK', async () => {
    const conflict = harness({ recordFrame: async (_lease, entry) => ({ ...lease, ...entry, data: 'different', id: '1', duplicate: true }) });
    await assert.rejects(conflict.receiver.receive(frame(), 5), { code: 'X_EDGE_WNS_RECEIPT_CONFLICT' });
    await assert.rejects(conflict.receiver.receive(frame(), 6), { code: 'X_EDGE_WNS_RECEIVER_STOPPED' }); assert.equal(conflict.acks.length, 0);
    const failed = harness(); const receiver = createEdgeWnsReceiver({ store: failed.store, lease, channel, authorize: async () => {}, sendAck: async () => { throw new Error('private socket detail'); } });
    await assert.rejects(receiver.receive(frame(), 5), error => error.code === 'X_EDGE_WNS_ACK_FAILED' && !error.message.includes('private socket detail'));
    const revoked = harness({ assertLease: async () => { throw Object.assign(new Error('lease lost'), { code: 'X_PUSH_LEASE_LOST' }); } });
    await assert.rejects(revoked.receiver.receive(frame(), 5), { code: 'X_PUSH_LEASE_LOST' }); assert.equal(revoked.acks.length, 0);
});
test('a concurrent receive or close cannot ACK a pending persisted frame', async () => {
    for (const mode of ['concurrent', 'close']) {
        let release; const pending = new Promise(resolve => { release = resolve; });
        const h = harness({ recordFrame: async (_lease, entry) => { await pending; return { ...lease, ...entry, id: '1', duplicate: false }; } });
        const first = h.receiver.receive(frame(), 5);
        if (mode === 'concurrent') await assert.rejects(h.receiver.receive(frame(), 6), { code: 'X_EDGE_WNS_RECEIVER_BUSY' });
        else h.receiver.close();
        release(); await assert.rejects(first, { code: 'X_EDGE_WNS_RECEIVER_STOPPED' }); assert.equal(h.acks.length, 0);
    }
});

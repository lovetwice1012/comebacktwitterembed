'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSyntheticDurableReceiver } = require('../../experiments/chrome-push/edge-fixture-durable.cjs');
const target = Buffer.from('1;synthetic-target'), scope = 'http://127.0.0.1:32123/';
function frame(channel = '1;synthetic-target', id = 'synthetic-id', data = 'ciphertext') {
    const body = Buffer.from(`Channel: ${channel}\r\nMsg-Id: ${id}\r\nContent-Encoding: aes128gcm\r\n\r\n${data}`);
    return Buffer.concat([Buffer.from(`NFY 1 WNS\\NOTIF A1 ${body.length}\r\n`), body]);
}
function fixture(options = {}) {
    const rows = new Map(), steps = []; let leaseValid = true;
    const store = {
        async assertLease(_lease, { authorize }) { steps.push('fence'); await authorize(); if (!leaseValid) throw new Error('STALE_LEASE'); },
        async recordFrame(_lease, input, { authorize }) {
            steps.push('persist'); await authorize(); if (!leaseValid) throw new Error('STALE_LEASE');
            if (options.dbFailure) throw new Error('SYNTHETIC_DB_FAILURE');
            const old = rows.get(input.version), saved = old || { ...input, id: String(rows.size + 1) };
            rows.set(input.version, saved); return { ...saved, duplicate: Boolean(old) };
        },
    };
    const receiver = createSyntheticDurableReceiver({ scope, store, lease: {}, channel: target, authorize: async () => {},
        beforeAck: async () => { steps.push('after-commit'); if (options.failAfterCommit) throw new Error('SYNTHETIC_CRASH'); if (options.expireAfterCommit) leaseValid = false; },
        sendAck: async () => { steps.push('ack'); } });
    return { receiver, rows, steps };
}
test('synthetic ciphertext is committed and fenced before ACK; replay does not duplicate it', async () => {
    const f = fixture();
    const first = await f.receiver.receive(frame(), 5);
    assert.equal(first.state, 'persisted'); assert.equal(first.duplicate, false);
    assert.deepEqual(f.steps, ['persist', 'after-commit', 'fence', 'ack']);
    const again = await f.receiver.receive(frame(), 6);
    assert.equal(again.duplicate, true); assert.equal(f.rows.size, 1);
    assert.equal(JSON.stringify(first).includes('ciphertext'), false);
});
test('foreign synthetic notifications are fenced and never persisted', async () => {
    const f = fixture();
    assert.deepEqual(await f.receiver.receive(frame('1;other'), 5), { state: 'discarded' });
    assert.equal(f.rows.size, 0); assert.deepEqual(f.steps, ['fence', 'ack']);
});
test('collision, failed DB, post-commit failure and lost lease never send ACK', async () => {
    const collision = fixture(); await collision.receiver.receive(frame(), 5); collision.steps.length = 0;
    await assert.rejects(collision.receiver.receive(frame('1;synthetic-target', 'synthetic-id', 'different'), 6), { code: 'X_EDGE_WNS_RECEIPT_CONFLICT' });
    assert(!collision.steps.includes('ack'));
    for (const options of [{ dbFailure: true }, { failAfterCommit: true }, { expireAfterCommit: true }]) {
        const f = fixture(options); await assert.rejects(f.receiver.receive(frame(), 5)); assert(!f.steps.includes('ack'));
        assert.equal(f.rows.size, options.dbFailure ? 0 : 1);
    }
});
test('research receiver refuses a non-loopback scope before use', () => {
    assert.throws(() => createSyntheticDurableReceiver({ scope: 'https://x.com/', store: {}, lease: {}, channel: target,
        authorize: async () => {}, sendAck: async () => {} }), { code: 'PROBE_DURABLE_CONFIG_INVALID' });
});

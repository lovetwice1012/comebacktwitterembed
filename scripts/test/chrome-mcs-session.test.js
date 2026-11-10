'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createChromeMcsSession } = require('../../src/automation/chrome-mcs-session');
const b = (n, v) => Buffer.concat([Buffer.from([n * 8 + 2, Buffer.byteLength(v)]), Buffer.from(v)]);
const pair = (k, v) => b(7, Buffer.concat([b(1, k), b(2, v)]));
const frame = ({ category = 'com.chrome.windows', subtype = 'app', id = 'id1', from = 'sender' } = {}) => ({ tag: 8,
    payload: Buffer.concat([b(3, from), b(5, category), pair('subtype', subtype), pair('content-encoding', 'aes128gcm'), b(9, id), Buffer.from([0xaa, 1, 1, 42])]) });
const login = last => ({ tag: 3, payload: Buffer.concat([b(1, 'ok'), last ? Buffer.from([48, last]) : Buffer.alloc(0)]) });
function harness(initial = []) {
    const pending = new Set(initial), steps = [], writes = [];
    const store = { async pending() { return [...pending]; }, async commit(m) { steps.push('commit'); pending.add(m.persistentId); return { id: m.persistentId }; },
        async confirm(ids) { steps.push('confirm'); for (const id of ids) pending.delete(id); } };
    const session = createChromeMcsSession({ credentials: { deviceId: '1', securityToken: '2', clientVersion: '140.0' },
        route: { expectedCategory: 'com.chrome.windows', expectedAppId: 'app', expectedSender: 'sender' }, store,
        send: async buffer => { steps.push('send'); writes.push(buffer); }, onReceipt: async () => steps.push('notify') });
    return { session, store, pending, steps, writes };
}
test('commits before stream ACK and keeps replay IDs until server confirms', async () => {
    const h = harness(); await h.session.start(); await h.session.receive(login(1)); h.steps.length = 0;
    assert.deepEqual(await h.session.receive(frame()), { state: 'received' });
    assert.deepEqual(h.steps, ['commit', 'send', 'notify']); assert(h.pending.has('id1'));
    assert.equal(h.writes[1][0], 7);
    await h.session.receive({ tag: 1, payload: Buffer.from([16, 2]) });
    assert.equal(h.pending.size, 0); assert.equal(h.steps.at(-1), 'confirm');
});
test('reconnect replays saved IDs and login confirmation clears them', async () => {
    const h = harness(['prior']); await h.session.start();
    assert(h.writes[0].includes(Buffer.from('prior'))); assert(h.pending.has('prior'));
    await h.session.receive(login(1)); assert.equal(h.pending.size, 0);
});
test('failed commit or lost send never acknowledges a later frame', async () => {
    const h = harness(); await h.session.start(); await h.session.receive(login(1));
    h.store.commit = async () => { throw new Error('DB_FAILED'); };
    await assert.rejects(h.session.receive(frame()), /DB_FAILED/); assert.equal(h.writes.length, 1);
    await assert.rejects(h.session.receive(frame()), /X_CHROME_SESSION_INVALID/);
});
test('a failed ACK write leaves the committed ID for a later login', async () => {
    const h = harness(); await h.session.start(); await h.session.receive(login(1));
    // Force an uncertain write after the receipt was committed.
    const pending = new Set(); let sends = 0;
    const session = createChromeMcsSession({ credentials: { deviceId: '1', securityToken: '2', clientVersion: '140.0' },
        route: { expectedCategory: 'com.chrome.windows', expectedAppId: 'app', expectedSender: 'sender' },
        store: { pending: async () => [...pending], commit: async m => { pending.add(m.persistentId); }, confirm: async () => {} },
        send: async () => { if (++sends === 2) throw new Error('WRITE_FAILED'); } });
    await session.start(); await session.receive(login(1));
    await assert.rejects(session.receive(frame()), /WRITE_FAILED/); assert(pending.has('id1'));
    await assert.rejects(session.receive(frame()), /X_CHROME_SESSION_INVALID/);
});
test('other apps are discarded without committing or notifying', async () => {
    const h = harness(); await h.session.start(); await h.session.receive(login(1)); h.steps.length = 0;
    assert.deepEqual(await h.session.receive(frame({ subtype: 'other' })), { state: 'discarded' });
    assert.deepEqual(h.steps, ['send']); assert.equal(h.pending.size, 0);
});
test('provider loss notice is recorded before acknowledgment and does not become a notification', async () => {
    const h = harness();
    h.store.control = async message => { h.steps.push('control'); if (message.persistentId) h.pending.add(message.persistentId); };
    await h.session.start(); await h.session.receive(login(1)); h.steps.length = 0;
    const message = frame({ id: 'lost-1' }); message.payload = Buffer.concat([message.payload, pair('message_type', 'deleted_messages')]);
    assert.deepEqual(await h.session.receive(message), { state: 'provider_control', kind: 'deleted_messages' });
    assert.deepEqual(h.steps, ['control', 'send']); assert(h.pending.has('lost-1'));
    await h.session.receive({ tag: 1, payload: Buffer.from([16, 2]) }); assert.equal(h.pending.size, 0);
});
test('failed provider notice recording does not acknowledge the message', async () => {
    const h = harness(); h.store.control = async () => { throw new Error('AUDIT_FAILED'); };
    await h.session.start(); await h.session.receive(login(1));
    const message = frame({ id: 'lost-2' }); message.payload = Buffer.concat([message.payload, pair('message_type', 'deleted_messages')]);
    await assert.rejects(h.session.receive(message), /AUDIT_FAILED/); assert.equal(h.writes.length, 1);
});
test('provider notices without a persistent ID can be audited and acknowledged', async () => {
    const h = harness(); let control;
    h.store.control = async message => { control = message; h.steps.push('control'); };
    await h.session.start(); await h.session.receive(login(1)); h.steps.length = 0;
    const message = frame({ id: '' }); message.payload = Buffer.concat([message.payload, pair('message_type', 'send_error')]);
    assert.deepEqual(await h.session.receive(message), { state: 'provider_control', kind: 'send_error' });
    assert.equal(control.persistentId, null); assert.deepEqual(h.steps, ['control', 'send']); assert.equal(h.pending.size, 0);
});
test('MCS idle control receives a protocol response without creating a user receipt', async () => {
    const h = harness(); await h.session.start(); await h.session.receive(login(1)); h.steps.length = 0;
    const control = { tag: 8, payload: Buffer.concat([b(5, 'com.google.android.gsf.gtalkservice'), pair('IdleNotification', 'true')]) };
    assert.deepEqual(await h.session.receive(control), { state: 'control' });
    assert.deepEqual(h.steps, ['send']); assert.equal(h.writes[1][0], 8); assert.equal(h.pending.size, 0);
});
test('rejects a forged stream confirmation and missing persistent ID', async () => {
    const h = harness(); await h.session.start(); await h.session.receive(login(1));
    await assert.rejects(h.session.receive({ tag: 1, payload: Buffer.from([16, 99]) }), /X_CHROME_SESSION_SEQUENCE_INVALID/);
    const second = harness(); await second.session.start(); await second.session.receive(login(1));
    await assert.rejects(second.session.receive(frame({ id: '' })), /X_CHROME_SESSION_ID_MISSING/);
    assert.equal(second.writes.length, 1);
});

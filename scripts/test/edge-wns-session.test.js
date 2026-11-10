'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEdgeWnsSession, reply } = require('../../src/automation/edge-wns-session');
const lease = { subscriptionId: '33333333-3333-4333-8333-333333333333', ownerUserId: '123456789', revision: 1 };
function envelope(command, body = '') { const payload = Buffer.from(`MS-CV: synthetic\r\n\r\n${body}`); return Buffer.concat([Buffer.from(`${command} ${payload.length}\r\n`), payload]); }
function notification(site = 'target') { const body = Buffer.from(`Channel: ${site}\r\nMsg-Id: synthetic-id\r\nContent-Encoding: aes128gcm\r\n\r\ncipher`); return Buffer.concat([Buffer.from(`NFY 5 WNS\\NOTIF ${body.length}\r\n`), body]); }
function harness(options = {}) {
    const events = [], frames = [], rotated = [];
    const incoming = [envelope('CNT 1 CON', '<connect/>'), envelope('ATH 2 CON'),
        envelope('BND 3 CON', '<wns><ver>1.0</ver><nonce>synthetic-nonce</nonce><reconnect-token>new-token</reconnect-token></wns>'), envelope('PUT 4 WNS')];
    const transport = { async connect() { events.push('connect'); }, async send(frame) { const name = frame.subarray(0, frame.indexOf(' ')).toString(); events.push(`send:${name}`); frames.push(Buffer.from(frame)); },
        async next() { if (!incoming.length) throw Object.assign(new Error('idle'), { code: 'X_EDGE_WNS_RECEIVE_TIMEOUT' }); return incoming.shift(); },
        close() { events.push('close'); }, ...options.transport };
    const store = { async recordFrame(_lease, entry, { authorize }) { events.push('persist'); await authorize(); return { ...lease, ...entry, id: '1', duplicate: false }; },
        async assertLease(_lease, { authorize }) { events.push('fence'); await authorize(); } };
    const session = createEdgeWnsSession({ transport, store, lease, siteChannel: Buffer.from('target'), authorize: async () => {},
        saveRotatedToken: options.saveRotatedToken || (async token => { events.push('rotate'); rotated.push(token); }),
        agent: { os: 'Test OS', osVersion: '1', architecture: 'x64', locale: 'en' },
        client: { channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic client', clientVersion: '1.2.3.4' },
        deviceKey: Buffer.alloc(32, 7), reconnectToken: Buffer.from('old-token'), ...(options.bound
            ? { authenticationMode: 'bound' } : { productKey: Buffer.from('0123456789abcdef'), productId: Buffer.from('fedcba9876543210') }) });
    return { session, incoming, events, frames, rotated };
}
test('bound session saves token and receives without product challenge', async () => {
    const h = harness({ bound: true }); h.incoming.pop();
    assert.deepEqual(await h.session.start(), { state: 'ready' });
    assert.deepEqual(h.events, ['connect', 'send:CNT', 'send:ATH', 'send:BND', 'rotate']);
    h.incoming.push(notification());
    assert.deepEqual(await h.session.next(), { state: 'persisted', inboxId: '1', duplicate: false });
    h.session.close(); for (const frame of h.frames) frame.fill(0);
});
test('bound session does not receive when token persistence fails', async () => {
    const h = harness({ bound: true, saveRotatedToken: async () => { throw new Error('database failure'); } });
    await assert.rejects(h.session.start(), /database failure/);
    assert(!h.events.includes('send:ACK')); assert.equal(h.events.at(-1), 'close');
});
test('persists rotated token before challenge and persists target before ACK', async () => {
    const h = harness(); assert.deepEqual(await h.session.start(), { state: 'ready' });
    assert.deepEqual(h.events, ['connect', 'send:CNT', 'send:ATH', 'send:BND', 'rotate', 'send:PUT']);
    assert.equal(h.rotated.length, 1); assert(h.rotated[0].every(byte => byte === 0));
    h.incoming.push(notification('other'), notification());
    assert.deepEqual(await h.session.next(), { state: 'discarded' });
    assert.deepEqual(await h.session.next(), { state: 'persisted', inboxId: '1', duplicate: false });
    assert.deepEqual(h.events.slice(6), ['fence', 'send:ACK', 'persist', 'fence', 'send:ACK']);
    assert.deepEqual(await h.session.next(1), { state: 'idle' }); h.session.close();
    await assert.rejects(h.session.next(), { code: 'X_EDGE_WNS_SESSION_STOPPED' });
    for (const frame of h.frames) frame.fill(0);
});
test('failed token persistence closes before challenge and clears borrowed token', async () => {
    let borrowed; const h = harness({ saveRotatedToken: async token => { borrowed = token; throw new Error('synthetic database failure'); } });
    await assert.rejects(h.session.start(), /synthetic database failure/);
    assert(borrowed.every(byte => byte === 0)); assert(!h.events.includes('send:PUT')); assert.equal(h.events.at(-1), 'close');
});
test('closing while token persistence is pending prevents the challenge from being sent', async () => {
    let release, started, borrowed; const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    const h = harness({ saveRotatedToken: async token => { borrowed = token; started(); await gate; } });
    const result = h.session.start(); await entered; h.session.close(); release();
    await assert.rejects(result, { code: 'X_EDGE_WNS_SESSION_STOPPED' });
    assert(!h.events.includes('send:PUT')); assert(borrowed.every(byte => byte === 0));
});
test('unexpected reply or concurrent operation closes without accepting a notification', async () => {
    const bad = harness(); bad.incoming[0] = envelope('CNT 2 CON', '<connect/>');
    await assert.rejects(bad.session.start(), { code: 'X_EDGE_WNS_REPLY_INVALID' }); assert.equal(bad.events.at(-1), 'close');
    let release; const gate = new Promise(resolve => { release = resolve; });
    const concurrent = harness({ transport: { connect: () => gate } });
    const start = concurrent.session.start(); await assert.rejects(concurrent.session.next(), { code: 'X_EDGE_WNS_SESSION_BUSY' });
    release(); await assert.rejects(start, { code: 'X_EDGE_WNS_SESSION_STOPPED' });
    assert(!concurrent.events.some(event => event.startsWith('send:')));
});
test('reply validation rejects length errors, protocol errors and unexpected bodies', () => {
    const valid = envelope('ATH 2 CON'); reply(valid, 'ATH', 2, 'CON', { emptyBody: true });
    for (const item of [envelope('ATH 3 CON'), envelope('ATH 2 CON', '<error>failed</error>'),
        envelope('ATH 2 CON', 'unexpected'), valid.subarray(0, -1)])
        assert.throws(() => reply(item, 'ATH', 2, 'CON', { emptyBody: true }), { code: 'X_EDGE_WNS_REPLY_INVALID' });
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createMacEdgePeerVerifier } = require('../../src/automation/edge-mac-peer');
const identityPath = process.env.MAC_IDENTITY_HELPER, peerPath = process.env.MAC_SOCKET_HELPER;
const executable = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

test('Mac peer verifier checks native helper identities and fails closed', { skip: !identityPath || !peerPath }, async () => {
    const digest = async filename => createHash('sha256').update(await fs.readFile(filename)).digest('hex');
    const args = { identityPath, peerPath, identitySha256: await digest(identityPath), peerSha256: await digest(peerPath) };
    const original = process.env.MAC_IDENTITY_TEST_CASE; process.env.MAC_IDENTITY_TEST_CASE = 'good';
    try {
        const verifier = createMacEdgePeerVerifier(args), ticks = await verifier.captureIdentity(123, executable);
        assert.equal(ticks, '1700000000:123456');
        const peer = { clientPort: 30001, serverPort: 23457, browserPid: 123, browserStartTicks: ticks, browserExecutable: executable };
        assert.equal(await verifier.authorizePeer(peer), true);
        process.env.MAC_IDENTITY_TEST_CASE = 'child-path'; assert.equal(await verifier.authorizePeer(peer), false);
        process.env.MAC_IDENTITY_TEST_CASE = 'parent'; await assert.rejects(verifier.captureIdentity(123, executable), { code: 'X_EDGE_CALIBRATION_PEER_FAILED' });
        assert.equal(await verifier.authorizePeer({ ...peer, browserExecutable: '/tmp/untrusted' }), false);
        assert.equal(await verifier.authorizePeer({ ...peer, browserStartTicks: 'bad' }), false);
        const badHash = createMacEdgePeerVerifier({ ...args, identitySha256: '0'.repeat(64) });
        await assert.rejects(badHash.captureIdentity(123, executable), { code: 'X_EDGE_CALIBRATION_PEER_FAILED' });
        let seen;
        const fake = createMacEdgePeerVerifier({ ...args, spawnProcess: (_file, argumentsSeen) => {
            seen = argumentsSeen; const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => {};
            queueMicrotask(() => { child.stdout.write('1'); child.stdout.end(); child.emit('close', 0); }); return child;
        } });
        assert.equal(await fake.authorizePeer({ ...peer, browserStartTicks: '1700000000:000001' }), true);
        assert.deepEqual(seen, ['123', '1700000000', '1', '30001', '23457']);
        const malformed = createMacEdgePeerVerifier({ ...args, spawnProcess: () => {
            const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => {};
            queueMicrotask(() => { child.stdout.write('1extra'); child.stdout.end(); child.emit('close', 0); }); return child;
        } });
        assert.equal(await malformed.authorizePeer(peer), false);
        let killed = false;
        const stalled = createMacEdgePeerVerifier({ ...args, timeoutMs: 100, spawnProcess: () => {
            const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => { killed = true; }; return child;
        } });
        await assert.rejects(stalled.captureIdentity(123, executable), { code: 'X_EDGE_CALIBRATION_PEER_FAILED' }); assert(killed);
    } finally { if (original === undefined) delete process.env.MAC_IDENTITY_TEST_CASE; else process.env.MAC_IDENTITY_TEST_CASE = original; }
});

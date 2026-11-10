'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createWindowsEdgePeerVerifier } = require('../../src/automation/edge-windows-peer');
const powershellPath = path.resolve('powershell.exe'), helperPath = path.resolve('EdgePeerVerify.ps1'), executable = path.resolve('msedge.exe');
function fake(output, code = 0) {
    const calls = []; let killed = 0;
    return { calls, get killed() { return killed; }, spawnProcess: (file, args, options) => {
        calls.push({ file, args, options }); const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => { killed++; };
        if (output !== null) queueMicrotask(() => { child.stdout.write(output); child.stdout.end(); child.emit('close', code); });
        return child;
    } };
}
test('peer verifier uses fixed shell-free arguments and returns only validated results', async () => {
    const identity = fake('{"ok":true,"startTicks":"638000000000000000"}');
    const verifier = createWindowsEdgePeerVerifier({ powershellPath, helperPath, spawnProcess: identity.spawnProcess });
    assert.equal(await verifier.captureIdentity(123, executable), '638000000000000000');
    assert.equal(identity.calls.length, 1); assert.equal(identity.calls[0].options.shell, false); assert(identity.calls[0].args.includes(executable));
    const peer = fake('{"ok":true}'); const peerVerifier = createWindowsEdgePeerVerifier({ powershellPath, helperPath, spawnProcess: peer.spawnProcess });
    assert.equal(await peerVerifier.authorizePeer({ clientPort: 12345, serverPort: 23456, browserPid: 123, browserStartTicks: '638000000000000000', browserExecutable: executable }), true);
    assert.equal(await peerVerifier.verifyExecutable(executable), true);
    assert.equal(await peerVerifier.verifyExecutable(path.resolve('not-edge.exe')), false);
});
test('peer verifier fails closed on malformed output, invalid input and timeout', async () => {
    const bad = fake('{"ok":true,"startTicks":"bad","secret":"fixture"}');
    const verifier = createWindowsEdgePeerVerifier({ powershellPath, helperPath, spawnProcess: bad.spawnProcess });
    await assert.rejects(verifier.captureIdentity(123, executable), { code: 'X_EDGE_CALIBRATION_PEER_FAILED' });
    assert.equal(await verifier.authorizePeer({ clientPort: 1, serverPort: 23456, browserPid: 123, browserStartTicks: '638000000000000000', browserExecutable: executable }), false);
    assert.equal(bad.calls.length, 1);
    const stalled = fake(null), timeout = createWindowsEdgePeerVerifier({ powershellPath, helperPath, timeoutMs: 100, spawnProcess: stalled.spawnProcess });
    await assert.rejects(timeout.captureIdentity(123, executable), { code: 'X_EDGE_CALIBRATION_PEER_FAILED' }); assert.equal(stalled.killed, 1);
});

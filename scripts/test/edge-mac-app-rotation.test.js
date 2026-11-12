'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ accept = false, errorCode = 'X_EDGE_MAC_PROFILE_INSPECTION_REQUIRED' } = {}) {
    const events = [], old = { rootPath: '/fixture/old', profileId: 'old' }, next = { rootPath: '/fixture/new', profileId: 'new' };
    let calls = 0; const mod = { exports: {} }, source = fs.readFileSync(path.join(__dirname, '../../src/automation/edge-mac-app.js'), 'utf8');
    vm.runInNewContext(source, { module: mod, exports: mod.exports, AbortSignal, require(name) {
        if (name === 'node:path') return path.posix;
        if (name === './chrome-mac-app') return { ensureMacSetupDirectory: async () => '/fixture' };
        if (name === './chrome-mac-profile-registry') return { getOrCreateMacEdgeProfile: async () => old };
        if (name === './edge-mac-profile-rotation') return { rotateMacEdgeProfile: async options => { events.push(['rotate', options]); return next; } };
        if (name === './edge-mac-setup-session') return { runExperimentalMacEdgeSetup: async options => {
            events.push(['setup', options.rootPath]); if (++calls === 1) throw Object.assign(new Error('synthetic'), { code: errorCode }); return { state: 'saved' };
        } }; throw new Error('unexpected dependency');
    } });
    const ui = { confirmNewProfile: async () => { events.push(['prompt']); return accept; } };
    const args = { applicationSupport: '/fixture', helperPath: '/helper', identityPath: '/identity', peerPath: '/peer',
        expectedSha256: 'a'.repeat(64), identitySha256: 'b'.repeat(64), peerSha256: 'c'.repeat(64), experimental: true, ui };
    return { run: mod.exports.runExperimentalMacEdgeApp, args, events, old };
}
test('new profile is created only after explicit confirmation', async () => {
    const stopped = fixture(); assert.equal((await stopped.run(stopped.args)).state, 'cancelled');
    assert.deepEqual(stopped.events.map(x => x[0]), ['setup', 'prompt']);
    const accepted = fixture({ accept: true }); assert.equal((await accepted.run(accepted.args)).state, 'saved');
    assert.deepEqual(accepted.events.map(x => x[0]), ['setup', 'prompt', 'rotate', 'setup']);
    assert.equal(accepted.events[2][1].oldProfile, accepted.old); assert.equal(accepted.events[2][1].confirmed, true);
    assert.equal(accepted.events[3][1], '/fixture/new');
});
test('lock and helper failures never prompt or rotate', async () => {
    for (const code of ['X_CHROME_MAC_LOCK_BUSY', 'X_CHROME_MAC_LOCK_FAILED', 'X_CHROME_MAC_LOCK_INVALID', 'X_CHROME_MAC_LOCK_LOST']) {
        const f = fixture({ accept: true, errorCode: code });
        await assert.rejects(f.run(f.args), { code });
        assert.deepEqual(f.events.map(x => x[0]), ['setup']);
    }
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(code) {
    const events = [], mod = { exports: {} }, source = fs.readFileSync(path.join(__dirname, '../../src/automation/edge-mac-open.js'), 'utf8');
    vm.runInNewContext(source, { module: mod, exports: mod.exports, require(name) {
        if (name === 'node:fs/promises') return { readdir: async () => ['existing'] }; if (name === 'node:path') return path.posix;
        if (name === 'classic-level') return { ClassicLevel: class {} };
        if (name === './chrome-mac-profile-lease') return { acquireMacProfileLease: async () => ({}), releaseMacProfileLease: async () => events.push('released') };
        if (name === './chrome-mac-snapshot') return { withMacEdgeSnapshot: async () => { throw Object.assign(new Error('secret'), { code }); } };
        if (name === './edge-wns-snapshot-io') return { inspectEdgeSnapshot: async () => ({ hasXSubscription: false }) };
        if (name === './edge-mac-broker') return { startMacEdgeBroker: async () => { events.push('broker'); } };
        throw new Error('unexpected dependency');
    } });
    return { open: mod.exports.openMacEdgeForSetup, events };
}
test('only the fixed Edge reader error suggests manual profile rotation', async () => {
    for (const code of ['X_EDGE_WNS_SNAPSHOT_INVALID', 'X_CHROME_MAC_LOCK_FAILED', 'X_CHROME_MAC_LOCK_BUSY', 'X_CHROME_MAC_LOCK_INVALID']) {
        const f = fixture(code), expected = code === 'X_EDGE_WNS_SNAPSHOT_INVALID' ? 'X_EDGE_MAC_PROFILE_INSPECTION_REQUIRED' : code;
        await assert.rejects(f.open({ rootPath: '/fixture', profileId: 'synthetic' }), { code: expected });
        assert.deepEqual(f.events, ['released']);
    }
});

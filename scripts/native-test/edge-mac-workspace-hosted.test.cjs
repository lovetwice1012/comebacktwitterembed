'use strict';
// Disposable hosted Mac only. No X or existing browser profile is opened.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createMacEdgeProfile } = require('../../src/automation/chrome-mac-profile');
const { calibrateMacEdgeInOwnedWorkspace } = require('../../src/automation/edge-mac-calibration-workspace');

test('signed Edge calibrates in a separate owned workspace and leaves its setup profile untouched',
    { skip: process.platform !== 'darwin' || process.env.CBTE_MAC_EDGE_HOSTED !== '1', timeout: 300000 }, async t => {
        assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
        const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-edge-workspace-hosted-'));
        let clean = false;
        t.after(async () => {
            if (!clean) return; // Retain the disposable fixture when shutdown is uncertain.
            const actual = await fs.realpath(base); assert.equal(path.dirname(actual), temp);
            assert.match(path.basename(actual), /^cbte-edge-workspace-hosted-/); await fs.rm(actual, { recursive: true });
        });
        const profile = await createMacEdgeProfile(base), sentinel = path.join(profile.profilePath, 'synthetic-sentinel');
        await fs.writeFile(sentinel, 'untouched', { flag: 'wx', mode: 0o600 });
        const identityPath = process.env.MAC_EDGE_IDENTITY_HELPER, peerPath = process.env.MAC_EDGE_SOCKET_HELPER;
        assert(path.isAbsolute(identityPath || '') && path.isAbsolute(peerPath || ''));
        const hash = async name => createHash('sha256').update(await fs.readFile(name)).digest('hex');
        const result = await calibrateMacEdgeInOwnedWorkspace({ rootPath: profile.rootPath, profileId: profile.profileId,
            identityPath, identitySha256: await hash(identityPath), peerPath, peerSha256: await hash(peerPath) });
        assert(['1', '2'].includes(result.connectVersion)); assert.ok(result.agent && result.client);
        assert.equal(await fs.readFile(sentinel, 'utf8'), 'untouched');
        assert(!(await fs.readdir(profile.rootPath)).some(name => name.startsWith('edge-calibration-')));
        clean = true;
        t.diagnostic('synthetic calibration completed; helper metadata and credentials omitted');
    });

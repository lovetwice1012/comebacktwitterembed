'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { fork } = require('node:child_process');
const { waitForMacProcessGroupExit } = require('../../src/automation/chrome-mac-process-group');

test('signed Edge calibrates through an owned Mac profile and OS-verified peer',
    { skip: process.platform !== 'darwin' || process.env.CBTE_MAC_EDGE_HOSTED !== '1', timeout: 600000 }, async t => {
        assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
        const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-edge-calibration-hosted-'));
        const token = randomBytes(16).toString('hex'), rootPath = path.join(base, `edge-calibration-${token}`);
        await fs.mkdir(rootPath, { mode: 0o700 }); await fs.mkdir(path.join(rootPath, 'profile'), { mode: 0o700 });
        await fs.writeFile(path.join(rootPath, 'owner.json'), JSON.stringify({ appId: 'x-notification-setup', kind: 'edge-calibration-v1', token }), { mode: 0o600, flag: 'wx' });
        let child, exited = false, groupGone = false;
        t.after(async () => {
            if (child && !exited) try { child.kill('SIGTERM'); } catch { /* Retain the fixture on uncertainty. */ }
            if (exited && child?.pid) groupGone = await waitForMacProcessGroupExit(child.pid);
            if (groupGone) {
                const actual = await fs.realpath(base); assert.equal(path.dirname(actual), temp);
                assert.match(path.basename(actual), /^cbte-edge-calibration-hosted-/); await fs.rm(actual, { recursive: true });
            }
            assert.equal(groupGone, true, 'synthetic calibration profile retained because process termination was not confirmed');
        });
        const identityPath = process.env.MAC_EDGE_IDENTITY_HELPER, peerPath = process.env.MAC_EDGE_SOCKET_HELPER;
        assert(path.isAbsolute(identityPath || '') && path.isAbsolute(peerPath || ''));
        child = fork(path.join(__dirname, 'edge-mac-calibration-hosted-child.cjs'), [], { detached: true, windowsHide: true,
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, CBTE_MAC_EDGE_HOSTED: '1' } });
        const result = await new Promise((resolve, reject) => {
            let response, timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} reject(new Error('FIXTURE_TIMEOUT')); }, 480000);
            child.on('message', message => { if (response) return; response = message; });
            child.once('error', () => { clearTimeout(timer); reject(new Error('FIXTURE_CHILD_FAILED')); });
            child.once('exit', code => { exited = true; clearTimeout(timer); if (code === 0 && response?.ok === true) resolve(response);
                else reject(new Error(`FIXTURE_CALIBRATION_${/^[A-Z_]+$/.test(response?.code || '') ? response.code : 'FAILED'}`)); });
            child.send({ rootPath, token, identityPath, peerPath });
        });
        assert(['1', '2'].includes(result.connectVersion));
        t.diagnostic(`synthetic Edge connect version ${result.connectVersion}; agent and credentials omitted`);
    });

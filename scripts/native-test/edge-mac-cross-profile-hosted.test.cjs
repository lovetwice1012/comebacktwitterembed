'use strict';

// Hosted synthetic profiles only. Never load a user's Edge profile or X
// account. Metadata and credentials stay in memory and are not logged.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { fork } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { ClassicLevel } = require('classic-level');
const webpush = require('web-push');
const { waitForMacProcessGroupExit } = require('../../src/automation/chrome-mac-process-group');
const { partitionStoreRecords } = require('../../src/automation/edge-wns-record');
const { buildEdgeTransferFromStore } = require('../../src/automation/edge-wns-snapshot');
const { selectSyntheticEdgeRecord, rewriteSyntheticOrigin } = require('../../experiments/chrome-push/edge-fixture-record.cjs');
const { withEdgeWnsCredentials } = require('../../src/automation/edge-wns-credentials');
const { createEdgeWnsTransport } = require('../../src/automation/edge-wns-transport');
const { createEdgeWnsSession } = require('../../src/automation/edge-wns-session');
const { safeCalibrationError } = require('./edge-mac-fixture-error.cjs');
const { formatVersionDiagnostics } = require('./edge-mac-version-diagnostic.cjs');

const enabled = process.platform === 'darwin' && process.env.CBTE_MAC_EDGE_HOSTED === '1'
    && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
test('calibration metadata from one synthetic Mac Edge profile receives another profile through WNS',
    { skip: !enabled, timeout: 900000 }, async t => {
        const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-edge-cross-profile-'));
        const children = [];
        t.after(async () => {
            for (const state of children) {
                if (!state.exited) { try { state.child.kill('SIGTERM'); } catch {} }
                if (state.exited && !state.groupGone && state.child.pid) state.groupGone = await waitForMacProcessGroupExit(state.child.pid);
            }
            if (children.length === 2 && children.every(state => state.confirmed && state.groupGone)) {
                const actual = await fs.realpath(base); assert.equal(path.dirname(actual), temp);
                assert.match(path.basename(actual), /^cbte-edge-cross-profile-/); await fs.rm(actual, { recursive: true });
            }
            assert.ok(children.length === 2 && children.every(state => state.confirmed && state.groupGone),
                'synthetic profiles retained because all calibration children did not stop cleanly');
        });
        const identityPath = process.env.MAC_EDGE_IDENTITY_HELPER, peerPath = process.env.MAC_EDGE_SOCKET_HELPER;
        assert.ok(path.isAbsolute(identityPath || '') && path.isAbsolute(peerPath || ''));
        async function createSyntheticProfile(label) {
            if (!['A', 'B'].includes(label)) throw new Error('FIXTURE_CROSS_INPUT_INVALID');
            t.diagnostic(`synthetic profile ${label} calibration started`);
            const token = randomBytes(16).toString('hex'), root = path.join(base, `edge-calibration-${token}`);
            await fs.mkdir(root, { mode: 0o700 }); await fs.mkdir(path.join(root, 'profile'), { mode: 0o700 });
            await fs.writeFile(path.join(root, 'owner.json'), JSON.stringify({ appId: 'x-notification-setup', kind: 'edge-calibration-v1', token }),
                { mode: 0o600, flag: 'wx' });
            const child = fork(path.join(__dirname, 'edge-mac-calibration-hosted-child.cjs'), [], { detached: true, windowsHide: true,
                stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, CBTE_MAC_EDGE_HOSTED: '1' } });
            const state = { child, exited: false, groupGone: false, confirmed: false }; children.push(state);
            const response = await new Promise((resolve, reject) => {
                let received, timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} reject(new Error('FIXTURE_CROSS_TIMEOUT')); }, 420000);
                child.on('message', message => { if (!received) received = message; });
                child.once('error', () => { clearTimeout(timer); reject(new Error('FIXTURE_CROSS_CHILD_FAILED')); });
                child.once('exit', code => { state.exited = true; clearTimeout(timer);
                    if (code === 0 && received?.ok === true) { state.confirmed = true; resolve(received); }
                    else {
                        const code = safeCalibrationError(received?.code);
                        t.diagnostic(`synthetic profile ${label} version verification: ${formatVersionDiagnostics(received?.versionDiagnostic)}`);
                        reject(new Error(`FIXTURE_CROSS_CALIBRATION_${label}_${code}`));
                    } });
                child.send({ rootPath: root, token, identityPath, peerPath });
            });
            state.groupGone = await waitForMacProcessGroupExit(child.pid);
            assert.equal(state.groupGone, true, 'synthetic calibration process group did not stop');
            t.diagnostic(`synthetic profile ${label} calibration completed`);
            return { root, response };
        }
        const a = await createSyntheticProfile('A'), b = await createSyntheticProfile('B');
        assert.equal(a.response.browserVersion, b.response.browserVersion, 'Edge changed between synthetic profiles');
        const captured = b.response.subscription;
        assert.ok(captured && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(captured.scope), 'invalid synthetic subscription scope');
        const storePath = path.join(b.root, 'profile', 'Default', 'EdgePushStorageWithConnectTokenAndKey');
        for (const name of [path.join(b.root, 'profile'), path.join(b.root, 'profile', 'Default'), storePath]) {
            const info = await fs.lstat(name); assert.ok(info.isDirectory() && !info.isSymbolicLink()); assert.equal(await fs.realpath(name), name);
        }
        const db = new ClassicLevel(storePath, { createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer' }), records = [];
        let selected, rewritten;
        const expected = { endpoint: captured.endpoint, publicKey: Buffer.from(captured.keys.p256dh, 'base64url'),
            auth: Buffer.from(captured.keys.auth, 'base64url'), applicationServerKey: Buffer.from(captured.applicationServerKey, 'base64url') };
        try {
            await db.open();
            for await (const [key, value] of db.iterator({ limit: 129 })) {
                try { assert.ok(Buffer.isBuffer(key) && Buffer.isBuffer(value) && key.length <= 4096 && value.length <= 65536 && records.length < 128);
                    records.push(Buffer.from(value)); }
                finally { key?.fill(0); value?.fill(0); }
            }
            const partition = partitionStoreRecords(records);
            selected = selectSyntheticEdgeRecord(partition.siteRecords, captured.scope);
            assert.ok(selected.endpoint === expected.endpoint && selected.publicKey.equals(expected.publicKey)
                && selected.auth.equals(expected.auth) && selected.applicationServerKey.equals(expected.applicationServerKey), 'synthetic store did not match the captured subscription');
            const matches = partition.siteRecords.filter(record => record.includes(Buffer.from(captured.scope)));
            assert.equal(matches.length, 1); rewritten = rewriteSyntheticOrigin(matches[0], captured.scope);
            const inputRecords = records.map(record => record === matches[0] ? rewritten : record);
            const baseOutput = await buildEdgeTransferFromStore({ records: inputRecords, expected, browserVersion: b.response.browserVersion,
                agent: b.response.agent, client: b.response.client, ...(b.response.connectVersion === '2' ? { connectVersion: '2' } : {}) });
            t.diagnostic(`synthetic profile metadata matches: connectVersion=${a.response.connectVersion === b.response.connectVersion}`
                + ` channel=${a.response.client.channel === b.response.client.channel}`
                + ` agent=${JSON.stringify(a.response.agent) === JSON.stringify(b.response.agent)}`);
            let file = baseOutput.file;
            const lease = { subscriptionId: '33333333-3333-4333-8333-333333333333', ownerUserId: '123456789', revision: 1 };
            const { decryptNotification } = await import(pathToFileURL(path.resolve(__dirname, '../../packages/angelic-angel/dist/crypto.js')).href);
            webpush.setVapidDetails('mailto:fixture@example.com', b.response.vapid.publicKey, b.response.vapid.privateKey);
            async function receiveOne(metadata, marker) {
                let stored, rotated, stage = 'CONNECT';
                const store = { async assertLease(_lease, { authorize }) { await authorize(); },
                    async recordFrame(_lease, frame, { authorize }) { await authorize(); stored = frame;
                        return { ...lease, ...frame, id: '1', duplicate: false }; } };
                const trial = { ...file, push: { ...file.push, agent: metadata.agent, client: metadata.client,
                    ...(metadata.connectVersion === '2' ? { connectVersion: '2' } : {}) } };
                if (metadata.connectVersion === '1') delete trial.push.connectVersion;
                try {
                    await withEdgeWnsCredentials(trial, async credentials => {
                        const transport = createEdgeWnsTransport({ timeoutMs: 15000 }); let session;
                        try {
                            session = createEdgeWnsSession({ ...credentials, transport, store, lease, authorize: async () => {},
                                saveRotatedToken: async token => { rotated = Buffer.from(token); } });
                            assert.equal((await session.start()).state, 'ready'); assert.ok(rotated?.length);
                            stage = 'SEND';
                            await webpush.sendNotification({ endpoint: captured.endpoint, keys: captured.keys }, JSON.stringify({ text: marker }), { TTL: 60, timeout: 15000 });
                            stage = 'RECEIVE';
                            const deadline = Date.now() + 30000; let received = false;
                            while (Date.now() < deadline && !received) received = (await session.next(Math.min(3000, Math.max(1, deadline - Date.now())))).state === 'persisted';
                            assert.ok(received && stored, 'synthetic notification was not persisted');
                            stage = 'DECRYPT';
                            const push = trial.push, keys = { public_key: [...Buffer.from(push.p256dhPublicKey, 'base64url')],
                                private_key: [...Buffer.from(push.p256dhPrivateKey.d, 'base64url')], auth_secret: [...Buffer.from(push.authenticationSecret, 'base64url')] };
                            try { assert.equal(decryptNotification(stored.data, stored.headers, keys)?.text, marker); }
                            finally { Object.values(keys).forEach(value => value.fill(0)); }
                        } finally { session?.close(); transport.close(); }
                    });
                    const value = rotated.toString('ascii');
                    file = { ...file, push: { ...file.push, reconnectToken: value } };
                } catch { throw new Error(`FIXTURE_${marker === 'cross-profile-control' ? 'CONTROL' : 'CROSS_PROFILE'}_${stage}_FAILED`); }
                finally { rotated?.fill(0); }
            }
            await receiveOne(b.response, 'cross-profile-control');
            await new Promise(resolve => setTimeout(resolve, 3000));
            await receiveOne(a.response, 'cross-profile-test');
            t.diagnostic('same-profile control and cross-profile WNS delivery passed');
        } finally {
            for (const value of [expected.publicKey, expected.auth, expected.applicationServerKey, rewritten]) value?.fill(0);
            if (selected) for (const name of ['channel', 'publicKey', 'auth', 'privateKey', 'applicationServerKey']) selected[name].fill(0);
            records.forEach(record => record.fill(0)); await db.close().catch(() => {});
        }
    });

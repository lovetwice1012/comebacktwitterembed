'use strict';
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
const { partitionStoreRecords, selectDeviceRecord } = require('../../src/automation/edge-wns-record');
const { buildEdgeTransferFromStore } = require('../../src/automation/edge-wns-snapshot');
const { selectSyntheticEdgeRecord, rewriteSyntheticOrigin } = require('../../experiments/chrome-push/edge-fixture-record.cjs');
const { withEdgeWnsCredentials } = require('../../src/automation/edge-wns-credentials');
const { createEdgeWnsTransport } = require('../../src/automation/edge-wns-transport');
const { createEdgeWnsSession } = require('../../src/automation/edge-wns-session');

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
            if (!groupGone && exited && child?.pid) groupGone = await waitForMacProcessGroupExit(child.pid);
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
        // Inspect only the disposable calibration profile after the child and
        // its process group have stopped. Never print keys or record values.
        groupGone = await waitForMacProcessGroupExit(child.pid);
        assert.equal(groupGone, true, 'calibration process group did not stop');
        const store = path.join(rootPath, 'profile', 'Default', 'EdgePushStorageWithConnectTokenAndKey');
        for (const entry of [path.join(rootPath, 'profile'), path.join(rootPath, 'profile', 'Default'), store]) {
            const info = await fs.lstat(entry);
            assert(info.isDirectory() && !info.isSymbolicLink()); assert.equal(await fs.realpath(entry), entry);
        }
        const db = new ClassicLevel(store, { createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer' });
        const records = [];
        try {
            await db.open();
            for await (const [key, value] of db.iterator({ limit: 129 })) {
                try {
                    assert(Buffer.isBuffer(key) && Buffer.isBuffer(value) && key.length <= 4096 && value.length <= 65536 && records.length < 128);
                    records.push(Buffer.from(value));
                } finally { key?.fill(0); value?.fill(0); }
            }
            const partition = partitionStoreRecords(records), device = selectDeviceRecord(partition.deviceRecord);
            try { assert.equal(device.deviceKey.length, 32); assert(device.reconnectToken.length > 0); }
            finally { device.deviceKey.fill(0); device.reconnectToken.fill(0); }
            assert(partition.siteRecords.length >= 1);
            const captured = result.subscription;
            assert(captured && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(captured.scope));
            const expected = { endpoint: captured.endpoint, publicKey: Buffer.from(captured.keys.p256dh, 'base64url'),
                auth: Buffer.from(captured.keys.auth, 'base64url'), applicationServerKey: Buffer.from(captured.applicationServerKey, 'base64url') };
            let selected, rewritten;
            try {
                selected = selectSyntheticEdgeRecord(partition.siteRecords, captured.scope);
                assert(selected.endpoint === expected.endpoint && selected.publicKey.equals(expected.publicKey)
                    && selected.auth.equals(expected.auth) && selected.applicationServerKey.equals(expected.applicationServerKey), 'synthetic browser subscription did not match its store');
                const matches = partition.siteRecords.filter(record => record.includes(Buffer.from(captured.scope)));
                assert.equal(matches.length, 1); rewritten = rewriteSyntheticOrigin(matches[0], captured.scope);
                // Adapt the local test origin in memory only; actual profile
                // files are never changed and no data is uploaded.
                const inputRecords = records.map(record => record === matches[0] ? rewritten : record);
                const output = await buildEdgeTransferFromStore({ records: inputRecords, expected, browserVersion: result.browserVersion,
                    agent: result.agent, client: result.client, ...(result.connectVersion === '2' ? { connectVersion: '2' } : {}) });
                assert.equal(output.file.push.scope, 'https://x.com/');
                assert.equal(output.file.push.connectVersion || '1', result.connectVersion);
                assert.equal(output.unclassifiedRecordCount, partition.unknownCount);
                assert.equal(output.otherNotificationsPossible, partition.unknownCount > 0 || output.otherSubscriptionCount > 0);
                const lease = { subscriptionId: '33333333-3333-4333-8333-333333333333', ownerUserId: '123456789', revision: 1 };
                let stored, rotated = false;
                const store = { async assertLease(_lease, { authorize }) { await authorize(); },
                    async recordFrame(_lease, frame, { authorize }) { await authorize(); stored = frame;
                        return { ...lease, ...frame, id: '1', duplicate: false }; } };
                await withEdgeWnsCredentials(output.file, async credentials => {
                    const transport = createEdgeWnsTransport({ timeoutMs: 15000 }); let session;
                    try {
                        session = createEdgeWnsSession({ ...credentials, transport, store, lease, authorize: async () => {},
                            saveRotatedToken: async token => { assert(token.length > 0); rotated = true; } });
                        assert.equal((await session.start()).state, 'ready'); assert.equal(rotated, true);
                        webpush.setVapidDetails('mailto:fixture@example.com', result.vapid.publicKey, result.vapid.privateKey);
                        await webpush.sendNotification({ endpoint: captured.endpoint, keys: captured.keys }, JSON.stringify({ text: 'mac-edge-synthetic' }), { TTL: 60, timeout: 15000 });
                        const deadline = Date.now() + 30000; let received = false;
                        while (Date.now() < deadline && !received) {
                            const event = await session.next(Math.min(3000, Math.max(1, deadline - Date.now())));
                            received = event.state === 'persisted';
                        }
                        assert(received && stored, 'synthetic push was not persisted');
                        const { decryptNotification } = await import(pathToFileURL(path.resolve(__dirname, '../../packages/angelic-angel/dist/crypto.js')).href);
                        const push = output.file.push, keys = { public_key: [...Buffer.from(push.p256dhPublicKey, 'base64url')],
                            private_key: [...Buffer.from(push.p256dhPrivateKey.d, 'base64url')], auth_secret: [...Buffer.from(push.authenticationSecret, 'base64url')] };
                        try { assert.equal(decryptNotification(stored.data, stored.headers, keys)?.text, 'mac-edge-synthetic'); }
                        finally { Object.values(keys).forEach(value => value.fill(0)); }
                    } finally { session?.close(); transport.close(); }
                });
                t.diagnostic('synthetic Mac Edge push received and decrypted through WNS; credentials omitted');
            } finally {
                for (const value of [expected.publicKey, expected.auth, expected.applicationServerKey, rewritten]) value?.fill(0);
                if (selected) for (const name of ['channel', 'publicKey', 'auth', 'privateKey', 'applicationServerKey']) selected[name].fill(0);
            }
            t.diagnostic(`synthetic store parsed: siteRecords=${partition.siteRecords.length} unknownRecords=${partition.unknownCount}`);
            t.diagnostic('synthetic browser subscription matched its store and the X-format converter');
        } finally { records.forEach(record => record.fill(0)); await db.close().catch(() => {}); }
    });

'use strict';
// Disposable hosted profiles and localhost Push only. No X or user profile.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { fork, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { ClassicLevel } = require('classic-level');
const webpush = require('web-push');
const { verifyInstalledEdge } = require('../../src/automation/edge-mac-broker');
const { startChromeBroker } = require('../../src/automation/edge-private-broker');
const { captureFromBroker } = require('../../src/automation/edge-broker-client');
const { waitForMacProcessGroupExit } = require('../../src/automation/chrome-mac-process-group');
const { partitionStoreRecords } = require('../../src/automation/edge-wns-record');
const { selectSyntheticEdgeRecord, rewriteSyntheticOrigin } = require('../../experiments/chrome-push/edge-fixture-record.cjs');
const { buildEdgeTransferFromStore } = require('../../src/automation/edge-wns-snapshot');
const { withEdgeWnsCredentials } = require('../../src/automation/edge-wns-credentials');
const { createEdgeWnsTransport } = require('../../src/automation/edge-wns-transport');
const { createEdgeWnsSession } = require('../../src/automation/edge-wns-session');
const { fixtureFailure, safeFixtureSend, sendCategory } = require('./edge-mac-suppression-errors.cjs');
const { withFixtureCdp } = require('./edge-mac-suppression-cdp.cjs');

test('synthetic Mac Edge suppression keeps an active WNS receiver in control',
    { skip: process.platform !== 'darwin' || process.env.CBTE_MAC_EDGE_HOSTED !== '1', timeout: 600000 }, async t => {
        assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
        const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-edge-suppress-'));
        const children = [], brokers = [], records = []; let server, session, transport, selected, rewritten, rotated;
        let calibrationStarted = false, calibrationClean = false, dbClosed = true, stage = 'SETUP';
        function track(child) {
            const item = { child, closed: false }; item.done = new Promise(resolve => { child.once('close', () => { item.closed = true; resolve(); }); child.once('error', resolve); });
            children.push(item); return child;
        }
        async function waitClosed(item) {
            let timer; const ok = item.closed || await Promise.race([item.done.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 20000); })]);
            clearTimeout(timer); return ok && item.child.pid && await waitForMacProcessGroupExit(item.child.pid);
        }
        t.after(async () => {
            try {
            let safe = (!calibrationStarted || calibrationClean) && dbClosed;
            try { session?.close(); } catch { safe = false; }
            try { transport?.close(); } catch { safe = false; }
            for (const broker of brokers) {
                let timer; const closed = await Promise.race([Promise.resolve().then(() => broker.stop()).then(() => true, () => false),
                    new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
                clearTimeout(timer); if (!closed) safe = false;
            }
            for (const item of children) if (!item.closed) try { item.child.kill('SIGTERM'); } catch {}
            for (const item of children) { try { if (!await waitClosed(item)) safe = false; } catch { safe = false; } }
            if (server) {
                try {
                    server.closeAllConnections();
                    if (server.listening) {
                        let timer; const closed = await Promise.race([new Promise(resolve => server.close(() => resolve(true))),
                            new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
                        clearTimeout(timer); if (!closed) safe = false;
                    }
                } catch { safe = false; }
            }
            try { for (const value of records) value.fill(0); rewritten?.fill(0); rotated?.fill(0);
                if (selected) for (const name of ['channel', 'publicKey', 'auth', 'privateKey', 'applicationServerKey']) selected[name].fill(0);
            } catch { safe = false; }
            assert.equal(safe, true, 'fixture retained because owned processes did not stop');
            const real = await fs.realpath(base); assert.ok(path.dirname(real) === temp && /^cbte-edge-suppress-/.test(path.basename(real)), 'fixture path changed');
            await fs.rm(real, { recursive: true });
            } catch { throw new Error('FIXTURE_SUPPRESSION_CLEANUP_FAILED'); }
        });
        try {
        const token = randomBytes(16).toString('hex'), root = path.join(base, `edge-calibration-${token}`), profile = path.join(root, 'profile');
        await fs.mkdir(root, { mode: 0o700 }); await fs.mkdir(profile, { mode: 0o700 });
        await fs.writeFile(path.join(root, 'owner.json'), JSON.stringify({ appId: 'x-notification-setup', kind: 'edge-calibration-v1', token }), { flag: 'wx', mode: 0o600 });
        const identityPath = process.env.MAC_EDGE_IDENTITY_HELPER, peerPath = process.env.MAC_EDGE_SOCKET_HELPER;
        assert.ok(path.isAbsolute(identityPath || '') && path.isAbsolute(peerPath || ''), 'fixture helpers unavailable');
        stage = 'CALIBRATION'; calibrationStarted = true;
        const child = track(fork(path.join(__dirname, 'edge-mac-suppression-child.cjs'), [], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
        const calibration = await new Promise((resolve, reject) => {
            let response, timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} reject(new Error('FIXTURE_CALIBRATION_TIMEOUT')); }, 420000);
            child.on('message', value => { if (!response) response = value; });
            child.once('error', () => { clearTimeout(timer); reject(new Error('FIXTURE_CALIBRATION_FAILED')); });
            child.once('exit', code => { clearTimeout(timer); if (code === 0 && response?.ok) resolve(response); else reject(new Error('FIXTURE_CALIBRATION_FAILED')); });
            child.send({ rootPath: root, token, identityPath, peerPath });
        });
        assert.ok(calibration.cleanupConfirmed === true && await waitClosed(children[0]), 'fixture calibration did not stop'); calibrationClean = true;
        const captured = calibration.subscription, origin = new URL(captured.scope);
        assert.ok(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && /^\/[\s]*$/.test(origin.pathname)
            && /^[1-9][0-9]{0,4}$/.test(origin.port), 'invalid fixture scope');
        stage = 'STORE'; const storePath = path.join(profile, 'Default', 'EdgePushStorageWithConnectTokenAndKey');
        for (const dir of [base, root, profile, path.join(profile, 'Default'), storePath]) {
            const stat = await fs.lstat(dir); assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && await fs.realpath(dir) === dir, 'fixture path invalid');
        }
        const db = new ClassicLevel(storePath, { createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer' });
        const expected = { endpoint: captured.endpoint, publicKey: Buffer.from(captured.keys.p256dh, 'base64url'),
            auth: Buffer.from(captured.keys.auth, 'base64url'), applicationServerKey: Buffer.from(captured.applicationServerKey, 'base64url') };
        let file;
        try {
            dbClosed = false; await db.open(); for await (const [key, value] of db.iterator({ limit: 129 })) {
                try { assert.ok(Buffer.isBuffer(key) && Buffer.isBuffer(value) && key.length <= 4096 && value.length <= 65536 && records.length < 128); records.push(Buffer.from(value)); }
                finally { key?.fill(0); value?.fill(0); }
            }
            const partition = partitionStoreRecords(records); selected = selectSyntheticEdgeRecord(partition.siteRecords, captured.scope);
            assert.ok(selected.endpoint === expected.endpoint && selected.publicKey.equals(expected.publicKey)
                && selected.auth.equals(expected.auth) && selected.applicationServerKey.equals(expected.applicationServerKey), 'fixture subscription mismatch');
            const matches = partition.siteRecords.filter(record => record.includes(Buffer.from(captured.scope))); assert.equal(matches.length, 1);
            rewritten = rewriteSyntheticOrigin(matches[0], captured.scope);
            const output = await buildEdgeTransferFromStore({ records: records.map(record => record === matches[0] ? rewritten : record), expected,
                browserVersion: calibration.browserVersion, agent: calibration.agent, client: calibration.client,
                ...(calibration.connectVersion === '2' ? { connectVersion: '2' } : {}) });
            file = output.file;
        } finally {
            try { await db.close(); dbClosed = true; } finally { for (const v of [expected.publicKey, expected.auth, expected.applicationServerKey]) v.fill(0); }
        }
        const markers = new Set(), observed = new Set(); let pushEvents = 0;
        server = http.createServer((request, response) => {
            if (request.url === '/push-event') pushEvents++;
            if (request.url?.startsWith('/delivered?tag=')) {
                try { const marker = decodeURIComponent(request.url.slice('/delivered?tag='.length)); if (markers.has(marker)) observed.add(marker); } catch {}
            }
            response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end('<!doctype html><title>Fixture</title>');
        });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(origin.port), '127.0.0.1', resolve); });
        const executable = await verifyInstalledEdge();
        async function launch(suppressReceive) {
            const broker = await startChromeBroker({ chromePath: executable, profilePath: profile, origin: origin.origin,
                browserMode: 'edge', includeApplicationServerKey: true, suppressReceive, extraArgs: ['--headless=new', '--no-proxy-server'],
                spawnChrome: (file, args, options) => track(spawn(file, args, { ...options, detached: true })) });
            brokers.push(broker); return broker;
        }
        async function stop(broker) {
            const item = children.find(entry => entry.child === broker.chrome);
            if (broker.chrome.exitCode === null && broker.chrome.signalCode === null) broker.chrome.kill('SIGTERM');
            assert.ok(item && await waitClosed(item), 'fixture browser did not stop'); await broker.stop();
        }
        webpush.setVapidDetails('mailto:fixture@example.com', calibration.vapid.publicKey, calibration.vapid.privateKey);
        stage = 'BASELINE_OPEN'; const baseline = await launch(false), control = `control-${randomBytes(16).toString('hex')}`; markers.add(control);
        stage = 'BASELINE_SW'; const ping = `ping-${randomBytes(16).toString('hex')}`; markers.add(ping);
        await withFixtureCdp(baseline.chrome, async call => {
            let target;
            for (let i = 0; i < 100 && !target; i++) {
                const values = await call('Target.getTargets');
                target = values.targetInfos?.find(item => { try { return item.type === 'page' && new URL(item.url).origin === origin.origin; } catch { return false; } });
                if (!target) await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (!target?.targetId) throw new Error('fixture target missing');
            const attached = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
            if (typeof attached.sessionId !== 'string') throw new Error('fixture target invalid');
            try {
                const expression = `(async()=>{const a=await navigator.serviceWorker.getRegistrations();const r=a.find(x=>x.scope===location.origin+'/');const s=await r?.pushManager.getSubscription();if(!r?.active||!s)return null;window.__cbteFixturePushCount=0;window.__cbteFixturePongCount=0;navigator.serviceWorker.addEventListener('message',e=>{if(e.data==='cbte-fixture-push')window.__cbteFixturePushCount++;if(e.data==='cbte-fixture-pong')window.__cbteFixturePongCount++});r.active.postMessage(${JSON.stringify(ping)});return s.toJSON()})()`;
                const value = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, attached.sessionId);
                const subscription = value.result?.value;
                assert.ok(subscription && subscription.endpoint === captured.endpoint && subscription.keys?.p256dh === captured.keys.p256dh
                    && subscription.keys?.auth === captured.keys.auth, 'fixture subscription not active');
            } finally { await call('Target.detachFromTarget', { sessionId: attached.sessionId }).catch(() => {}); }
        });
        async function fixtureCounts() {
            try {
                return await withFixtureCdp(baseline.chrome, async call => {
                    const values = await call('Target.getTargets');
                    const target = values.targetInfos?.find(item => { try { return item.type === 'page' && new URL(item.url).origin === origin.origin; } catch { return false; } });
                    if (!target?.targetId) return null;
                    const attached = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
                    if (typeof attached.sessionId !== 'string') return null;
                    try {
                        const response = await call('Runtime.evaluate', { expression: '({push:window.__cbteFixturePushCount,pong:window.__cbteFixturePongCount})', returnByValue: true }, attached.sessionId);
                        const value = response.result?.value;
                        return Number.isSafeInteger(value?.push) && value.push >= 0 && Number.isSafeInteger(value?.pong) && value.pong >= 0 ? value : null;
                    } finally { await call('Target.detachFromTarget', { sessionId: attached.sessionId }).catch(() => {}); }
                });
            } catch { return null; }
        }
        stage = 'BASELINE_SW_PING'; let pingDeadline = Date.now() + 10000, pingCounts = null;
        while (Date.now() < pingDeadline) {
            pingCounts = await fixtureCounts(); if (observed.has(ping) && pingCounts?.pong > 0) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(observed.has(ping) && pingCounts?.pong > 0, 'fixture worker round trip unavailable');
        stage = 'BASELINE_SEND';
        const baselineEventsBefore = pushEvents;
        const baselineSend = await safeFixtureSend(() => webpush.sendNotification({ endpoint: captured.endpoint, keys: captured.keys }, control, { TTL: 60, timeout: 15000 }));
        t.diagnostic(`synthetic baseline send=${baselineSend}`);
        stage = 'BASELINE_WAIT'; let deadline = Date.now() + 30000; while (!observed.has(control) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
        t.diagnostic(`synthetic baseline push-event=${pushEvents > baselineEventsBefore ? 'observed' : 'not_observed'}`);
        const counts = await fixtureCounts();
        const clientObservation = counts ? counts.push > 0 ? 'observed' : 'not_observed' : 'unavailable';
        t.diagnostic(`synthetic baseline push-client=${clientObservation}`);
        assert.equal(observed.has(control), true, 'fixture browser did not receive control');
        stage = 'BASELINE_STOP'; await stop(baseline);
        let stored; const lease = { subscriptionId: '33333333-3333-4333-8333-333333333333', ownerUserId: '123456789', revision: 1 };
        const store = { async assertLease(_lease, { authorize }) { await authorize(); }, async recordFrame(_lease, frame, { authorize }) {
            await authorize(); stored = frame; return { ...lease, ...frame, id: '1', duplicate: false }; } };
        await withEdgeWnsCredentials(file, async credentials => {
            stage = 'CONNECT';
            transport = createEdgeWnsTransport({ timeoutMs: 15000 });
            session = createEdgeWnsSession({ ...credentials, transport, store, lease, authorize: async () => {}, saveRotatedToken: async value => { rotated = Buffer.from(value); } });
            assert.equal((await session.start()).state, 'ready');
            stage = 'SUPPRESSED_OPEN'; const suppressed = await launch(true), marker = `trial-${randomBytes(16).toString('hex')}`, payload = JSON.stringify({ text: marker });
            stage = 'SEND'; const trialEventsBefore = pushEvents;
            markers.add(payload); const trialSend = await safeFixtureSend(() => webpush.sendNotification({ endpoint: captured.endpoint, keys: captured.keys }, payload, { TTL: 60, timeout: 15000 }));
            t.diagnostic(`synthetic trial send=${trialSend}`);
            stage = 'RECEIVE'; deadline = Date.now() + 30000; let received = false;
            while (Date.now() < deadline && !received) received = (await session.next(Math.min(3000, Math.max(1, deadline - Date.now())))).state === 'persisted';
            assert.ok(received && stored, 'fixture worker did not receive');
            stage = 'DECRYPT'; const { decryptNotification } = await import(pathToFileURL(path.resolve(__dirname, '../../packages/angelic-angel/dist/crypto.js')).href);
            const keys = { public_key: [...Buffer.from(file.push.p256dhPublicKey, 'base64url')], private_key: [...Buffer.from(file.push.p256dhPrivateKey.d, 'base64url')], auth_secret: [...Buffer.from(file.push.authenticationSecret, 'base64url')] };
            try { assert.ok(decryptNotification(stored.data, stored.headers, keys)?.text === marker, 'fixture plaintext mismatch'); }
            finally { Object.values(keys).forEach(value => value.fill(0)); }
            stage = 'OBSERVE'; await new Promise(resolve => setTimeout(resolve, 5000));
            assert.equal(observed.has(payload), false, 'fixture browser also received');
            assert.equal(pushEvents, trialEventsBefore, 'fixture browser push event observed');
            assert.ok(suppressed.chrome.exitCode === null && suppressed.chrome.signalCode === null, 'fixture browser did not remain running');
            assert.equal((await session.next(1000)).state, 'idle', 'fixture receiver did not remain ready');
            const again = await captureFromBroker({ port: suppressed.port, token: suppressed.token, includeApplicationServerKey: true });
            assert.ok(again.endpoint === captured.endpoint && again.keys?.p256dh === captured.keys.p256dh
                && again.keys?.auth === captured.keys.auth && again.applicationServerKey === captured.applicationServerKey, 'fixture subscription changed');
            await stop(suppressed);
        });
        rotated?.fill(0); t.diagnostic('synthetic Mac Edge control browser received; suppressed browser not observed over 5 seconds while WNS session received and decrypted');
        } catch (error) {
            if (stage === 'BASELINE_SEND' || stage === 'SEND') t.diagnostic(`synthetic send failure category=${sendCategory(error)}`);
            throw fixtureFailure(stage);
        }
    });

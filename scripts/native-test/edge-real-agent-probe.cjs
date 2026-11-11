'use strict';

// Explicit synthetic-only probe. Its parent must run it in a Windows Job so
// all browser children stop before the temporary profile is removed. It never
// reads a normal profile or prints protocol values, tokens or notifications.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { createWindowsEdgePeerVerifier } = require('../../src/automation/edge-windows-peer');
const { withMacEdgeEphemeralCertificate } = require('../../src/automation/edge-mac-ephemeral-certificate');
const { createEdgeWnsTransport } = require('../../src/automation/edge-wns-transport');
const { connectFrameForVersion } = require('../../src/automation/edge-wns-connect-version');
const { reply, createEdgeWnsSession } = require('../../src/automation/edge-wns-session');
const { deviceFrame, bindFrame, createNonce } = require('../../src/automation/edge-wns-protocol');
const { parseBindResponse } = require('../../src/automation/edge-wns-bind');
const { selectDeviceRecord } = require('../../src/automation/edge-wns-record');
const { ClassicLevel } = require('classic-level');

// Test only the unauthenticated CNT exchange on separate connections. No
// subscription or device credentials are sent; response contents are wiped.
async function probeConnectVersion(agent, version) {
    let transport, outgoing, incoming;
    try {
        outgoing = connectFrameForVersion(agent, 1, version);
        transport = createEdgeWnsTransport({ timeoutMs: 10000 });
        await transport.connect(); await transport.send(outgoing); incoming = await transport.next(10000);
        reply(incoming, 'CNT', 1, 'CON');
        return { version, status: 'accepted' };
    } catch (error) {
        const allowed = new Set(['X_EDGE_WNS_CONNECT_TIMEOUT', 'X_EDGE_WNS_CONNECT_FAILED', 'X_EDGE_WNS_SOCKET_FAILED',
            'X_EDGE_WNS_SOCKET_CLOSED', 'X_EDGE_WNS_RECEIVE_TIMEOUT', 'X_EDGE_WNS_REPLY_INVALID', 'X_EDGE_WNS_FRAME_INVALID']);
        return { version, status: allowed.has(error?.code) ? error.code : 'PROBE_EXCHANGE_FAILED' };
    } finally { outgoing?.fill(0); incoming?.fill(0); transport?.close(); }
}

async function readSyntheticDevice(rootPath) {
    let current = rootPath;
    for (const part of ['profile', 'Default', 'EdgePushStorageWithConnectTokenAndKey']) {
        current = path.join(current, part); const stat = await fs.lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(current)).toLowerCase() !== current.toLowerCase())
            throw new Error('PROBE_STORE_INVALID');
    }
    const store = new ClassicLevel(current, { createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer' });
    let selected, count = 0;
    try {
        await store.open();
        for await (const [key, value] of store.iterator({ limit: 129 })) {
            try {
                if (++count > 128 || !Buffer.isBuffer(value) || value.length > 65536) throw new Error('PROBE_STORE_INVALID');
                let candidate;
                try { candidate = selectDeviceRecord(value); } catch { /* A synthetic non-device record. */ }
                if (candidate) {
                    if (selected) { candidate.deviceKey.fill(0); candidate.reconnectToken.fill(0); throw new Error('PROBE_STORE_AMBIGUOUS'); }
                    selected = candidate;
                }
            } finally { key?.fill(0); value?.fill(0); }
        }
        if (!selected) throw new Error('PROBE_DEVICE_MISSING');
        return selected;
    } catch (error) { selected?.deviceKey.fill(0); selected?.reconnectToken.fill(0); throw error; }
    finally { await store.close().catch(() => {}); }
}

// Uses credentials from the probe's own temporary synthetic browser profile.
// It performs CNT, ATH and BND only; no notifications are requested or read.
async function probeAuthenticatedVersion(rootPath, metadata, version, reconnect) {
    let device, first, second, stage = 'device';
    try {
        device = await readSyntheticDevice(rootPath);
        async function handshake(token, phase) {
            let transport, frame, incoming;
            try {
                transport = createEdgeWnsTransport({ timeoutMs: 10000 }); await transport.connect();
                stage = `${phase}-connect`; frame = connectFrameForVersion(metadata.agent, 1, version);
                await transport.send(frame); frame.fill(0); frame = null;
                incoming = await transport.next(10000); reply(incoming, 'CNT', 1, 'CON'); incoming.fill(0); incoming = null;
                stage = `${phase}-device-auth`; frame = deviceFrame(2); await transport.send(frame); frame.fill(0); frame = null;
                incoming = await transport.next(10000); reply(incoming, 'ATH', 2, 'CON', { emptyBody: true }); incoming.fill(0); incoming = null;
                stage = `${phase}-bind`; frame = bindFrame({ ...metadata.client, nonce: createNonce(), reconnectToken: token, deviceKey: device.deviceKey }, 3);
                await transport.send(frame); frame.fill(0); frame = null; incoming = await transport.next(10000);
                reply(incoming, 'BND', 3, 'CON'); return parseBindResponse(incoming, 3);
            } finally { frame?.fill(0); incoming?.fill(0); transport?.close(); }
        }
        first = await handshake(device.reconnectToken, 'initial');
        if (!reconnect) return { version, status: 'bound' };
        // Use only the freshly returned synthetic token, never the stale one.
        await new Promise(resolve => setTimeout(resolve, 100));
        second = await handshake(first.reconnectToken, 'reconnect');
        return { version, status: 'reconnected' };
    } catch (error) {
        const allowed = new Set(['X_EDGE_WNS_CONNECT_TIMEOUT', 'X_EDGE_WNS_CONNECT_FAILED', 'X_EDGE_WNS_SOCKET_FAILED',
            'X_EDGE_WNS_SOCKET_CLOSED', 'X_EDGE_WNS_RECEIVE_TIMEOUT', 'X_EDGE_WNS_REPLY_INVALID', 'X_EDGE_WNS_FRAME_INVALID', 'X_EDGE_WNS_BIND_INVALID']);
        return { version, status: allowed.has(error?.code) ? error.code : 'PROBE_AUTH_FAILED', stage };
    } finally {
        first?.reconnectToken.fill(0); second?.reconnectToken.fill(0);
        device?.deviceKey.fill(0); device?.reconnectToken.fill(0);
    }
}

// Exercise the actual receiver session's selected handshake and token-save
// callback twice. The store is deliberately unable to process notifications.
async function probeReceiverSession(rootPath, metadata, connectVersion) {
    let device, first, second, stage = 'device'; const rotated = [], siteChannel = Buffer.from('synthetic-only-channel');
    try {
        device = await readSyntheticDevice(rootPath);
        const config = token => ({ transport: createEdgeWnsTransport({ timeoutMs: 10000 }),
            store: { async recordFrame() { throw new Error('notification handling forbidden'); },
                async assertLease() { throw new Error('notification handling forbidden'); } },
            lease: Object.freeze({}), siteChannel, authorize: async () => true,
            saveRotatedToken: async value => { rotated.push(Buffer.from(value)); }, agent: metadata.agent, client: metadata.client,
            deviceKey: device.deviceKey, reconnectToken: token, authenticationMode: 'bound', connectVersion });
        stage = 'first-start'; first = createEdgeWnsSession(config(device.reconnectToken));
        if ((await first.start()).state !== 'ready' || rotated.length !== 1) throw new Error('PROBE_SESSION_INVALID');
        first.close(); first = null;
        await new Promise(resolve => setTimeout(resolve, 100));
        stage = 'second-start'; second = createEdgeWnsSession(config(rotated[0]));
        if ((await second.start()).state !== 'ready' || rotated.length !== 2) throw new Error('PROBE_SESSION_INVALID');
        return { status: 'resumed' };
    } catch (error) {
        const allowed = new Set(['X_EDGE_WNS_CONNECT_TIMEOUT', 'X_EDGE_WNS_CONNECT_FAILED', 'X_EDGE_WNS_SOCKET_FAILED',
            'X_EDGE_WNS_SOCKET_CLOSED', 'X_EDGE_WNS_RECEIVE_TIMEOUT', 'X_EDGE_WNS_REPLY_INVALID', 'X_EDGE_WNS_FRAME_INVALID', 'X_EDGE_WNS_BIND_INVALID']);
        return { status: allowed.has(error?.code) ? error.code : 'PROBE_SESSION_FAILED', stage };
    } finally {
        first?.close(); second?.close(); siteChannel.fill(0); for (const token of rotated) token.fill(0);
        device?.deviceKey.fill(0); device?.reconnectToken.fill(0);
    }
}

async function main() {
    if (process.platform !== 'win32' || process.env.CBTE_EDGE_AGENT_PROBE !== '1') throw new Error('PROBE_UNAVAILABLE');
    const base = process.env.CBTE_EDGE_PROBE_BASE, parent = await fs.realpath(os.tmpdir());
    if (typeof base !== 'string' || !path.isAbsolute(base) || path.dirname(base).toLowerCase() !== parent.toLowerCase()
        || !/^cbte-edge-agent-probe-[0-9a-f]{32}$/.test(path.basename(base)) || (await fs.realpath(base)).toLowerCase() !== base.toLowerCase())
        throw new Error('PROBE_ROOT_INVALID');
    const info = await fs.lstat(base); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('PROBE_ROOT_INVALID');
    const token = randomBytes(16).toString('hex'), rootPath = path.join(base, `edge-calibration-${token}`);
    await fs.mkdir(rootPath); await fs.mkdir(path.join(rootPath, 'profile'));
    await fs.writeFile(path.join(rootPath, 'owner.json'), JSON.stringify({ appId: 'x-notification-setup', kind: 'edge-calibration-v1', token }), { flag: 'wx' });
    const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const peer = createWindowsEdgePeerVerifier({ powershellPath: path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        helperPath: path.resolve(__dirname, '../../client/angelic-setup/EdgePeerVerify.ps1') });
    if (!await peer.verifyExecutable(edgePath)) throw new Error('PROBE_BROWSER_INVALID');
    // Override only this dedicated probe process; shipped Windows calibration
    // retains its existing return format and does not capture agent fields.
    const parserId = require.resolve('../../src/automation/edge-wns-agent-metadata'), parser = require(parserId); let diagnostic;
    require.cache[parserId].exports = { parseEdgeAgentMetadata(frame) {
        try { return parser.parseEdgeAgentMetadata(frame); }
        catch (error) {
            const offset = frame.indexOf('\r\n\r\n');
            const body = offset < 0 ? Buffer.alloc(0) : frame.subarray(offset + 4);
            const allowed = new Set(['connect', 'ver', 'agent', 'os', 'osVer', 'proc', 'lcid']);
            const tags = [...body.toString('ascii').matchAll(/<\/?([A-Za-z][A-Za-z0-9]*)\b[^>]*>/g)]
                .slice(0, 32).map(match => `${match[0][1] === '/' ? '/' : ''}${allowed.has(match[1]) ? match[1] : 'other'}`);
            const text = body.toString('ascii'), versionMatch = /<connect>\s*<ver>([^<]{1,16})<\/ver>/.exec(text);
            const version = versionMatch && /^[0-9.]+$/.test(versionMatch[1]) ? versionMatch[1] : 'other';
            diagnostic = { bodyBytes: body.length, tags, version, hasWhitespace: /[\r\n\t]/.test(text) }; throw error;
        }
    } };
    const relayId = require.resolve('../../src/automation/edge-calibration-relay'), relay = require(relayId);
    require.cache[relayId].exports = { ...relay, createEdgeCalibrationRelay: options => relay.createEdgeCalibrationRelay({ ...options, captureAgent: true }) };
    const { runEdgeCalibration } = require('../../src/automation/edge-calibration-runner');
    try {
        const result = await withMacEdgeEphemeralCertificate(material => runEdgeCalibration({ rootPath, token, edgePath, ...material,
            captureIdentity: peer.captureIdentity, authorizePeer: peer.authorizePeer, timeoutMs: 60000 }));
        if (!result.client?.agent || !result.client?.client || !['1', '2'].includes(result.client.connectVersion)) throw new Error('PROBE_METADATA_INVALID');
        const connections = process.env.CBTE_EDGE_PROBE_CONNECT_VERSIONS === '1'
            ? [await probeConnectVersion(result.client.agent, '1'), await probeConnectVersion(result.client.agent, '2')] : undefined;
        const requestedAuth = process.env.CBTE_EDGE_PROBE_AUTH_VERSION;
        if (['1', '2'].includes(requestedAuth) && process.env.CBTE_EDGE_PROBE_RECEIVER_SESSION === '1') throw new Error('PROBE_MODE_CONFLICT');
        const authentication = ['1', '2'].includes(requestedAuth)
            ? await probeAuthenticatedVersion(rootPath, result.client, requestedAuth, process.env.CBTE_EDGE_PROBE_RECONNECT === '1') : undefined;
        const receiverVersion = process.env.CBTE_EDGE_PROBE_RECEIVER_VERSION || '1';
        if (!['1', '2'].includes(receiverVersion)) throw new Error('PROBE_VERSION_INVALID');
        const receiverSession = process.env.CBTE_EDGE_PROBE_RECEIVER_SESSION === '1'
            ? await probeReceiverSession(rootPath, result.client, receiverVersion) : undefined;
        return { ok: true, agentFormatRecognized: true, connectVersion: result.client.connectVersion,
            ...(connections ? { connections } : {}), ...(authentication ? { authentication } : {}), ...(receiverSession ? { receiverSession } : {}) };
    } catch (error) {
        return { ok: false, code: /^X_EDGE_CALIBRATION_[A-Z_]+$/.test(error?.code || '') ? error.code : 'PROBE_FAILED',
            ...(diagnostic ? { diagnostic } : {}) };
    }
}
main().then(result => process.stdout.write(JSON.stringify(result)), () => process.stdout.write('{"ok":false,"code":"PROBE_FAILED"}'));

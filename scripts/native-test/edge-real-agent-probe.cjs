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
const { connectFrame } = require('../../src/automation/edge-wns-protocol');
const { reply } = require('../../src/automation/edge-wns-session');

// Test only the unauthenticated CNT exchange on separate connections. No
// subscription or device credentials are sent; response contents are wiped.
async function probeConnectVersion(agent, version) {
    let transport, outgoing, incoming;
    try {
        outgoing = connectFrame(agent, 1);
        const needle = Buffer.from('<connect><ver>1</ver>'), index = outgoing.indexOf(needle);
        if (index < 0 || outgoing.indexOf(needle, index + 1) !== -1) throw new Error('PROBE_FRAME_INVALID');
        if (version === '2') outgoing[index + Buffer.byteLength('<connect><ver>')] = '2'.charCodeAt(0);
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
        return { ok: true, agentFormatRecognized: true, connectVersion: result.client.connectVersion,
            ...(connections ? { connections } : {}) };
    } catch (error) {
        return { ok: false, code: /^X_EDGE_CALIBRATION_[A-Z_]+$/.test(error?.code || '') ? error.code : 'PROBE_FAILED',
            ...(diagnostic ? { diagnostic } : {}) };
    }
}
main().then(result => process.stdout.write(JSON.stringify(result)), () => process.stdout.write('{"ok":false,"code":"PROBE_FAILED"}'));

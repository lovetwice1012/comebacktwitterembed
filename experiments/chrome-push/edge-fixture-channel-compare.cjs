'use strict';
// Compare only keyed fingerprints from independently generated profiles.
// Neither the identifier nor fingerprint is printed or saved.
const { fork } = require('node:child_process');
const { randomBytes, createHmac } = require('node:crypto');
const path = require('node:path');
async function sample(salt) {
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('EDGE_PROBE_')) delete env[name];
    Object.assign(env, { EDGE_PROBE_SYSTEM_DEFAULT: '1', EDGE_PROBE_RECONNECT: '1', EDGE_PROBE_COMPARE_CHANNEL: '1', EDGE_PROBE_COMPARE_SALT: salt });
    const child = fork(path.join(__dirname, 'edge-wns-proxy-probe.cjs'), [], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let result, diagnostic = '';
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4096); });
    try {
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { child.kill(); reject(new Error('PROBE_COMPARE_TIMEOUT')); }, 90000);
            child.once('message', value => { result = value; });
            child.once('error', () => { clearTimeout(timer); reject(new Error('PROBE_COMPARE_FAILED')); });
            child.once('close', code => {
                clearTimeout(timer);
                if (code === 0 && /^[0-9a-f]{64}$/.test(result?.channelFingerprint || '') && /^[0-9a-f]{64}$/.test(result?.protocolFingerprint || '')) resolve(result);
                else reject(new Error(diagnostic.match(/\bPROBE_(?!STAGE)[A-Z_]+\b/)?.[0] || 'PROBE_COMPARE_FAILED'));
            });
        });
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
}
async function verifyDerived(channel, protocolVersion) {
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('EDGE_PROBE_')) delete env[name];
    Object.assign(env, { EDGE_PROBE_SYSTEM_DEFAULT: '1', EDGE_PROBE_RECONNECT: '1', EDGE_PROBE_COPY_PROFILE: '1', EDGE_PROBE_MINIMAL_PROFILE: '1',
        EDGE_PROBE_OMIT_COMPONENT: 'local-state,preferences', EDGE_PROBE_INDEPENDENT_RECONNECT: '1', EDGE_PROBE_GENERATED_HANDSHAKE: '1',
        EDGE_PROBE_SYNTHETIC_CHANNEL: channel, EDGE_PROBE_SYNTHETIC_PROTOCOL: protocolVersion, EDGE_PROBE_REPORT_DIRECT_IPC: '1' });
    if (process.env.EDGE_PROBE_VALIDATE_ACK === '1') env.EDGE_PROBE_ACK_FOLLOWUP = '1';
    if (process.env.EDGE_PROBE_VALIDATE_ROTATION === '1') env.EDGE_PROBE_ROTATION = '1';
    if (process.env.EDGE_PROBE_VALIDATE_STALE === '1') { env.EDGE_PROBE_ROTATION = '1'; env.EDGE_PROBE_USE_STALE_TOKEN = '1'; }
    if (process.env.EDGE_PROBE_VALIDATE_OFFLINE === '1') { env.EDGE_PROBE_ROTATION = '1'; env.EDGE_PROBE_OFFLINE = '1'; }
    const child = fork(path.join(__dirname, 'edge-wns-proxy-probe.cjs'), [], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let result, diagnostic = '';
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4096); });
    try {
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { child.kill(); reject(new Error('PROBE_COMPARE_TIMEOUT')); }, 90000);
            child.once('message', value => { result = value; });
            child.once('error', () => { clearTimeout(timer); reject(new Error('PROBE_COMPARE_FAILED')); });
            child.once('close', code => {
                clearTimeout(timer);
                if (code === 0 && result?.independentResult) resolve(result.independentResult);
                else reject(new Error(diagnostic.match(/\bPROBE_(?!STAGE)[A-Z_]+\b/)?.[0] || 'PROBE_COMPARE_FAILED'));
            });
        });
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
}
async function main() {
    const salt = randomBytes(32), fingerprints = [];
    try {
        const encoded = salt.toString('hex');
        for (let i = 0; i < 3; i++) fingerprints.push(await sample(encoded));
        const distinct = new Set(fingerprints.map(value => value.channelFingerprint)).size;
        const protocolDistinct = new Set(fingerprints.map(value => value.protocolFingerprint)).size;
        let directResult = null;
        if (process.env.EDGE_PROBE_VALIDATE_DERIVED === '1' && distinct === 1 && protocolDistinct === 1) {
            // The observed synthetic identifier is exactly three decimal digits.
            // Recover it only in memory to test a fourth isolated profile.
            let channel;
            for (let value = 100; value <= 999; value++) {
                const candidate = String(value), digest = createHmac('sha256', salt).update(candidate, 'ascii').digest('hex');
                if (digest === fingerprints[0].channelFingerprint) { channel = candidate; break; }
            }
            if (!channel) throw new Error('PROBE_COMPARE_FAILED');
            let protocolVersion;
            for (let major = 0; major <= 9; major++) for (let minor = 0; minor <= 9; minor++) {
                const candidate = `${major}.${minor}`;
                if (createHmac('sha256', salt).update(`protocol:${candidate}`, 'ascii').digest('hex') === fingerprints[0].protocolFingerprint)
                    protocolVersion = candidate;
            }
            if (!protocolVersion) throw new Error('PROBE_COMPARE_FAILED');
            directResult = await verifyDerived(channel, protocolVersion);
        }
        console.log(JSON.stringify({ syntheticProfiles: fingerprints.length, distinctIdentifiers: distinct,
            identicalAcrossProfiles: distinct === 1, protocolVersionsIdentical: protocolDistinct === 1, generatedFramesWithoutCapturedMetadata: directResult === null ? null
                : Boolean(directResult.notificationReceived && directResult.matchesSentCiphertext && directResult.payloadDecrypted),
            reconnectTokenUnchanged: directResult?.reconnectTokenUnchanged ?? null,
            ackWritten: directResult?.ackWritten ?? null, followupReceived: directResult?.followupReceived ?? null,
            followupMatches: directResult?.followupMatches ?? null, followupDecrypted: directResult?.followupDecrypted ?? null,
            rotation: directResult?.rotation ?? null }));
    } finally { salt.fill(0); fingerprints.length = 0; }
}
main().catch(error => { console.error(/^PROBE_[A-Z_]+$/.test(error?.message || '') ? error.message : 'PROBE_COMPARE_FAILED'); process.exitCode = 1; });

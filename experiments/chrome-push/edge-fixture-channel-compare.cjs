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
async function verifyDerived(channel, protocolVersion, { acknowledgeBeforeClose = false } = {}) {
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('EDGE_PROBE_')) delete env[name];
    Object.assign(env, { EDGE_PROBE_SYSTEM_DEFAULT: '1', EDGE_PROBE_RECONNECT: '1', EDGE_PROBE_COPY_PROFILE: '1', EDGE_PROBE_MINIMAL_PROFILE: '1',
        EDGE_PROBE_OMIT_COMPONENT: 'local-state,preferences', EDGE_PROBE_INDEPENDENT_RECONNECT: '1', EDGE_PROBE_GENERATED_HANDSHAKE: '1',
        EDGE_PROBE_SYNTHETIC_CHANNEL: channel, EDGE_PROBE_SYNTHETIC_PROTOCOL: protocolVersion, EDGE_PROBE_REPORT_DIRECT_IPC: '1' });
    if (process.env.EDGE_PROBE_VALIDATE_SKIP_CHALLENGE === '1') {
        if (process.env.NODE_ENV !== 'test') throw new Error('PROBE_MODE_INVALID');
        env.EDGE_PROBE_SKIP_CHALLENGE = '1';
    }
    if (process.env.EDGE_PROBE_VALIDATE_NO_RELAY === '1') {
        if (process.env.NODE_ENV !== 'test' || process.env.EDGE_PROBE_VALIDATE_SKIP_CHALLENGE !== '1') throw new Error('PROBE_MODE_INVALID');
        env.EDGE_PROBE_NO_RELAY = '1';
    }
    if (process.env.EDGE_PROBE_VALIDATE_ACK === '1') env.EDGE_PROBE_ACK_FOLLOWUP = '1';
    if (process.env.EDGE_PROBE_VALIDATE_ROTATION === '1') env.EDGE_PROBE_ROTATION = '1';
    if (process.env.EDGE_PROBE_VALIDATE_STALE === '1') { env.EDGE_PROBE_ROTATION = '1'; env.EDGE_PROBE_USE_STALE_TOKEN = '1'; }
    if (process.env.EDGE_PROBE_VALIDATE_OFFLINE === '1') { env.EDGE_PROBE_ROTATION = '1'; env.EDGE_PROBE_OFFLINE = '1'; }
    if (acknowledgeBeforeClose) {
        if (process.env.EDGE_PROBE_VALIDATE_OFFLINE !== '1') throw new Error('PROBE_MODE_INVALID');
        env.EDGE_PROBE_OFFLINE_ACK = '1';
    }
    if (process.env.EDGE_PROBE_VALIDATE_OBSERVE_MS !== undefined) env.EDGE_PROBE_OBSERVE_MS = process.env.EDGE_PROBE_VALIDATE_OBSERVE_MS;
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
                if (code === 0 && result?.independentResult && (process.env.EDGE_PROBE_VALIDATE_NO_RELAY !== '1' || result.noRelayVerified === true))
                    resolve({ ...result.independentResult, noRelayVerified: result.noRelayVerified === true });
                else reject(new Error(diagnostic.match(/\bPROBE_(?!STAGE)[A-Z_]+\b/)?.[0] || 'PROBE_COMPARE_FAILED'));
            });
        });
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
}
async function verifyPipeline(channel, protocolVersion) {
    if (process.env.NODE_ENV !== 'test' || Number(process.env.AUTOMATION_TEST_DB_PORT) !== 33621) throw new Error('PROBE_MODE_INVALID');
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('EDGE_PROBE_')) delete env[name];
    Object.assign(env, { EDGE_PROBE_REAL_WNS: '1', EDGE_PROBE_DATABASE: '1', EDGE_PROBE_SYNTHETIC_CHANNEL: channel, EDGE_PROBE_SYNTHETIC_PROTOCOL: protocolVersion });
    const child = fork(path.join(__dirname, 'edge-broker-pipe-probe.cjs'), [], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let result, diagnostic = '';
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4096); });
    try {
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { child.kill(); reject(new Error('PROBE_COMPARE_TIMEOUT')); }, 90000);
            child.once('message', value => { result = value; });
            child.once('error', () => { clearTimeout(timer); reject(new Error('PROBE_COMPARE_FAILED')); });
            child.once('close', code => {
                clearTimeout(timer);
                if (code === 0 && result?.realWnsWorkerTested === true && result?.databaseRecovery === true) resolve(true);
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
        let directResult = null, binaryMatches = null, pipelineVerified = null, acknowledgedResult = null;
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
            if (process.env.EDGE_PROBE_SCAN_CHANNEL === '1') {
                if (process.env.NODE_ENV !== 'test') throw new Error('PROBE_MODE_INVALID');
                const fs = require('node:fs/promises');
                const dll = await fs.readFile('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\157.0.4341.42\\msedge.dll');
                try {
                    const count = candidate => { let cursor = 0, total = 0; while ((cursor = dll.indexOf(candidate, cursor)) >= 0) { total++; cursor += candidate.length; } return total; };
                    binaryMatches = { ascii: count(Buffer.from(channel, 'ascii')), utf16: count(Buffer.from(channel, 'utf16le')) };
                    const needle = Buffer.from(channel, 'utf16le'), contexts = [];
                    for (let offset = 0; (offset = dll.indexOf(needle, offset)) >= 0; offset += needle.length) {
                        const window = dll.subarray(Math.max(0, offset - 2048), Math.min(dll.length, offset + 2048));
                        const words = ['wns', 'push', 'channel', 'client', 'protocol', 'notification'];
                        contexts.push(words.filter(word => window.includes(Buffer.from(word, 'ascii')) || window.includes(Buffer.from(word, 'utf16le'))));
                    }
                    binaryMatches.nearbyWords = contexts;
                } finally { dll.fill(0); }
            }
            directResult = await verifyDerived(channel, protocolVersion);
            if (process.env.EDGE_PROBE_VALIDATE_REPLAY_PAIR === '1') acknowledgedResult = await verifyDerived(channel, protocolVersion, { acknowledgeBeforeClose: true });
            if (process.env.EDGE_PROBE_VALIDATE_PIPELINE === '1') pipelineVerified = await verifyPipeline(channel, protocolVersion);
        }
        console.log(JSON.stringify({ syntheticProfiles: fingerprints.length, distinctIdentifiers: distinct,
            identicalAcrossProfiles: distinct === 1, protocolVersionsIdentical: protocolDistinct === 1, generatedFramesWithoutCapturedMetadata: directResult === null ? null
                : Boolean(directResult.notificationReceived && directResult.matchesSentCiphertext && directResult.payloadDecrypted),
            reconnectTokenUnchanged: directResult?.reconnectTokenUnchanged ?? null,
            noRelayVerified: directResult?.noRelayVerified ?? null, binaryMatches, pipelineVerified,
            acknowledgedBeforeClose: acknowledgedResult === null ? null : { ackWritten: acknowledgedResult.ackWritten === true,
                rotation: acknowledgedResult.rotation ?? null },
            ackWritten: directResult?.ackWritten ?? null, followupReceived: directResult?.followupReceived ?? null,
            followupMatches: directResult?.followupMatches ?? null, followupDecrypted: directResult?.followupDecrypted ?? null,
            rotation: directResult?.rotation ?? null }));
    } finally { salt.fill(0); fingerprints.length = 0; }
}
main().catch(error => { console.error(/^PROBE_[A-Z_]+$/.test(error?.message || '') ? error.message : 'PROBE_COMPARE_FAILED'); process.exitCode = 1; });

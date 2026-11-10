'use strict';
// Direct WNS interoperability probe for freshly generated test credentials.
// This is not a production receiver and never logs or persists its input.
const tls = require('node:tls');
const { randomInt } = require('node:crypto');
const { rewriteSyntheticBind } = require('./edge-fixture-rewrite.cjs');
const { firstFixtureNotification } = require('./edge-wns-fixture-framing.cjs');
const { rewriteSyntheticChallenge } = require('./edge-fixture-challenge.cjs');
const fail = code => Object.assign(new Error(code), { code });

function selectSyntheticHandshake(chunks) {
    if (!Array.isArray(chunks) || chunks.length > 4096) throw fail('PROBE_FRAMES_INVALID');
    let length = 0;
    for (const chunk of chunks) if (!Buffer.isBuffer(chunk) || (length += chunk.length) > 262144) throw fail('PROBE_FRAMES_INVALID');
    const data = Buffer.concat(chunks), selected = {}; let offset = 0;
    try {
        while (offset < data.length) {
            const end = data.indexOf('\r\n', offset); if (end < offset || end - offset > 512) throw fail('PROBE_FRAMES_INVALID');
            const header = data.subarray(offset, end);
            if (!header.length || header.some(byte => byte < 0x20 || byte > 0x7e)) throw fail('PROBE_FRAMES_INVALID');
            const parts = header.toString('ascii').split(' '), size = parts.at(-1);
            if (!/^\d{1,6}$/.test(size)) throw fail('PROBE_FRAMES_INVALID');
            const finish = end + 2 + Number(size); if (finish > data.length) throw fail('PROBE_FRAMES_INVALID');
            const kind = parts[0] === 'CNT' && parts[2] === 'CON' ? 'cnt'
                : parts[0] === 'ATH' && parts[2] === 'CON\\DEVICE' ? 'ath'
                    : parts[0] === 'BND' && parts[2] === 'CON\\WNS' ? 'bnd'
                        : parts[0] === 'PUT' && parts[2] === 'WNS\\CHALLENGE' ? 'challenge' : null;
            if (kind) { if (selected[kind]) throw fail('PROBE_FRAMES_INVALID'); selected[kind] = Buffer.from(data.subarray(offset, finish)); }
            offset = finish;
        }
        if (!selected.cnt || !selected.ath || !selected.bnd) throw fail('PROBE_FRAMES_INVALID');
        return selected;
    } catch (error) { for (const frame of Object.values(selected)) frame.fill(0); throw error; }
    finally { data.fill(0); }
}

async function independentSyntheticReconnect({ frames, key, token, connect = () => tls.connect({ host: 'client.wns.windows.com', port: 443,
    servername: 'client.wns.windows.com', rejectUnauthorized: true }), timeoutMs = 15000, sendNotification, decryptNotification, productConstants }) {
    if (!frames || !Buffer.isBuffer(key) || key.length !== 32 || typeof token !== 'string' || typeof connect !== 'function'
        || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw fail('PROBE_DIRECT_CONFIG_INVALID');
    const nonce = String(randomInt(1, 10)) + Array.from({ length: 31 }, () => String(randomInt(0, 10))).join('');
    const bind = rewriteSyntheticBind(frames.bnd, key, token, nonce), socket = connect();
    let pending = Buffer.alloc(0), waiting = null, failure = null; const queue = [];
    const abort = code => { if (failure) return; failure = fail(code); if (waiting) { const w = waiting; waiting = null; clearTimeout(w.timer); w.reject(failure); } };
    socket.on('error', () => abort('PROBE_DIRECT_SOCKET_FAILED'));
    socket.on('close', () => abort('PROBE_DIRECT_SOCKET_CLOSED'));
    socket.on('data', chunk => {
        try {
            if (!Buffer.isBuffer(chunk) || pending.length + chunk.length > 262144) throw fail('PROBE_DIRECT_FRAME_INVALID');
            pending = Buffer.concat([pending, chunk]);
            while (pending.length) {
                const end = pending.indexOf('\r\n'); if (end < 0) { if (pending.length > 512) throw fail('PROBE_DIRECT_FRAME_INVALID'); break; }
                if (end > 512 || pending.subarray(0, end).some(byte => byte < 0x20 || byte > 0x7e)) throw fail('PROBE_DIRECT_FRAME_INVALID');
                const parts = pending.subarray(0, end).toString('ascii').split(' '), size = parts.at(-1);
                if (!/^\d{1,6}$/.test(size)) throw fail('PROBE_DIRECT_FRAME_INVALID');
                const finish = end + 2 + Number(size); if (finish > 262144) throw fail('PROBE_DIRECT_FRAME_INVALID');
                if (pending.length < finish) break;
                const frame = Buffer.from(pending.subarray(0, finish)); pending = Buffer.from(pending.subarray(finish));
                if (queue.length >= 16) { frame.fill(0); throw fail('PROBE_DIRECT_FRAME_INVALID'); }
                queue.push(frame);
                if (waiting) { const w = waiting; waiting = null; clearTimeout(w.timer); w.resolve(queue.shift()); }
            }
        } catch { abort('PROBE_DIRECT_FRAME_INVALID'); socket.destroy(); }
    });
    function next() {
        if (failure) return Promise.reject(failure);
        if (queue.length) return Promise.resolve(queue.shift());
        return new Promise((resolve, reject) => { const timer = setTimeout(() => { waiting = null; reject(fail('PROBE_DIRECT_TIMEOUT')); }, timeoutMs); waiting = { resolve, reject, timer }; });
    }
    async function exchange(frame, verb, destination = 'CON') {
        await new Promise((resolve, reject) => socket.write(frame, error => error ? reject(fail('PROBE_DIRECT_WRITE_FAILED')) : resolve()));
        const response = await next();
        try {
            const end = response.indexOf('\r\n'), parts = response.subarray(0, end).toString('ascii').split(' ');
            if (parts[0] !== verb || parts[2] !== destination) {
                const actual = /^WNS\/\d(?:\.\d)?$/.test(parts[0] || '') ? 'WNS_VERSION' : /^[A-Z]{1,12}$/.test(parts[0] || '') ? parts[0]
                    : /^2\d\d$/.test(parts[0] || '') ? 'STATUS_SUCCESS' : /^4\d\d$/.test(parts[0] || '') ? 'STATUS_CLIENT_ERROR'
                        : /^5\d\d$/.test(parts[0] || '') ? 'STATUS_SERVER_ERROR' : /^\d+$/.test(parts[0] || '') ? 'NUMBER'
                    : (parts[0] || '') === '' ? 'EMPTY' : 'OTHER';
                const route = ['CON', 'WNS', 'WNS\\CHALLENGE', 'WNS\\NOTIF'].includes(parts[2]) ? parts[2].replace('\\', '_') : 'OTHER';
                throw fail(`PROBE_DIRECT_EXPECTED_${verb}_GOT_${actual}_ROUTE_${route}`);
            }
            if (verb !== 'BND') return {};
            const nonces = [...response.toString('ascii').matchAll(/<nonce>([^<]{1,256})<\/nonce>/g)];
            return { hasReconnectToken: response.includes(Buffer.from('<reconnect-token>')),
                hasNonce: nonces.length === 1, serverNonce: nonces.length === 1 ? nonces[0][1] : null };
        } finally { response.fill(0); }
    }
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { socket.destroy(); reject(fail('PROBE_DIRECT_TIMEOUT')); }, timeoutMs);
            socket.once('secureConnect', () => { clearTimeout(timer); resolve(); });
            socket.once('error', () => { clearTimeout(timer); reject(fail('PROBE_DIRECT_SOCKET_FAILED')); });
        });
        await exchange(frames.cnt, 'CNT'); await exchange(frames.ath, 'ATH');
        const response = await exchange(bind, 'BND');
        const result = { cntResponse: true, athResponse: true, bindResponse: true,
            hasReconnectToken: response.hasReconnectToken, hasNonce: response.hasNonce };
        if (sendNotification !== undefined || decryptNotification !== undefined) {
            if (!Buffer.isBuffer(frames.challenge) || typeof sendNotification !== 'function' || typeof decryptNotification !== 'function'
                || !productConstants || !response.serverNonce)
                throw fail('PROBE_DIRECT_CONFIG_INVALID');
            const challenge = rewriteSyntheticChallenge(frames.challenge, response.serverNonce, productConstants.key, productConstants.id);
            try { await exchange(challenge, 'PUT', 'WNS'); result.challengeResponse = true; }
            finally { challenge.fill(0); }
            const expected = await sendNotification();
            if (!Buffer.isBuffer(expected)) throw fail('PROBE_DIRECT_CONFIG_INVALID');
            try {
                let notification;
                try { notification = await next(); }
                catch (error) { if (error.code === 'PROBE_DIRECT_TIMEOUT' || error.code === 'PROBE_DIRECT_SOCKET_CLOSED') return { ...result, notificationReceived: false }; throw error; }
                try {
                    const ciphertext = firstFixtureNotification([notification]);
                    if (!ciphertext) return { ...result, notificationReceived: false };
                    try { return { ...result, notificationReceived: true, matchesSentCiphertext: ciphertext.equals(expected), payloadDecrypted: await decryptNotification(ciphertext) }; }
                    finally { ciphertext.fill(0); }
                } finally { notification.fill(0); }
            } finally { expected.fill(0); }
        }
        return result;
    } finally { socket.destroy(); pending.fill(0); for (const frame of queue) frame.fill(0); bind.fill(0); }
}
module.exports = { selectSyntheticHandshake, independentSyntheticReconnect };

'use strict';
// Direct WNS interoperability probe for freshly generated test credentials.
// This is not a production receiver and never logs or persists its input.
const tls = require('node:tls');
const { randomInt, randomBytes } = require('node:crypto');
const { rewriteSyntheticBind } = require('./edge-fixture-rewrite.cjs');
const { firstFixtureNotification } = require('./edge-wns-fixture-framing.cjs');
const { rewriteSyntheticChallenge } = require('./edge-fixture-challenge.cjs');
const { syntheticReconnectSignature } = require('./edge-fixture-signature.cjs');
const { syntheticNotificationAck } = require('./edge-fixture-ack.cjs');
const { syntheticRecipientMatches } = require('./edge-fixture-routing.cjs');
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

function describeSyntheticHandshake(frames) {
    const allowedTags = new Set(['ver', 'agent', 'os', 'osVer', 'proc', 'lcid', 'provision', 'name', 'reconnect-token', 'nonce', 'signature', 'appId', 'response']);
    const allowedHeaders = new Set(['ms-cv', 'content-type', 'content-length', 'context']);
    const describe = frame => {
        if (!Buffer.isBuffer(frame) || frame.length > 262144) throw fail('PROBE_FRAMES_INVALID');
        const end = frame.indexOf('\r\n'), split = frame.indexOf('\r\n\r\n', end + 2);
        if (end < 0 || end > 512 || split < end || split > end + 8192) throw fail('PROBE_FRAMES_INVALID');
        const parts = frame.subarray(0, end).toString('ascii').split(' ');
        const headerLines = frame.subarray(end + 2, split).toString('ascii').split('\r\n');
        const headers = headerLines.map(line => {
            const colon = line.indexOf(':'); if (colon < 1) return 'other';
            const name = line.slice(0, colon).toLowerCase(); return allowedHeaders.has(name) ? name : 'other';
        });
        const headerValueShapes = headerLines.map(line => {
            const colon = line.indexOf(':'); if (colon < 1) return { length: 0, shape: 'other' };
            const value = line.slice(colon + 1).trim();
            return { length: value.length, shape: /^\d+$/.test(value) ? 'digits' : /^[0-9a-f]+$/i.test(value) ? 'hex'
                : /^[A-Za-z0-9+/=]+$/.test(value) ? 'base64-like' : 'other' };
        });
        const body = frame.subarray(split + 4).toString('ascii');
        const leaves = [...body.matchAll(/<([A-Za-z][A-Za-z0-9-]*)>([^<>]*)<\/\1>/g)]
            .filter(match => allowedTags.has(match[1])).map(match => ({ tag: match[1], length: match[2].length,
                shape: /^\d+$/.test(match[2]) ? 'digits' : /^[0-9a-f]+$/i.test(match[2]) ? 'hex' : 'text' }));
        return { headerParts: parts.map(part => /^\d+$/.test(part) ? `digits:${part.length}` : /^[A-Z\\]+$/.test(part) ? part : 'other'), headers, headerValueShapes, leaves };
    };
    return Object.fromEntries(Object.entries(frames).map(([name, frame]) => [name, describe(frame)]));
}

function syntheticHandshakeRelations(frames, serverChunks, deviceFields = {}) {
    if (!frames?.bnd || !frames?.challenge || !Array.isArray(serverChunks) || serverChunks.length > 4096
        || serverChunks.some(chunk => !Buffer.isBuffer(chunk)) || serverChunks.reduce((n, chunk) => n + chunk.length, 0) > 262144)
        throw fail('PROBE_FRAMES_INVALID');
    const bnd = frames.bnd.toString('ascii'), challenge = frames.challenge.toString('ascii');
    const bndParts = bnd.slice(0, bnd.indexOf('\r\n')).split(' '), challengeParts = challenge.slice(0, challenge.indexOf('\r\n')).split(' ');
    const channel = bndParts[3];
    if (!/^[0-9a-f]{1,16}$/i.test(channel || '')) throw fail('PROBE_FRAMES_INVALID');
    const data = Buffer.concat(serverChunks);
    try {
        const text = data.toString('ascii');
        const tags = [...text.matchAll(/<(?:id|channel|device-id)>([^<]{1,128})<\/(?:id|channel|device-id)>/gi)].map(match => match[1]);
        const contexts = [...text.matchAll(/(?:^|\r\n)context:\s*([^\r\n]{1,128})/gi)].map(match => match[1].trim());
        const normalize = value => value.toLowerCase().replace(/^0+/, '') || '0';
        const same = values => values.some(value => /^[0-9a-f]{1,32}$/i.test(value) && normalize(value) === normalize(channel));
        const crossRadix = values => values.some(value => {
            if (!/^[0-9a-f]{1,32}$/i.test(value)) return false;
            const lhs = [BigInt(`0x${channel}`), ...(/^\d+$/.test(channel) ? [BigInt(channel)] : [])];
            const rhs = [BigInt(`0x${value}`), ...(/^\d+$/.test(value) ? [BigInt(value)] : [])];
            return lhs.some(a => rhs.some(b => a === b));
        });
        const matchingDeviceFields = Object.entries(deviceFields).filter(([, value]) => Buffer.isBuffer(value)
            && value.length <= 32 && crossRadix([value.toString('ascii')])).map(([field]) => Number(field));
        return { bndAndChallengeChannelEqual: channel === challengeParts[3], channelMatchesServerId: same(tags),
            channelMatchesServerContext: same(contexts), channelMatchesServerIdCrossRadix: crossRadix(tags),
            channelMatchesServerContextCrossRadix: crossRadix(contexts),
            matchingDeviceFields,
            serverIdShapes: tags.map(value => ({ length: value.length, shape: /^\d+$/.test(value) ? 'digits' : /^[0-9a-f]+$/i.test(value) ? 'hex' : 'other' })),
            serverContextCount: contexts.length };
    } finally { data.fill(0); }
}

function syntheticFrame(command, body) {
    const context = randomBytes(8).toString('hex').toUpperCase(), correlation = `${randomBytes(12).toString('base64')}.0`;
    const payload = Buffer.from(`Context: ${context}\r\nMS-CV: ${correlation}\r\n\r\n${body}`, 'ascii');
    return Buffer.concat([Buffer.from(`${command} ${payload.length}\r\n`, 'ascii'), payload]);
}
function syntheticPrelude() {
    return {
        cnt: syntheticFrame('CNT 1 CON', '<connect><ver>1</ver><agent><os>Windows 10</os><osVer>10.0.00000</osVer><proc>x86_64</proc><lcid>en</lcid></agent></connect>'),
        ath: syntheticFrame('ATH 2 CON\\DEVICE', '<device><provision>false</provision></device>'),
    };
}

function syntheticClientMetadata(bindFrame) {
    if (!Buffer.isBuffer(bindFrame) || bindFrame.length > 262144) throw fail('PROBE_DIRECT_CONFIG_INVALID');
    const text = bindFrame.toString('ascii'), end = text.indexOf('\r\n');
    if (end < 0 || end > 512) throw fail('PROBE_DIRECT_CONFIG_INVALID');
    const firstLine = text.slice(0, end).split(' '), size = firstLine.at(-1);
    const matches = [...text.matchAll(/<wns><ver>([^<]{1,32})<\/ver><client><name>([^<]{1,128})<\/name><ver>([^<]{1,64})<\/ver>/g)];
    const client = matches[0];
    if (!/^\d{1,6}$/.test(size || '') || Number(size) !== bindFrame.length - end - 2 || firstLine[0] !== 'BND'
        || firstLine[2] !== 'CON\\WNS' || !/^[0-9a-f]{1,16}$/i.test(firstLine[3] || '') || matches.length !== 1
        || client.slice(1).some(value => !/^[\x20-\x7e]+$/.test(value) || /[<>&]/.test(value))) throw fail('PROBE_DIRECT_CONFIG_INVALID');
    return { channel: firstLine[3], protocolVersion: client[1], clientName: client[2], clientVersion: client[3] };
}

function syntheticHandshake(key, token, productConstants, metadata = { channel: '100', protocolVersion: '1.0', clientName: 'Microsoft Edge', clientVersion: '157.0.4341.42' }) {
    if (typeof token !== 'string' || /[<>&]/.test(token) || !productConstants || !Buffer.isBuffer(productConstants.id)
        || productConstants.id.length !== 16 || productConstants.id.some(byte => byte < 0x21 || byte > 0x7e)
        || !/^[^<>&\s]{16}$/.test(productConstants.id.toString('ascii')))
        throw fail('PROBE_DIRECT_CONFIG_INVALID');
    const nonce = String(randomInt(1, 10)) + Array.from({ length: 31 }, () => String(randomInt(0, 10))).join('');
    const signature = syntheticReconnectSignature(key, token, nonce);
    try {
        if (!/^[0-9a-f]{1,16}$/i.test(metadata.channel || '') || [metadata.protocolVersion, metadata.clientName, metadata.clientVersion]
            .some(value => typeof value !== 'string' || value.length < 1 || value.length > 128 || !/^[\x20-\x7e]+$/.test(value) || /[<>&]/.test(value)))
            throw fail('PROBE_DIRECT_CONFIG_INVALID');
        const prelude = syntheticPrelude();
        return { ...prelude,
            bnd: syntheticFrame(`BND 3 CON\\WNS ${metadata.channel}`, `<wns><ver>${metadata.protocolVersion}</ver><client><name>${metadata.clientName}</name><ver>${metadata.clientVersion}</ver><nonce>${nonce}</nonce><signature>${signature.toString('base64')}</signature><reconnect-token>${token}</reconnect-token></client></wns>`),
            challenge: syntheticFrame(`PUT 4 WNS\\CHALLENGE ${metadata.channel}`, `<challenge><appId>${productConstants.id.toString('ascii')}</appId><response>${'0'.repeat(32)}</response></challenge>`),
        };
    } finally { signature.fill(0); }
}

async function independentSyntheticReconnect({ frames, key, token, connect = () => tls.connect({ host: 'client.wns.windows.com', port: 443,
    servername: 'client.wns.windows.com', rejectUnauthorized: true }), timeoutMs = 15000, sendNotification, decryptNotification, productConstants, generatedPrelude = false, generatedHandshake = false, clientMetadata, ackAndFollowup = false, onRotatedToken, expectedChannel, sendOtherNotification }) {
    if ((!frames && !generatedHandshake) || !Buffer.isBuffer(key) || key.length !== 32 || typeof token !== 'string' || typeof connect !== 'function'
        || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000
        || onRotatedToken !== undefined && typeof onRotatedToken !== 'function') throw fail('PROBE_DIRECT_CONFIG_INVALID');
    const nonce = String(randomInt(1, 10)) + Array.from({ length: 31 }, () => String(randomInt(0, 10))).join('');
    const generated = generatedHandshake ? syntheticHandshake(key, token, productConstants, clientMetadata) : null;
    const bind = generated?.bnd || rewriteSyntheticBind(frames.bnd, key, token, nonce);
    const prelude = generated || (generatedPrelude ? syntheticPrelude() : null), socket = connect();
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
            const tokens = [...response.toString('ascii').matchAll(/<reconnect-token>([^<]{1,4096})<\/reconnect-token>/g)];
            if (onRotatedToken) {
                if (tokens.length !== 1 || !/^[\x21-\x7e]{1,4096}$/.test(tokens[0][1])) throw fail('PROBE_DIRECT_FRAME_INVALID');
                const captured = Buffer.from(tokens[0][1], 'ascii');
                try { await onRotatedToken(captured); } finally { captured.fill(0); }
            }
            return { hasReconnectToken: response.includes(Buffer.from('<reconnect-token>')),
                hasNonce: nonces.length === 1, reconnectTokenUnchanged: tokens.length === 1 ? tokens[0][1] === token : null,
                serverNonce: nonces.length === 1 ? nonces[0][1] : null };
        } finally { response.fill(0); }
    }
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { socket.destroy(); reject(fail('PROBE_DIRECT_TIMEOUT')); }, timeoutMs);
            socket.once('secureConnect', () => { clearTimeout(timer); resolve(); });
            socket.once('error', () => { clearTimeout(timer); reject(fail('PROBE_DIRECT_SOCKET_FAILED')); });
        });
        await exchange(prelude?.cnt || frames.cnt, 'CNT'); await exchange(prelude?.ath || frames.ath, 'ATH');
        const response = await exchange(bind, 'BND');
        const result = { cntResponse: true, athResponse: true, bindResponse: true,
            hasReconnectToken: response.hasReconnectToken, hasNonce: response.hasNonce, reconnectTokenUnchanged: response.reconnectTokenUnchanged };
        if (sendNotification !== undefined || decryptNotification !== undefined) {
            const challengeTemplate = generated?.challenge || frames?.challenge;
            if (!Buffer.isBuffer(challengeTemplate) || typeof sendNotification !== 'function' || typeof decryptNotification !== 'function'
                || !productConstants || !response.serverNonce)
                throw fail('PROBE_DIRECT_CONFIG_INVALID');
            const challenge = rewriteSyntheticChallenge(challengeTemplate, response.serverNonce, productConstants.key, productConstants.id);
            try { await exchange(challenge, 'PUT', 'WNS'); result.challengeResponse = true; }
            finally { challenge.fill(0); }
            let acknowledgementSequence = 5;
            if (sendOtherNotification !== undefined) {
                if (typeof sendOtherNotification !== 'function' || !Buffer.isBuffer(expectedChannel)) throw fail('PROBE_DIRECT_CONFIG_INVALID');
                const expectedOther = await sendOtherNotification();
                if (!Buffer.isBuffer(expectedOther)) throw fail('PROBE_DIRECT_CONFIG_INVALID');
                try {
                    const other = await next();
                    try {
                        if (syntheticRecipientMatches(other, expectedChannel)) throw fail('PROBE_DIRECT_FOREIGN_ROUTE_INVALID');
                        const ciphertext = firstFixtureNotification([other]);
                        try { if (!ciphertext?.equals(expectedOther)) throw fail('PROBE_DIRECT_FOREIGN_ROUTE_INVALID'); }
                        finally { ciphertext?.fill(0); }
                        const acknowledgement = syntheticNotificationAck(other, acknowledgementSequence++);
                        try { await new Promise((resolve, reject) => socket.write(acknowledgement, error => error ? reject(fail('PROBE_DIRECT_WRITE_FAILED')) : resolve())); }
                        finally { acknowledgement.fill(0); }
                        Object.assign(result, { otherReceived: true, otherCipherMatched: true, otherDiscardedBeforeDecrypt: true, otherAckWritten: true });
                    } finally { other.fill(0); }
                } finally { expectedOther.fill(0); }
            }
            const expected = await sendNotification();
            if (!Buffer.isBuffer(expected)) throw fail('PROBE_DIRECT_CONFIG_INVALID');
            try {
                let notification;
                try { notification = await next(); }
                catch (error) { if (error.code === 'PROBE_DIRECT_TIMEOUT' || error.code === 'PROBE_DIRECT_SOCKET_CLOSED') return { ...result, notificationReceived: false }; throw error; }
                try {
                    if (expectedChannel && !syntheticRecipientMatches(notification, expectedChannel)) throw fail('PROBE_DIRECT_TARGET_ROUTE_INVALID');
                    const ciphertext = firstFixtureNotification([notification]);
                    if (!ciphertext) return { ...result, notificationReceived: false };
                    try {
                        const received = { ...result, notificationReceived: true, matchesSentCiphertext: ciphertext.equals(expected), payloadDecrypted: await decryptNotification(ciphertext) };
                        if (!ackAndFollowup || !received.matchesSentCiphertext || !received.payloadDecrypted) return received;
                        const acknowledgement = syntheticNotificationAck(notification, acknowledgementSequence++);
                        try { await new Promise((resolve, reject) => socket.write(acknowledgement, error => error ? reject(fail('PROBE_DIRECT_WRITE_FAILED')) : resolve())); }
                        finally { acknowledgement.fill(0); }
                        const expectedNext = await sendNotification();
                        if (!Buffer.isBuffer(expectedNext)) throw fail('PROBE_DIRECT_CONFIG_INVALID');
                        try {
                            let followup;
                            try { followup = await next(); }
                            catch (error) { if (error.code === 'PROBE_DIRECT_TIMEOUT' || error.code === 'PROBE_DIRECT_SOCKET_CLOSED') return { ...received, ackWritten: true, followupReceived: false }; throw error; }
                            try {
                                const nextCipher = firstFixtureNotification([followup]);
                                if (!nextCipher) return { ...received, ackWritten: true, followupReceived: false };
                                try { return { ...received, ackWritten: true, followupReceived: true, followupMatches: nextCipher.equals(expectedNext), followupDecrypted: await decryptNotification(nextCipher) }; }
                                finally { nextCipher.fill(0); }
                            } finally { followup.fill(0); }
                        } finally { expectedNext.fill(0); }
                    }
                    finally { ciphertext.fill(0); }
                } finally { notification.fill(0); }
            } finally { expected.fill(0); }
        }
        return result;
    } finally { socket.destroy(); pending.fill(0); for (const frame of queue) frame.fill(0); bind.fill(0); if (prelude) for (const frame of Object.values(prelude)) frame.fill(0); }
}
module.exports = { selectSyntheticHandshake, describeSyntheticHandshake, syntheticHandshakeRelations, syntheticPrelude, syntheticClientMetadata, syntheticHandshake, independentSyntheticReconnect };

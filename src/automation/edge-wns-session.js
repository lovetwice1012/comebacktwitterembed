'use strict';

// Protocol orchestration for one receiver. The caller supplies the already
// fenced token-save operation and the transport; no browser data is loaded here.
const { deviceFrame, bindFrame, challengeFrame, createNonce } = require('./edge-wns-protocol');
const { connectFrameForVersion } = require('./edge-wns-connect-version');
const { parseBindResponse } = require('./edge-wns-bind');
const { createEdgeWnsReceiver } = require('./edge-wns-receiver');
const { MAX_HEADER, MAX_PAYLOAD } = require('./edge-wns-framing');
const fail = code => Object.assign(new Error(code), { code });
function reply(frame, verb, number, route, { emptyBody = false } = {}) {
    if (!Buffer.isBuffer(frame) || frame.length > MAX_HEADER + 2 + MAX_PAYLOAD) throw fail('X_EDGE_WNS_REPLY_INVALID');
    const end = frame.indexOf('\r\n'), separator = frame.indexOf('\r\n\r\n', end + 2);
    if (end < 0 || end > MAX_HEADER || separator < end + 2 || separator - end - 2 > 8192) throw fail('X_EDGE_WNS_REPLY_INVALID');
    const command = frame.subarray(0, end);
    if (command.some(byte => byte < 0x20 || byte > 0x7e)) throw fail('X_EDGE_WNS_REPLY_INVALID');
    const parts = command.toString('ascii').split(' '), size = parts.at(-1);
    if (parts.length !== 4 || parts[0] !== verb || parts[1] !== String(number) || parts[2] !== route
        || !/^\d{1,6}$/.test(size) || Number(size) !== frame.length - end - 2) throw fail('X_EDGE_WNS_REPLY_INVALID');
    const headers = frame.subarray(end + 2, separator);
    if (headers.some(byte => byte !== 9 && byte !== 10 && byte !== 13 && (byte < 0x20 || byte > 0x7e))) throw fail('X_EDGE_WNS_REPLY_INVALID');
    for (const line of headers.toString('ascii').split('\r\n')) {
        const colon = line.indexOf(':'), name = line.slice(0, colon).toLowerCase(), value = line.slice(colon + 1).trim();
        if (colon < 1 || !/^[a-z][a-z0-9-]{0,63}$/.test(name) || /[\r\n]/.test(value)
            || ['error', 'error-code'].includes(name) || ['status', 'status-code'].includes(name) && !/^2\d\d$/.test(value)) throw fail('X_EDGE_WNS_REPLY_INVALID');
    }
    const body = frame.subarray(separator + 4);
    if (emptyBody && body.length || /<\s*error(?:\s|>)/i.test(body.toString('ascii'))) throw fail('X_EDGE_WNS_REPLY_INVALID');
}
function copyObject(value, names) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail('X_EDGE_WNS_SESSION_CONFIG_INVALID');
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key) || !Object.hasOwn(descriptors[key], 'value'))) throw fail('X_EDGE_WNS_SESSION_CONFIG_INVALID');
    return Object.fromEntries(names.map(name => [name, descriptors[name].value]));
}
function createEdgeWnsSession({ transport, store, lease, siteChannel, authorize, saveRotatedToken, agent, client, deviceKey, reconnectToken, productKey, productId, authenticationMode = 'challenge', connectVersion = '1' }) {
    if (!transport || ['connect', 'send', 'next', 'close'].some(name => typeof transport[name] !== 'function')
        || typeof saveRotatedToken !== 'function' || !Buffer.isBuffer(deviceKey) || deviceKey.length !== 32
        || !Buffer.isBuffer(reconnectToken) || !reconnectToken.length || reconnectToken.length > 4096
        || !['challenge', 'bound'].includes(authenticationMode) || !['1', '2'].includes(connectVersion)
        || authenticationMode === 'challenge' && (!Buffer.isBuffer(productKey) || productKey.length !== 16 || !Buffer.isBuffer(productId) || productId.length !== 16)
        || authenticationMode === 'bound' && (productKey !== undefined || productId !== undefined))
        throw fail('X_EDGE_WNS_SESSION_CONFIG_INVALID');
    const safeAgent = copyObject(agent, ['os', 'osVersion', 'architecture', 'locale']);
    const safeClient = copyObject(client, ['channel', 'protocolVersion', 'clientName', 'clientVersion']);
    const secrets = { deviceKey: Buffer.from(deviceKey), reconnectToken: Buffer.from(reconnectToken),
        ...(authenticationMode === 'challenge' ? { productKey: Buffer.from(productKey), productId: Buffer.from(productId) } : {}) };
    let receiver;
    try { receiver = createEdgeWnsReceiver({ store, lease, channel: siteChannel, authorize, sendAck: frame => transport.send(frame) }); }
    catch (error) { for (const value of Object.values(secrets)) value.fill(0); throw error; }
    let state = 'new', busy = false, ackSequence = 5, awaitingBoundReply = false;
    function clearSecrets() { for (const value of Object.values(secrets)) value.fill(0); }
    function stop() { if (state === 'closed') return; state = 'closed'; clearSecrets(); receiver.close(); transport.close(); }
    async function exclusive(work) {
        if (state === 'closed') throw fail('X_EDGE_WNS_SESSION_STOPPED');
        if (busy) { stop(); throw fail('X_EDGE_WNS_SESSION_BUSY'); }
        busy = true;
        try { return await work(); } catch (error) { stop(); throw error; } finally { busy = false; }
    }
    function ensureOpen() { if (state === 'closed') throw fail('X_EDGE_WNS_SESSION_STOPPED'); }
    async function send(frame) { try { ensureOpen(); await transport.send(frame); ensureOpen(); } finally { frame.fill(0); } }
    async function exchange(frame, verb, number, route, options) {
        await send(frame); const response = await transport.next();
        try { ensureOpen(); reply(response, verb, number, route, options); return response; }
        catch (error) { response.fill(0); throw error; }
    }
    return Object.freeze({
        start: () => exclusive(async () => {
            if (state !== 'new') throw fail('X_EDGE_WNS_SESSION_STATE_INVALID');
            let cnt, ath, bnd;
            try {
                // Validate all local metadata before starting the handshake.
                cnt = connectFrameForVersion(safeAgent, 1, connectVersion); ath = deviceFrame(2);
                bnd = bindFrame({ ...safeClient, nonce: createNonce(), reconnectToken: secrets.reconnectToken, deviceKey: secrets.deviceKey }, 3);
                await transport.connect();
                (await exchange(cnt, 'CNT', 1, 'CON')).fill(0); cnt = null;
                (await exchange(ath, 'ATH', 2, 'CON', { emptyBody: true })).fill(0); ath = null;
                awaitingBoundReply = true;
                const bound = await exchange(bnd, 'BND', 3, 'CON'); bnd = null;
                awaitingBoundReply = false;
                let binding;
                try { binding = parseBindResponse(bound, 3); } finally { bound.fill(0); }
                try {
                    await saveRotatedToken(binding.reconnectToken);
                    ensureOpen();
                    if (authenticationMode === 'challenge') {
                        const challenge = challengeFrame({ channel: safeClient.channel, serverNonce: binding.nonce,
                            productKey: secrets.productKey, productId: secrets.productId }, 4);
                        (await exchange(challenge, 'PUT', 4, 'WNS', { emptyBody: true })).fill(0);
                    }
                } finally { binding.reconnectToken.fill(0); }
                ensureOpen();
                state = 'ready'; return { state };
            } finally { cnt?.fill(0); ath?.fill(0); bnd?.fill(0); clearSecrets(); }
        }),
        next: (waitMs) => exclusive(async () => {
            if (state !== 'ready') throw fail('X_EDGE_WNS_SESSION_STATE_INVALID');
            let frame;
            try { frame = await transport.next(waitMs); }
            catch (error) { if (error?.code === 'X_EDGE_WNS_RECEIVE_TIMEOUT') return { state: 'idle' }; throw error; }
            try {
                if (ackSequence > 1000000) throw fail('X_EDGE_WNS_SESSION_SEQUENCE_INVALID');
                return await receiver.receive(frame, ackSequence++);
            } finally { frame.fill(0); }
        }),
        // Only this handshake phase can prove a buffered BND belongs to the
        // validated CNT/ATH exchange. Challenge mode still needs its PUT reply.
        canRecoverBufferedBoundReply: () => authenticationMode === 'bound' && awaitingBoundReply,
        close: stop,
    });
}
module.exports = { createEdgeWnsSession, reply };

'use strict';

// MCS session engine. The explicitly enabled gateway supplies an authenticated
// transport and durable, lease-fenced receipt store. This module opens no socket.
const protocol = require('./chrome-mcs-protobuf');
const { encodeFrame } = require('./chrome-mcs-framing');
const error = code => Object.assign(new Error(code), { code });

function createChromeMcsSession({ credentials, route, store, send, onReceipt = () => {}, now = Date.now }) {
    if (!credentials || !route || !store || typeof store.pending !== 'function' || typeof store.commit !== 'function'
        || typeof store.confirm !== 'function' || typeof send !== 'function' || typeof onReceipt !== 'function' || typeof now !== 'function')
        throw error('X_CHROME_SESSION_CONFIG_INVALID');
    let state = 'new', inbound = 0, outbound = 0, confirmed = 0, busy = false;
    const sent = new Map();
    let unacknowledged = [];
    async function exclusive(work) {
        if (busy || state === 'failed' || state === 'closed') throw error('X_CHROME_SESSION_INVALID');
        busy = true;
        try { return await work(); }
        catch (cause) { state = 'failed'; throw cause; }
        finally { busy = false; }
    }
    async function sendPacket(tag, payload, first = false, ids = []) {
        if (outbound >= 0x7fffffff) throw error('X_CHROME_SESSION_SEQUENCE_INVALID');
        const next = outbound + 1;
        // An uncertain write always ends this session. On reconnect, the store
        // supplies every committed but unconfirmed ID in the login request.
        await send(encodeFrame(tag, payload, { first }));
        outbound = next;
        if (ids.length) sent.set(next, ids.slice());
    }
    async function confirmPackets(last) {
        if (!last) return;
        if (last > outbound || last < confirmed) throw error('X_CHROME_SESSION_SEQUENCE_INVALID');
        const through = [];
        for (const [sequence, ids] of sent) if (sequence <= last) through.push(...ids);
        if (through.length) await store.confirm([...new Set(through)]);
        for (const sequence of sent.keys()) if (sequence <= last) sent.delete(sequence);
        confirmed = last;
    }
    async function acknowledge(tag) {
        const ids = unacknowledged;
        const payload = tag === 0 || tag === 1 ? protocol.heartbeatAck(inbound) : protocol.streamAck(inbound);
        await sendPacket(tag, payload, false, ids);
        unacknowledged = [];
    }
    return {
        start: () => exclusive(async () => {
            if (state !== 'new') throw error('X_CHROME_SESSION_INVALID');
            const ids = await store.pending();
            if (!Array.isArray(ids) || ids.length > 100 || new Set(ids).size !== ids.length) throw error('X_CHROME_SESSION_PENDING_INVALID');
            const request = protocol.loginRequest({ ...credentials, receivedIds: ids });
            await sendPacket(2, request, true, ids);
            state = 'connecting';
        }),
        receive: frame => exclusive(async () => {
            if (!frame || !Number.isInteger(frame.tag) || !Buffer.isBuffer(frame.payload)) throw error('X_CHROME_SESSION_FRAME_INVALID');
            if (state === 'connecting') {
                if (frame.tag !== 3) throw error('X_CHROME_SESSION_LOGIN_FAILED');
                const response = protocol.loginResponse(frame.payload);
                if (!response.accepted) throw error('X_CHROME_SESSION_LOGIN_FAILED');
                await confirmPackets(protocol.lastStreamReceived(3, frame.payload));
                inbound = 1; state = 'listening';
                return { state, ...(response.heartbeatIntervalMs ? { heartbeatIntervalMs: response.heartbeatIntervalMs } : {}) };
            }
            if (state !== 'listening' || ![0, 1, 7, 8].includes(frame.tag)) throw error('X_CHROME_SESSION_FRAME_INVALID');
            await confirmPackets(protocol.lastStreamReceived(frame.tag, frame.payload));
            if (inbound >= 0x7fffffff) throw error('X_CHROME_SESSION_SEQUENCE_INVALID');
            inbound++;
            if (frame.tag === 0) { await acknowledge(1); return { state: 'heartbeat' }; }
            if (frame.tag !== 8) return { state: 'control' };
            const control = protocol.inspectControlMessage(frame.payload);
            if (control) {
                if (control.idle) {
                    await sendPacket(8, protocol.idleResponse(inbound, now()), false, unacknowledged);
                    unacknowledged = [];
                } else await acknowledge(7);
                return { state: 'control' };
            }
            const message = protocol.dataMessage(frame.payload, route);
            if (!message.matches) { await acknowledge(7); return { state: 'discarded' }; }
            if (message.control) {
                if (typeof store.control !== 'function') throw error('X_CHROME_SESSION_CONTROL_UNAVAILABLE');
                // The audit and replay ID commit before the stream ACK. No
                // control data is passed to the notification router.
                await store.control(message);
                if (message.persistentId) unacknowledged.push(message.persistentId);
                await acknowledge(7);
                return { state: 'provider_control', kind: message.control };
            }
            if (!message.persistentId) throw error('X_CHROME_SESSION_ID_MISSING');
            const encrypted = protocol.encryptedPayload(message);
            // commit must atomically persist both ciphertext and replay ID and
            // enforce the caller's current owner/lease/rollout authorization.
            const receipt = await store.commit({ ...message, encrypted });
            unacknowledged.push(message.persistentId);
            await acknowledge(7);
            await onReceipt(receipt);
            return { state: 'received' };
        }),
        ping: () => exclusive(async () => {
            if (state !== 'listening') throw error('X_CHROME_SESSION_INVALID');
            await acknowledge(0);
        }),
        close: () => { state = 'closed'; },
    };
}
module.exports = { createChromeMcsSession };

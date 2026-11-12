'use strict';

// One receiver inside the shared worker. The parent owns lease renewal and
// must abort the signal as soon as the lease or rollout authorization ends.
const { createEdgeWnsTransport } = require('./edge-wns-transport');
const { createEdgeWnsSession, reply } = require('./edge-wns-session');
const { parseBindResponse } = require('./edge-wns-bind');
const { createEdgeWnsReceiver } = require('./edge-wns-receiver');
const { MAX_HEADER } = require('./edge-wns-framing');
const fail = code => Object.assign(new Error(code), { code });
function isIdentifiableNotification(frame) {
    if (!Buffer.isBuffer(frame)) return false;
    const end = frame.indexOf('\r\n');
    if (end < 0 || end > MAX_HEADER) return false;
    const header = frame.subarray(0, end);
    if (header.some(byte => byte < 0x20 || byte > 0x7e)) return false;
    const match = /^NFY [0-9]{1,10} WNS\\NOTIF(?: [0-9a-fA-F]{1,16})? ([0-9]{1,6})$/.exec(header.toString('ascii'));
    if (!match || Number(match[1]) !== frame.length - end - 2) return false;
    const separator = frame.indexOf('\r\n\r\n', end + 2);
    if (separator < end + 2 || separator - end - 2 > 8192) return false;
    const bytes = frame.subarray(end + 2, separator);
    if (bytes.some(byte => byte !== 9 && byte !== 10 && byte !== 13 && (byte < 0x20 || byte > 0x7e))) return false;
    const names = new Set();
    for (const line of bytes.toString('ascii').split('\r\n')) {
        const colon = line.indexOf(':'), name = line.slice(0, colon).toLowerCase();
        // Unknown, duplicate, status or error headers might carry control
        // semantics. Do not cross that boundary during recovery.
        if (colon < 1 || !['channel', 'msg-id', 'content-encoding', 'ms-cv'].includes(name) || names.has(name)) return false;
        names.add(name);
    }
    return names.has('channel') && names.has('msg-id') && names.has('content-encoding');
}
function validateCredentials(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail('X_EDGE_WNS_GATEWAY_CONFIG_INVALID');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const bound = descriptors.authenticationMode && Object.hasOwn(descriptors.authenticationMode, 'value') && descriptors.authenticationMode.value === 'bound';
    const names = bound ? ['agent', 'client', 'deviceKey', 'reconnectToken', 'siteChannel', 'authenticationMode']
        : ['agent', 'client', 'deviceKey', 'reconnectToken', 'productKey', 'productId', 'siteChannel'];
    if (Object.hasOwn(descriptors, 'connectVersion')) names.push('connectVersion');
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key) || !Object.hasOwn(descriptors[key], 'value'))) throw fail('X_EDGE_WNS_GATEWAY_CONFIG_INVALID');
    if (Object.hasOwn(descriptors, 'connectVersion') && descriptors.connectVersion.value !== '2') throw fail('X_EDGE_WNS_GATEWAY_CONFIG_INVALID');
}
/** @param {{store:any, lease:any, vault:any, authorize:Function, credentials:any, signal:AbortSignal, onReady?:Function, onReceived?:Function, transportFactory?:Function, waitMs?:number}} options */
async function runEdgeWnsGateway({ store, lease, vault, authorize, credentials, signal, onReady, onReceived, transportFactory, waitMs = 15000 }) {
    validateCredentials(credentials);
    if (!store || ['readWnsTokenState', 'saveWnsTokenState', 'assertLease', 'recordFrame', 'getInbox'].some(name => typeof store[name] !== 'function')
        || !lease || !vault || typeof authorize !== 'function' || !(signal instanceof AbortSignal)
        || onReady !== undefined && typeof onReady !== 'function' || onReceived !== undefined && typeof onReceived !== 'function'
        || transportFactory !== undefined && typeof transportFactory !== 'function' || !Number.isSafeInteger(waitMs) || waitMs < 100 || waitMs > 60000)
        throw fail('X_EDGE_WNS_GATEWAY_CONFIG_INVALID');
    if (signal.aborted) return { state: 'stopped' };
    let recovered, session, transport, token, generation = 0, established = false;
    const stopped = () => signal.aborted;
    const guard = async () => { if (stopped()) throw fail('X_EDGE_WNS_STOPPED'); await store.assertLease(lease, { authorize }); if (stopped()) throw fail('X_EDGE_WNS_STOPPED'); };
    const saveRotatedToken = async value => {
        if (stopped()) throw fail('X_EDGE_WNS_STOPPED');
        const result = await store.saveWnsTokenState(lease, { vault, authorize, token: value, expectedGeneration: generation });
        if (!result || result.generation !== generation + 1) throw fail('X_EDGE_WNS_STATE_INVALID');
        generation = result.generation;
    };
    function abort() {
        try { session?.close(); } catch { /* Continue closing the transport. */ }
        try { transport?.close(); } catch { /* A stopped session cannot send further frames. */ }
    }
    signal.addEventListener('abort', abort, { once: true });
    try {
        recovered = await store.readWnsTokenState(lease, { vault, authorize });
        if (stopped()) return { state: 'stopped' };
        if (recovered) {
            if (!Number.isSafeInteger(recovered.generation) || recovered.generation < 1 || !Buffer.isBuffer(recovered.token)) throw fail('X_EDGE_WNS_STATE_INVALID');
            generation = recovered.generation; token = Buffer.from(recovered.token); recovered.token.fill(0);
        } else {
            if (!Buffer.isBuffer(credentials.reconnectToken)) throw fail('X_EDGE_WNS_GATEWAY_CONFIG_INVALID');
            token = Buffer.from(credentials.reconnectToken);
        }
        transport = transportFactory ? transportFactory({ signal }) : createEdgeWnsTransport({ signal });
        if (!transport || ['connect', 'send', 'next', 'close'].some(name => typeof transport[name] !== 'function')) throw fail('X_EDGE_WNS_GATEWAY_CONFIG_INVALID');
        const guarded = { async connect() { await guard(); return transport.connect(); }, async send(frame) { await guard(); return transport.send(frame); },
            next: wait => transport.next(wait), close: () => { if (!transport.hasBufferedAfterDisconnect?.()) transport.close(); } };
        session = createEdgeWnsSession({ transport: guarded, store, lease, siteChannel: credentials.siteChannel, authorize,
            saveRotatedToken,
            agent: credentials.agent, client: credentials.client, deviceKey: credentials.deviceKey, reconnectToken: token,
            productKey: credentials.productKey, productId: credentials.productId, authenticationMode: credentials.authenticationMode,
            ...(credentials.connectVersion === '2' ? { connectVersion: '2' } : {}) });
        token.fill(0); token = null;
        await session.start();
        established = true;
        if (stopped()) return { state: 'stopped' };
        await guard();
        if (onReady) await onReady({ lease });
        while (!stopped()) {
            const result = await session.next(waitMs);
            if (stopped()) break;
            if (result.state === 'persisted' && !result.duplicate && onReceived) {
                await guard();
                const inbox = await store.getInbox({ subscriptionId: lease.subscriptionId, ownerUserId: lease.ownerUserId, id: result.inboxId });
                if (!inbox || inbox.revision !== lease.revision || inbox.subscriptionId !== lease.subscriptionId
                    || inbox.ownerUserId !== lease.ownerUserId || String(inbox.id) !== String(result.inboxId)) throw fail('X_EDGE_WNS_RECEIPT_INVALID');
                await guard(); await onReceived({ lease, inbox });
            }
        }
        return { state: 'stopped' };
    } catch (error) {
        if (stopped()) return { state: 'stopped' };
        const recoverBound = !established && session?.canRecoverBufferedBoundReply();
        if ((established || recoverBound) && ['X_EDGE_WNS_SOCKET_FAILED', 'X_EDGE_WNS_SOCKET_CLOSED', 'X_EDGE_WNS_ACK_FAILED', 'X_EDGE_WNS_BACKPRESSURE', 'X_EDGE_WNS_FRAME_INVALID'].includes(error?.code)
            && transport?.hasBufferedAfterDisconnect?.() && typeof transport.takeBufferedAfterDisconnect === 'function') {
            // The provider may not replay frames after a failed connection. Persist
            // only complete, already-received frames while this lease remains valid;
            // there is no socket on which to acknowledge them.
            const frames = transport.takeBufferedAfterDisconnect(); let drain, binding;
            try {
                if (recoverBound) {
                    // The first complete frame must authenticate this specific
                    // BND exchange. Commit its rotated token under the current
                    // lease before accepting any subsequent notification.
                    reply(frames[0], 'BND', 3, 'CON');
                    binding = parseBindResponse(frames[0], 3);
                    await guard();
                    await saveRotatedToken(binding.reconnectToken);
                    await guard();
                }
                const drainAuthorize = async query => {
                    if (stopped()) throw fail('X_EDGE_WNS_STOPPED');
                    await authorize(query);
                    if (stopped()) throw fail('X_EDGE_WNS_STOPPED');
                };
                const createDrain = () => createEdgeWnsReceiver({ store, lease, channel: credentials.siteChannel, authorize: drainAuthorize, sendAck: async () => {} });
                drain = createDrain(); let invalidFrame = false;
                for (const frame of recoverBound ? frames.slice(1) : frames) {
                    if (stopped()) break;
                    await store.assertLease(lease, { authorize: drainAuthorize });
                    if (stopped()) break;
                    try { await drain.receive(frame, 1, { acknowledge: false }); }
                    catch (frameError) {
                        // Each buffered frame was independently decoded. A
                        // malformed or unsupported envelope must not discard
                        // later complete notifications from this same socket.
                        // Stop for store, lease and authorization errors.
                        if (frameError?.code !== 'X_EDGE_WNS_NOTIFICATION_INVALID' || !['ENCODING', 'EMPTY'].includes(frameError.stage)
                            || !isIdentifiableNotification(frame)) throw frameError;
                        invalidFrame = true; drain.close(); drain = createDrain();
                    }
                }
                // Still report the unprocessable frame; it was not persisted.
                if (invalidFrame) throw fail('X_PUSH_BUFFERED_RECOVERY_FAILED');
            } catch (drainError) {
                // Do not report an ordinary disconnect when recovery itself
                // failed: some buffered receipts may not have been stored.
                // Never expose database or frame contents in the reason code.
                error = /^X_PUSH_(?:LEASE_LOST|ROLLOUT_WITHDRAWN|ROLLOUT_CHECK_FAILED|STORE_TIMEOUT|MONITOR_INACTIVE|MONITOR_CHECK_FAILED|AUTHORITY_UNAVAILABLE)$/.test(drainError?.code || '')
                    ? fail(drainError.code) : fail('X_PUSH_BUFFERED_RECOVERY_FAILED');
            } finally { binding?.reconnectToken.fill(0); drain?.close(); for (const frame of frames) frame.fill(0); }
        }
        if (stopped()) return { state: 'stopped' };
        if (typeof error?.code === 'string' && /^X_(?:EDGE_WNS|PUSH|SETUP)_[A-Z_]+$/.test(error.code)) throw error;
        throw fail('X_EDGE_WNS_GATEWAY_FAILED');
    } finally {
        signal.removeEventListener('abort', abort);
        abort(); token?.fill(0); if (Buffer.isBuffer(recovered?.token)) recovered.token.fill(0);
    }
}
module.exports = { runEdgeWnsGateway };

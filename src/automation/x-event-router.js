'use strict';

const { AutomationError } = require('./service');
const { normalizeEvent } = require('./engine');
const { types: { isProxy } } = require('node:util');
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const POST_URL = /^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/status\/([1-9]\d{0,19})$/;
const POST_PATH = /^\/([A-Za-z0-9_]{1,15})\/status\/([1-9]\d{0,19})$/;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const fail = code => { throw new AutomationError(code, 'X通知の形式を確認できないため、通知は送信されていません。', 422); };
const object = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => Object.hasOwn(descriptor, 'value'));
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));

function text(value, maximum, code = 'X_NOTIFICATION_INVALID_TEXT') {
    if (typeof value !== 'string' || value.length > maximum
        || [...value].some(character => { const code = character.charCodeAt(0); return code < 32 && ![9, 10, 13].includes(code) || code === 127; })) fail(code);
}

// Unknown display/analytics fields may accompany an X push. Validate their
// entire JSON tree before ignoring them, without invoking getters or toJSON.
// The same bounds apply to already-decoded objects and wire-format inputs.
function decodePayload(payload) {
    if (isProxy(payload)) fail('X_NOTIFICATION_UNSUPPORTED');
    if (typeof payload === 'string' || Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
        try {
            if (typeof payload === 'string' && payload.length > MAX_PAYLOAD_BYTES) fail('X_NOTIFICATION_UNSUPPORTED');
            const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
            if (bytes.byteLength > MAX_PAYLOAD_BYTES) fail('X_NOTIFICATION_UNSUPPORTED');
            payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch { fail('X_NOTIFICATION_UNSUPPORTED'); }
    }
    let bytes = 0, nodes = 0;
    const ancestors = new Set();
    const add = count => { bytes += count; if (bytes > MAX_PAYLOAD_BYTES) fail('X_NOTIFICATION_UNSUPPORTED'); };
    function visit(value, depth) {
        if (++nodes > 8192 || depth > 32) fail('X_NOTIFICATION_UNSUPPORTED');
        if (value === null || value === undefined) { add(4); return; }
        if (typeof value === 'boolean') { add(value ? 4 : 5); return; }
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) fail('X_NOTIFICATION_UNSUPPORTED');
            add(String(value).length); return;
        }
        if (typeof value === 'string') {
            if (value.length > MAX_PAYLOAD_BYTES) fail('X_NOTIFICATION_UNSUPPORTED');
            add(Buffer.byteLength(JSON.stringify(value))); return;
        }
        if (typeof value !== 'object' || isProxy(value) || ancestors.has(value)) fail('X_NOTIFICATION_UNSUPPORTED');
        const array = Array.isArray(value);
        if (array ? Object.getPrototypeOf(value) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
            fail('X_NOTIFICATION_UNSUPPORTED');
        const fields = Object.getOwnPropertyDescriptors(value), names = Object.getOwnPropertyNames(fields);
        if (Object.getOwnPropertySymbols(fields).length || names.length > 8193
            || names.some(name => !Object.hasOwn(fields[name], 'value'))) fail('X_NOTIFICATION_UNSUPPORTED');
        ancestors.add(value); add(2);
        if (array) {
            const length = fields.length?.value;
            if (!Number.isSafeInteger(length) || length > 8192
                || names.some(name => name !== 'length' && (!/^(?:0|[1-9]\d*)$/.test(name) || Number(name) >= length))) fail('X_NOTIFICATION_UNSUPPORTED');
            for (let index = 0; index < length; index++) { if (index) add(1); visit(fields[index]?.value, depth + 1); }
        } else {
            for (const [index, name] of names.entries()) {
                if (index) add(1);
                if (name.length > MAX_PAYLOAD_BYTES) fail('X_NOTIFICATION_UNSUPPORTED');
                add(Buffer.byteLength(JSON.stringify(name)) + 1);
                visit(fields[name].value, depth + 1);
            }
        }
        ancestors.delete(value);
    }
    visit(payload, 0);
    return payload;
}

// The public X service worker (https://x.com/sw.js, inspected 2026-10-14)
// reads event.data.json() as title/body/data and declares tweet_id, uri,
// user_id and type in data. Its user_id does NOT establish the post author.
// Adapt only an explicit post permalink whose ID agrees with any tweet_id. No
// title parsing, recipient-ID inference, URL fetching or private event fallback.
// Source SHA-256 and the remaining live-push acceptance boundary are documented
// in docs/angelic-angel/x-webpush-adapter.md.
function inspectXWebPushPostCandidate(payload) {
    return inspectParsedXWebPushPostCandidate(decodePayload(payload));
}
function inspectParsedXWebPushPostCandidate(payload, { strictDisplayMetadata = true } = {}) {
    if (!object(payload) || !Object.hasOwn(payload, 'data') || !object(payload.data)
        || Object.hasOwn(payload, 'notificationType')) fail('X_NOTIFICATION_UNSUPPORTED');
    text(payload.title, 300);
    if (payload.body !== undefined) text(payload.body, 10000);
    if (payload.tag !== undefined) text(payload.tag, 4096);
    if (strictDisplayMetadata) {
        if (payload.icon !== undefined) text(payload.icon, 4096);
        if (payload.timestamp !== undefined && !((typeof payload.timestamp === 'number' && Number.isFinite(payload.timestamp))
            || typeof payload.timestamp === 'string' && /^\d{1,16}$/.test(payload.timestamp))) fail('X_NOTIFICATION_INVALID_TIME');
    }
    const data = payload.data;
    if (Object.hasOwn(data, 'xchat_message') || Object.hasOwn(data, 'xchat_delete') || data.silent === true) fail('X_NOTIFICATION_UNSUPPORTED');
    if (data.silent !== undefined && typeof data.silent !== 'boolean') fail('X_NOTIFICATION_UNSUPPORTED');
    if (data.totalCount !== undefined && (!Number.isSafeInteger(data.totalCount) || data.totalCount !== 1)) fail('X_NOTIFICATION_UNSUPPORTED');
    for (const field of ['bundle_text', 'impression_id', 'lang', 'multi_body', 'multi_title', 'multi_uri', 'scribe_target', 'type', 'user_id'])
        if (data[field] !== undefined) text(data[field], field === 'multi_body' ? 10000 : 4096);
    // X's worker names dm_av / avcall_created and xchat events explicitly.
    // Other private/account/system classifications never become post events,
    // even when an envelope also supplies a plausible post link.
    for (const field of ['type', 'scribe_target']) if (typeof data[field] === 'string'
        && /(?:^|[^a-z0-9])(?:dm|xchat|avcall|login|auth|authentication|security|system|account)(?:$|[^a-z0-9])/i.test(data[field])) fail('X_NOTIFICATION_UNSUPPORTED');
    const match = typeof data.uri === 'string' && (POST_URL.exec(data.uri) || POST_PATH.exec(data.uri));
    if (!match || ['i', 'intent'].includes(match[1].toLowerCase())
        || Object.hasOwn(data, 'tweet_id') && (typeof data.tweet_id !== 'string' || data.tweet_id !== match[2])) fail('X_NOTIFICATION_INVALID_POST');
    // A canonical permalink proves only the referenced post identity. Likes
    // and other notifications may link to the same post, so this inspection
    // result has no event kind and MUST NOT grant delivery admission.
    return Object.freeze({ authorAccountId: null, authorHandle: match[1], postId: match[2],
        postUrl: `https://x.com/${match[1]}/status/${match[2]}`, title: payload.title,
        ...(payload.body === undefined ? {} : { body: payload.body }) });
}

// Keep the port's internal contract and admit the independently observed X
// post envelope only when type, scribe target and the exact tweet-ID tag agree.
// A permalink, title, recipient ID or the word "tweet" alone grants no admission.
function normalizeXNotification(payload, options = {}) {
    payload = decodePayload(payload);
    let authorHandle, authorAccountId, postId, postUrl, title, body;
    if (object(payload) && !Object.hasOwn(payload, 'notificationType')) {
        // Timestamp/icon are bounded opaque display metadata. The trusted
        // inbox receipt supplies observedAtMs; no payload time is publication.
        const candidate = inspectParsedXWebPushPostCandidate(payload, { strictDisplayMetadata: false });
        if (payload.data.type !== 'tweet' || payload.data.scribe_target !== 'tweet'
            || payload.tag !== `tweet-${candidate.postId}`) fail('X_NOTIFICATION_UNSUPPORTED');
        ({ authorHandle, authorAccountId, postId, postUrl, title, body } = candidate);
    } else {
        if (!keys(payload, ['notificationType', 'url', 'author', 'title', 'text']) || payload.notificationType !== 'tweet') fail('X_NOTIFICATION_UNSUPPORTED');
        const match = typeof payload.url === 'string' && POST_URL.exec(payload.url);
        if (!match || !keys(payload.author, ['id', 'handle'])) fail('X_NOTIFICATION_INVALID_POST');
        authorHandle = payload.author.handle;
        if (typeof authorHandle !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(authorHandle) || authorHandle.toLowerCase() !== match[1].toLowerCase()) fail('X_NOTIFICATION_INVALID_AUTHOR');
        authorAccountId = payload.author.id ?? null;
        if (authorAccountId !== null && (typeof authorAccountId !== 'string' || !/^[1-9]\d{0,19}$/.test(authorAccountId))) fail('X_NOTIFICATION_INVALID_AUTHOR');
        for (const [field, maximum] of [['title', 300], ['text', 10000]]) if (payload[field] !== undefined) text(payload[field], Number(maximum));
        postId = match[2]; postUrl = `https://x.com/${match[1]}/status/${postId}`;
        title = payload.title; body = payload.text;
    }
    const observedAtMs = options.receivedAtMs;
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) fail('X_NOTIFICATION_INVALID_TIME');
    const event = normalizeEvent({ providerId: 'twitter', kind: 'new', sourceKey: authorAccountId || authorHandle.toLowerCase(),
        contentId: postId, url: postUrl, author: authorHandle,
        title: title || `@${authorHandle} の新しい投稿`, body, observedAtMs });
    return Object.freeze({ authorAccountId, authorHandle, event: Object.freeze(event) });
}

function matchesXMonitor(row, notification) {
    if (notification.authorAccountId !== null) return String(row.account_id) === notification.authorAccountId;
    return typeof row.account_handle === 'string' && row.account_handle.toLowerCase() === notification.authorHandle.toLowerCase();
}

function createXEventRouter(db, queue, options = {}) {
    const clock = options.clock || Date.now;
    const inspect = (row) => require('./x-processing-settings').inspectXMonitorProcessing(db.queryDatabase, row, clock(), {
        useLegacyUserInterval: options.useLegacyUserInterval === true,
    });
    async function boundTargets(lease) {
        if (!lease || !UUID.test(String(lease.subscriptionId || '')) || !/^\d{1,32}$/.test(String(lease.ownerUserId || '')))
            fail('X_NOTIFICATION_INBOX_INVALID');
        const rows = await db.queryDatabase("SELECT * FROM automation_x_monitors WHERE owner_user_id=? AND state<>'deleted' ORDER BY id", [lease.ownerUserId]);
        return rows.filter(row => {
            let settings;
            try { settings = JSON.parse(row.notification_settings_json); } catch { return false; }
            return row.owner_user_id === lease.ownerUserId && settings?.subscriptionId === lease.subscriptionId && row.state !== 'deleted';
        });
    }
    const active = row => (row.enabled === undefined || Number(row.enabled) === 1) && (row.state === undefined || row.state === 'ready');
    async function hasTargets(lease, mode) {
        for (const row of await boundTargets(lease)) if (active(row) && (await inspect(row)).effectiveMode === mode) return true;
        return false;
    }
    async function routeReceived({ lease, inbox, payload, processingMode }) {
        if (!lease || !inbox || !/^[1-9]\d{0,19}$/.test(String(inbox.id || '')) || !UUID.test(String(lease.subscriptionId || ''))
            || !/^\d{1,32}$/.test(String(lease.ownerUserId || '')) || inbox.ownerUserId !== lease.ownerUserId || inbox.subscriptionId !== lease.subscriptionId
            || !['received', 'routed'].includes(inbox.status)
            || processingMode !== undefined && !['batch', 'realtime'].includes(processingMode)) fail('X_NOTIFICATION_INBOX_INVALID');
        const notification = normalizeXNotification(payload, { receivedAtMs: inbox.receivedAtMs });
        // Subscription ownership comes from the authenticated encrypted inbox,
        // never from a notification's author or a client-selected owner.
        const rows = await boundTargets(lease), results = [];
        let matched = 0, pending = false;
        for (const row of rows) {
            if (!matchesXMonitor(row, notification)) continue;
            matched++;
            // Pausing a matching monitor or deferring its batch delivery must
            // never turn a partially delivered receipt into terminal unmatched.
            if (!active(row) || processingMode === 'realtime' && (await inspect(row)).effectiveMode !== 'realtime') {
                pending = true; continue;
            }
            results.push(await queue.routeX({ ownerUserId: lease.ownerUserId, monitorId: String(row.id), subscriptionId: lease.subscriptionId,
                inboxEventId: inbox.id, payload, receivedAtMs: inbox.receivedAtMs,
                ...(processingMode === undefined ? {} : { processingMode }) }, clock()));
        }
        return { state: !matched ? 'unmatched' : pending || results.some(result => result.state === 'pending') ? 'pending' : 'routed', results };
    }
    return { routeReceived, hasRealtimeTargets: lease => hasTargets(lease, 'realtime'), hasBatchTargets: lease => hasTargets(lease, 'batch') };
}

module.exports = { createXEventRouter, normalizeXNotification, matchesXMonitor, inspectXWebPushPostCandidate };

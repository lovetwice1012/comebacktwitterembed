'use strict';

const { AutomationError } = require('./service');
const { normalizeEvent } = require('./engine');
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const POST_URL = /^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/status\/([1-9]\d{0,19})$/;
const POST_PATH = /^\/([A-Za-z0-9_]{1,15})\/status\/([1-9]\d{0,19})$/;
const fail = code => { throw new AutomationError(code, 'X通知の形式を確認できないため、通知は送信されていません。', 422); };
const object = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => Object.hasOwn(descriptor, 'value'));
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));

function text(value, maximum, code = 'X_NOTIFICATION_INVALID_TEXT') {
    if (typeof value !== 'string' || value.length > maximum
        || [...value].some(character => { const code = character.charCodeAt(0); return code < 32 && ![9, 10, 13].includes(code) || code === 127; })) fail(code);
}

// The public X service worker (https://x.com/sw.js, inspected 2026-10-14)
// reads event.data.json() as title/body/data and declares tweet_id, uri,
// user_id and type in data. Its user_id does NOT establish the post author.
// Adapt only an explicit post permalink whose ID agrees with tweet_id. No
// title parsing, recipient-ID inference, URL fetching or private event fallback.
// Source SHA-256 and the remaining live-push acceptance boundary are documented
// in docs/angelic-angel/x-webpush-adapter.md.
function inspectXWebPushPostCandidate(payload) {
    if (!keys(payload, ['title', 'body', 'tag', 'icon', 'timestamp', 'data'])
        || !keys(payload.data, ['bundle_text', 'impression_id', 'lang', 'multi_body', 'multi_title', 'multi_uri',
            'scribe_target', 'silent', 'totalCount', 'tweet_id', 'type', 'uri', 'user_id', 'xchat_delete', 'xchat_message'])) fail('X_NOTIFICATION_UNSUPPORTED');
    text(payload.title, 300);
    if (payload.body !== undefined) text(payload.body, 10000);
    for (const field of ['tag', 'icon']) if (payload[field] !== undefined) text(payload[field], 4096);
    if (payload.timestamp !== undefined && !((typeof payload.timestamp === 'number' && Number.isFinite(payload.timestamp))
        || typeof payload.timestamp === 'string' && /^\d{1,16}$/.test(payload.timestamp))) fail('X_NOTIFICATION_INVALID_TIME');
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
    if (typeof data.tweet_id !== 'string' || !/^[1-9]\d{0,19}$/.test(data.tweet_id)) fail('X_NOTIFICATION_INVALID_POST');
    const match = typeof data.uri === 'string' && (POST_URL.exec(data.uri) || POST_PATH.exec(data.uri));
    if (!match || match[2] !== data.tweet_id || ['i', 'intent'].includes(match[1].toLowerCase())) fail('X_NOTIFICATION_INVALID_POST');
    // A canonical permalink proves only the referenced post identity. Likes
    // and other notifications may link to the same post, so this inspection
    // result has no event kind and MUST NOT grant delivery admission.
    return Object.freeze({ authorAccountId: null, authorHandle: match[1], postId: match[2],
        postUrl: `https://x.com/${match[1]}/status/${match[2]}`, title: payload.title,
        ...(payload.body === undefined ? {} : { body: payload.body }) });
}

// Only the explicit internal contract is admitted to delivery. X's official
// source establishes an envelope, but not an enum proving a new-post event;
// that form stays unsupported until a genuine post-type fixture is verified.
function normalizeXNotification(payload, options = {}) {
    if (typeof payload === 'string' || Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
        try {
            const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
            if (bytes.byteLength > 64 * 1024) fail('X_NOTIFICATION_UNSUPPORTED');
            payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch { fail('X_NOTIFICATION_UNSUPPORTED'); }
    }
    if (!keys(payload, ['notificationType', 'url', 'author', 'title', 'text']) || payload.notificationType !== 'tweet') fail('X_NOTIFICATION_UNSUPPORTED');
    const match = typeof payload.url === 'string' && POST_URL.exec(payload.url);
    if (!match || !keys(payload.author, ['id', 'handle'])) fail('X_NOTIFICATION_INVALID_POST');
    const authorHandle = payload.author.handle;
    if (typeof authorHandle !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(authorHandle) || authorHandle.toLowerCase() !== match[1].toLowerCase()) fail('X_NOTIFICATION_INVALID_AUTHOR');
    const authorAccountId = payload.author.id ?? null;
    if (authorAccountId !== null && (typeof authorAccountId !== 'string' || !/^[1-9]\d{0,19}$/.test(authorAccountId))) fail('X_NOTIFICATION_INVALID_AUTHOR');
    for (const [field, maximum] of [['title', 300], ['text', 10000]]) if (payload[field] !== undefined) text(payload[field], Number(maximum));
    const observedAtMs = options.receivedAtMs;
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) fail('X_NOTIFICATION_INVALID_TIME');
    const event = normalizeEvent({ providerId: 'twitter', kind: 'new', sourceKey: authorAccountId || authorHandle.toLowerCase(),
        contentId: match[2], url: `https://x.com/${match[1]}/status/${match[2]}`, author: authorHandle,
        title: payload.title || `@${authorHandle} の新しい投稿`, body: payload.text, observedAtMs });
    return Object.freeze({ authorAccountId, authorHandle, event: Object.freeze(event) });
}

function matchesXMonitor(row, notification) {
    if (notification.authorAccountId !== null) return String(row.account_id) === notification.authorAccountId;
    return typeof row.account_handle === 'string' && row.account_handle.toLowerCase() === notification.authorHandle.toLowerCase();
}

function createXEventRouter(db, queue, options = {}) {
    const clock = options.clock || Date.now;
    async function routeReceived({ lease, inbox, payload }) {
        if (!lease || !inbox || !/^[1-9]\d{0,19}$/.test(String(inbox.id || '')) || !UUID.test(String(lease.subscriptionId || ''))
            || !/^\d{1,32}$/.test(String(lease.ownerUserId || '')) || inbox.ownerUserId !== lease.ownerUserId || inbox.subscriptionId !== lease.subscriptionId
            || !['received', 'routed'].includes(inbox.status)) fail('X_NOTIFICATION_INBOX_INVALID');
        const notification = normalizeXNotification(payload, { receivedAtMs: inbox.receivedAtMs });
        // Subscription ownership comes from the authenticated encrypted inbox,
        // never from a notification's author or a client-selected owner.
        const rows = await db.queryDatabase("SELECT * FROM automation_x_monitors WHERE owner_user_id=? AND state<>'deleted' AND enabled=1 ORDER BY id", [lease.ownerUserId]);
        const results = [];
        for (const row of rows) {
            let settings;
            try { settings = JSON.parse(row.notification_settings_json); } catch { continue; }
            if (row.owner_user_id !== lease.ownerUserId || settings?.subscriptionId !== lease.subscriptionId || !matchesXMonitor(row, notification)) continue;
            results.push(await queue.routeX({ ownerUserId: lease.ownerUserId, monitorId: String(row.id), subscriptionId: lease.subscriptionId,
                inboxEventId: inbox.id, payload, receivedAtMs: inbox.receivedAtMs }, clock()));
        }
        return { state: results.some(result => result.state === 'pending') ? 'pending' : 'routed', results };
    }
    return { routeReceived };
}

module.exports = { createXEventRouter, normalizeXNotification, matchesXMonitor, inspectXWebPushPostCandidate };

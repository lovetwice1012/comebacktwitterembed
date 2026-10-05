'use strict';

const {
    MINUTE,
    dateMs,
    monitorError,
    requestJson,
    sourceError,
    urlFromInput,
} = require('../autoWatch/_shared');

function normalizeSource(input) {
    const raw = String(input || '').trim();
    if (!raw) throw sourceError('Twitch requires a channel login or channel URL.');
    let login = raw.replace(/^@/, '');
    const url = urlFromInput(raw);
    if (url) {
        if (!/(^|\.)twitch\.tv$/i.test(url.hostname)) throw sourceError('Twitch source must be a twitch.tv channel URL.');
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length !== 1) throw sourceError('Twitch source must be a channel URL.');
        login = parts[0];
    }
    if (!/^[A-Za-z0-9_]{3,25}$/.test(login)) throw sourceError('Invalid Twitch channel login.');
    return { sourceKey: login.toLowerCase(), sourceUrl: `https://www.twitch.tv/${login}` };
}

async function fetch(source, context) {
    const payload = {
        operationName: 'AutoWatchChannelMetadata',
        variables: { login: source.source_key },
        query: `query AutoWatchChannelMetadata($login: String!) {
            user(login: $login) { id login stream { id title createdAt } }
        }`,
    };
    const response = await requestJson(context, 'https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: {
            // Public browser client identifier, not an OAuth/app token.
            'Client-ID': process.env.TWITCH_GQL_CLIENT_ID || 'kimne78kx3ncx6brgo4mv6wki5h1ko',
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify(payload),
    });
    const user = response.body?.data?.user;
    if (response.body?.errors?.length || user && !Object.hasOwn(user, 'stream')) throw monitorError('AUTO_WATCH_GUEST_CONTENT_UNAVAILABLE', 'Twitch did not return a complete guest channel state.');
    if (!user) throw monitorError('AUTO_WATCH_SOURCE_NOT_FOUND', 'Twitch channel was not found or is not guest-visible.', { retryAfterMs: 6 * 60 * MINUTE });
    const stream = user.stream;
    const items = stream ? [{
        contentId: stream.id,
        url: `https://www.twitch.tv/${source.source_key}`,
        publishedAtMs: dateMs(stream.createdAt),
        title: stream.title || null,
    }] : [];
    return { items, state: source.state || {}, etag: response.etag, lastModified: response.lastModified, rateLimit: response.rateLimit };
}

module.exports = {
    id: 'twitch',
    label: 'Twitch',
    guestOnly: true,
    minPollMs: 15 * MINUTE,
    defaultPollMs: 15 * MINUTE,
    globalSpacingMs: 5000,
    requestCost: 1,
    normalizeSource,
    fetch,
    _internal: { normalizeSource },
};

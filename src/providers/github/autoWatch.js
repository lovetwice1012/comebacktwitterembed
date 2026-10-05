'use strict';

const {
    HOUR,
    MINUTE,
    monitorError,
    conditionalHeaders,
    dateMs,
    dedupeItems,
    requestJson,
    sourceError,
    urlFromInput,
} = require('../autoWatch/_shared');

function normalizeSource(input) {
    const raw = String(input || '').trim();
    if (!raw) throw sourceError('GitHub requires an account name or profile URL.');
    let login = raw;
    const url = urlFromInput(raw);
    if (url) {
        if (!/(^|\.)github\.com$/i.test(url.hostname)) throw sourceError('GitHub source must be a github.com profile URL.');
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length !== 1) throw sourceError('GitHub account monitoring accepts a profile, not a repository URL.');
        login = parts[0];
    }
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) throw sourceError('Invalid GitHub account name.');
    return { sourceKey: login.toLowerCase(), sourceUrl: `https://github.com/${login}` };
}

function eventUrl(event) {
    const repoName = String(event?.repo?.name || '');
    if (!/^[^/]+\/[^/]+$/.test(repoName)) return null;
    const root = `https://github.com/${repoName}`;
    const payload = event?.payload || {};
    if (event.type === 'PushEvent' && /^[0-9a-f]{7,64}$/i.test(payload.head || '')) return `${root}/commit/${payload.head}`;
    if (event.type === 'ReleaseEvent' && payload.release?.html_url) return payload.release.html_url;
    if (event.type === 'IssuesEvent' && Number.isInteger(payload.issue?.number)) return `${root}/issues/${payload.issue.number}`;
    if (event.type === 'IssueCommentEvent' && Number.isInteger(payload.issue?.number)) return `${root}/issues/${payload.issue.number}`;
    if (event.type === 'PullRequestEvent' && Number.isInteger(payload.pull_request?.number)) return `${root}/pull/${payload.pull_request.number}`;
    if (event.type === 'PullRequestReviewEvent' && Number.isInteger(payload.pull_request?.number)) return `${root}/pull/${payload.pull_request.number}`;
    if (event.type === 'ForkEvent' && payload.forkee?.html_url) return payload.forkee.html_url;
    return root;
}

async function fetch(source, context) {
    const response = await requestJson(context, `https://api.github.com/users/${encodeURIComponent(source.source_key)}/events/public?per_page=100`, {
        headers: conditionalHeaders(source, {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2026-03-10',
            'User-Agent': 'ComebackTwitterEmbed-auto-watch',
        }),
    });
    if (response.notModified) return { notModified: true, state: source.state || {}, etag: response.etag, lastModified: response.lastModified, rateLimit: response.rateLimit };
    if (!Array.isArray(response.body)) throw monitorError('AUTO_WATCH_GUEST_CONTENT_UNAVAILABLE', 'GitHub did not return an event list.');
    const items = dedupeItems((Array.isArray(response.body) ? response.body : []).map(event => ({
        contentId: event?.id,
        url: eventUrl(event),
        publishedAtMs: dateMs(event?.created_at),
        title: event?.type || null,
        kind: event?.type || undefined,
        author: event?.actor?.login || undefined,
        body: typeof event?.payload?.release?.body === 'string' ? event.payload.release.body : undefined,
    })));
    return { items, state: source.state || {}, etag: response.etag, lastModified: response.lastModified, rateLimit: response.rateLimit };
}

module.exports = {
    id: 'github',
    label: 'GitHub',
    guestOnly: true,
    // GitHub documents 60 unauthenticated REST requests/hour. This watcher
    // allocates only 30, and the six-hour interval is user-approved latency.
    minPollMs: 6 * HOUR,
    defaultPollMs: 6 * HOUR,
    hourlyRequestBudget: 30,
    globalSpacingMs: 2 * MINUTE,
    requestCost: 1,
    normalizeSource,
    fetch,
    _internal: { eventUrl, normalizeSource },
};

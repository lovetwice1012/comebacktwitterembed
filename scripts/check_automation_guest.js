'use strict';
// Explicit, one-shot, read-only upstream smoke check. No production DB, tokens,
// saved subscriptions, Discord connections, or background runner are loaded.
const fs = require('node:fs');
const path = require('node:path');
const rawFetch = require('node-fetch');
delete process.env.TWITCH_GQL_CLIENT_ID;
const watch = require('../src/providers/autoWatch');
async function main() {
    const [providerId, input] = process.argv.slice(2);
    if (!providerId || !input) throw new Error('Usage: node scripts/check_automation_guest.js <provider> <public-account-url-or-id>');
    const normalized = watch.normalizeSource(providerId, input);
    const report = { at: new Date().toISOString(), providerId, source: normalized.sourceUrl, requests: [], status: 'not-run', subscriptionsChanged: 0, messagesSent: 0 };
    const fetch = async (url, options) => {
        if (report.requests.length >= 4) throw new Error('SMOKE_REQUEST_LIMIT');
        const headers = new rawFetch.Headers(options?.headers);
        for (const name of ['authorization', 'cookie', 'x-api-key']) if (headers.has(name)) throw new Error('SMOKE_CREDENTIAL_REJECTED');
        const request = { host: new URL(url).hostname, method: options?.method || 'GET' }; report.requests.push(request);
        const result = await rawFetch(url, { ...options, headers, timeout: 15000, follow: 1, size: 8 * 1024 * 1024 });
        request.status = result.status;
        request.remaining = result.headers.get('x-ratelimit-remaining');
        return result;
    };
    try {
        const result = await watch.fetchSource({ provider_id: providerId, source_key: normalized.sourceKey, state_json: '{}' }, { fetch, config: { autoWatch: { enableGuestCrawls: true, httpTimeoutMs: 15000 } } });
        report.status = 'fetched'; report.items = result.items?.length || 0; report.etagProvided = !!result.etag;
        // Zero items is not proof of complete discovery (could be off-air,
        // an empty profile, missing guest hydration, or a changed parser).
        report.discoveryVerified = report.items > 0;
    } catch (error) { report.status = 'failed'; report.errorCode = error.code || error.type || 'GUEST_CHECK_FAILED'; process.exitCode = 1; }
    const folder = path.resolve(__dirname, '../docs/audits/remediation'); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `guest-${providerId}.json`), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

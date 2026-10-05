'use strict';

// Run: node scripts/benchmark_main_instagram_cache.js
// Offline only: real Instagram client/parser, synthetic HTML and clock, no HTTP.
// Baseline is an explicit model of the old successful HTML-profile cache path;
// it does not model API failures/backoff, media extraction or network latency.
// Each sample runs in a fresh process with GC exposed. JSON goes to stdout.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { performance } = require('node:perf_hooks');
const { createInstagramClient } = require('../src/providers/instagram/client');
const { normalizeProfileHtmlData } = require('../src/providers/instagram/instagramSourceParser');
const { CACHE_TTL_MS } = require('../src/providers/instagram/constants');

const PROFILES = 10_000;
const TRIALS = 5;
const WARMUP = 200;
const HOT_READS = 1000;
const START = 1_800_000_000_000;
const IDLE_MS = 31 * 60 * 1000;
const BIO_LENGTH = 1024;

// Legacy policy: unbounded Map; only delete expired entries for a revisited key.
// The shared production parser avoids duplicating the transport/parser code.
function createLegacyProfileCache(fetch) {
    const entries = new Map();
    return {
        async fetchProfileData(username) {
            const key = `profile:${username.toLowerCase()}`;
            const cached = entries.get(key);
            if (cached && cached.expiresAt > Date.now()) return cached.data;
            if (cached) entries.delete(key);
            const res = await fetch(`https://www.instagram.com/${username}/`);
            assert.ok(res.ok);
            const data = normalizeProfileHtmlData(username, await res.text());
            assert.ok(data);
            entries.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
            return data;
        },
        getCacheStats: () => ({ size: entries.size, maxEntries: null, ttlMs: CACHE_TTL_MS }),
        clearCache: () => entries.clear(),
    };
}

function profileHtml(username) {
    const bio = `${username}: ${'b'.repeat(BIO_LENGTH)}`;
    return `<html><head>
        <meta property="og:title" content="Artist (@${username})">
        <meta name="description" content="123 Followers, 4 Following, 5 Posts - Artist on Instagram: &quot;${bio}&quot;">
        <meta property="og:image" content="https://scontent.cdninstagram.com/${username}.jpg">
    </head></html>`;
}

function heapBytes() {
    global.gc();
    return process.memoryUsage().heapUsed;
}

async function runCase(version) {
    assert.ok(['before', 'after'].includes(version));
    assert.equal(typeof global.gc, 'function', 'child process must enable GC');
    let now = START;
    let requests = 0;
    const originalNow = Date.now;
    Date.now = () => now;
    try {
        const fetch = async url => {
            const target = new URL(url);
            assert.equal(target.origin, 'https://www.instagram.com');
            assert.match(target.pathname, /^\/[a-z0-9_]+\/$/i, 'unexpected fallback request');
            requests++;
            const html = profileHtml(target.pathname.split('/')[1]);
            return { ok: true, status: 200, text: async () => html };
        };
        const factory = version === 'before' ? createLegacyProfileCache : createInstagramClient;
        let warmupClient = factory(fetch);
        for (let i = 0; i < WARMUP; i++) await warmupClient.fetchProfileData(`warm_${i}`);
        warmupClient.clearCache();
        warmupClient = null;
        requests = 0;

        const client = factory(fetch);
        const outputHash = createHash('sha256');
        const emptyHeapBytes = heapBytes();
        const start = performance.now();
        for (let i = 0; i < PROFILES; i++) {
            const profile = await client.fetchProfileData(`profile_${String(i).padStart(5, '0')}`);
            outputHash.update(JSON.stringify(profile));
        }
        const fillMs = performance.now() - start;
        assert.equal(requests, PROFILES);
        const afterFill = {
            entries: client.getCacheStats().size,
            heapDeltaBytes: heapBytes() - emptyHeapBytes,
        };
        const hotStart = performance.now();
        for (let i = 0; i < HOT_READS; i++) await client.fetchProfileData('PROFILE_09999');
        const hotReadsMs = performance.now() - hotStart;
        assert.equal(requests, PROFILES, 'hot reads must not fetch or extend TTL');

        now += IDLE_MS;
        const idleEntries = client.getCacheStats().size;
        const cleanupStart = performance.now();
        outputHash.update(JSON.stringify(await client.fetchProfileData('after_expiry')));
        const cleanupMs = performance.now() - cleanupStart;
        const afterExpiryAccess = {
            entries: client.getCacheStats().size,
            // All earlier writes used START; the one new entry is the only fresh one.
            expiredEntries: client.getCacheStats().size - 1,
            heapDeltaBytes: heapBytes() - emptyHeapBytes,
        };
        assert.equal(afterFill.entries, version === 'before' ? PROFILES : 1024);
        assert.equal(afterExpiryAccess.entries, version === 'before' ? PROFILES + 1 : 1);
        assert.equal(requests, PROFILES + 1);
        client.clearCache();
        assert.equal(client.getCacheStats().size, 0);
        return {
            fillMs, hotReadsMs, cleanupMs, afterFill, idleEntries, afterExpiryAccess,
            requests, outputSha256: outputHash.digest('hex'),
        };
    } finally {
        Date.now = originalNow;
    }
}

function median(values) {
    return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

async function main() {
    if (process.argv[2] === '--case') {
        console.log(JSON.stringify(await runCase(process.argv[3])));
        return;
    }
    const samples = { before: [], after: [] };
    for (let trial = 0; trial < TRIALS; trial++) {
        // Alternate ordering to reduce any consistent first-run bias.
        for (const version of trial % 2 ? ['after', 'before'] : ['before', 'after']) {
            samples[version].push(JSON.parse(execFileSync(process.execPath,
                ['--expose-gc', __filename, '--case', version], { encoding: 'utf8' })));
        }
    }
    const expectedHash = samples.before[0].outputSha256;
    for (const sample of [...samples.before, ...samples.after]) assert.equal(sample.outputSha256, expectedHash);
    const summary = Object.fromEntries(Object.entries(samples).map(([version, values]) => [version, {
        medianFillMs: median(values.map(value => value.fillMs)),
        medianHotReadsMs: median(values.map(value => value.hotReadsMs)),
        medianCleanupMs: median(values.map(value => value.cleanupMs)),
        entriesAfterFill: values[0].afterFill.entries,
        medianHeapDeltaAfterFillBytes: median(values.map(value => value.afterFill.heapDeltaBytes)),
        entriesAfterIdle: values[0].idleEntries,
        entriesAfterExpiryAccess: values[0].afterExpiryAccess.entries,
        expiredEntriesAfterAccess: values[0].afterExpiryAccess.expiredEntries,
        medianHeapDeltaAfterExpiryAccessBytes: median(values.map(value => value.afterExpiryAccess.heapDeltaBytes)),
        requests: values[0].requests,
    }]));
    console.log(JSON.stringify({
        kind: 'offline synthetic; mocked HTTP/clock; successful HTML profiles only',
        baseline: 'legacy-profile-ttl-v1: explicit unbounded Map model; same production profile parser',
        runtime: process.version,
        workload: { profiles: PROFILES, trials: TRIALS, warmup: WARMUP, hotReads: HOT_READS,
            startMs: START, idleMs: IDLE_MS, bioLength: BIO_LENGTH, ttlMs: CACHE_TTL_MS, seed: 'none; sequential IDs' },
        sourceSha256: Object.fromEntries([
            ['client', require.resolve('../src/providers/instagram/client')],
            ['parser', require.resolve('../src/providers/instagram/instagramSourceParser/parsing')],
            ['benchmark', __filename],
        ].map(([name, file]) => [name, createHash('sha256').update(readFileSync(file)).digest('hex')])),
        limitations: [
            'Heap deltas include process/JIT overhead and synthetic strings; entry counts are deterministic.',
            'Timing compares a legacy success-path model to the actual client; no production latency claim.',
            'Expired entries are reclaimed on the next cache access; idle clients retain at most 1024 entries.',
            'The cap limits entry count, not bytes per profile or media payload.',
        ],
        outputSha256: expectedHash, summary, samples,
    }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });

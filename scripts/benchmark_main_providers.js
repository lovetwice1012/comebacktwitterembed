'use strict';

// Offline, deterministic fixtures; stdout is JSON and this script writes no files.
// Actual before/after: node scripts/benchmark_main_providers.js --baseline-dir <dir>
// <dir> contains src/providers/{github/client.js,autoWatch/runner.js} from before
// the change (plus an optional manifest.json of file SHA-256 hashes).
// Without a snapshot, explicitly labelled compact behavioural models are used:
// unconditional repository enrichment and the original array-scan cursor merge.
// Models are reproducible comparison references, NOT historical source snapshots.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, wrap } = require('node:module');
const { performance } = require('node:perf_hooks');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const CLIENT = 'src/providers/github/client.js';
const RUNNER = 'src/providers/autoWatch/runner.js';
const VISUALS = 'src/providers/github/visuals.js';

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

// Execute both versions in the same V8 realm, resolving unchanged dependencies
// against the checkout. Runner infrastructure is stubbed: no DB, timers or HTTP.
function loadSource(relativePath, source, overrides = {}) {
    const filename = path.join(ROOT, relativePath);
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInThisContext(wrap(source), { filename })(module.exports, id => (
        Object.hasOwn(overrides, id) ? overrides[id] : localRequire(id)
    ), module, filename, path.dirname(filename));
    return module.exports;
}

function loadRunner(source) {
    return loadSource(RUNNER, source, {
        './store': {}, './index': {}, 'node-fetch': {},
        '../../providerFetch': { withDeadline: () => null },
        '../../errorTracking': {}, '../../recoveryBootstrap': {},
    })._internal;
}

function baselineCursorModel(cursor, observed, acknowledged, { seed = false } = {}) {
    const old = new Set(cursor.seenContentIds);
    const accepted = new Set((acknowledged || []).map(item => String(item.contentId)));
    const ids = [];
    const add = id => { if (id && !ids.includes(id)) ids.push(id); };
    for (const item of observed) {
        const id = String(item.contentId);
        if (seed || old.has(id) || accepted.has(id)) add(id);
    }
    for (const id of cursor.seenContentIds) add(String(id));
    return { ...cursor, seenContentIds: ids.slice(0, 5000) };
}

function loadVersions(baselineDir) {
    const currentClient = fs.readFileSync(path.join(ROOT, CLIENT), 'utf8');
    const currentRunner = fs.readFileSync(path.join(ROOT, RUNNER), 'utf8');
    const currentFactory = loadSource(CLIENT, currentClient).createGitHubClient;
    const after = { createGitHubClient: currentFactory, advanceCursor: loadRunner(currentRunner).advanceCursor };
    const hashes = Object.fromEntries([CLIENT, RUNNER, VISUALS].map(file => [file, sha256(fs.readFileSync(path.join(ROOT, file)))]));
    if (!baselineDir) {
        return {
            after,
            before: {
                // The old repository branch always fetched the full default
                // enrichment, regardless of presentation settings. Repo only.
                createGitHubClient: fetch => {
                    const client = currentFactory(fetch);
                    return { fetchGitHubData: parsed => {
                        assert.equal(parsed.type, 'repo', 'The model only covers repository enrichment');
                        return client.fetchGitHubData(parsed, {});
                    } };
                },
                advanceCursor: baselineCursorModel,
            },
            provenance: { kind: 'behavioural-model', description: 'Forced full repository enrichment using the current transport; original array-scan cursor algorithm.', currentSha256: hashes },
        };
    }
    const directory = path.resolve(baselineDir);
    const manifestPath = path.join(directory, 'manifest.json');
    const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
    const beforeHashes = {};
    for (const file of [CLIENT, RUNNER, VISUALS]) {
        const filename = path.join(directory, file);
        if (file === VISUALS && !fs.existsSync(filename)) continue;
        beforeHashes[file] = sha256(fs.readFileSync(filename));
        if (manifest?.files?.[file]?.sha256) assert.equal(beforeHashes[file], manifest.files[file].sha256, `Snapshot changed: ${file}`);
    }
    return {
        after,
        before: {
            createGitHubClient: loadSource(CLIENT, fs.readFileSync(path.join(directory, CLIENT), 'utf8')).createGitHubClient,
            advanceCursor: loadRunner(fs.readFileSync(path.join(directory, RUNNER), 'utf8')).advanceCursor,
        },
        provenance: { kind: 'source-snapshot', directory, beforeSha256: beforeHashes, currentSha256: hashes, dependencies: 'Unchanged helpers resolve from the current checkout; runner infrastructure is stubbed.' },
    };
}

function githubCases() {
    const cases = [{ name: 'default-generated', settings: {}, expectedRequests: 5 }];
    for (const card of ['generated', 'hidden', 'hosted']) {
        for (const language of [true, false]) {
            for (const breakdown of [true, false]) {
                cases.push({
                    name: `${card}-language-${language}-breakdown-${breakdown}`,
                    settings: {
                        github_card_style: card === 'hosted' ? 'github' : 'generated',
                        hidden_output_items: [card === 'hidden' && 'repo_card', !language && 'language', !breakdown && 'language_breakdown'].filter(Boolean),
                    },
                    expectedRequests: card === 'generated' ? 4 + Number(language || breakdown) : 1 + Number(breakdown),
                });
            }
        }
    }
    cases.push(
        { name: 'compact-generated', settings: { display_density: 'compact' }, expectedRequests: 4 },
        { name: 'compact-hosted', settings: { display_density: 'compact', github_card_style: 'github' }, expectedRequests: 1 },
        { name: 'hidden-string-settings', settings: { hidden_output_items: '["repo_card","language_breakdown"]' }, expectedRequests: 1 },
        { name: 'generated-link-only', settings: { media_display_mode: 'link_only' }, expectedRequests: 5 },
    );
    return cases;
}

function githubFixture({ statsUnavailable = false, avatarFallback = false } = {}) {
    const { encodePng, createPixelBuffer } = require('../src/providers/github/raster');
    const avatar = encodePng(1, 1, createPixelBuffer(1, 1, '#2468ac'));
    const parsed = { type: 'repo', owner: 'owner', repo: 'repo', canonicalUrl: 'https://github.com/owner/repo' };
    const repository = {
        name: 'repo', full_name: 'owner/repo', html_url: parsed.canonicalUrl,
        description: 'Fixed provider benchmark repository.', stargazers_count: 1234, forks_count: 56,
        watchers_count: 1234, open_issues_count: 7, language: 'JavaScript', license: { spdx_id: 'MIT' },
        topics: ['fixture', 'offline'], default_branch: 'main', pushed_at: '2026-01-19T12:00:00Z',
        created_at: '2025-01-01T00:00:00Z',
        owner: { login: 'owner', html_url: 'https://github.com/owner', avatar_url: 'https://avatars.example.test/owner.png' },
    };
    const requests = [];
    const fetch = async (url, options) => {
        requests.push({ url, method: options?.method || 'GET' });
        if (url === 'https://api.github.com/repos/owner/repo') return { ok: true, json: async () => structuredClone(repository) };
        if (url.endsWith('/stats/commit_activity')) return statsUnavailable ? { ok: false, status: 503 } : {
            ok: true, json: async () => [{ week: 1767484800, total: 7, days: [0, 1, 2, 0, 3, 1, 0] }],
        };
        if (url.endsWith('/commits?per_page=100')) return { ok: true, json: async () => [
            { commit: { committer: { date: '2026-01-05T00:00:00Z' } } },
            { commit: { committer: { date: '2026-01-06T00:00:00Z' } } },
        ] };
        if (url.endsWith('/languages')) return { ok: true, json: async () => ({ JavaScript: 8000, CSS: 2000 }) };
        if (url === 'https://avatars.example.test/owner.png?s=180') return { ok: true, buffer: async () => avatarFallback ? Buffer.from('invalid raster') : avatar };
        if (url === 'https://github.com/owner.png?size=180') return { ok: true, buffer: async () => avatar };
        assert.fail(`Unexpected fixture request: ${url}`);
    };
    return { parsed, requests, fetch };
}

async function extractFixture(factory, settings, fixtureOptions) {
    const fixture = githubFixture(fixtureOptions);
    const provider = loadSource('src/providers/github/index.js', fs.readFileSync(path.join(ROOT, 'src/providers/github/index.js'), 'utf8'), {
        './client': { createGitHubClient: factory },
        'node-fetch': fixture.fetch,
        '../../providerFetch': { withDeadline: fetch => fetch },
        '../../errorTracking': { recordProviderError: (_provider, error) => { throw error; } },
    });
    const message = { content: fixture.parsed.canonicalUrl, guild: { id: 'fixture-guild' }, author: { username: 'tester', id: 'fixture-user' } };
    return { output: await provider.extract(message, fixture.parsed.canonicalUrl, settings), requests: fixture.requests };
}

function cursorCases() {
    return [2293, 5000, 20000].flatMap(count => {
        const observed = Array.from({ length: count }, (_,index) => ({ contentId: String(count - index), url: `https://example.test/${count - index}` }));
        return [true, false].map(seed => ({
            name: `${count}-${seed ? 'seed' : 'repeat'}`,
            args: [{ seenContentIds: seed ? [] : observed.slice(20, 5020).map(item => item.contentId), baselineMaxNumericContentId: String(count - 20) }, observed, seed ? observed : observed.slice(0, 20), { seed }],
        }));
    });
}

function median(values) {
    return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

function measurePair(before, after, args, warmups, samples) {
    for (let i = 0; i < warmups; i++) { before(...args); after(...args); }
    const times = { before: [], after: [] };
    for (let i = 0; i < samples; i++) {
        for (const [label, fn] of i % 2 ? [['after', after], ['before', before]] : [['before', before], ['after', after]]) {
            const started = performance.now();
            fn(...args);
            times[label].push(performance.now() - started);
        }
    }
    return { beforeMedianMs: median(times.before), afterMedianMs: median(times.after), samplesMs: times };
}

async function benchmark({ baselineDir, samples = 11, warmups = 3 } = {}) {
    const { before, after, provenance } = loadVersions(baselineDir);
    const github = [];
    for (const item of githubCases()) {
        const previous = await extractFixture(before.createGitHubClient, item.settings);
        const current = await extractFixture(after.createGitHubClient, item.settings);
        assert.deepEqual(current.output, previous.output, item.name);
        assert.equal(previous.requests.length, 5, `Before requests: ${item.name}`);
        assert.equal(current.requests.length, item.expectedRequests, `After requests: ${item.name}`);
        github.push({ name: item.name, beforeRequests: previous.requests.length, afterRequests: current.requests.length,
            outputEquivalent: true, beforeUrls: previous.requests.map(x => x.url), afterUrls: current.requests.map(x => x.url) });
    }
    const cursors = cursorCases().map(item => {
        const previous = before.advanceCursor(...item.args);
        const current = after.advanceCursor(...item.args);
        assert.deepEqual(current, previous, item.name);
        const measured = measurePair(before.advanceCursor, after.advanceCursor, item.args, warmups, samples);
        return { name: item.name, outputEquivalent: true, retainedIds: current.seenContentIds.length,
            outputSha256: sha256(JSON.stringify(current)), ...measured, speedup: measured.beforeMedianMs / measured.afterMedianMs };
    });
    return { schemaVersion: 1, node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model,
        methodology: { workload: 'Local synthetic; no real HTTP, DB or Discord delivery; fixed fixture dates and ordered IDs, no random benchmark inputs', githubMetric: 'Actual extraction request counts and full SendStep equality (including generated PNG bytes)', cursorMetric: 'Synchronous wall time, alternating before/after order; assertions outside timing', samples, warmups },
        provenance, github, cursors };
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
        console.log('node scripts/benchmark_main_providers.js [--baseline-dir DIR] [--samples 11] [--warmups 3]\nJSON is written to stdout only. Without --baseline-dir, the baseline is an explicitly labelled behavioural model.');
    } else {
        const options = {};
        for (let i = 0; i < args.length; i += 2) {
            const [flag, value] = [args[i], args[i + 1]];
            if (!['--baseline-dir', '--samples', '--warmups'].includes(flag) || value === undefined) throw new Error(`Invalid argument: ${flag}`);
            if (flag === '--baseline-dir') options.baselineDir = value;
            else {
                const number = Number(value);
                if (!Number.isSafeInteger(number) || number < (flag === '--samples' ? 1 : 0) || number > 100) throw new Error(`Invalid ${flag}`);
                options[flag.slice(2)] = number;
            }
        }
        benchmark(options).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
    }
}

module.exports = { baselineCursorModel, cursorCases, extractFixture, githubCases, githubFixture, loadVersions, benchmark };

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadDashboard = require('./helpers/load-dashboard.cjs');
const { BoundedAsyncCache } = loadDashboard('lib/bounded-cache.ts');
const { loadSnapshotOnce, pruneReportEntries, withReportCacheMetadata } = loadDashboard('lib/report-cache.ts');

test('dashboard guild cache shares concurrent reads, retries failures and bounds retained sessions', async () => {
    let now = 0;
    let calls = 0;
    const cache = new BoundedAsyncCache(256, 60, () => now);
    const load = async () => ++calls;
    assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => cache.get('session', load))), Array(20).fill(1));
    now = 61;
    assert.equal(await cache.get('session', load), 2);
    await assert.rejects(cache.get('failed', async () => { throw new Error('offline'); }), /offline/);
    assert.equal(await cache.get('failed', async () => 'recovered'), 'recovered');
    for (let i = 0; i < 2000; i++) await cache.get(String(i), load);
    assert.equal(cache.size, 256);
    now = 122;
    await cache.get('new', load);
    assert.equal(cache.size, 1);
});

test('persisted snapshots finish loading before all concurrent readers proceed and failures are retryable', async () => {
    const state = { persistentSnapshotLoaded: false };
    let release;
    let calls = 0;
    let finished = 0;
    const load = () => { calls++; return new Promise(resolve => { release = resolve; }); };
    const waiting = Array.from({ length: 20 }, () => loadSnapshotOnce(state, load).then(() => finished++));
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(finished, 0);
    release();
    await Promise.all(waiting);
    assert.equal(finished, 20);
    const failed = { persistentSnapshotLoaded: false };
    await loadSnapshotOnce(failed, async () => { throw new Error('offline'); });
    assert.equal(failed.persistentSnapshotLoaded, false);
    await loadSnapshotOnce(failed, async () => {});
    assert.equal(failed.persistentSnapshotLoaded, true);
});

test('report insertion prunes idle entries immediately while retaining builds in progress', () => {
    const entries = new Map();
    const inFlight = { lastAccessedAtMs: 0, refreshPromise: new Promise(() => {}) };
    entries.set('running', inFlight);
    for (let i = 0; i < 2000; i++) {
        entries.set(String(i), { lastAccessedAtMs: i, refreshPromise: null });
        pruneReportEntries(entries, 12, 3600000, i);
        assert.ok(entries.size <= 12);
    }
    assert.equal(entries.get('running'), inFlight);
    pruneReportEntries(entries, 12, 3600000, 4000000);
    assert.equal(entries.size, 1);
});

test('poll response preserves the full JSON payload without copying report tables', () => {
    const snapshot = { summary: { events: '1234567890123456' }, rows: [{ guild_id: 'anonymous', count: 5 }] };
    const metadata = { ready: true, refreshing: false };
    const result = withReportCacheMetadata(snapshot, metadata);
    assert.equal(JSON.stringify(result), JSON.stringify({ ...snapshot, cache: metadata }));
    assert.equal(result.rows, snapshot.rows);
    assert.equal(result.summary, snapshot.summary);
});

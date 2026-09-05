'use strict';
// Offline comparison. SQLite checks relational equivalence; it is not a MySQL
// production latency measurement. No application credentials are needed.
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { originalQuery, detailedInterestQuery, createFixture, normalize } = require('./test/helpers/interest-fixture.cjs');
const loadDashboard = require('./test/helpers/load-dashboard.cjs');
const { withReportCacheMetadata } = loadDashboard('lib/report-cache.ts');

const rows = [];
for (let user = 0; user < 50; user++) {
    for (let post = 0; post < 200; post++) rows.push({
        time: 150, user: String(user), provider: post < 100 ? 'twitter' : 'youtube',
        account: post < 100 ? 'a' : 'b', guild: `g${post % 2}`, type: 'video',
    });
}
const db = createFixture(rows);
function median(work) {
    const samples = [];
    work();
    for (let i = 0; i < 5; i++) {
        const start = performance.now();
        work();
        samples.push(performance.now() - start);
    }
    return Math.round(samples.sort((a, b) => a - b)[2] * 100) / 100;
}
try {
    const where = 'target.occurred_at_ms >= ? AND target.occurred_at_ms <= ?';
    const before = db.prepare(originalQuery(where));
    const after = db.prepare(detailedInterestQuery(where));
    const args = [100, 200, 100, 200, 200];
    assert.deepEqual(normalize(before.all(...args)), normalize(after.all(...args)));
    const admin = loadDashboard('lib/admin-data.ts', {
        '@/lib/prisma': { prisma: {} }, '@/lib/env': {}, '@/lib/audit-log': {},
        '@/lib/discord': {}, '@/lib/settings-db': {}, '@/lib/settings-catalog': {},
    }, ['clientSafe']);
    const snapshot = { generatedAt: '2026-09-05T00:00:00Z', rows: Array.from({ length: 5000 }, (_, i) => ({
        provider_id: 'twitter', account_key: `account-${i}`, content_events: i * 100,
        unique_users: i + 5, metadata: { metric: 'shares', ratio: 0.3 },
    })) };
    const cache = { ready: true, refreshing: false };
    const renderBefore = () => JSON.stringify(admin.__test.clientSafe({ ...snapshot, cache }));
    const renderAfter = () => JSON.stringify(withReportCacheMetadata(snapshot, cache));
    assert.equal(renderBefore(), renderAfter());
    console.log(JSON.stringify({
        runtime: process.version,
        interestQuery: {
            engine: 'node:sqlite in-memory', inputEvents: rows.length, users: 50,
            resultRows: after.all(...args).length, identicalResults: true,
            beforeMedianMs: median(() => before.all(...args)), afterMedianMs: median(() => after.all(...args)),
        },
        reportPolling: {
            reportRows: snapshot.rows.length, jsonBytes: Buffer.byteLength(renderAfter()), identicalJson: true,
            beforeMedianMs: median(renderBefore), afterMedianMs: median(renderAfter),
        },
        settingsQueries: { providers: 12, before: 59, after: 11, summaryAfter: 1, evidence: 'dashboard-settings-performance.test.js' },
    }, null, 2));
} finally { db.close(); }

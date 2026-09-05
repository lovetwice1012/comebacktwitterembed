'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const loadDashboard = require('./helpers/load-dashboard.cjs');

const snapshot = { generatedAt: new Date().toISOString(), summary: { content: { content_events: 12 }, analytics: {} }, rawSamples: [] };
let release;
const stored = new Promise(resolve => { release = resolve; });
const queries = [];
const admin = loadDashboard('lib/admin-data.ts', {
    '@/lib/prisma': { prisma: { $queryRawUnsafe: async sql => {
        queries.push(sql);
        assert.match(sql, /FROM bot_admin_report_snapshots/);
        return stored;
    } } },
    '@/lib/env': { getDashboardAdminAnalyticsPrewarm: () => false, getClientId: () => 'test' },
    '@/lib/audit-log': {}, '@/lib/discord': {}, '@/lib/settings-db': {}, '@/lib/settings-catalog': {},
}, ['getAdminDetailedAnalyticsCacheEntry', 'normalizeDetailedAnalyticsFilters']);

after(() => {
    clearInterval(globalThis.__cbteAdminDetailedAnalyticsCache?.timer);
});

test('simultaneous analytics requests reuse a persisted complete report without triggering fresh aggregates', async () => {
    const pending = Array.from({ length: 25 }, () => admin.getAdminDetailedAnalytics({}));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(queries.length, 1);
    release([{ payload_json: JSON.stringify(snapshot), generated_at_ms: Date.now() }]);
    const responses = await Promise.all(pending);
    assert.ok(responses.every(response => response.cache.ready && !response.cache.refreshing));
    assert.deepEqual(responses[0].summary, snapshot.summary);
    assert.equal(responses[0].summary, responses[24].summary);
    assert.equal(queries.length, 1);
});

test('real detailed report cache stays bounded during a burst of distinct filters', () => {
    for (let i = 0; i < 100; i++) {
        admin.__test.getAdminDetailedAnalyticsCacheEntry(admin.__test.normalizeDetailedAnalyticsFilters({ guildId: String(i) }));
        assert.ok(globalThis.__cbteAdminDetailedAnalyticsCache.entries.size <= 12);
    }
});

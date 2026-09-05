'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/load-dashboard.cjs');

function reportBuilder(fail = false) {
  const queries = [];
  const query = async sql => { queries.push(String(sql)); if (fail && String(sql).includes('bot_provider_content_facets')) throw new Error('facet query failed'); return []; };
  const admin = load('lib/admin-data.ts', {
    '@/lib/prisma': { prisma: { $queryRawUnsafe: query, $queryRaw: query } },
    '@/lib/env': { getDashboardAdminAnalyticsPrewarm: () => false, getClientId: () => 'test', getBotToken: () => 'test', getDatabaseUrl: () => 'configured' },
    '@/lib/audit-log': { ensureAuditLogTable: async () => {} },
    '@/lib/discord': { fetchBotGuildIds: async () => [] },
    '@/lib/settings-db': {},
    '@/lib/settings-catalog': { getCatalog: () => [], getProviderSpecs: () => [], providerLabel: value => value, text: value => value },
    '@/lib/table-counts': { countedTables: new Set(), loadExactTableCounts: async () => new Map() },
  });
  return { admin, queries };
}

test('headless report builds complete detailed and preview schemas without a Next server', async () => {
  const { admin, queries } = reportBuilder();
  for (const kind of ['overview', 'analytics', 'guild-preview', 'provider-preview']) {
    const value = await admin.buildAdminReportSnapshot(kind, { guildId: '123456789012345678', providerId: 'twitter', dateFrom: '2026-09-01T00:00', dateTo: '2026-09-02T00:00' });
    assert.equal(value.complete, true);
    assert.equal(value.kind, kind);
    if (kind !== 'overview') { assert.equal(value.filters.guildId, '123456789012345678'); assert.equal(value.report.window.startMs, Date.parse('2026-09-01T00:00:00+09:00')); }
    if (kind === 'analytics') {
      for (const section of ['summary', 'timeSeries', 'providerAccounts', 'providerReliability', 'valueDrivers', 'providerSegments', 'numericFacetStats', 'rawSamples', 'failureReasons']) assert.ok(section in value.report, section);
    } else if (kind === 'overview') { assert.ok(value.report.analytics); for (const section of ['analyticsQuality','derivedAggregates','seasonality30d','decisionInsights','autoExtract']) assert.ok(section in value.report.analytics, section); } else assert.ok(Object.keys(value.report.sections).length >= 10, 'full preview sections retained');
    assert.equal(value.report.cache, undefined, 'worker returns completed report, never an in-progress route cache');
  }
  assert.ok(queries.some(sql => sql.includes('bot_provider_content_facets')));
  assert.ok(queries.some(sql => sql.includes('bot_error_events')));
});

test('headless report rejects an incomplete build even if a query had an optional fallback', async () => {
  const { admin } = reportBuilder(true);
  await assert.rejects(admin.buildAdminReportSnapshot('analytics', {}), /facet query failed/);
});

test('report client retains all completed data on refresh failure and never computes inside Next', async () => {
  const originalFetch = global.fetch;
  const originalToken = process.env.ADMIN_AGENT_TOKEN;
  process.env.ADMIN_AGENT_TOKEN = 'test-report-token';
  const full = { summary: { content: { content_events: 42 } }, numericFacetStats: [{ avg_value: 100 }], rawSamples: [{ message_id: '123' }] };
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (options.method === 'POST') throw new Error('queue connection failed');
    return { ok: true, json: async () => ({ report: full, key: 'exact-filter-key', cache: { ready: true, refreshing: false, updatedAt: '2020-01-01T00:00:00Z' } }) };
  };
  try {
    const client = load('lib/admin-report-client.ts', { '@/lib/admin-agent': { adminAgentEndpoint: path => new URL(`http://127.0.0.1:30988/v1/${path}`) } });
    const result = await client.getIndependentAdminReport('analytics', { guildId: '123', eventType: 'provider_extract' }, 'owner', true);
    assert.deepEqual(result.rawSamples, full.rawSamples);
    assert.deepEqual(result.numericFacetStats, full.numericFacetStats);
    assert.equal(result.cache.ready, true);
    assert.match(result.cache.lastError, /queue connection failed/);
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[0].url).searchParams.get('filters'), '{"guildId":"123","eventType":"provider_extract"}');
    assert.deepEqual(JSON.parse(calls[1].options.body), { filters: { guildId: '123', eventType: 'provider_extract' }, force: true });
    assert.equal(calls[1].options.headers['x-admin-actor'], 'owner');
  } finally { global.fetch = originalFetch; if (originalToken === undefined) delete process.env.ADMIN_AGENT_TOKEN; else process.env.ADMIN_AGENT_TOKEN = originalToken; }
});

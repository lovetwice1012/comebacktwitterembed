'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../../dashboard/node_modules/react');
const { renderToStaticMarkup } = require('../../dashboard/node_modules/react-dom/server');
const load = require('./helpers/load-dashboard.cjs');
const { reportForDashboard } = load('lib/admin-report-client.ts');
const kinds = { overview: 'OverviewPanel', analytics: 'DetailedAnalyticsPanel', 'guild-preview': 'GuildAdminPreviewPanel', 'provider-preview': 'ProviderMarketingPreviewPanel' };
const structuredError = { code: 'WORKER_UNCONFIGURED', details: { endpoint: 'report-worker', state: 'not-configured' } };

function renderPanel(kind, payload) {
  let stateIndex = 0;
  // Seed the existing AJAX payload state while retaining real React rendering/hooks.
  const hooks = kind === 'overview' ? React : { ...React, useState(initial) { stateIndex++; return React.useState(stateIndex === 3 ? payload : initial); } };
  const module = load('components/admin/admin-console.tsx', { react: hooks }, Object.values(kinds));
  const props = kind === 'overview' ? { overview: payload, onRefresh() {}, refreshing: false } : {};
  return renderToStaticMarkup(React.createElement(module.__test[kinds[kind]], props));
}

for (const kind of Object.keys(kinds)) {
  test(`${kind}: actual metadata-only payload with structured worker error renders unavailable, never a client exception`, () => {
    const metadataOnly = { reportMetadata: { kind }, cache: { ready: false, refreshing: false, lastError: structuredError } };
    const rawHtml = renderPanel(kind, metadataOnly);
    assert.match(rawHtml, /レポートを利用できません/);
    assert.match(rawHtml, /WORKER_UNCONFIGURED/);
    assert.match(rawHtml, /data-report-state="failed"/);
    assert.match(rawHtml, /再試行/);
    if (kind !== 'overview') { assert.match(rawHtml, /placeholder="サービスID"/); assert.match(rawHtml, /この条件のレポートを作成/); }
    const normalized = reportForDashboard(kind, { report: null, cache: metadataOnly.cache });
    assert.equal(typeof normalized.cache.lastError, 'string');
    assert.deepEqual(normalized.cache.lastErrorDetails, structuredError);
    assert.match(renderPanel(kind, normalized), /WORKER_UNCONFIGURED/);
  });

  test(`${kind}: pending and not-generated reports have distinct explicit states`, () => {
    const pending = reportForDashboard(kind, { report: null, actionId: 'report-action', cache: { ready: false, refreshing: true } });
    const pendingHtml = renderPanel(kind, pending);
    assert.match(pendingHtml, /data-report-state="pending"/);
    assert.match(pendingHtml, /レポートを生成中/);
    assert.match(pendingHtml, /report-action/);
    const idle = reportForDashboard(kind, { report: null, cache: { ready: false, refreshing: false } });
    assert.match(renderPanel(kind, idle), /レポートはまだ生成されていません/);
    assert.match(renderPanel(kind, idle), /生成を開始/);
  });
}

test('all four legacy panels retain complete previous report on a failed refresh, alongside readable failure and raw evidence', async () => {
  const query = async () => [];
  const admin = load('lib/admin-data.ts', {
    '@/lib/prisma': { prisma: { $queryRawUnsafe: query, $queryRaw: query } },
    '@/lib/env': { getDashboardAdminAnalyticsPrewarm: () => false, getClientId: () => 'test', getBotToken: () => 'test', getDatabaseUrl: () => 'configured' },
    '@/lib/audit-log': { ensureAuditLogTable: async () => {} }, '@/lib/discord': { fetchBotGuildIds: async () => [] }, '@/lib/settings-db': {},
    '@/lib/settings-catalog': { getCatalog: () => [], getProviderSpecs: () => [], providerLabel: value => value, text: value => value },
    '@/lib/table-counts': { countedTables: new Set(), loadExactTableCounts: async () => new Map() },
  });
  for (const kind of Object.keys(kinds)) {
    const completed = await admin.buildAdminReportSnapshot(kind, { providerId: 'twitter', dateFrom: '2026-09-01T00:00', dateTo: '2026-09-02T00:00' });
    const view = reportForDashboard(kind, { report: completed.report, cache: { ready: true, refreshing: false, lastError: structuredError, updatedAt: '2026-09-01T01:02:03Z' } });
    assert.equal(view.cache.ready, true);
    assert.deepEqual(view.summary, completed.report.summary);
    const html = renderPanel(kind, view);
    assert.match(html, /data-report-state="stale"/);
    assert.match(html, /前回完成したレポートを表示しています/);
    assert.match(html, /最終成功時の結果/);
    assert.match(html, /生成エラーの原記録・コード・詳細/);
  }
});

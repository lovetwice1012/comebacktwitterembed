'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../../dashboard/node_modules/react');
const { renderToStaticMarkup } = require('../../dashboard/node_modules/react-dom/server');
const load = require('./helpers/load-dashboard.cjs');
const owner = '796972193287503913';
const secret = 'test-controller-token-never-return-to-browser';
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function withRoute(work, user = owner) {
  const keys = ['RECOVERY_CONTROLLER_URL', 'RECOVERY_CONTROLLER_TOKEN', 'ADMIN_OWNER_ID'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = global.fetch;
  process.env.RECOVERY_CONTROLLER_URL = 'http://127.0.0.1:34212';
  process.env.RECOVERY_CONTROLLER_TOKEN = secret;
  process.env.ADMIN_OWNER_ID = owner;
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error('unexpected network access'); };
  const route = load('app/api/admin/recovery/route.ts', {
    'next/server': { NextResponse: { json: (body, options) => ({ body, status: options?.status || 200, headers: options?.headers }) } },
    '@/lib/api': { ApiError, requireAdminSession: async () => { if (!user) throw new ApiError(401, 'login required'); if (![owner, '933314562487386122'].includes(user)) throw new ApiError(403, 'administrator required'); return { user: { id: user } }; }, errorResponse: error => ({ status: error.status || 500, body: { error: error.message } }) },
  });
  try { await work(route, () => calls); }
  finally { global.fetch = originalFetch; for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; } }
}

test('emergency recovery status requires an allowed administrator and exposes no mutation handler', async () => {
  await withRoute(async (route, calls) => { assert.equal((await route.GET()).status, 401); assert.equal(calls(), 0); }, null);
  await withRoute(async (route, calls) => { assert.equal((await route.GET()).status, 403); assert.equal(calls(), 0); }, '123456789012345678');
  await withRoute(async route => { assert.equal(route.POST, undefined); assert.equal(route.PUT, undefined); assert.equal(route.DELETE, undefined); });
  await withRoute(async route => { delete process.env.RECOVERY_CONTROLLER_URL; assert.equal((await route.GET()).body.state, 'not_configured'); }, '933314562487386122');
});

test('missing configuration and non-local endpoints are explicit without making a request', async () => {
  await withRoute(async (route, calls) => {
    delete process.env.RECOVERY_CONTROLLER_URL;
    const missing = await route.GET();
    assert.equal(missing.body.state, 'not_configured');
    assert.equal(missing.body.available, false);
    assert.equal(missing.body.backup, undefined);
    for (const value of ['https://127.0.0.1:34212', 'http://example.test:34212', 'http://user:password@127.0.0.1:34212', 'http://127.0.0.1:34212?token=bad']) {
      process.env.RECOVERY_CONTROLLER_URL = value;
      assert.equal((await route.GET()).body.state, 'invalid_configuration');
    }
    assert.equal(calls(), 0);
  });
});

test('read-only local status proxy forwards a server-side bearer and preserves actual gates while removing credentials', async () => {
  await withRoute(async route => {
    global.fetch = async (url, options) => {
      assert.equal(String(url), 'http://127.0.0.1:34212/v1/status');
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.authorization, `Bearer ${secret}`);
      return new Response(JSON.stringify({ phase: 'candidate_ready', updatedAt: '2026-09-06T00:00:00Z',
        backup: { backupId: 'backup-1', sourceTimestamp: '2026-09-05T20:00:00Z', sourceSha256: 'a'.repeat(64), sourceBytes: 1234 },
        candidate: { id: 'candidate-1', databaseState: 'restored', checks: { mysql: { ready: true } } },
        gates: [{ code: 'PRIMARY_NOT_ENROLLED', message: 'Primary guard is not enrolled', ready: false }], primaryEnrolled: false, activeNode: 'primary', epoch: 3,
        lastError: { code: 'AUTH_TEST', message: `nested ${secret}`, token: 'other-sensitive-value' }, unexpectedSecret: secret }), { headers: { 'content-type': 'application/json' } });
    };
    const response = await route.GET();
    assert.equal(response.body.available, true);
    assert.equal(response.body.primaryEnrolled, false);
    assert.equal(response.body.gates[0].ready, false);
    assert.equal(response.body.backup.sourceBytes, 1234);
    assert.equal(response.body.epoch, 3);
    assert.equal(response.body.lastError.code, 'AUTH_TEST');
    assert.equal(JSON.stringify(response.body).includes(secret), false);
    assert.equal(JSON.stringify(response.body).includes('other-sensitive-value'), false);
    assert.equal(response.body.unexpectedSecret, undefined);
    assert.match(response.headers['cache-control'], /no-store/);
  });
});

test('unavailable, malformed and oversized controller responses remain contained status errors', async () => {
  await withRoute(async route => {
    for (const fetcher of [async () => { throw new Error(secret); }, async () => new Response('<html>bad gateway</html>'), async () => new Response(JSON.stringify({ phase: 'failed', padding: 'x'.repeat(1024 * 1024) }))]) {
      global.fetch = fetcher;
      const response = await route.GET();
      assert.equal(response.status, 503);
      assert.equal(response.body.available, false);
      assert.equal(response.body.backup, undefined);
      assert.equal(JSON.stringify(response.body).includes(secret), false);
    }
  });
});

test('emergency recovery view shows actual backup age, missing enrollment and unmet gates without an activation control', () => {
  const { RecoveryStatusView, backupAge } = load('components/admin/emergency-recovery-panel.tsx');
  const stamp = Date.parse('2026-09-05T00:00:00Z');
  assert.equal(backupAge(stamp, stamp + 90000000), '1日 1時間 0分前');
  assert.equal(backupAge(stamp / 1000, stamp + 90000000), '1日 1時間 0分前');
  assert.equal(backupAge(null), '未取得');
  const html = renderToStaticMarkup(React.createElement(RecoveryStatusView, { stale: true, status: { phase: 'candidate_ready', primaryEnrolled: false, epoch: 3, activeNode: 'primary', fetchedAt: '2026-09-06T00:00:00Z',
    backup: { backupId: 'backup-1', sourceTimestamp: '2026-09-05T00:00:00Z', sourceSha256: 'abc', sourceBytes: 1234 },
    candidate: { id: 'candidate-1', databaseState: 'restored', checks: { checksum: { ready: true } } },
    gates: [{ code: 'PRIMARY_NOT_ENROLLED', message: 'Primary guard has not enrolled', ready: false }], lastError: { code: 'WAITING_FOR_PRIMARY' } } }));
  assert.match(html, /未登録/);
  assert.match(html, /未充足/);
  assert.match(html, /backup-1/);
  assert.match(html, /1234 bytes/);
  assert.match(html, /最後の応答/);
  assert.match(html, /WAITING_FOR_PRIMARY/);
  assert.doesNotMatch(html, /<button/);
});

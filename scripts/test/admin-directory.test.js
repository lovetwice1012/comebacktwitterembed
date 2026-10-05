'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/load-dashboard.cjs');
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }

test('admin directory authenticates before contacting Discord and rejects malformed guild ids', async t => {
  let authorized = false, requests = 0;
  const original = global.fetch; t.after(() => { global.fetch = original; });
  global.fetch = async () => { requests++; throw new Error('unexpected network'); };
  const route = load('app/api/admin/directory/route.ts', {
    '@/lib/api': { ApiError, requireAdminSession: async () => { if (!authorized) throw new ApiError(403, 'admin required'); }, json: data => ({ status: 200, data }), errorResponse: error => ({ status: error.status || 500 }) },
    '@/lib/env': { getBotToken: () => 'fixture-only' },
  });
  assert.equal((await route.GET(new Request('http://local/api/admin/directory'))).status, 403);
  authorized = true;
  assert.equal((await route.GET(new Request('http://local/api/admin/directory?guildId=../users'))).status, 400);
  assert.equal(requests, 0);
});

test('admin directory uses Bot auth, bounded pages, cached reads and exposes only display data', async t => {
  const requests = [];
  const original = global.fetch; t.after(() => { global.fetch = original; });
  global.fetch = async (url, init) => { requests.push({ url, init }); return { ok: true, json: async () => Array.from({ length: 200 }, (_, i) => ({ id: String(i + 1000), name: 'Fixture', permissions: 'not-for-client' })) }; };
  const route = load('app/api/admin/directory/route.ts', {
    '@/lib/api': { ApiError, requireAdminSession: async () => {}, json: data => ({ status: 200, data }), errorResponse: error => ({ status: error.status || 500 }) },
    '@/lib/env': { getBotToken: () => 'fixture-only' },
  });
  const request = new Request('http://local/api/admin/directory?after=999');
  const result = await route.GET(request); await route.GET(request);
  assert.equal(requests.length, 1); assert.equal(requests[0].init.headers.Authorization, 'Bot fixture-only');
  assert.match(requests[0].url, /limit=200&after=999$/);
  assert.equal(result.data.nextCursor, '1199'); assert.equal(result.data.items[0].permissions, undefined);
  assert.doesNotMatch(JSON.stringify(result), /fixture-only/);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/load-dashboard.cjs');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

const owner = '796972193287503913';
const ordinary = '123456789012345678';
const other = '223456789012345678';
const secret = 'ui-preference-test-secret';
const session = id => ({ user: { id, username: 'Fixture user', isAdmin: id === owner }, accessToken: 'fixture-token' });
const preference = () => load('lib/ui-preference.ts', { '@/lib/env': { getNextAuthSecret: () => secret } });
const rollout = (jar = new Map()) => load('lib/ui-rollout.ts', {
  '@/lib/env': { getNextAuthSecret: () => secret, readRootConfig: () => ({}) },
  'next/headers': { cookies: async () => ({ get: name => jar.has(name) ? { value: jar.get(name) } : undefined }) },
});
async function defaults(operation) {
  const previous = process.env.DASHBOARD_UI_PREVIEW_USER_IDS;
  delete process.env.DASHBOARD_UI_PREVIEW_USER_IDS;
  try { return await operation(); }
  finally { if (previous === undefined) delete process.env.DASHBOARD_UI_PREVIEW_USER_IDS; else process.env.DASHBOARD_UI_PREVIEW_USER_IDS = previous; }
}

test('ordinary accounts explicitly opt in, preferences survive subsequent reads, and the pilot can return to legacy', async () => defaults(async () => {
  const prefs = preference(), jar = new Map(), policy = rollout(jar);
  assert.equal(await policy.usesNewDashboardUI(session(ordinary)), false);
  assert.equal(await policy.usesNewDashboardUI(session(owner)), true);
  for (const [id, version] of [[ordinary, 'preview'], [owner, 'legacy']]) {
    const cookie = prefs.createDashboardUIPreferenceCookie(id, version);
    jar.set(cookie.name, cookie.value);
  }
  assert.equal(await policy.usesNewDashboardUI(session(ordinary)), true);
  assert.equal(await rollout(jar).usesNewDashboardUI(session(ordinary)), true);
  assert.equal(await policy.usesNewDashboardUI(session(owner)), false);
  assert.equal(await policy.usesNewDashboardUI(session(other)), false);
  assert.equal(await policy.usesNewDashboardUI(null), false);
  const cookie = prefs.createDashboardUIPreferenceCookie(ordinary, 'legacy');
  jar.set(cookie.name, cookie.value);
  assert.equal(await rollout(jar).usesNewDashboardUI(session(ordinary)), false);
}));

test('signed account preferences reject account swapping, tampering, expiry, unsigned values and rotated secrets', async () => {
  const prefs = preference(), now = 1800000000000;
  const cookie = prefs.createDashboardUIPreferenceCookie(ordinary, 'preview', now);
  assert.equal(prefs.readDashboardUIPreference(ordinary, cookie.value, now), 'preview');
  assert.equal(prefs.readDashboardUIPreference(other, cookie.value, now), null);
  assert.equal(prefs.readDashboardUIPreference(ordinary, cookie.value.replace('preview', 'legacy'), now), null);
  assert.equal(prefs.readDashboardUIPreference(ordinary, cookie.value, now + prefs.DASHBOARD_UI_PREFERENCE_MAX_AGE * 1000), null);
  for (const value of ['preview', 'true', '', 'v1.preview.1800000000.bad', `${cookie.value}x`]) assert.equal(prefs.readDashboardUIPreference(ordinary, value, now), null);
  const changedSecret = load('lib/ui-preference.ts', { '@/lib/env': { getNextAuthSecret: () => 'rotated-secret' } });
  assert.equal(changedSecret.readDashboardUIPreference(ordinary, cookie.value, now), null);
  assert.equal(prefs.dashboardUIPreferenceCookieName('invalid-account'), null);
});

function api(current = session(ordinary), locale = 'ja', signingSecret = secret) {
  class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
  return load('app/api/me/dashboard-ui/route.ts', {
    '@/lib/api': { ApiError, requireSession: async () => { if (!current) throw new ApiError(401, 'ログインが必要です。'); return current; } },
    '@/lib/env': { getNextAuthSecret: () => signingSecret },
    '@/lib/server-locale': { getDashboardLocaleFromRequest: () => locale },
  });
}
async function canonical(operation) {
  const previous = process.env.NEXTAUTH_URL;
  process.env.NEXTAUTH_URL = 'https://dashboard.example';
  try { return await operation(); }
  finally { if (previous === undefined) delete process.env.NEXTAUTH_URL; else process.env.NEXTAUTH_URL = previous; }
}
function request(body, { origin = 'https://dashboard.example', contentType = 'application/json', url = 'http://127.0.0.1:30987/api/me/dashboard-ui', raw = false, headers = {} } = {}) {
  return new Request(url, { method: 'POST', headers: { ...(origin === null ? {} : { Origin: origin }), 'Content-Type': contentType, ...headers }, body: raw ? body : JSON.stringify(body) });
}

test('authenticated API binds the signed HttpOnly preference to its session account and supports both directions behind a proxy', async () => canonical(async () => {
  const endpoint = api(), prefs = preference();
  for (const version of ['preview', 'legacy']) {
    const response = await endpoint.POST(request({ version, userId: owner, viewerId: owner, isAdmin: true }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { version });
    const setCookie = response.headers.get('set-cookie');
    assert(setCookie.includes(prefs.dashboardUIPreferenceCookieName(ordinary)));
    assert(!setCookie.includes(prefs.dashboardUIPreferenceCookieName(owner)));
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=lax', 'Path=/']) assert(setCookie.includes(flag), flag);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const value = response.cookies.get(prefs.dashboardUIPreferenceCookieName(ordinary)).value;
    assert.equal(prefs.readDashboardUIPreference(ordinary, value), version);
  }
}));

test('preference API rejects guests, cross-origin writes, missing Origin and invalid data without setting cookies', async () => canonical(async () => {
  const cases = [
    [api(null), request({ version: 'preview' }), 401],
    [api(), request({ version: 'preview' }, { origin: 'https://untrusted.example' }), 403],
    [api(), request({ version: 'preview' }, { origin: null }), 403],
    [api(), request({ version: 'preview' }, { contentType: 'text/plain' }), 415],
    [api(), request('{invalid', { raw: true }), 400],
    [api(), request({ version: 'all' }), 400],
    [api(), request(['preview']), 400],
    [api(), request({ version: 'preview', unused: 'x'.repeat(1100) }), 413],
  ];
  for (const [endpoint, req, expected] of cases) {
    const response = await endpoint.POST(req);
    assert.equal(response.status, expected);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
  const unavailable = await api(session(ordinary), 'ja', '').POST(request({ version: 'preview' }));
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('set-cookie'), null);
  assert(!(await unavailable.text()).includes('signing'));
}));

test('ordinary dashboard control uses the authenticated API to switch both ways and refresh the current route', async () => canonical(async () => defaults(async () => {
  const jar = new Map(), endpoint = api(), prefs = preference();
  const refreshes = [], calls = [];
  const f = await reactFixture('export { DashboardUIPreference } from "@/components/dashboard/dashboard-ui-preference";', {
    moduleOverrides: { 'next/navigation': { useRouter: () => ({ refresh: () => { refreshes.push(true); } }) } },
  });
  f.set('fetch', async (url, options) => {
    calls.push({ url, options });
    const response = await endpoint.POST(request(options.body, { raw: true }));
    const cookie = response.cookies.get(prefs.dashboardUIPreferenceCookieName(ordinary));
    if (cookie) jar.set(cookie.name, cookie.value);
    return response;
  });
  try {
    await f.render(f.React.createElement(f.exports.DashboardUIPreference, { version: 'legacy', locale: 'ja' }));
    await f.click('新しい画面を試す');
    assert.equal(await rollout(jar).usesNewDashboardUI(session(ordinary)), true);
    assert.equal(refreshes.length, 1);
    assert.deepEqual(JSON.parse(calls[0].options.body), { version: 'preview' });
    await f.render(f.React.createElement(f.exports.DashboardUIPreference, { version: 'preview', locale: 'ja' }));
    assert.equal(f.container.querySelector('[role="switch"]').getAttribute('aria-checked'), 'true');
    await f.click('旧画面に戻す');
    assert.equal(await rollout(jar).usesNewDashboardUI(session(ordinary)), false);
    assert.equal(refreshes.length, 2);
    assert.deepEqual(JSON.parse(calls[1].options.body), { version: 'legacy' });
    assert.equal(calls[0].url, '/api/me/dashboard-ui');
  } finally { await f.close(); }
})));

test('failed UI switch keeps the displayed version and allows a retry without exposing response errors', async () => {
  let requests = 0, refreshes = 0;
  const f = await reactFixture('export { DashboardUIPreference } from "@/components/dashboard/dashboard-ui-preference";', {
    moduleOverrides: { 'next/navigation': { useRouter: () => ({ refresh: () => { refreshes++; } }) } },
  });
  f.set('fetch', async () => { requests++; return requests === 1 ? { ok: false, json: async () => ({ error: 'sensitive backend exception' }) } : { ok: true, json: async () => ({ version: 'preview' }) }; });
  try {
    await f.render(f.React.createElement(f.exports.DashboardUIPreference, { version: 'legacy', locale: 'ja' }));
    await f.click('新しい画面を試す');
    assert.equal(f.container.querySelector('[role="switch"]').getAttribute('aria-checked'), 'false');
    assert(f.container.querySelector('[role="alert"]'));
    assert(!f.container.textContent.includes('sensitive'));
    assert.equal(refreshes, 0);
    await f.click('新しい画面を試す');
    assert.equal(refreshes, 1);
    assert.equal(f.container.querySelector('[role="alert"]'), null);
  } finally { await f.close(); }
});

test('root injection hides the preference from guests, administration and automation while preserving frozen legacy source', async () => {
  let pathname = '/dashboard';
  const f = await reactFixture('export { DashboardUIProvider } from "@/components/dashboard/dashboard-ui-provider";', {
    moduleOverrides: { 'next/navigation': { useRouter: () => ({ refresh() {} }), usePathname: () => pathname } },
  });
  try {
    for (const [authenticated, route, visible] of [[false, '/dashboard', false], [true, '/dashboard', true], [true, '/dashboard/111111111111111111/providers/twitter', true], [true, '/admin', false], [true, '/dashboard/automation', false], [true, '/dashboard/111111111111111111/automation', false]]) {
      pathname = route;
      await f.render(f.React.createElement(f.exports.DashboardUIProvider, { version: 'legacy', authenticated, locale: 'ja' }, 'Existing page'));
      assert.equal(Boolean(f.container.querySelector('[role="switch"]')), visible, `${authenticated}:${route}`);
      assert(f.container.textContent.includes('Existing page'));
    }
  } finally { await f.close(); }
});

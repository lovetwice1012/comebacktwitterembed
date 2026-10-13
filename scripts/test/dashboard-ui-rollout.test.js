'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/load-dashboard.cjs');

const owner = '796972193287503913';
const otherAdmin = '933314562487386122';
const ordinary = '123456789012345678';
const guildId = '111111111111111111';
const session = (id, isAdmin = false) => ({ user: { id, username: 'Fixture user', globalName: null, isAdmin }, accessToken: 'fixture-token' });

async function isolatedOverride(value, operation) {
  const previous = process.env.DASHBOARD_UI_PREVIEW_USER_IDS;
  if (value === undefined) delete process.env.DASHBOARD_UI_PREVIEW_USER_IDS;
  else process.env.DASHBOARD_UI_PREVIEW_USER_IDS = value;
  try { return await operation(); }
  finally { if (previous === undefined) delete process.env.DASHBOARD_UI_PREVIEW_USER_IDS; else process.env.DASHBOARD_UI_PREVIEW_USER_IDS = previous; }
}
const policy = (config = {}, cookieValues = new Map()) => load('lib/ui-rollout.ts', { '@/lib/env': { readRootConfig: () => config, getNextAuthSecret: () => 'ui-preference-fixture-secret' }, 'next/headers': { cookies: async () => ({ get: name => cookieValues.has(name) ? { value: cookieValues.get(name) } : undefined }) } });

test('only the selected authenticated Discord account gets the new UI by default', async () => isolatedOverride(undefined, async () => {
  const rollout = policy();
  assert.deepEqual(rollout.getDashboardUIPreviewUserIds(), [owner]);
  assert.equal(await rollout.usesNewDashboardUI(session(owner, true)), true);
  assert.equal(await rollout.usesNewDashboardUI(session(otherAdmin, true)), false);
  assert.equal(await rollout.usesNewDashboardUI(session(ordinary)), false);
  for (const value of [null, undefined, {}, { user: {} }, { user: { id: Number(owner) } }]) assert.equal(await rollout.usesNewDashboardUI(value), false);
}));

test('guild IDs and forged client flags cannot activate the UI for another account', async () => isolatedOverride(undefined, async () => {
  const rollout = policy();
  const forged = { ...session(ordinary, true), guildId: owner, uiVersion: 'preview', usesNewDashboardUI: true,
    query: { userId: owner, guildId: owner, preview: 'true', mode: 'preview' }, cookies: { dashboard_ui: 'preview' }, user: { id: ordinary, isAdmin: true, uiPreview: true } };
  assert.equal(await rollout.usesNewDashboardUI(forged), false);
}));

test('configuration overrides replace the default allowlist and accept only valid string IDs', async () => isolatedOverride(undefined, async () => {
  const rollout = policy({ dashboard: { uiPreviewUserIds: [otherAdmin, otherAdmin, ' invalid ', '*', ordinary, Number(owner)] } });
  assert.deepEqual(rollout.getDashboardUIPreviewUserIds(), [otherAdmin, ordinary]);
  assert.equal(await rollout.usesNewDashboardUI(session(owner, true)), false);
  assert.equal(await rollout.usesNewDashboardUI(session(otherAdmin, true)), true);
}));

test('empty or invalid configuration explicitly disables the default pilot', async () => isolatedOverride(undefined, async () => {
  for (const value of [[], '', 'invalid,*', null, false, Number(owner), {}]) {
    const rollout = policy({ dashboard: { uiPreviewUserIds: value } });
    assert.deepEqual(rollout.getDashboardUIPreviewUserIds(), []);
    assert.equal(await rollout.usesNewDashboardUI(session(owner, true)), false);
  }
}));

test('environment override takes precedence and deduplicates comma or whitespace separated IDs', async () => isolatedOverride(` ${otherAdmin}, ${otherAdmin}\n${ordinary} * invalid `, async () => {
  const rollout = policy({ dashboard: { uiPreviewUserIds: [owner] } });
  assert.deepEqual(rollout.getDashboardUIPreviewUserIds(), [otherAdmin, ordinary]);
  assert.equal(await rollout.usesNewDashboardUI(session(owner, true)), false);
}));

test('empty and invalid environment overrides disable the default pilot even with a configured owner', async () => {
  for (const value of ['', 'invalid,*', '123', 'null']) await isolatedOverride(value, async () => {
    const rollout = policy({ dashboard: { uiPreviewUserIds: [owner] } });
    assert.deepEqual(rollout.getDashboardUIPreviewUserIds(), []);
    assert.equal(await rollout.usesNewDashboardUI(session(owner, true)), false);
  });
});

test('trusted server session ignores client admin flags and requires a verified session token', async () => isolatedOverride(undefined, async () => {
  let supplied = { user: { id: otherAdmin, isAdmin: true, uiPreview: true }, accessToken: 'fixture-token' };
  const sessions = load('lib/server-session.ts', {
    'next-auth': { getServerSession: async () => supplied },
    'next/navigation': { redirect: destination => { throw new Error(`redirect:${destination}`); } },
    '@/features/auth/options': { authOptions: {} }, '@/lib/admin': { isDashboardAdminUserId: id => id === owner || id === otherAdmin },
  });
  const rollout = policy();
  assert.equal(await rollout.usesNewDashboardUI(await sessions.getDashboardSession()), false);
  supplied = { user: { id: owner } };
  assert.equal(await sessions.getDashboardSession(), null);
  await assert.rejects(sessions.requireDashboardSession(), /redirect:\//);
  supplied = { user: { id: owner, isAdmin: false }, accessToken: 'fixture-token' };
  assert.equal(await rollout.usesNewDashboardUI(await sessions.getDashboardSession()), true);
}));

test('server root layout and client context always receive the same per-session version without cross-account reuse', async () => isolatedOverride(undefined, async () => {
  let current = session(owner, true);
  const layout = load('app/layout.tsx', {
    './globals.css': {}, './dashboard-ui-preference.css': {}, '@/lib/env': { readRootConfig: () => ({}), getNextAuthSecret: () => 'ui-preference-fixture-secret' }, 'next/headers': { cookies: async () => ({ get: () => undefined }) },
    '@/lib/server-locale': { getDashboardLocale: async () => 'ja' },
    '@/lib/server-session': { getDashboardSession: async () => current },
  });
  for (const [identity, expected] of [[owner, 'preview'], [otherAdmin, 'legacy'], [ordinary, 'legacy'], [null, 'legacy'], [owner, 'preview']]) {
    current = identity ? session(identity, identity !== ordinary) : null;
    const html = await layout.default({ children: 'Fixture content' });
    assert.equal(html.props['data-dashboard-ui'], expected);
    assert.equal(html.props.children.props.children.props.version, expected);
  }
}));

// These route tests invoke the actual RSC route functions and legacy server
// pages. Only data I/O and presentational components are mocked; session and
// guild access checks remain part of the exercised route behavior.
function routesFor(current, { access = { guildId, name: 'Fixture guild', canEdit: true, canManageGuild: true }, cookieValues = new Map() } = {}) {
  const calls = { session: 0, access: 0, settings: 0, visible: 0, audit: 0 };
  const marker = name => Object.assign(function Component() { return null; }, { displayName: name });
  const PreviewShell = marker('PreviewShell'), LegacyShell = marker('LegacyShell'), PreviewDenied = marker('PreviewDenied'), LegacyDenied = marker('LegacyDenied');
  const mocks = {
    './dashboard-ui-preference.css': {},
    '@/lib/env': { readRootConfig: () => ({}), getNextAuthSecret: () => 'ui-preference-fixture-secret' }, 'next/headers': { cookies: async () => ({ get: name => cookieValues.has(name) ? { value: cookieValues.get(name) } : undefined }) },
    '@/lib/server-locale': { getDashboardLocale: async () => 'ja' },
    '@/lib/server-session': { requireDashboardSession: async () => { calls.session++; if (!current) throw new Error('redirect:/'); return current; }, getDashboardSession: async () => current },
    '@/lib/discord': { getGuildAccess: async (given, id) => { assert.equal(given, current); assert.equal(id, guildId); calls.access++; return access; }, listVisibleGuilds: async given => { assert.equal(given, current); calls.visible++; return []; } },
    '@/lib/settings-catalog': { getProviderCatalog: () => ({ providerId: 'twitter', label: 'X / Twitter' }), providerDomain: () => 'x.com', getBotProviders: () => [], getCatalog: () => [], providerLabel: provider => provider.label },
    '@/lib/settings-db': { getProviderSettingsState: async () => { calls.settings++; return []; } },
    '@/lib/guild-provider-summary': { getVisibleGuildProviderSummaries: async ids => { assert.deepEqual(ids, []); return new Map(); } },
    '@/lib/audit-log': { listAuditLogs: async () => { calls.audit++; return []; } },
    'next/link': { __esModule: true, default: marker('Link') },
    'next/navigation': { notFound: () => { throw new Error('notFound'); }, redirect: destination => { throw new Error(`redirect:${destination}`); } },
    '@/components/dashboard/dashboard-shell': { DashboardShell: PreviewShell },
    '@/legacy/components/dashboard/dashboard-shell': { DashboardShell: LegacyShell },
    '@/components/dashboard/access-denied': { AccessDenied: PreviewDenied },
    '@/legacy/components/dashboard/access-denied': { AccessDenied: LegacyDenied },
  };
  const presentational = {
    'dashboard/guild-list': ['GuildList'], 'dashboard/guild-switcher': ['GuildSwitcher'], 'dashboard/dashboard-workspace': ['DashboardWorkspace'],
    'dashboard/auth-buttons': ['SignOutButton', 'SignInButton'], 'dashboard/language-switcher': ['LanguageSwitcher'],
    'dashboard/access-management': ['AccessManagement'], 'personal-links/personal-links-workspace': ['PersonalLinksWorkspace'],
    'settings/provider-settings-form': ['ProviderSettingsForm'], 'settings/provider-preview-browser': ['ProviderPreviewBrowser'], 'providers/provider-list': ['ProviderList'],
    'admin/admin-console-loader': ['AdminConsoleLoader'], 'preview/output-preview-card': ['OutputPreviewCard'],
  };
  for (const [name, exports] of Object.entries(presentational)) for (const prefix of ['@/components/', '@/legacy/components/']) mocks[prefix + name] = Object.fromEntries(exports.map(name => [name, marker(prefix + name)]));
  return { calls, mocks, PreviewShell, LegacyShell, PreviewDenied, LegacyDenied, load: file => load(file, mocks) };
}
async function resolveLegacy(element) {
  // Legacy RSC elements are intentionally returned by the route dispatcher.
  // Invoke only those async server page functions, never client components.
  while (typeof element?.type === 'function' && element.type.constructor.name === 'AsyncFunction') element = await element.type(element.props);
  return element;
}
function renderedText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(renderedText).join(' ');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return renderedText(node.props?.children);
}

test('public home and metadata use the captured production copy for other accounts and anonymous visitors', async () => isolatedOverride(undefined, async () => {
  for (const identity of [owner, otherAdmin, ordinary, null]) {
    const current = identity ? session(identity, identity !== ordinary) : null;
    const r = routesFor(current);
    const home = await resolveLegacy(await r.load('app/page.tsx').default({ searchParams: Promise.resolve({ uiVersion: 'preview', userId: owner }) }));
    const text = renderedText(home);
    if (identity === owner) {
      assert(text.includes('運営管理'));
      assert(!text.includes('Provider設定を安全に編集する管理画面'));
    } else {
      assert(text.includes('Provider設定を安全に編集する管理画面'));
      if (identity === otherAdmin) assert(text.includes('Admin'));
    }
    const metadata = await load('app/layout.tsx', { ...r.mocks, './globals.css': {} }).generateMetadata();
    assert.equal(metadata.description.includes('guild設定Dashboard'), identity !== owner);
  }
}));

test('dashboard and personal routes select the actual legacy pages for other admins and keep the owner on preview', async () => isolatedOverride(undefined, async () => {
  for (const identity of [owner, otherAdmin, ordinary]) {
    const r = routesFor(session(identity, identity !== ordinary));
    const page = await resolveLegacy(await r.load('app/dashboard/page.tsx').default({ searchParams: Promise.resolve({ mode: 'user', preview: 'true', userId: owner }) }));
    assert.equal(identity === owner ? page.type === r.PreviewShell : page.type === 'main', true);
    assert.equal(r.calls.visible, 1);
    const personal = await resolveLegacy(await r.load('app/dashboard/personal-links/page.tsx').default());
    assert.equal(identity === owner ? personal.type === r.PreviewShell : personal.type === 'main', true);
    assert(r.calls.session >= 2);
  }
}));

test('both settings versions execute guild authorization before reading settings, even when query flags request preview', async () => isolatedOverride(undefined, async () => {
  for (const identity of [owner, otherAdmin, ordinary]) {
    for (const allowed of [true, false]) {
      const r = routesFor(session(identity, identity !== ordinary), { access: allowed ? { guildId, name: 'Fixture guild', canEdit: false, canManageGuild: false } : null });
      const page = await resolveLegacy(await r.load('app/dashboard/[guildId]/providers/[providerId]/page.tsx').default({ params: Promise.resolve({ guildId, providerId: 'twitter', uiVersion: 'preview' }) }));
      assert.equal(r.calls.access, 1);
      assert.equal(r.calls.settings, allowed ? 1 : 0);
      assert.equal(page.type, allowed ? identity === owner ? r.PreviewShell : r.LegacyShell : identity === owner ? r.PreviewDenied : r.LegacyDenied);
    }
  }
}));

test('both access-management versions retain Manage Server authorization', async () => isolatedOverride(undefined, async () => {
  for (const identity of [owner, otherAdmin]) {
    for (const canManageGuild of [true, false]) {
      const r = routesFor(session(identity, true), { access: { guildId, name: 'Fixture guild', canEdit: true, canManageGuild } });
      const page = await resolveLegacy(await r.load('app/dashboard/[guildId]/access/page.tsx').default({ params: Promise.resolve({ guildId }) }));
      assert.equal(r.calls.access, 1);
      assert.equal(page.type, canManageGuild ? identity === owner ? r.PreviewShell : r.LegacyShell : identity === owner ? r.PreviewDenied : r.LegacyDenied);
    }
  }
}));

test('preview and centralized history routes select matching snapshots and retain guild permissions', async () => isolatedOverride(undefined, async () => {
  for (const identity of [owner, otherAdmin]) {
    for (const allowed of [true, false]) {
      const previewRoutes = routesFor(session(identity, true), { access: allowed ? { guildId, name: 'Fixture guild', canEdit: true, canManageGuild: true } : null });
      const preview = await resolveLegacy(await previewRoutes.load('app/dashboard/[guildId]/preview/page.tsx').default({ params: Promise.resolve({ guildId }) }));
      assert.equal(previewRoutes.calls.access, 1);
      assert.equal(preview.type, allowed ? identity === owner ? previewRoutes.PreviewShell : previewRoutes.LegacyShell : identity === owner ? previewRoutes.PreviewDenied : previewRoutes.LegacyDenied);
      const historyRoutes = routesFor(session(identity, true), { access: { guildId, name: 'Fixture guild', canEdit: true, canManageGuild: allowed } });
      const history = await resolveLegacy(await historyRoutes.load('features/audit/audit-logs-page.tsx').AuditLogsPage({ guildId }));
      assert.equal(historyRoutes.calls.access, 1);
      assert.equal(historyRoutes.calls.audit, allowed ? 1 : 0);
      assert.equal(history.type, allowed ? identity === owner ? historyRoutes.PreviewShell : historyRoutes.LegacyShell : identity === owner ? historyRoutes.PreviewDenied : 'div');
    }
  }
}));

test('admin selection preserves both allowed admins, denies ordinary users, and dashboard routes require login', async () => isolatedOverride(undefined, async () => {
  for (const identity of [owner, otherAdmin]) {
    const r = routesFor(session(identity, true));
    const page = await resolveLegacy(await r.load('app/admin/page.tsx').default());
    assert.equal(page.type, identity === owner ? r.mocks['@/components/admin/admin-console-loader'].AdminConsoleLoader : Symbol.for('react.fragment'));
  }
  const ordinaryRoutes = routesFor(session(ordinary));
  await assert.rejects(ordinaryRoutes.load('app/admin/page.tsx').default(), /notFound/);
  const guestRoutes = routesFor(null);
  for (const file of ['app/dashboard/page.tsx', 'app/dashboard/personal-links/page.tsx', 'app/admin/page.tsx']) await assert.rejects(guestRoutes.load(file).default({ searchParams: Promise.resolve({ mode: 'user' }) }), /redirect:\//);
}));

test('an ordinary account preference consistently changes SSR routes, root context and metadata without granting guild or admin access', async () => isolatedOverride(undefined, async () => {
  const current = session(ordinary);
  const prefs = load('lib/ui-preference.ts', { '@/lib/env': { getNextAuthSecret: () => 'ui-preference-fixture-secret' } });
  const cookie = prefs.createDashboardUIPreferenceCookie(ordinary, 'preview');
  const cookieValues = new Map([[cookie.name, cookie.value]]);
  const r = routesFor(current, { cookieValues, access: null });
  const page = await resolveLegacy(await r.load('app/dashboard/page.tsx').default({ searchParams: Promise.resolve({ mode: 'user' }) }));
  assert.equal(page.type, r.PreviewShell);
  const layout = load('app/layout.tsx', { ...r.mocks, './globals.css': {} });
  const html = await layout.default({ children: 'Fixture content' });
  assert.equal(html.props['data-dashboard-ui'], 'preview');
  assert.equal(html.props.children.props.children.props.version, 'preview');
  assert.equal(html.props.children.props.children.props.authenticated, true);
  assert.equal((await layout.generateMetadata()).description.includes('guild設定Dashboard'), false);
  const denied = await resolveLegacy(await r.load('app/dashboard/[guildId]/providers/[providerId]/page.tsx').default({ params: Promise.resolve({ guildId, providerId: 'twitter' }) }));
  assert.equal(denied.type, r.PreviewDenied);
  assert.equal(r.calls.settings, 0);
  await assert.rejects(r.load('app/admin/page.tsx').default(), /notFound/);
  const legacyCookie = prefs.createDashboardUIPreferenceCookie(ordinary, 'legacy');
  cookieValues.set(legacyCookie.name, legacyCookie.value);
  const oldPage = await resolveLegacy(await r.load('app/dashboard/page.tsx').default({ searchParams: Promise.resolve({ mode: 'user' }) }));
  assert.equal(oldPage.type, 'main');
  assert.equal((await layout.default({ children: 'Fixture content' })).props['data-dashboard-ui'], 'legacy');
}));

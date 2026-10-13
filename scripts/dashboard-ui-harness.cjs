'use strict';

// Ordinary dashboard visual/interaction fixture. Fake identities and in-memory
// data only. No production config, DB, Discord transport, auth or worker is used.
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { DateTime } = require('luxon');

const screenshotNames = new Set([
  'desktop-home', 'mobile-home', 'desktop-providers', 'mobile-providers',
  'desktop-settings', 'mobile-settings', 'settings-search', 'settings-save-review',
  'desktop-cross', 'mobile-cross', 'desktop-personal', 'mobile-personal',
  'personal-form', 'mobile-personal-form', 'mobile-navigation', 'guild-switcher',
  'readonly-settings', 'english-home', 'english-settings', 'desktop-bulk', 'mobile-bulk',
  'desktop-preview', 'mobile-preview', 'desktop-access', 'mobile-access',
  'desktop-history', 'mobile-history', 'desktop-media', 'mobile-media',
  'access-user-selected', 'access-role-receipt', 'readonly-access', 'readonly-media',
]);
const fakeGuilds = [
  { guildId: '111111111111111111', name: '検証用・創作サーバー', canEdit: true, canManageGuild: true },
  { guildId: '222222222222222222', name: '検証用・作品共有とイベント案内のための長い名前のサーバー・クリエイター交流コミュニティ', canEdit: true, canManageGuild: true },
  { guildId: '333333333333333333', name: '検証用・閲覧専用サーバー', canEdit: false, canManageGuild: false },
].map(guild => ({ ...guild, iconUrl: null, permissions: { administrator: guild.canManageGuild, manageGuild: guild.canManageGuild, manageChannels: guild.canEdit }, providerSummary: { enabled: 3, disabled: 1, total: 4 } }));
const fakeProviders = [
  { providerId: 'twitter', label: 'X / Twitter', domain: 'x.com' },
  { providerId: 'pixiv', label: 'Pixiv', domain: 'pixiv.net' },
  { providerId: 'booth', label: 'BOOTH', domain: 'booth.pm' },
  { providerId: 'youtube', label: 'YouTube', domain: 'youtube.com' },
];
const text = (ja, en) => ({ ja, en });
const choice = (value, ja, en) => ({ value, label: text(ja, en) });
const specs = [
  { key: 'enabled', kind: 'providerEnabled', label: text('リンクを展開', 'Expand links'), category: 'basic', recommended: true, defaultValue: true },
  { key: 'display_density', kind: 'choice', label: text('表示する情報量', 'Amount of detail'), category: 'output', recommended: true, defaultValue: 'standard', choices: [choice('compact', '少なめ', 'Less detail'), choice('standard', '標準', 'Standard'), choice('detail', '詳しく', 'More detail')] },
  { key: 'media_display_mode', kind: 'choice', label: text('画像・動画の表示方法', 'Image and video display'), category: 'output', recommended: true, defaultValue: 'embed', choices: [choice('embed', '本文と一緒に表示', 'Show with the message'), choice('attachment', 'ファイルで送信', 'Send as files'), choice('thumbnail_only', '小さな画像だけ表示', 'Show a small image'), choice('link_only', 'リンクだけ表示', 'Show links only')] },
  { key: 'silent_expansion', kind: 'bool', label: text('通知を鳴らさずに展開', 'Expand without push notifications'), category: 'output', recommended: true, defaultValue: false },
  { key: 'show_previous_shares', kind: 'bool', label: text('以前の共有を表示', 'Show previous shares'), category: 'output', defaultValue: true },
  { key: 'failure_display_policy', kind: 'choice', label: text('リンクを取得できないとき', 'When a link cannot be fetched'), category: 'output', defaultValue: 'source_link', choices: [choice('silent', '表示しない', 'Show nothing'), choice('source_link', '元リンクを表示', 'Show source link'), choice('error_summary', '原因を表示', 'Show the reason')] },
  { key: 'defaultLanguage', kind: 'choice', label: text('表示・翻訳の言語', 'Display and translation language'), category: 'basic', defaultValue: 'ja', choices: [choice('ja', '日本語', 'Japanese'), choice('en-US', 'English', 'English')] },
  { key: 'disable', kind: 'targets', label: text('展開しない対象', 'Excluded targets'), category: 'permissions', advanced: true, defaultValue: { user: [], channel: [], role: [] } },
  { key: 'bannedWords', kind: 'bannedWords', label: text('指定した語を含む投稿を除外', 'Exclude posts containing these words'), category: 'filters', advanced: true, impactLevel: 'danger', defaultValue: [] },
  { key: 'deletemessageifonlypostedtweetlink', kind: 'bool', label: text('リンクだけの元投稿を削除', 'Delete link-only source messages'), category: 'behavior', advanced: true, impactLevel: 'danger', defaultValue: false },
  { key: 'button_invisible', kind: 'buttonVisibility', label: text('非表示にするボタン', 'Hide selected buttons'), category: 'buttons', advanced: true, defaultValue: { translate: false, delete: false, personal_save: false, personal_remind: false, personal_restock: false, gallery: false } },
  { key: 'quote_repost_depth_by_account', kind: 'accountDepthMap', label: text('アカウント別の引用展開数', 'Quote depth by account'), category: 'behavior', advanced: true, defaultValue: {} },
];

async function startHarness({ buildOnly = false, port = Number(process.env.DASHBOARD_UI_PORT || 4177), fakeViewerId = process.env.DASHBOARD_UI_FAKE_VIEWER_ID ?? '796972193287503913', uiPreviewUserIds } = {}) {
  const root = path.resolve(__dirname, '..'), dashboard = path.join(root, 'dashboard');
  const localRequire = createRequire(path.join(dashboard, 'package.json'));
  // The fake identity is fixed by this loopback server; only the real signed
  // preference cookie changes its UI. No production session/config is read.
  // Load the production server policy with an empty root configuration, so the
  // fixture never reads deployment secrets or Discord/DB configuration.
  const load = require('./test/helpers/load-dashboard.cjs');
  const fixtureSecret = 'loopback-ui-preference-fixture-only';
  const environment = { readRootConfig: () => ({}), getNextAuthSecret: () => fixtureSecret };
  const rollout = load('lib/ui-rollout.ts', { '@/lib/env': environment, 'next/headers': { cookies: async () => ({ get: () => undefined }) } });
  const preferences = load('lib/ui-preference.ts', { '@/lib/env': environment });
  const previousOverride = process.env.DASHBOARD_UI_PREVIEW_USER_IDS;
  if (uiPreviewUserIds !== undefined) process.env.DASHBOARD_UI_PREVIEW_USER_IDS = uiPreviewUserIds;
  let uiVersion;
  let previewDefaults;
  try { previewDefaults = rollout.getDashboardUIPreviewUserIds(); uiVersion = await rollout.usesNewDashboardUI(fakeViewerId ? { user: { id: fakeViewerId } } : null) ? 'preview' : 'legacy'; }
  finally { if (previousOverride === undefined) delete process.env.DASHBOARD_UI_PREVIEW_USER_IDS; else process.env.DASHBOARD_UI_PREVIEW_USER_IDS = previousOverride; }
  const viewer = { id: fakeViewerId, displayName: '架空の検証ユーザー', isAdmin: ['796972193287503913', '933314562487386122'].includes(fakeViewerId) };
  const stats = { requests: [], mutations: [], fixtureOnly: true, fakeViewerId, uiVersion };
  async function requestVersion(req) {
    const jar = new Map(String(req.headers.cookie || '').split(';').map(pair => { const index = pair.indexOf('='); return [pair.slice(0, index).trim(), pair.slice(index + 1)]; }));
    const policy = load('lib/ui-rollout.ts', { '@/lib/env': { ...environment, readRootConfig: () => ({ dashboard: { uiPreviewUserIds: previewDefaults } }) }, 'next/headers': { cookies: async () => ({ get: name => jar.has(name) ? { value: jar.get(name) } : undefined }) } });
    return await policy.usesNewDashboardUI(fakeViewerId ? { user: { id: fakeViewerId } } : null) ? 'preview' : 'legacy';
  }
  const values = new Map();
  for (const guild of fakeGuilds) for (const provider of fakeProviders) {
    const initial = Object.fromEntries(specs.map(spec => [spec.key, structuredClone(spec.defaultValue)]));
    if (provider.providerId === 'booth') initial.enabled = false;
    if (provider.providerId === 'pixiv') initial.display_density = 'compact';
    values.set(`${guild.guildId}:${provider.providerId}`, initial);
  }
  function settings(guildId, providerId) {
    const current = values.get(`${guildId}:${providerId}`);
    return specs.map(({ defaultValue, ...spec }) => ({ key: spec.key, kind: spec.kind, spec: { description: '', impactLevel: 'low', ...spec }, value: structuredClone(current[spec.key]), rawValue: structuredClone(current[spec.key]), defaultValue: structuredClone(defaultValue), customized: JSON.stringify(current[spec.key]) !== JSON.stringify(defaultValue), changedFromDefault: JSON.stringify(current[spec.key]) !== JSON.stringify(defaultValue), warnings: [] }));
  }
  const now = Date.now();
  const members = [
    { id: '555555555555555555', username: 'fixture_artist', nickname: '検証用・作品担当', avatarUrl: null },
    { id: '666666666666666666', username: 'fixture_reviewer', nickname: '検証用・レビュー担当', avatarUrl: null },
    { id: '777777777777777777', username: 'fixture_long_username_for_overflow_check', nickname: '検証用・長い表示名を使う作品共有とイベント案内の担当者', avatarUrl: null },
  ];
  const roles = [
    { id: '888888888888888888', name: '作品レビュアー', color: '#5965e9', managed: false, position: 10 },
    { id: '999999999999999999', name: 'イベント案内・作品共有担当のとても長い名前のロール', color: '#f59e0b', managed: false, position: 9 },
    { id: '123456789012345678', name: '検証用・連携ロール', color: null, managed: true, position: 8 },
  ];
  const grants = new Map(fakeGuilds.map(guild => [guild.guildId, [{ guildId: guild.guildId, targetType: 'user', targetId: members[0].id, accessLevel: 'view', grantedByUserId: '444444444444444444' }, { guildId: guild.guildId, targetType: 'role', targetId: roles[0].id, accessLevel: 'view', grantedByUserId: '444444444444444444' }]]));
  const media = { running: true, totalCacheCount: 28, totalSizeBytes: 293601280, providers: [
    { providerId: 'youtube', label: 'YouTube', domain: 'youtube.com', cacheCount: 18, expiredCount: 2, totalSizeBytes: 209715200 },
    { providerId: 'niconico', label: 'ニコニコ動画', domain: 'nicovideo.jp', cacheCount: 10, expiredCount: 1, totalSizeBytes: 83886080 },
  ] };
  const auditLogs = [
    { auditLogId: 'fixture-log-1', providerId: 'twitter', settingKey: 'media_display_mode', actorUserId: '444444444444444444', actorUsernameSnapshot: '検証用・管理者', action: 'setting.update', before: 'embed', after: 'link_only', createdAt: '2026-10-13T03:00:00Z' },
    { auditLogId: 'fixture-log-2', providerId: 'pixiv', settingKey: 'display_density', actorUserId: '666666666666666666', actorUsernameSnapshot: '検証用・レビュー担当', action: 'setting.update', before: 'standard', after: 'compact', createdAt: '2026-10-13T02:30:00Z' },
    { auditLogId: 'fixture-log-3', providerId: 'twitter', settingKey: 'silent_expansion', actorUserId: '444444444444444444', actorUsernameSnapshot: '検証用・管理者', action: 'setting.update', before: false, after: true, createdAt: '2026-10-13T02:00:00Z' },
    { auditLogId: 'fixture-log-4', providerId: '', actorUserId: '444444444444444444', actorUsernameSnapshot: '検証用・管理者', action: 'guild.sync', before: { sourceGuildId: '222222222222222222' }, after: { sourceGuildId: '222222222222222222', providerCount: 4, copied: 12, skippedTargets: 2 }, createdAt: '2026-10-13T01:30:00Z' },
  ];
  function bootstrap() {
    return { fixtureOnly: true, viewer, uiVersion, guilds: fakeGuilds, providers: fakeProviders, media, auditLogs, settings: Object.fromEntries([...values.keys()].map(key => { const [guildId, providerId] = key.split(':'); return [key, settings(guildId, providerId)]; })) };
  }
  const personal = {
    saved: [
      { id: 'saved-1', kind: 'saved', url: 'https://example.test/art/first', title: '次の作品で参考にしたい配色', note: '暖色と寒色の比率を比較する', tags: ['作品', '参考資料'], updatedAt: now, editable: true, cancellable: true },
      { id: 'saved-2', kind: 'saved', url: 'https://example.test/articles/layout', title: '読み返したいレイアウトの記事・長いタイトルの折り返しと余白を確認するための検証データ', note: '', tags: ['読む'], updatedAt: now, editable: true, cancellable: true },
    ],
    reminder: [{ id: 'reminder-1', kind: 'reminder', url: 'https://example.test/event', title: '作品の提出前に見返す', dueAt: now + 86400000, timeZone: 'Asia/Tokyo', status: 'pending', updatedAt: now, editable: true, cancellable: true }],
    restock: [{ id: 'restock-1', kind: 'restock', url: 'https://booth.pm/ja/items/1234567', title: '架空の商品・再入荷待ち', variationId: 'fixture-blue', variationName: '青色', status: 'watching', updatedAt: now, editable: true, cancellable: true }],
  };
  const assets = new Map();
  const builder = await require('esbuild').context({ absWorkingDir: root, entryPoints: [path.join(__dirname, 'fixtures/dashboard-ui.tsx')], bundle: true, write: false, outfile: 'app.js', platform: 'browser', jsx: 'automatic', sourcemap: 'inline', tsconfig: path.join(dashboard, 'tsconfig.json'), nodePaths: [path.join(dashboard, 'node_modules')], alias: { react: path.dirname(localRequire.resolve('react/package.json')), 'react-dom': path.dirname(localRequire.resolve('react-dom/package.json')), 'next/link': path.join(__dirname, 'fixtures/next-browser-fixture.tsx'), 'next/navigation': path.join(__dirname, 'fixtures/next-browser-fixture.tsx') }, plugins: [{ name: 'fixture-auth-never-sends', setup(build) { build.onResolve({ filter: /^next-auth\/react$/ }, () => ({ path: 'safe-fixture-auth', namespace: 'fixture-auth' })); build.onLoad({ filter: /.*/, namespace: 'fixture-auth' }, () => ({ contents: 'export async function signOut(){ window.dispatchEvent(new CustomEvent("dashboard-fixture:auth", { detail: "signOut" })); return {url:"/dashboard"}; } export async function signIn(){ window.dispatchEvent(new CustomEvent("dashboard-fixture:auth", { detail: "signIn" })); }', loader: 'js' })); } }], define: { 'process.env.NODE_ENV': '"development"' } });
  let building;
  function build() {
    building ||= (async () => {
      const result = await builder.rebuild();
      const theme = require(path.join(dashboard, 'tailwind.config.ts')).default;
      for (const file of result.outputFiles) {
        const name = path.basename(file.path);
        const content = name.endsWith('.css') ? (await localRequire('postcss')([localRequire('tailwindcss')({ ...theme, content: ['app', 'components', 'features', 'lib', 'legacy'].map(folder => path.join(dashboard, folder, '**/*.{ts,tsx}').replaceAll('\\', '/')).concat(path.join(__dirname, 'fixtures/dashboard-ui.tsx').replaceAll('\\', '/')) }), localRequire('autoprefixer')]).process(file.text, { from: undefined })).css : file.text;
        assets.set(`/${name}`, content);
      }
    })().finally(() => { building = null; });
    return building;
  }
  await build();
  if (buildOnly) { const sizes = Object.fromEntries([...assets].map(([name, content]) => [name, Buffer.byteLength(content)])); await builder.dispose(); return { built: true, fixtureOnly: true, assets: sizes }; }

  async function input(req, limit = 65536) {
    let bytes = 0; const chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw Object.assign(new Error('Fixture input too large'), { status: 413 }); chunks.push(chunk); }
    return bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }
  const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' }); res.end(JSON.stringify(value)); };
  function editable(guildId) { if (!fakeGuilds.some(guild => guild.guildId === guildId && guild.canEdit)) throw Object.assign(new Error('検証用の閲覧専用サーバーです。'), { status: 403 }); }
  const server = http.createServer(async (req, res) => {
    try {
      if (!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host || '')) return json(res, { error: 'Loopback fixture only' }, 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== url.origin) return json(res, { error: 'Fixture origin required' }, 403);
      if (url.pathname === '/fixture/stop' && req.method === 'POST') { json(res, { stopping: true, fixtureOnly: true }); setImmediate(() => { void close(); }); return; }
      if (url.pathname === '/fixture/screenshot' && req.method === 'POST') {
        const body = await input(req, 10 * 1024 * 1024);
        if (!screenshotNames.has(body.name) || typeof body.image !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(body.image)) return json(res, { error: 'Allowlisted screenshot name and JPEG base64 required' }, 400);
        const bytes = Buffer.from(body.image, 'base64');
        if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return json(res, { error: 'JPEG screenshot required' }, 400);
        const folder = path.join(root, 'docs/qa/dashboard-redesign-2026-10-13'); await fs.mkdir(folder, { recursive: true });
        const saved = path.join(folder, `${body.name}.jpg`); await fs.writeFile(saved, bytes); json(res, { path: saved, bytes: bytes.length, fixtureOnly: true }); return;
      }
      if (url.pathname === '/fixture/bootstrap' && req.method === 'GET') { uiVersion = await requestVersion(req); return json(res, bootstrap()); }
      if (url.pathname === '/api/me/dashboard-ui' && req.method === 'POST') {
        if (!fakeViewerId) return json(res, { error: 'Fixture login required' }, 401);
        const body = await input(req, 1024);
        if (!['legacy', 'preview'].includes(body.version)) return json(res, { error: 'Invalid fixture UI version' }, 400);
        const cookie = preferences.createDashboardUIPreferenceCookie(fakeViewerId, body.version);
        res.setHeader('Set-Cookie', `${cookie.name}=${cookie.value}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
        return json(res, { version: body.version });
      }
      if (url.pathname === '/fixture/evidence' && req.method === 'GET') return json(res, { ...stats, settings: Object.fromEntries(values), personal, grants: Object.fromEntries(grants), media, productionIO: false });
      if (url.pathname === '/api/guilds/switcher' && req.method === 'GET') return json(res, fakeGuilds);
      const accessRoute = url.pathname.match(/^\/api\/guilds\/(\d+)\/access$/);
      if (accessRoute) {
        const guildId = accessRoute[1];
        if (!fakeGuilds.some(guild => guild.guildId === guildId && guild.canManageGuild)) return json(res, { error: '検証用のアクセス変更にはサーバー管理権限が必要です。' }, 403);
        stats.requests.push({ path: url.pathname, method: req.method, query: Object.fromEntries(url.searchParams) });
        if (req.method === 'GET') { const query = (url.searchParams.get('query') || '').trim(); return json(res, { enabled: true, grants: grants.get(guildId), members: members.filter(member => !query || member.id === query), roles, directoryError: null }); }
        if (req.method !== 'POST') return json(res, { error: 'Unsupported fixture method' }, 405);
        const body = await input(req), ids = [...new Set(body.targetIds || [])];
        if (!['user', 'role'].includes(body.targetType) || ![null, 'view', 'edit'].includes(body.accessLevel) || !ids.length || ids.length > 100 || ids.some(id => !/^\d{16,24}$/.test(id))) return json(res, { error: '検証用の対象とアクセス権を確認してください。' }, 400);
        const updated = grants.get(guildId).filter(grant => grant.targetType !== body.targetType || !ids.includes(grant.targetId));
        if (body.accessLevel) for (const targetId of ids) updated.push({ guildId, targetType: body.targetType, targetId, accessLevel: body.accessLevel, grantedByUserId: '444444444444444444' });
        grants.set(guildId, updated); stats.mutations.push({ action: 'access', guildId, ...body, fixtureOnly: true }); return json(res, { enabled: true, grants: updated });
      }
      const mediaRoute = url.pathname.match(/^\/api\/guilds\/(\d+)\/media$/);
      if (mediaRoute) {
        const guildId = mediaRoute[1], guild = fakeGuilds.find(guild => guild.guildId === guildId);
        if (!guild) return json(res, { error: 'Unknown fixture guild' }, 404);
        if (req.method === 'GET') return json(res, media);
        if (req.method !== 'POST') return json(res, { error: 'Unsupported fixture method' }, 405);
        if (!guild.permissions.administrator) return json(res, { error: '検証用の削除には管理者権限が必要です。' }, 403);
        const body = await input(req); if (body.action !== 'cleanupExpired') return json(res, { error: 'Unsupported fixture media action' }, 400);
        const cleanup = Object.fromEntries(media.providers.map(provider => [provider.providerId, provider.expiredCount]));
        for (const provider of media.providers) { provider.cacheCount -= provider.expiredCount; provider.totalSizeBytes -= provider.expiredCount * 1048576; provider.expiredCount = 0; }
        media.totalCacheCount = media.providers.reduce((sum, provider) => sum + provider.cacheCount, 0); media.totalSizeBytes = media.providers.reduce((sum, provider) => sum + provider.totalSizeBytes, 0);
        stats.mutations.push({ action: 'cleanupExpired', guildId, cleanup, fixtureOnly: true }); return json(res, { cleanup, status: media });
      }
      if (url.pathname === '/api/guilds/sync' && req.method === 'POST') {
        const body = await input(req);
        if (!fakeGuilds.some(guild => guild.guildId === body.sourceGuildId)) return json(res, { error: 'Unknown fixture source guild' }, 404);
        const targets = [...new Set(body.targetGuildIds || [])].filter(id => id !== body.sourceGuildId);
        for (const id of targets) if (!fakeGuilds.some(guild => guild.guildId === id && guild.canManageGuild)) return json(res, { error: '検証用のコピー先にはサーバー管理権限が必要です。' }, 403);
        for (const id of targets) for (const provider of fakeProviders) values.set(`${id}:${provider.providerId}`, structuredClone(values.get(`${body.sourceGuildId}:${provider.providerId}`)));
        stats.mutations.push({ action: 'copy', ...body }); return json(res, { targetCount: targets.length, fixtureOnly: true });
      }
      const settingRoute = url.pathname.match(/^\/api\/guilds\/(\d+)\/providers\/(?:([^/]+)\/(settings|reset)|(bulk))$/);
      if (settingRoute) {
        const [, guildId, providerId, operation, bulk] = settingRoute;
        if (!fakeGuilds.some(guild => guild.guildId === guildId)) return json(res, { error: 'Unknown fixture guild' }, 404);
        if (!bulk && !fakeProviders.some(provider => provider.providerId === providerId)) return json(res, { error: 'Unknown fixture service' }, 404);
        if (req.method === 'GET' && operation === 'settings') return json(res, { settings: settings(guildId, providerId) });
        editable(guildId); const body = await input(req);
        if (operation === 'reset' && req.method === 'POST') values.set(`${guildId}:${providerId}`, Object.fromEntries(specs.map(spec => [spec.key, structuredClone(spec.defaultValue)])));
        else if (bulk && req.method === 'POST' || operation === 'settings' && req.method === 'PATCH') {
          for (const provider of bulk ? fakeProviders : fakeProviders.filter(item => item.providerId === providerId)) {
            const current = values.get(`${guildId}:${provider.providerId}`);
            for (const [key, value] of Object.entries(body.changes || {})) if (Object.hasOwn(current, key)) current[key] = structuredClone(value);
          }
        } else return json(res, { error: 'Unsupported fixture method' }, 405);
        stats.mutations.push({ action: bulk ? 'preset' : operation, guildId, providerId, changes: body.changes }); return json(res, { warnings: [], complete: true, fixtureOnly: true, ...(operation === 'reset' ? { settings: settings(guildId, providerId) } : {}) });
      }
      if (url.pathname.startsWith('/api/personal-links/')) {
        const [kind, id] = url.pathname.slice('/api/personal-links/'.length).split('/');
        if (!Object.hasOwn(personal, kind)) return json(res, { error: 'Unknown fixture list' }, 404);
        stats.requests.push({ path: url.pathname, method: req.method, query: Object.fromEntries(url.searchParams) });
        const body = req.method === 'GET' ? {} : await input(req);
        if (kind === 'restock' && id === 'options' && req.method === 'POST') return json(res, { options: [{ id: 'fixture-blue', name: '青色', state: 'sold_out' }, { id: 'fixture-red', name: '赤色', state: 'sold_out' }] });
        if (req.method === 'GET') {
          const query = (url.searchParams.get('query') || '').toLowerCase(), tag = url.searchParams.get('tag');
          const rows = personal[kind].filter(item => (!query || `${item.title} ${item.url} ${item.note || ''}`.toLowerCase().includes(query)) && (!tag || item.tags?.includes(tag)));
          const page = Math.max(1, Number(url.searchParams.get('page') || 1)), size = 20;
          return json(res, { items: rows.slice((page - 1) * size, page * size), hasMore: page * size < rows.length });
        }
        const existing = personal[kind].find(item => item.id === id);
        if ((req.method === 'PATCH' || req.method === 'DELETE') && !existing) return json(res, { error: '検証用の項目がありません。' }, 404);
        const date = kind === 'reminder' && req.method !== 'DELETE' ? DateTime.fromISO(body.when, { zone: body.timeZone || 'Asia/Tokyo' }) : null;
        if (date && !date.isValid) return json(res, { error: '日時とタイムゾーンを確認してください。' }, 400);
        const notification = kind === 'saved' ? {} : { status: kind === 'reminder' ? 'pending' : 'watching', ...(date ? { dueAt: date.toMillis(), timeZone: body.timeZone } : {}) };
        if (req.method === 'POST') {
          if (kind === 'saved' && personal.saved.some(item => item.url === body.url)) return json(res, { already: true });
          if (kind !== 'saved' && personal[kind].some(item => item.requestId === body.requestId)) return json(res, {});
          personal[kind].unshift({ ...body, ...notification, id: randomUUID(), kind, updatedAt: Date.now(), editable: true, cancellable: true });
        } else if (req.method === 'PATCH') Object.assign(existing, body, notification, { updatedAt: Date.now() });
        else if (req.method === 'DELETE') {
          if (kind === 'saved') personal[kind] = personal[kind].filter(item => item.id !== id);
          else Object.assign(existing, { status: 'cancelled', editable: false, cancellable: false });
        } else return json(res, { error: 'Unsupported fixture method' }, 405);
        stats.mutations.push({ action: req.method, kind, id, fixtureOnly: true }); return json(res, {});
      }
      if (assets.has(url.pathname)) { res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.css') ? 'text/css;charset=utf-8' : 'text/javascript;charset=utf-8' }); return res.end(assets.get(url.pathname)); }
      if (url.pathname === '/' || /^\/dashboard(?:\/|$)/.test(url.pathname)) {
        uiVersion = await requestVersion(req);
        await build(); res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
        return res.end(`<!doctype html><html lang="ja" data-dashboard-ui="${uiVersion}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>通常ダッシュボード・架空データ検証</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>`);
      }
      json(res, { error: 'Fixture route not found' }, 404);
    } catch (error) { json(res, { error: error.message || 'Fixture operation failed', fixtureOnly: true }, Number(error.status) || 400); }
  });
  let closing = false;
  async function close() { if (closing) return; closing = true; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await builder.dispose(); if (require.main === module) process.stdin.pause(); }
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { await builder.dispose(); throw error; }
  return { url: `http://127.0.0.1:${server.address().port}`, stats, close, fixtureOnly: true, fakeViewerId, uiVersion };
}

module.exports = { startHarness, screenshotNames };
if (require.main === module) startHarness({ buildOnly: process.argv.includes('--build-only') }).then(result => {
  if (result.built) { console.log(JSON.stringify(result)); return; }
  console.log(JSON.stringify({ url: `${result.url}/dashboard`, pid: process.pid, fixtureOnly: true, fakeViewerId: result.fakeViewerId, uiVersion: result.uiVersion, screenshotFolder: 'docs/qa/dashboard-redesign-2026-10-13', stop: 'stdin "stop" or same-origin POST /fixture/stop' }));
  process.stdin.resume(); process.stdin.on('data', data => { if (String(data).trim() === 'stop') void result.close().then(() => process.exit(0)); });
  process.on('SIGINT', () => { void result.close().then(() => process.exit(0)); }); process.on('SIGTERM', () => { void result.close().then(() => process.exit(0)); });
}).catch(error => { console.error(error.message); process.exitCode = 1; });

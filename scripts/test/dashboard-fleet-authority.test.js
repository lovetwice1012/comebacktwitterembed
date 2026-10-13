'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const load = require('./helpers/load-dashboard.cjs');

async function fixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cbte-dashboard-authority-'));
  const filename = path.join(directory, 'lease.json');
  const keys = ['CBTE_FLEET_LEASE_FILE', 'CBTE_FLEET_NODE', 'CBTE_FLEET_EPOCH', 'DASHBOARD_FLEET_LEASE_MODE'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { CBTE_FLEET_LEASE_FILE: filename, CBTE_FLEET_NODE: 'primary', CBTE_FLEET_EPOCH: '3', DASHBOARD_FLEET_LEASE_MODE: 'shared-current' });
  const write = (changes = {}) => fs.writeFileSync(filename, JSON.stringify({ state: 'active', node: 'primary', epoch: 3, instanceId: 'primary:current-guardian', validUntilUnixMs: Date.now() + 60000, token: 'private-token', leaseId: 'private-lease', ...changes }));
  try { await run({ directory, filename, write, authority: load('lib/fleet-authority.ts') }); }
  finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert(path.basename(directory).startsWith('cbte-dashboard-authority-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('strict mode retains pinned epoch behavior and only explicit shared-current follows a reacquired epoch', async () => fixture(async f => {
  f.write({ epoch: 4 });
  assert.equal(f.authority.readDashboardFleetAuthority().available, true);
  assert.equal(f.authority.readDashboardFleetAuthority({ ...process.env, DASHBOARD_FLEET_LEASE_MODE: '' }).available, false);
  assert.deepEqual(f.authority.readDashboardFleetAuthority({}), { managed: false, available: true });
  assert.deepEqual(f.authority.readDashboardFleetAuthority({ DASHBOARD_FLEET_LEASE_MODE: 'shared-current' }), { managed: true, available: false });
}));

test('current authority is not cached and malformed, stale, inactive or wrong-node evidence fails closed', async () => fixture(async f => {
  assert.equal(f.authority.readDashboardFleetAuthority().available, false);
  f.write(); assert.equal(f.authority.readDashboardFleetAuthority().epoch, 3);
  f.write({ epoch: 4, instanceId: 'primary:new-guardian' }); assert.equal(f.authority.readDashboardFleetAuthority().epoch, 4);
  for (const change of [{ state: 'standby' }, { node: 'oci' }, { epoch: 0 }, { epoch: '4' }, { instanceId: '' }, { instanceId: 'private/path' }, { validUntilUnixMs: Date.now() - 1 }]) {
    f.write(change); assert.deepEqual(f.authority.readDashboardFleetAuthority(), { managed: true, available: false });
  }
  fs.writeFileSync(f.filename, '{broken private-token'); assert.equal(f.authority.readDashboardFleetAuthority().available, false);
  fs.writeFileSync(f.filename, 'x'.repeat(16385)); assert.equal(f.authority.readDashboardFleetAuthority().available, false);
  f.write({ state: 'renewal_unconfirmed' }); assert.equal(f.authority.readDashboardFleetAuthority().available, true);
}));

test('an operation admitted under one guardian cannot continue under a newer valid epoch or instance', async () => fixture(async f => {
  f.write(); const fence = f.authority.createDashboardFleetWriteFence(); fence();
  f.write({ epoch: 4 });
  assert.equal(f.authority.readDashboardFleetAuthority().available, true);
  assert.throws(fence, { code: 'DASHBOARD_AUTHORITY_UNAVAILABLE', status: 503 });
  f.write(); const instanceFence = f.authority.createDashboardFleetWriteFence();
  f.write({ instanceId: 'primary:replacement' }); assert.throws(instanceFence, { code: 'DASHBOARD_AUTHORITY_UNAVAILABLE' });
}));

test('Node middleware leaves view and login available, admits only exact independent exceptions, and blocks mutations without authority', async () => fixture(async f => {
  const module = load('middleware.ts', { 'next/server': { NextResponse: { next: () => ({ status: 200, next: true }), json: (body, options) => ({ body, ...options }) } } });
  const request = (method, pathname) => ({ method, nextUrl: { pathname }, headers: new Headers({ 'x-middleware-subrequest': 'middleware:middleware:middleware:middleware:middleware' }) });
  for (const pathname of ['/dashboard', '/admin', '/api/guilds', '/api/personal-links/saved', '/api/admin/recovery']) assert.equal(module.middleware(request('GET', pathname)).next, true);
  for (const pathname of ['/api/auth/signin', '/api/auth/signout', '/api/me/dashboard-ui', '/api/admin/agent-recovery']) assert.equal(module.middleware(request('POST', pathname)).next, true);
  for (const [method, pathname] of [['PATCH', '/api/guilds/123/providers/twitter/settings'], ['POST', '/api/guilds/sync'], ['DELETE', '/api/personal-links/saved/id'], ['POST', '/api/automation/square/webhook'], ['POST', '/api/admin/agent/actions'], ['POST', '/api/admin/agent-recovery/other'], ['PATCH', '/api/me/dashboard-ui']]) {
    const response = module.middleware(request(method, pathname));
    assert.equal(response.status, 503); assert.equal(response.body.code, 'DASHBOARD_AUTHORITY_UNAVAILABLE');
    assert(!JSON.stringify(response).includes('private-token')); assert.equal(response.headers['Retry-After'], '5');
  }
  f.write(); assert.equal(module.middleware(request('PATCH', '/api/guilds/123/providers/twitter/settings')).next, true);
  assert.equal(module.config.runtime, 'nodejs'); assert(module.config.matcher.includes('/api/:path*'));
}));

test('shared-current health distinguishes HTTP reachability from authority and never exposes lease credentials', async () => fixture(async f => {
  const health = load('app/api/health/route.ts', { 'next/server': { NextResponse: { json: (body, options) => ({ body, status: options?.status || 200, headers: options?.headers }) } } });
  let response = await health.GET();
  assert.equal(response.status, 200); assert.equal(response.body.ok, true); assert.equal(response.body.authorityAvailable, false);
  f.write({ epoch: 7 }); response = await health.GET();
  assert.equal(response.status, 200); assert.equal(response.body.authorityAvailable, true); assert.equal(response.body.epoch, 7);
  assert(!JSON.stringify(response).includes('private-')); assert.equal(response.body.scope, 'dashboard_http_only');
  f.write({ state: 'standby' }); response = await health.GET();
  assert.equal(response.status, 200); assert.equal(response.body.authorityAvailable, false); assert.equal(response.body.node, undefined);
}));

function fakeDatabase(onQuery = () => {}) {
  const stats = { queries: [], commits: 0, rollbacks: 0 };
  const query = async (sql, params) => { stats.queries.push({ sql, params }); await onQuery(sql); return []; };
  return { stats, queryDatabase: query, withDatabaseTransaction: async work => { try { const value = await work(query); stats.commits++; return value; } catch (error) { stats.rollbacks++; throw error; } } };
}

test('shared Bot store facade permits reads while authority is absent and denies writes before DB work', async () => fixture(async f => {
  const db = fakeDatabase(); const guarded = load('lib/fleet-database.ts').guardedDashboardDatabase(db);
  await guarded.queryDatabase('SELECT * FROM personal_saved_links WHERE owner_user_id=?', ['fixture-owner']);
  assert.equal(db.stats.queries.length, 1);
  await assert.rejects(guarded.queryDatabase('UPDATE personal_saved_links SET title=? WHERE id=?', ['new', 'fixture']), { status: 503 });
  assert.equal(db.stats.queries.length, 1); assert.equal(db.stats.commits, 0);
  f.write(); await guarded.queryDatabase('UPDATE personal_saved_links SET title=? WHERE id=?', ['new', 'fixture']);
  assert.equal(db.stats.commits, 1);
}));

test('a valid epoch change while SQL is running rolls back an admitted mutation before transaction commit', async () => fixture(async f => {
  f.write(); const db = fakeDatabase(sql => { if (sql.startsWith('UPDATE')) f.write({ epoch: 4 }); });
  const guarded = load('lib/fleet-database.ts').guardedDashboardDatabase(db);
  await assert.rejects(guarded.queryDatabase('UPDATE fixture SET value=?', ['value']), { code: 'DASHBOARD_AUTHORITY_UNAVAILABLE' });
  assert.equal(db.stats.commits, 0); assert.equal(db.stats.rollbacks, 1);
  assert.equal(f.authority.readDashboardFleetAuthority().available, true);
}));

test('an admitted transaction rechecks authority before every subsequent SQL statement', async () => fixture(async f => {
  f.write(); const db = fakeDatabase(); const guarded = load('lib/fleet-database.ts').guardedDashboardDatabase(db);
  await assert.rejects(guarded.withDatabaseTransaction(async query => { await query('SELECT 1'); f.write({ state: 'standby' }); await query('UPDATE fixture SET value=1'); }), { status: 503 });
  assert.equal(db.stats.queries.length, 1); assert.equal(db.stats.commits, 0); assert.equal(db.stats.rollbacks, 1);
}));

test('direct settings and delegated-access helpers refuse mutations before validation, table creation or DB work', async () => fixture(async () => {
  let databaseCalls = 0;
  const prisma = { $queryRawUnsafe: () => { databaseCalls++; }, $executeRawUnsafe: () => { databaseCalls++; }, $transaction: () => { databaseCalls++; } };
  const mocks = { '@/lib/prisma': { prisma }, '@/lib/env': { readRootConfig: () => ({}), getDashboardFlag: () => true, getDelegatedAccessRolloutStartAt: () => null }, '@/lib/settings-catalog': {}, '@/lib/settings-validation': {}, '@/lib/audit-log': {} };
  const settings = load('lib/settings-db.ts', mocks);
  for (const [name, args] of [['saveProviderSettings', ['guild', 'twitter', {}, { id: 'actor' }]], ['resetProviderSettings', ['guild', 'twitter', { id: 'actor' }]], ['saveBulkProviderSettings', ['guild', {}, { id: 'actor' }]], ['syncGuildSettings', ['source', 'target', { id: 'actor' }]]]) await assert.rejects(settings[name](...args), { status: 503 });
  await assert.rejects(load('lib/delegated-access.ts', mocks).replaceDelegatedAccess({}), { status: 503 });
  assert.equal(databaseCalls, 0);
}));

test('Prisma settings prepare audit schema outside the mutation and roll back when the admitted guardian changes before commit', async () => fixture(async f => {
  f.write(); let commits = 0, rollbacks = 0, schemaPrepared = 0;
  const tx = { $executeRawUnsafe: async sql => { assert(!sql.includes('CREATE TABLE')); f.write({ epoch: 4 }); } };
  const prisma = { $queryRawUnsafe: async () => [], $transaction: async work => { try { await work(tx); commits++; } catch (error) { rollbacks++; throw error; } } };
  const settings = load('lib/settings-db.ts', {
    '@/lib/prisma': { prisma },
    '@/lib/settings-catalog': { getProvider: () => ({ id: 'twitter' }), editableSpecs: () => [], getProviderSettingColumns: () => ({}) },
    '@/lib/settings-validation': { validateProviderChanges: () => ({ changes: {}, warnings: [] }) },
    '@/lib/audit-log': { ensureAuditLogTable: async () => { schemaPrepared++; }, recordAuditLog: async () => {} },
  });
  await assert.rejects(settings.saveProviderSettings('111111111111111111', 'twitter', {}, { id: 'fixture-owner' }), { code: 'DASHBOARD_AUTHORITY_UNAVAILABLE' });
  assert.equal(schemaPrepared, 1); assert.equal(commits, 0); assert.equal(rollbacks, 1);
}));

test('audit insertion never runs implicit-commit DDL on a mutation transaction', async () => fixture(async f => {
  f.write(); let writes = 0;
  const tx = { $executeRawUnsafe: () => { throw new Error('DDL would implicitly commit the mutation'); }, $executeRaw: async () => { writes++; } };
  const audit = load('lib/audit-log.ts', { '@/lib/prisma': { prisma: {} }, '@/lib/env': { getAuditHashSecret: () => 'fixture' } });
  await audit.recordAuditLog(tx, { guildId: '111111111111111111', actor: { id: 'fixture-owner', username: 'Fixture' }, action: 'setting.update' });
  assert.equal(writes, 1);
}));

test('audit and delegated-access GETs do not create tables while the node has no authority', async () => fixture(async () => {
  let writes = 0;
  const mocks = { '@/lib/prisma': { prisma: { $executeRawUnsafe: () => { writes++; }, $queryRawUnsafe: async () => [] } }, '@/lib/env': { getAuditHashSecret: () => 'fixture', getDashboardFlag: () => true, getDelegatedAccessRolloutStartAt: () => null } };
  assert.deepEqual(await load('lib/audit-log.ts', mocks).listAuditLogs('111111111111111111', {}), []);
  assert.deepEqual(await load('lib/delegated-access.ts', mocks).listDelegatedAccess('111111111111111111'), []);
  assert.equal(writes, 0);
}));

test('media GET serves existing files and expired responses without cleanup or telemetry writes during lease gaps', async () => fixture(async f => {
  const token = 'fixture_token_12345678'; const files = path.join(f.directory, 'files');
  fs.mkdirSync(path.join(files, token), { recursive: true }); fs.writeFileSync(path.join(files, token, 'fixture.mp4'), 'fixture bytes');
  let cleanup = 0, telemetry = 0; let expiresAtMs = Date.now() + 60000;
  const store = { cleanupExpiredDownloads: async () => { cleanup++; }, contentTypeForFilename: () => 'video/mp4', _internal: { getFilesDir: () => files, readIndex: async () => ({ [token]: { token, filename: 'fixture.mp4', expiresAtMs } }) } };
  const media = load('lib/media-delivery.ts', { '@/lib/bot-require': { requireBotModule: name => name === 'src/errorTracking.js' ? { recordAnalyticsEvent: () => { telemetry++; } } : store } });
  const response = await media.serveCachedMedia('youtube', token); assert.equal(response.status, 200); assert.equal(await response.text(), 'fixture bytes');
  expiresAtMs = Date.now() - 1; assert.equal((await media.serveCachedMedia('youtube', token)).status, 410);
  assert.equal(cleanup, 0); assert.equal(telemetry, 0);
}));

test('bulk media deletion stops before the next item when guardian ownership changes', async () => fixture(async f => {
  f.write(); const removed = [];
  const store = { listCachedDownloads: async () => [{ token: 'first' }, { token: 'second' }], deleteCachedDownload: async token => { removed.push(token); f.write({ epoch: 4 }); return true; } };
  const media = load('lib/media-cache.ts', { '@/lib/bot-require': { requireBotModule: () => store }, '@/lib/settings-catalog': {} });
  await assert.rejects(media.deleteProviderMediaCache('youtube'), { status: 503 });
  assert.deepEqual(removed, ['first']);
}));

test('independent reports remain readable but GET cannot enqueue refreshes and direct force-refresh fails without authority', async () => fixture(async () => {
  const previousFetch = globalThis.fetch; const requests = [];
  globalThis.fetch = async (_url, request) => { requests.push(request.method); return new Response(JSON.stringify({ report: { fixture: true }, cache: { updatedAt: '2020-01-01T00:00:00Z' } })); };
  try {
    const reports = load('lib/admin-report-client.ts', { '@/lib/admin-agent': { adminAgentEndpoint: () => new URL('http://127.0.0.1:1/fixture') } });
    const report = await reports.getIndependentAdminReport('overview', {}, 'fixture-owner');
    assert.equal(report.fixture, true); assert.equal(report.cache.ready, true); assert.deepEqual(requests, ['GET']);
    await assert.rejects(reports.getIndependentAdminReport('overview', {}, 'fixture-owner', true), { status: 503 });
    assert.deepEqual(requests, ['GET']);
  } finally { globalThis.fetch = previousFetch; }
}));

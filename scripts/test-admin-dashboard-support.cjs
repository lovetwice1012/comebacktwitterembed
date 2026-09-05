const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const ts = require('../dashboard/node_modules/typescript');
const root = path.resolve(__dirname, '..');
function load(file, mocks = {}, extras = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports, require: id => Object.hasOwn(mocks, id) ? mocks[id] : require(id), Buffer, URL, AbortSignal, process, ...extras }, { filename: file });
  return exports;
}
async function main() {
  const log = load('dashboard/lib/admin-log-query.ts');
  const cursor = { audit: { id: 'abc', time: '2026-09-05T12:00:00Z' }, errors: { id: '12', time: 1788609600000 } };
  assert.equal(log.decodeLogCursor(Buffer.from(JSON.stringify(cursor)).toString('base64url')).audit.id, 'abc');
  assert.throws(() => log.decodeLogCursor(Buffer.from('{"audit":{"id":"1 OR 1=1","time":0}}').toString('base64url')));
  assert.throws(() => log.logConditions('errors', { from: 'invalid' }));
  assert.throws(() => log.logConditions('errors', { from: '2026-09-06', to: '2026-09-05' }));
  const conditions = log.logConditions('errors', { guildId: '123 OR 1=1', from: '2026-09-05T21:00:00+09:00', to: '2026-09-05T22:00:00+09:00' }, cursor.errors);
  assert.equal(conditions.where.includes('123 OR 1=1'), false);
  assert.equal(conditions.params[0], '123 OR 1=1');
  assert.match(conditions.where, /occurred_at_ms < \? OR \(occurred_at_ms = \? AND error_event_id < \?\)/);
  assert.match(conditions.order, /occurred_at_ms DESC, error_event_id DESC/);

  const metrics = load('dashboard/lib/metric-observation-query.ts');
  assert.equal(metrics.observedRatio(0, 10), 0);
  assert.equal(metrics.observedRatio(0, 0), null);
  assert.equal(metrics.observedRatio(null, 10), null);
  assert.equal(metrics.observedRatio(101, 102), 101 / 102);
  assert.equal(metrics.aggregateNumericFacet([{facet_key:'p.likes',sum_value:110,numeric_subject_count:1,avg_value:110},{facet_key:'p.likes',sum_value:20,numeric_subject_count:2,avg_value:10}], 'p.likes'),130);
  assert.equal(metrics.aggregateNumericFacet([{facet_key:'p.likes',numeric_subject_count:1,avg_value:110},{facet_key:'p.likes',numeric_subject_count:2,avg_value:10}], 'p.likes','avg_value'),130/3);
  assert.equal(metrics.aggregateNumericFacet([{facet_key:'p.price',events:100,aggregation_status:'unsupported_aggregation'}], 'p.price'),null);
  const sql = metrics.metricObservationQuery('c.occurred_at_ms >= ? AND c.occurred_at_ms < ?', true);
  // Execute the generated relational query against duplicate observations. SQLite uses equivalent IS null-safe equality.
  const python = String.raw`import json,sqlite3,sys,re
sql=json.load(sys.stdin)['sql'].replace('<=>',' IS ')
db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
db.create_collation('utf8mb4_bin',lambda a,b: (a>b)-(a<b))
db.create_function('CONCAT',-1,lambda *xs: ''.join(str(x) for x in xs))
db.create_function('REGEXP',2,lambda p,v: bool(re.search(p,v or '')))
db.executescript('CREATE TABLE bot_provider_content_events(content_event_id INTEGER,provider_id TEXT,account_key TEXT,content_id TEXT,normalized_url TEXT,content_url TEXT,author_user_id TEXT,guild_id TEXT,occurred_at_ms INTEGER); CREATE TABLE bot_provider_content_facets(facet_id INTEGER,content_event_id INTEGER,provider_id TEXT,account_key TEXT,facet_key TEXT,numeric_value REAL,collected_at_ms INTEGER);')
for i,(provider,content,value) in enumerate([('twitter','same',100),('twitter','same',100),('twitter','same',110),('twitter','other',5),('pixiv','same',20)],1):
 db.execute('INSERT INTO bot_provider_content_events VALUES(?,?,?,?,?,?,?,?,?)',(i,provider,'author',content,'https://'+provider+'/'+content,None,'user'+str(i%2),'guild',i*100))
 db.execute('INSERT INTO bot_provider_content_facets VALUES(?,?,?,?,?,?,?)',(i,i,provider,'author',provider+'.likes',value,i*100))
rows=[dict(r) for r in db.execute(sql,(0,1000,100))]
t=next(r for r in rows if r['provider_id']=='twitter');p=next(r for r in rows if r['provider_id']=='pixiv')
assert t['sum_value']==115,t
assert t['content_count']==2 and t['events']==4,t
assert t['users']==2 and t['guilds']==1,t
assert p['sum_value']==20,p
db.execute('INSERT INTO bot_provider_content_facets VALUES(6,1,?,?,?,?,?)',('twitter','author','twitter.likes',120,900))
delayed=next(dict(r) for r in db.execute(sql,(0,1000,100)) if r['provider_id']=='twitter')
assert delayed['sum_value']==125 and delayed['latest_observation_ms']==900,delayed
db.execute('INSERT INTO bot_provider_content_facets VALUES(7,1,?,?,?,?,?)',('twitter','author','twitter.price',1500,900))
db.execute('INSERT INTO bot_provider_content_facets VALUES(8,4,?,?,?,?,?)',('twitter','author','twitter.price',20,900))
price=next(dict(r) for r in db.execute(sql,(0,1000,100)) if r['facet_key']=='twitter.price')
assert price['aggregation_status']=='unsupported_aggregation',price
assert all(price[k] is None for k in ['sum_value','avg_value','min_value','max_value']),price
db.execute('INSERT INTO bot_provider_content_facets VALUES(9,1,?,?,?,?,?)',('twitter','author','twitter.likes',None,950))
missing=next(dict(r) for r in db.execute(sql,(0,1000,100)) if r['facet_key']=='twitter.likes')
assert missing['sum_value']==5 and missing['numeric_subject_count']==1,missing
print('latest observations: delayed collection time, missing latest values, noncomparable units, deduplication and unique membership passed')`;
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', python], { input: JSON.stringify({ sql }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  process.stdout.write(result.stdout);

  class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
  let authorized = true, upstreamCalls = 0, upstreamInit;
  const endpoint = load('dashboard/lib/admin-agent.ts', { 'server-only': {} });
  process.env.ADMIN_AGENT_TOKEN = 'test-secret-never-in-response';
  process.env.ADMIN_AGENT_URL = 'http://127.0.0.1:30988';
  process.env.NEXTAUTH_URL = 'https://cbte.example';
  const route = load('dashboard/app/api/admin/agent/[...path]/route.ts', {
    'next/server': { NextResponse: { json: (body, options) => ({ body, status: options?.status || 200 }) } },
    '@/lib/api': { ApiError, requireAdminSession: async () => { if (!authorized) throw new ApiError(403, 'admin required'); return { user: { id: 'owner' } }; }, errorResponse: e => ({ status: e.status || 500, body: { error: e.message } }) },
    '@/lib/admin-agent': endpoint,
  }, { fetch: async (_url, init) => { upstreamCalls++; upstreamInit = init; return { status: 202, json: async () => ({ id: 'action-1', status: 'queued' }) }; } });
  function request(method, origin = 'https://cbte.example') { return { method, url: 'https://cbte.example/api/admin/agent/actions', nextUrl: { origin: 'https://cbte.example', search: '' }, headers: new Map([['origin', origin], ['content-type', 'application/json']]), text: async () => '{"type":"url.inspect","input":{"url":"https://example.com"}}' }; }
  const ctx = path => ({ params: Promise.resolve({ path }) });
  assert.equal((await route.POST(request('POST', 'https://attacker.example'), ctx(['actions']))).status, 403);
  assert.equal(upstreamCalls, 0);
  assert.equal((await route.GET(request('GET'), ctx(['..', 'private']))).status, 404);
  authorized = false;
  assert.equal((await route.GET(request('GET'), ctx(['health']))).status, 403);
  assert.equal(upstreamCalls, 0);
  authorized = true;
  const response = await route.POST(request('POST'), ctx(['actions']));
  assert.equal(response.status, 202);
  assert.equal(upstreamInit.headers['x-admin-actor'], 'owner');
  assert.equal(upstreamInit.headers.authorization, 'Bearer test-secret-never-in-response');
  assert.equal(JSON.stringify(response).includes('test-secret'), false);
  process.env.ADMIN_AGENT_URL = 'https://external.example';
  assert.throws(() => endpoint.adminAgentEndpoint('actions'));
  console.log('admin dashboard: auth, CSRF, endpoint restriction, token isolation, log cursor, ratios passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

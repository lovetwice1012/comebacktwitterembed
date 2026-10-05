'use strict';
// Local UI contract fixture: no production credentials, DB, or Discord transport.
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');

async function startHarness() {
  const root = path.resolve(__dirname, '..'), dashboard = path.join(root, 'dashboard');
  const localRequire = createRequire(path.join(dashboard, 'package.json'));
  const stats = { requests: [], mutations: [] };
  const guild = '111111111111111111', channel = '333333333333333333', user = '222222222222222222';
  const stamp = new Date().toISOString();
  const runs = Array.from({ length: 4 }, (_, i) => ({ id: `run-${i + 1}`, firstAt: stamp, lastAt: stamp, guildId: guild, channelId: i === 3 ? '444444444444444444' : channel, userId: user, outcome: i ? 'F' : 'E', provider: 'twitter', input: { guildId: guild, channelId: i === 3 ? '444444444444444444' : channel, userId: user, messageId: `${555555555555555550n + BigInt(i)}`, provider: 'twitter', url: `https://x.com/example/status/${i + 1}` }, completion: { outcome: i ? 'F' : 'E', durationMs: 1234, details: { failureStage: i ? undefined : 'fetch', reason: i ? '送信完了' : '取得先がHTTP 429を返しました' } } }));
  const incidents = [{ id: 'incident-1', title: '取得先のレート制限', status: 'Detected', createdAt: stamp, evidence: { code: 'RATE_LIMIT', confirmed: true } }];
  const actions = new Map([['running-1', { id: 'running-1', type: 'report.generate', status: 'running', createdAt: stamp }]]);
  const receipts = new Map(); let settings = { enabled: true, bannedWords: ['例'], maxQuoteDepth: 2 }, revision = 1;
  const specs = [{ key: 'enabled', label: { ja: '自動展開を有効にする' }, description: { ja: 'このサーバーでURLの自動展開を行います。' } }, { key: 'bannedWords', label: { ja: '除外する単語' }, description: { ja: '一致した投稿の展開を見送ります。' } }, { key: 'maxQuoteDepth', label: { ja: '引用を取得する深さ' }, description: { ja: '引用先の最大取得数です。' } }];
  const catalog = [{ type: 'settings.get', label: '設定を確認', inputExample: { guildId: '', providerId: 'twitter' } }, { type: 'settings.change', label: '設定を変更', inputExample: { guildId: '', providerId: 'twitter', key: 'enabled', value: true }, mutating: true }, { type: 'settings.reset', label: '設定を初期値に戻す', mutating: true }, { type: 'settings.copy', label: '設定をコピー', mutating: true }];
  const assets = new Map();
  const result = await require('esbuild').build({ absWorkingDir: root, entryPoints: [path.join(__dirname, 'fixtures/admin-workspace-ui.tsx')], bundle: true, write: false, outfile: 'app.js', platform: 'browser', jsx: 'automatic', nodePaths: [path.join(dashboard, 'node_modules')], alias: { react: path.dirname(localRequire.resolve('react/package.json')), 'react-dom': path.dirname(localRequire.resolve('react-dom/package.json')) }, define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}'  } });
  const theme = require(path.join(dashboard, 'tailwind.config.ts')).default;
  for (const file of result.outputFiles) {
    const name = path.basename(file.path);
    const content = name.endsWith('.css') ? (await localRequire('postcss')([localRequire('tailwindcss')({ ...theme, content: [path.join(dashboard, 'components/**/*.{ts,tsx}').replaceAll('\\', '/'), path.join(__dirname, 'fixtures/admin-workspace-ui.tsx').replaceAll('\\', '/')] }), localRequire('autoprefixer')]).process(file.text, { from: undefined })).css : file.text;
    assets.set(`/${name}`, content);
  }
  async function api(req, url) {
    const path = url.pathname, q = url.searchParams;
    stats.requests.push({ method: req.method, path, query: Object.fromEntries(q) });
    if (path === '/api/admin/directory') return { items: q.has('guildId') ? [{ id: channel, name: 'お問い合わせ', type: 0 }] : [{ id: guild, name: '検証サーバー' }] };
    if (path === '/api/admin/catalog') return [{ providerId: 'twitter', label: 'X / Twitter', settings: specs }];
    const endpoint = path.replace('/api/admin/agent/', '');
    if (endpoint === 'health') return { ok: true, time: stamp };
    if (endpoint === 'catalog') return { actions: catalog };
    if (endpoint === 'shards') return { state: 'recent_heartbeat', heartbeatAt: stamp, items: [] };
    if (endpoint === 'metrics') return { requestCount: 4, problemRequestCount: 1, outcomes: { F: 3, E: 1 }, fullSuccess: { numerator: 3, denominator: 4, ratio: 0.75 }, coverage: { measurementState: 'observed', collectionState: 'recent_heartbeat' } };
    if (endpoint === 'runs') {
      let items = runs.filter(row => ['guildId', 'channelId', 'userId', 'messageId'].every(key => !q.get(key) || (row[key] || row.input[key]) === q.get(key)));
      if (q.get('problematic') === '1') items = items.filter(row => row.outcome !== 'F');
      if (q.get('outcome')) items = items.filter(row => q.get('outcome').split(',').includes(row.outcome));
      const offset = Number(q.get('cursor') || 0); return { appliedFilters: Object.fromEntries(q), items: items.slice(offset, offset + 2), nextCursor: offset + 2 < items.length ? String(offset + 2) : null };
    }
    if (endpoint.startsWith('runs/')) { const row = runs.find(item => item.id === endpoint.slice(5)); if (!row) throw new Error('Record not found'); return { ...row, events: [{ payload: { ...row.input, kind: 'request.started', occurredAt: stamp } }, { payload: { ...row.completion, kind: 'request.completed', occurredAt: stamp } }] }; }
    if (endpoint === 'incidents') return { items: incidents };
    if (endpoint.startsWith('incidents/')) return incidents[0];
    if (endpoint === 'events' || endpoint === 'notifications') return { appliedFilters: Object.fromEntries(q), items: [] };
    if (endpoint === 'actions' && req.method === 'GET') return { appliedFilters: Object.fromEntries(q), items: [...actions.values()].filter(row => (!q.get('status') || row.status === q.get('status')) && (!q.get('guildId') || row.input?.guildId === q.get('guildId'))) };
    if (endpoint.startsWith('actions/')) return actions.get(endpoint.slice(8));
    if (endpoint === 'actions' && req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks));
      if (receipts.has(request.idempotencyKey)) return receipts.get(request.idempotencyKey);
      let result;
      if (request.type === 'settings.get') result = { settings, hash: `revision-${revision}`, specs, defaults: { enabled: true, bannedWords: [], maxQuoteDepth: 1 } };
      else if (request.type === 'settings.change' || request.type === 'settings.reset') {
        if (request.input.expectedHash !== `revision-${revision}`) throw new Error('SETTINGS_CONFLICT');
        stats.mutations.push(request); settings = { ...settings, [request.input.key]: request.type === 'settings.reset' ? true : request.input.value }; revision++;
        result = { settings, hash: `revision-${revision}`, reflectionStatus: 'saved' };
      } else result = { outcome: 'preview_generated', steps: [], reason: 'fixture' };
      const action = { id: `action-${actions.size + 1}`, type: request.type, input: request.input, status: 'succeeded', result, createdAt: stamp, updatedAt: stamp };
      actions.set(action.id, action); receipts.set(request.idempotencyKey, action); return action;
    }
    if (path.startsWith('/api/admin/')) return { cache: { ready: false, refreshing: false } };
    throw new Error('Unknown fixture request');
  }
  const server = http.createServer(async (req, res) => {
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host || '')) { res.writeHead(403); res.end(); return; }
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith('/api/')) { if (req.method !== 'GET' && req.headers.origin !== url.origin) { res.writeHead(403); res.end(); return; } const data = await api(req, url); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); return; }
      if (assets.has(url.pathname)) { res.writeHead(200, { 'content-type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(assets.get(url.pathname)); return; }
      res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); res.end('<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>管理画面 ローカル検証</title><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script></html>');
    } catch (error) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, stats, close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); } };
}
module.exports = { startHarness };
if (require.main === module) startHarness().then(harness => { console.log(harness.url + '/admin'); process.stdin.resume(); process.stdin.on('data', data => { if (String(data).trim() === 'stop') void harness.close().then(() => process.exit(0)); }); }).catch(error => { console.error(error); process.exitCode = 1; });

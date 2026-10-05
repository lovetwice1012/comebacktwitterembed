'use strict';
// Loopback-only fixture. Uses disposable SQL and production React/API modules,
// with a fixed fake login and mock stock options. No notification runner starts.
process.env.NODE_ENV = 'test';
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createFixture } = require('./lib/personal-dashboard-fixture.cjs');
const load = require('./test/helpers/load-dashboard.cjs');
async function main() {
    const root = path.resolve(__dirname, '..'), dashboard = path.join(root, 'dashboard');
    const local = createRequire(path.join(dashboard, 'package.json'));
    const f = await createFixture(Number(process.env.AUTOMATION_TEST_DB_PORT));
    const user = '111111111111111111', guild = '333333333333333333';
    class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
    const route = load('app/api/personal-links/[...path]/route.ts', {
        '@/lib/api': { ApiError, requireSession: async () => ({ user: { id: user } }), json: (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }) },
        '@/lib/server-locale': { getDashboardLocaleFromRequest: () => 'ja' },
        '@/lib/personal-links-server': { ...f.api, personalLinkServices: () => f.services },
    });
    const builder = await require('esbuild').context({ absWorkingDir: root, entryPoints: ['scripts/fixtures/personal-links-ui.tsx'],
        bundle: true, write: false, outfile: 'app.js', platform: 'browser', jsx: 'automatic', tsconfig: path.join(dashboard, 'tsconfig.json'),
        nodePaths: [path.join(dashboard, 'node_modules')], alias: { react: path.dirname(local.resolve('react/package.json')), 'react-dom': path.dirname(local.resolve('react-dom/package.json')),
            'next/navigation': path.join(__dirname, 'fixtures/personal-links-navigation.ts') }, define: { 'process.env.NODE_ENV': '"development"' } });
    const assets = new Map();
    async function build() {
        for (const output of (await builder.rebuild()).outputFiles) {
            const name = path.basename(output.path);
            const content = name.endsWith('.css') ? (await local('postcss')([local('tailwindcss')({ ...require(path.join(dashboard, 'tailwind.config.ts')).default,
                content: [path.join(dashboard, 'components/**/*.{ts,tsx}').replaceAll('\\', '/'), path.join(__dirname, 'fixtures/personal-links-ui.tsx').replaceAll('\\', '/')] }), local('autoprefixer')]).process(output.text, { from: undefined })).css : output.text;
            assets.set(`/${name}`, content);
        }
    }
    await build();
    const server = http.createServer(async (req, res) => {
        try {
            if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')) { res.writeHead(403); return res.end(); }
            const url = new URL(req.url, `http://${req.headers.host}`);
            res.setHeader('Cache-Control', 'no-store');
            const chunks = []; let bytes = 0;
            for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) throw new Error('Fixture body too large'); chunks.push(chunk); }
            const raw = Buffer.concat(chunks);
            if (url.pathname === '/fixture/stop' && req.method === 'POST' && req.headers.origin === url.origin) {
                res.end('Stopping disposable fixture.'); setImmediate(() => { void close(); }); return;
            }
            if (url.pathname.startsWith('/api/personal-links/')) {
                const request = new Request(url, { method: req.method, headers: req.headers, ...(raw.length ? { body: raw } : {}) });
                request.nextUrl = url;
                const response = await route[req.method](request, { params: Promise.resolve({ path: url.pathname.slice('/api/personal-links/'.length).split('/') }) });
                res.writeHead(response.status, Object.fromEntries(response.headers.entries())); return res.end(await response.text());
            }
            if (url.pathname === '/fixture/settings') {
                if (req.method === 'PATCH') {
                    if (req.headers.origin !== url.origin) throw new Error('Fixture origin');
                    await f.settings.saveProviderSettings(guild, 'pixiv', JSON.parse(raw), { id: user, username: 'Fixture' });
                }
                const states = await f.settings.getProviderSettingsState('pixiv', guild, 'ja');
                res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(states.filter(s => ['gallery_display_mode', 'show_previous_shares'].includes(s.key))));
            }
            if (url.pathname === '/fixture/evidence') {
                const bot = await f.botSettings._internal.loadProviderSettings({ id: 'pixiv' }, guild);
                res.setHeader('Content-Type', 'application/json');
                return res.end(JSON.stringify({ gallery: bot.gallery_display_mode, previousShares: bot.show_previous_shares,
                    saved: await f.store.listSaved(user), reminders: await f.store.listNotifications(user, 'reminder'), restock: await f.store.listNotifications(user, 'restock') }));
            }
            if (url.pathname === '/mobile') {
                res.setHeader('Content-Type', 'text/html;charset=utf-8'); return res.end('<!doctype html><html><meta charset="utf-8"><title>390px verification</title><iframe title="390px preview" src="/" style="display:block;border:1px solid #ccc;width:390px;height:880px;margin:20px auto"></iframe></html>');
            }
            if (url.pathname === '/') {
                res.setHeader('Content-Type', 'text/html;charset=utf-8');
                return res.end('<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>あとで見る・通知 検証</title><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script></html>');
            }
            if (assets.has(url.pathname)) { res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript'); return res.end(assets.get(url.pathname)); }
            res.writeHead(404); res.end();
        } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
    });
    server.listen(0, '127.0.0.1', () => { process.env.NEXTAUTH_URL = `http://127.0.0.1:${server.address().port}`; console.log(JSON.stringify({ url: process.env.NEXTAUTH_URL, schema: f.db.schema })); });
    let closing = false;
    async function close() { if (closing) return; closing = true; server.closeAllConnections(); server.close(); await builder.dispose(); await f.close(); console.log('Disposable fixture closed.'); process.exit(0); }
    process.stdin.resume(); process.stdin.on('data', data => { if (String(data).trim() === 'stop') void close(); });
    process.on('SIGINT', close); process.on('SIGTERM', close);
}
main().catch(error => { console.error(error.message); process.exit(1); });

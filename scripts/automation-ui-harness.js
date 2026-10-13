'use strict';

// A loopback-only, disposable integration fixture. Never imported by the Bot
// or Dashboard. It cannot read production DB credentials or send Discord I/O.
process.env.NODE_ENV = 'test';
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createTestDatabase } = require('./lib/automation-test-db');
const { dispatch } = require('../src/automation/api');
async function main() {
    const root = path.resolve(__dirname, '..'), dashboard = path.join(root, 'dashboard'), localRequire = createRequire(path.join(dashboard, 'package.json'));
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    const service = require('../src/automation/service').createService(db);
    const actor = { userId: '222222222222222222', guildId: '111111111111111111', canView: true, canEdit: true, isAdmin: true };
    await require('./lib/automation-test-db').grantTestDonor(db, actor.userId);
    const evaluator = require('../src/automation/evaluation').createEvaluator(service.dictionaryData);
    const starter = require('../src/automation/moderation'), moderation = starter.createModeration(db, service, evaluator);
    const rest = async (route, options) => {
        const guildId = actor.guildId, userId = actor.userId, botId = '333333333333333333', channelId = '444444444444444444';
        const permissions = String((1n << 10n) | (1n << 11n) | (1n << 29n));
        const channel = { id: channelId, guild_id: guildId, type: 0, name: '検証用チャンネル', nsfw: false, permission_overwrites: [] };
        const webhook = { id: '555555555555555555', token: 'fixture-only-not-a-real-webhook-aaaaaaaaaaaa', guild_id: guildId, channel_id: channelId, type: 1, name: 'ComebackTwitterEmbed Auto', user: { id: botId } };
        const data = route === `/guilds/${guildId}` ? { id: guildId, owner_id: userId } : route === `/guilds/${guildId}/roles` ? [{ id: guildId, permissions }]
            : route.startsWith(`/guilds/${guildId}/members/`) ? { user: { id: route.split('/').at(-1) }, roles: [] } : route === '/users/@me' ? { id: botId }
                : route === `/guilds/${guildId}/channels` ? [channel] : route === `/channels/${channelId}` ? channel : route === `/channels/${channelId}/webhooks` ? options?.method === 'POST' ? webhook : [webhook]
                    : route.startsWith('/webhooks/') ? webhook : undefined;
        if (!data) throw new Error('No external Discord request is allowed in this fixture');
        return { data };
    };
    const destinations = require('../src/automation/destinations').createDestinations(db, service, { rest });
    const services = {
        db, service, evaluator, destinations, billing: require('../src/automation/square-billing').createSquareBilling(db, { env: {} }), monitors: require('../src/automation/monitors').createMonitors(db, service, destinations),
        donations: require('../src/automation/square-donations').createSquareDonations(db, { env: {} }),
        dictionaryService: require('../src/automation/dictionary-service').createDictionaryService(db, service, evaluator),
        market: require('../src/automation/marketplace').createMarketplace(db, { service, evaluator, moderationMatcher: moderation }), history: require('../src/automation/history').createHistory(db, service), moderation, starter,
        schema: require('../src/automation/schema'), format: require('../src/automation/format'), bundle: require('../src/automation/bundle'), catalog: require('../src/automation/catalog'),
    };
    await service.saveDestination(actor, { name: '検証ユーザーのDM', kind: 'dm', scope: 'private' });
    await service.createWorkflow(actor, { definition: services.catalog.template('sale', 'morning', 'text'), scope: 'private' });
    await service.saveDictionary(actor, { dictionary: { schemaVersion: 1, name: '検証用辞書', source: '架空の試験データ', license: 'CC0-1.0', entries: ['広告', { term: '広告制作', kind: 'allow' }] } });
    const assets = new Map();
    // Personal-link preview data never reaches the production store.
    const personalItems = { saved: [], reminder: [], restock: [] };
    const builder = await require('esbuild').context({ absWorkingDir: root, entryPoints: [path.join(__dirname, 'fixtures/automation-ui.tsx')], bundle: true, write: false, outfile: 'app.js', platform: 'browser', jsx: 'automatic', sourcemap: 'inline', nodePaths: [path.join(dashboard, 'node_modules')], alias: { react: path.dirname(localRequire.resolve('react/package.json')), 'react-dom': path.dirname(localRequire.resolve('react-dom/package.json')), 'next/link': path.join(__dirname, 'fixtures/next-browser-fixture.tsx'), 'next/navigation': path.join(__dirname, 'fixtures/next-browser-fixture.tsx') }, define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' } });
    async function build() {
        const result = await builder.rebuild();
        const theme = require(path.join(dashboard, 'tailwind.config.ts')).default;
        for (const file of result.outputFiles) {
            const name = path.basename(file.path);
            const content = name.endsWith('.css') ? (await localRequire('postcss')([localRequire('tailwindcss')({ ...theme, content: [path.join(dashboard, 'components/**/*.{ts,tsx}').replaceAll('\\', '/'), path.join(__dirname, 'fixtures/automation-ui.tsx').replaceAll('\\', '/')] }), localRequire('autoprefixer')]).process(file.text, { from: undefined })).css : file.text;
            assets.set(`/${name}`, content);
        }
    }
    await build();
    const server = http.createServer(async (req, res) => {
        try {
            if (!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host || '')) { res.writeHead(403); res.end(); return; }
            const url = new URL(req.url, `http://${req.headers.host}`);
            res.setHeader('Cache-Control', 'no-store');
            if (url.pathname === '/api/guilds/switcher') {
                res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify([
                    { guildId: actor.guildId, name: '検証用サーバーA', canEdit: true, canManageGuild: true },
                    { guildId: '666666666666666666', name: '検証用サーバーB', canEdit: false, canManageGuild: false },
                ])); return;
            }
            if (url.pathname === '/fixture/stop' && req.method === 'POST' && req.headers.origin === url.origin) {
                res.end('Stopping disposable fixture.'); setImmediate(() => { void close(); }); return;
            }
            if (url.pathname === '/fixture/screenshot' && req.method === 'POST') {
                if (req.headers.origin !== url.origin) { res.writeHead(403); res.end(); return; }
                const chunks = []; let bytes = 0;
                for await (const chunk of req) { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) throw new Error('Screenshot limit'); chunks.push(chunk); }
                const input = JSON.parse(Buffer.concat(chunks));
                if (!['mobile-review', 'desktop-list'].includes(input.name) || typeof input.image !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(input.image)) throw new Error('Invalid screenshot');
                const image = Buffer.from(input.image, 'base64');
                if (image[0] !== 0xff || image[1] !== 0xd8) throw new Error('JPEG screenshot required');
                const folder = path.join(root, 'docs/qa/ux-live-2026-10-12');
                await require('node:fs/promises').mkdir(folder, { recursive: true });
                const saved = path.join(folder, `${input.name}.jpg`);
                await require('node:fs/promises').writeFile(saved, image);
                res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ path: saved, bytes: image.length })); return;
            }
            if (url.pathname.startsWith('/api/automation/')) {
                if (req.method !== 'GET' && req.headers.origin !== url.origin) { res.writeHead(403); res.end(); return; }
                let size = 0; const chunks = [];
                for await (const chunk of req) { size += chunk.length; if (size > 160 * 1024 * 1024) throw new Error('Fixture body limit'); chunks.push(chunk); }
                const body = size ? JSON.parse(Buffer.concat(chunks)) : {};
                const result = await dispatch({ method: req.method, path: url.pathname.slice('/api/automation/'.length).split('/'), search: url.searchParams, body }, actor, services);
                res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); return;
            }
            if (url.pathname.startsWith('/api/personal-links/')) {
                if (req.method !== 'GET' && req.headers.origin !== url.origin) { res.writeHead(403); res.end(); return; }
                const [, kind, id] = url.pathname.slice('/api/'.length).split('/');
                if (!Object.hasOwn(personalItems, kind)) { res.writeHead(404); res.end(); return; }
                let bytes = 0; const chunks = [];
                for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) throw new Error('Fixture body limit'); chunks.push(chunk); }
                const input = bytes ? JSON.parse(Buffer.concat(chunks)) : {};
                if (kind === 'restock' && id === 'options') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ options: [{ id: '*', name: '商品全体', state: 'sold_out' }] })); return; }
                if (req.method === 'GET') {
                    const term = (url.searchParams.get('query') || '').toLowerCase(), tag = url.searchParams.get('tag');
                    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ items: personalItems[kind].filter(item => (!term || `${item.title} ${item.url} ${item.note}`.toLowerCase().includes(term)) && (!tag || item.tags?.includes(tag))), hasMore: false })); return;
                }
                if (req.method === 'POST') personalItems[kind].push({ ...input, id: require('node:crypto').randomUUID(), kind, updatedAt: Date.now(), editable: true, cancellable: true, ...(kind === 'saved' ? {} : { status: kind === 'reminder' ? 'pending' : 'watching', dueAt: kind === 'reminder' ? Date.parse(`${input.when}+09:00`) : undefined }) });
                else if (req.method === 'PATCH') personalItems[kind] = personalItems[kind].map(item => item.id === id ? { ...item, ...input, updatedAt: Date.now() } : item);
                else if (req.method === 'DELETE') personalItems[kind] = personalItems[kind].filter(item => item.id !== id);
                else { res.writeHead(405); res.end(); return; }
                res.setHeader('Content-Type', 'application/json'); res.end('{}'); return;
            }
            if (url.pathname === '/' || /^\/dashboard(?:\/|$)/.test(url.pathname) || url.pathname === '/admin/notification-plans') {
                await build();
                res.setHeader('Content-Type', 'text/html;charset=utf-8');
                res.end('<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>自動化ローカル検証</title><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script></html>'); return;
            }
            if (assets.has(url.pathname)) { res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css;charset=utf-8' : 'text/javascript;charset=utf-8'); res.end(assets.get(url.pathname)); return; }
            res.writeHead(404); res.end();
        } catch (error) {
            const retryAfterMs = Number(error.retryAfterMs);
            const headers = { 'Content-Type': 'application/json', ...(Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) } : {}) };
            res.writeHead(Number(error.status) || 400, headers);
            res.end(JSON.stringify({ error: error.message, code: error.code, issues: error.issues, retryAfterMs: error.retryAfterMs, limit: error.limit, windowMs: error.windowMs, scope: error.scope, maxSlots: error.maxSlots, availableSlots: error.availableSlots, planName: error.planName }));
        }
    });
    const requestedPort = Number(process.env.AUTOMATION_UI_PORT || 0);
    server.listen(requestedPort, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/`, schema: db.schema, pid: process.pid })));
    let closing = false;
    async function close() { if (closing) return; closing = true; server.closeAllConnections(); server.close(); evaluator.stop(); await builder.dispose(); await db.close(); console.log('Fixture stopped; only its disposable schema was removed.'); process.exit(0); }
    process.on('SIGINT', close); process.on('SIGTERM', close);
    // Build/API errors do not create a watcher that could send real messages.
    process.stdin.resume(); process.stdin.on('data', data => { if (String(data).trim() === 'stop') void close(); });
}
main().catch(error => { console.error(error.code || error.message); process.exit(1); });

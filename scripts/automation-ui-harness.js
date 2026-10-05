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
        service, evaluator, destinations, monitors: require('../src/automation/monitors').createMonitors(db, service, destinations),
        dictionaryService: require('../src/automation/dictionary-service').createDictionaryService(db, service, evaluator),
        market: require('../src/automation/marketplace').createMarketplace(db, { service, evaluator, moderationMatcher: moderation }), history: require('../src/automation/history').createHistory(db, service), moderation, starter,
        schema: require('../src/automation/schema'), format: require('../src/automation/format'), bundle: require('../src/automation/bundle'), catalog: require('../src/automation/catalog'),
    };
    await service.saveDestination(actor, { name: '検証ユーザーのDM', kind: 'dm', scope: 'private' });
    await service.createWorkflow(actor, { definition: services.catalog.template('sale', 'morning', 'text'), scope: 'private' });
    await service.saveDictionary(actor, { dictionary: { schemaVersion: 1, name: '検証用辞書', source: '架空の試験データ', license: 'CC0-1.0', entries: ['広告', { term: '広告制作', kind: 'allow' }] } });
    const assets = new Map();
    const builder = await require('esbuild').context({ absWorkingDir: root, entryPoints: [path.join(__dirname, 'fixtures/automation-ui.tsx')], bundle: true, write: false, outfile: 'app.js', platform: 'browser', jsx: 'automatic', sourcemap: 'inline', nodePaths: [path.join(dashboard, 'node_modules')], alias: { react: path.dirname(localRequire.resolve('react/package.json')), 'react-dom': path.dirname(localRequire.resolve('react-dom/package.json')) }, define: { 'process.env.NODE_ENV': '"development"' } });
    async function build() {
        const result = await builder.rebuild();
        const theme = require(path.join(dashboard, 'tailwind.config.ts')).default;
        for (const file of result.outputFiles) {
            const name = path.basename(file.path);
            const content = name.endsWith('.css') ? (await localRequire('postcss')([localRequire('tailwindcss')({ ...theme, content: [path.join(dashboard, 'components/automation/**/*.{ts,tsx}').replaceAll('\\', '/'), path.join(__dirname, 'fixtures/automation-ui.tsx').replaceAll('\\', '/')] }), localRequire('autoprefixer')]).process(file.text, { from: undefined })).css : file.text;
            assets.set(`/${name}`, content);
        }
    }
    await build();
    const server = http.createServer(async (req, res) => {
        try {
            if (!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host || '')) { res.writeHead(403); res.end(); return; }
            const url = new URL(req.url, `http://${req.headers.host}`);
            res.setHeader('Cache-Control', 'no-store');
            if (url.pathname.startsWith('/api/automation/')) {
                if (req.method !== 'GET' && req.headers.origin !== url.origin) { res.writeHead(403); res.end(); return; }
                let size = 0; const chunks = [];
                for await (const chunk of req) { size += chunk.length; if (size > 160 * 1024 * 1024) throw new Error('Fixture body limit'); chunks.push(chunk); }
                const body = size ? JSON.parse(Buffer.concat(chunks)) : {};
                const result = await dispatch({ method: req.method, path: url.pathname.slice('/api/automation/'.length).split('/'), search: url.searchParams, body }, actor, services);
                res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); return;
            }
            if (url.pathname === '/') {
                await build();
                res.setHeader('Content-Type', 'text/html;charset=utf-8');
                res.end('<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>自動化ローカル検証</title><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script></html>'); return;
            }
            if (assets.has(url.pathname)) { res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css;charset=utf-8' : 'text/javascript;charset=utf-8'); res.end(assets.get(url.pathname)); return; }
            res.writeHead(404); res.end();
        } catch (error) { res.writeHead(Number(error.status) || 400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message, code: error.code, issues: error.issues })); }
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

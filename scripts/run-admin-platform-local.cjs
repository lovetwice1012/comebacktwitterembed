'use strict';

// Disposable local integration environment. Startup only reads capabilities
// (and optional public URL evidence). Actions selected in the UI are real.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const repo = path.resolve(__dirname, '..');
const binary = process.env.CBTE_ADMIN_TEST_BINARY;
if (!binary || !fs.existsSync(binary)) throw new Error('Set CBTE_ADMIN_TEST_BINARY to the locally built agent executable.');
const dir = process.env.CBTE_ADMIN_LOCAL_STATE_DIR
    ? path.resolve(process.env.CBTE_ADMIN_LOCAL_STATE_DIR)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'cbte-admin-integration-'));
fs.mkdirSync(dir, { recursive: true });
const token = crypto.randomBytes(32).toString('hex');
const password = 'CBTE-local-integration-only';
const passwordHash = spawnSync(binary, ['password-hash'], { input: password + '\n', encoding: 'utf8', windowsHide: true }).stdout.trim();
const common = { ...process.env, ADMIN_AGENT_TOKEN: token, ADMIN_OWNER_ID: '796972193287503913',
    ADMIN_AGENT_WORKER: path.join(repo, 'src/adminSupport/worker.js'), ADMIN_AGENT_WORKER_DIR: repo,
    ADMIN_SUPPORT_DATA_DIR: path.join(dir, 'support'), ADMIN_TELEMETRY_ENABLED: '0',
    ADMIN_AGENT_DISCORD_WEBHOOK: '', ADMIN_AGENT_PUSH_WEBHOOK: '' };
const children = [];
let previewProxy;
function launch(command, args, env, cwd = repo) {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = fs.createWriteStream(path.join(dir, 'process-' + children.length + '.log'));
    child.stdout.pipe(log); child.stderr.pipe(log); children.push(child); return child;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(url) {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
        try { if ((await fetch(url, { signal: AbortSignal.timeout(10000) })).ok) return; } catch {}
        await sleep(500);
    }
    throw new Error('Service did not become ready: ' + url);
}
async function api(route, body) {
    const res = await fetch('http://127.0.0.1:34188/' + route, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Agent-Token': token },
        body: body ? JSON.stringify(body) : undefined,
    });
    const value = await res.json();
    if (!res.ok) throw new Error('API ' + res.status + ': ' + JSON.stringify(value));
    return value;
}
async function action(type, input, idempotencyKey) {
    let value = await api('v1/actions', { type, input, idempotencyKey });
    for (let n = 0; n < 180 && ['queued', 'running'].includes(value.status); n++) {
        await sleep(500); value = await api('v1/actions/' + value.id);
    }
    if (value.status !== 'succeeded') throw new Error('Action failed: ' + JSON.stringify(value.error || value));
    return value;
}
let stopping = false;
async function stop(exitCode = 0) {
    if (stopping) return; stopping = true;
    for (const child of children) {
        if (process.platform === 'win32' && child.pid) {
            spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
        } else child.kill('SIGTERM');
    }
    previewProxy?.close();
    console.log('Local integration services stopped. Diagnostic logs: ' + dir);
    setTimeout(() => process.exit(exitCode), 1000);
}
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
(async () => {
    launch(process.execPath, [path.join(repo, 'admin-agent/analysis-server.cjs')], {
        ...common, ADMIN_ANALYSIS_LISTEN: '127.0.0.1:34190', ADMIN_ANALYSIS_STATE_DIR: path.join(dir, 'interactive'),
    });
    await waitFor('http://127.0.0.1:34190/health');
    launch(process.execPath, [path.join(repo, 'admin-agent/analysis-server.cjs')], {
        ...common, ADMIN_ANALYSIS_LISTEN: '127.0.0.1:34191', ADMIN_ANALYSIS_STATE_DIR: path.join(dir, 'reports'),
        ADMIN_ANALYSIS_ACTIONS: 'reports.build', ADMIN_WORKER_DEADLINE_MS: '640000',
    });
    await waitFor('http://127.0.0.1:34191/health');
    launch(binary, [], { ...common, ADMIN_AGENT_LISTEN: '127.0.0.1:34188', ADMIN_AGENT_STATE_DIR: path.join(dir, 'core'),
        ADMIN_AGENT_PASSWORD_HASH: passwordHash, ADMIN_AGENT_COOKIE_SECURE: 'false', ADMIN_AGENT_BASE_PATH: '',
        ADMIN_AGENT_PUBLIC_URL: 'http://127.0.0.1:34188/', ADMIN_AGENT_WORKER_URL: 'http://127.0.0.1:34190/execute',
        ADMIN_AGENT_REPORT_WORKER_URL: 'http://127.0.0.1:34191/execute',
        ADMIN_AGENT_LOCAL_HEALTH_URL: 'http://127.0.0.1:34190/health', ADMIN_AGENT_PUBLIC_HEALTH_URL: '',
        ADMIN_AGENT_NODE: process.execPath,
    });
    await waitFor('http://127.0.0.1:34188/healthz');
    const first = await action('capabilities', {}, 'integration-capabilities');
    const second = await action('capabilities', {}, 'integration-capabilities');
    if (first.id !== second.id) throw new Error('Idempotency failed.');
    if (process.env.CBTE_LIVE_READONLY_TESTS === '1') {
        const result = await action('url.inspect', { url: 'https://github.com/discordjs/discord.js', settings: { enabled: true } }, 'integration-inspect');
        if (!result.result?.steps?.length || !result.result?.httpAttempts?.some(a => a.status === 200)) throw new Error('Actual API evidence missing.');
        const data = result.result;
        const replay = await action('url.reparse', { url: data.url, settings: data.settings, context: data.context, httpAttempts: data.httpAttempts }, 'integration-reparse');
        if (!replay.result?.replayed || !replay.result?.steps?.length) throw new Error('Offline replay failed.');
        console.log(JSON.stringify({ liveInspection: data.outcome, generatedSteps: data.steps.length, httpAttempts: data.httpAttempts.length, replay: replay.result.outcome }));
    }
    console.log('CBTE_LOCAL_READY http://127.0.0.1:34188/ (test-only password in this script)');
    if (process.env.CBTE_LOCAL_DASHBOARD === '1') {
        // Explicit opt-in, loopback-only test entry. The JWT secret is unique to
        // this disposable Next process; production authentication is unchanged.
        const secret = crypto.randomBytes(32).toString('hex');
        const { encode } = require('../dashboard/node_modules/next-auth/jwt');
        let previewJwt;
        let previewJwtRefreshAt = 0;
        async function getPreviewJwt() {
            if (!previewJwt || Date.now() >= previewJwtRefreshAt) {
                previewJwt = await encode({ secret, maxAge: 3600, token: {
                    discordId: common.ADMIN_OWNER_ID, username: 'local-admin-preview',
                    globalName: 'ローカル管理画面検証', accessToken: 'local-preview-only',
                    expiresAt: Date.now() + 3600000,
                } });
                previewJwtRefreshAt = Date.now() + 1800000;
            }
            return previewJwt;
        }
        launch(process.execPath, [path.join(repo, 'dashboard/node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', '34189'], {
            ...common, NODE_ENV: 'development', NEXTAUTH_SECRET: secret,
            NEXTAUTH_URL: 'http://127.0.0.1:34187', ADMIN_AGENT_URL: 'http://127.0.0.1:34188',
            ADMIN_AGENT_PUBLIC_URL: 'http://127.0.0.1:34188/',
            DASHBOARD_NEXT_DIST_DIR: '.next-admin-local-preview', NEXT_TELEMETRY_DISABLED: '1',
        }, path.join(repo, 'dashboard'));
        await waitFor('http://127.0.0.1:34189/');
        previewProxy = http.createServer(async (request, response) => {
            if (request.headers.host !== '127.0.0.1:34187'
                || (request.headers.origin && request.headers.origin !== 'http://127.0.0.1:34187')
                || request.headers['sec-fetch-site'] === 'cross-site') {
                response.writeHead(403); response.end('This local preview only accepts its own loopback origin.'); return;
            }
            let jwt;
            try { jwt = await getPreviewJwt(); }
            catch { response.writeHead(500); response.end('Could not create a local preview session.'); return; }
            const upstream = http.request({
                host: '127.0.0.1', port: 34189, method: request.method, path: request.url,
                headers: { ...request.headers, host: '127.0.0.1:34187',
                    cookie: 'next-auth.session-token=' + jwt },
            }, result => { response.writeHead(result.statusCode, result.headers); result.pipe(response); });
            upstream.on('error', () => { response.writeHead(502); response.end('Local Next preview is unavailable.'); });
            request.pipe(upstream);
        });
        await new Promise(resolve => previewProxy.listen(34187, '127.0.0.1', resolve));
        console.log('CBTE_DASHBOARD_READY http://127.0.0.1:34187/admin (disposable local authentication)');
    }
})().catch(error => { console.error(error.message); stop(1); });

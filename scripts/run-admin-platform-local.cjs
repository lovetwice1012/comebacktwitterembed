'use strict';

// Disposable local integration environment. No production writes or messages.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const binary = process.env.CBTE_ADMIN_TEST_BINARY;
if (!binary || !fs.existsSync(binary)) throw new Error('Set CBTE_ADMIN_TEST_BINARY to the locally built agent executable.');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbte-admin-integration-'));
const token = crypto.randomBytes(32).toString('hex');
const password = 'CBTE-local-integration-only';
const passwordHash = spawnSync(binary, ['password-hash'], { input: password + '\n', encoding: 'utf8', windowsHide: true }).stdout.trim();
const common = { ...process.env, ADMIN_AGENT_TOKEN: token, ADMIN_OWNER_ID: '796972193287503913',
    ADMIN_AGENT_WORKER: path.join(repo, 'src/adminSupport/worker.js'), ADMIN_AGENT_WORKER_DIR: repo,
    ADMIN_SUPPORT_DATA_DIR: path.join(dir, 'support'), ADMIN_TELEMETRY_ENABLED: '0',
    ADMIN_AGENT_DISCORD_WEBHOOK: '', ADMIN_AGENT_PUSH_WEBHOOK: '' };
const children = [];
function launch(command, args, env) {
    const child = spawn(command, args, { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = fs.createWriteStream(path.join(dir, 'process-' + children.length + '.log'));
    child.stdout.pipe(log); child.stderr.pipe(log); children.push(child); return child;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(url) {
    for (let n = 0; n < 60; n++) {
        try { if ((await fetch(url)).ok) return; } catch {}
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
async function stop() {
    if (stopping) return; stopping = true;
    for (const child of children) child.kill('SIGTERM');
    console.log('Local integration services stopped. Diagnostic logs: ' + dir);
    setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
(async () => {
    launch(process.execPath, [path.join(repo, 'admin-agent/analysis-server.cjs')], {
        ...common, ADMIN_ANALYSIS_LISTEN: '127.0.0.1:34190', ADMIN_ANALYSIS_STATE_DIR: path.join(dir, 'interactive'),
    });
    await waitFor('http://127.0.0.1:34190/health');
    launch(binary, [], { ...common, ADMIN_AGENT_LISTEN: '127.0.0.1:34188', ADMIN_AGENT_STATE_DIR: path.join(dir, 'core'),
        ADMIN_AGENT_PASSWORD_HASH: passwordHash, ADMIN_AGENT_COOKIE_SECURE: 'false', ADMIN_AGENT_BASE_PATH: '',
        ADMIN_AGENT_PUBLIC_URL: 'http://127.0.0.1:34188/', ADMIN_AGENT_WORKER_URL: 'http://127.0.0.1:34190/execute',
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
})().catch(error => { console.error(error.message); for (const child of children) child.kill(); process.exitCode = 1; });

'use strict';

// Isolated execution boundary for the management core. This service must run in
// its own systemd unit/cgroup; the core talks to loopback instead of spawning
// provider workers inside the core's memory budget.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const DEFAULT_STATE = '/var/lib/cbte-admin-analysis/state';
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;
const timestamp = () => new Date().toISOString();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function canonicalJSON(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
}

function authorized(received, expected) {
    if (!expected || typeof received !== 'string') return false;
    // Hash both sides to equal-length buffers before the constant-time compare.
    return crypto.timingSafeEqual(crypto.createHash('sha256').update(received).digest(), crypto.createHash('sha256').update(expected).digest());
}

function unknownResult(causeCode, message, details = {}) {
    return { ok: false, error: { code: 'DELIVERY_UNKNOWN', causeCode, message,
        ...details }, events: [] };
}

async function atomicWrite(filename, value) {
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
    } finally { await handle.close(); }
    try {
        await fs.rename(temporary, filename);
        // Persist the directory entry as well as its contents on Linux.
        if (process.platform !== 'win32') {
            const directory = await fs.open(path.dirname(filename), 'r');
            try { await directory.sync(); } finally { await directory.close(); }
        }
    } catch (error) {
        await fs.unlink(temporary).catch(() => {});
        throw error;
    }
}

function sendJSON(response, status, data) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
}

async function readJSON(request) {
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw Object.assign(new Error('Request exceeds 32 MiB.'), { status: 413 });
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) throw Object.assign(new Error('Request exceeds 32 MiB.'), { status: 413 });
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Object.assign(new Error('Request must be a single JSON object.'), { status: 400 }); }
}

function validateRequest(request) {
    if (!request || Array.isArray(request) || typeof request !== 'object') throw Object.assign(new Error('Request must be an object.'), { status: 400 });
    if (typeof request.actionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(request.actionId)) throw Object.assign(new Error('Invalid actionId.'), { status: 400 });
    if (typeof request.type !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(request.type)) throw Object.assign(new Error('Invalid action type.'), { status: 400 });
    if (request.input !== undefined && (!request.input || typeof request.input !== 'object' || Array.isArray(request.input))) throw Object.assign(new Error('input must be an object.'), { status: 400 });
    return { actionId: request.actionId, type: request.type, input: request.input || {} };
}

function runWorker(request, config) {
    let child;
    let finish;
    let cancelled = null;
    let killTimer;
    let finalTimer;
    let exited = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderrTruncated = false;
    const output = [], stderr = [];

    function signalGroup(signal) {
        if (!child?.pid || exited) return;
        try {
            if (process.platform === 'linux') process.kill(-child.pid, signal);
            else child.kill(signal);
        } catch (error) {
            if (error.code !== 'ESRCH') { try { child.kill(signal); } catch {} }
        }
    }
    function cancel(code, message) {
        if (cancelled || exited) return;
        cancelled = { code, message };
        signalGroup('SIGTERM');
        killTimer = setTimeout(() => signalGroup('SIGKILL'), 250);
        finalTimer = setTimeout(() => finish?.(null, 'SIGKILL'), 2000);
    }

    const promise = new Promise(resolve => {
        const deadline = setTimeout(() => cancel('WORKER_DEADLINE', 'The analysis worker exceeded its deadline. External operation outcome has not been confirmed.'), config.deadlineMs);
        let completed = false;
        finish = (exitCode, signal, spawnError) => {
            if (completed) return;
            completed = true; exited = true;
            clearTimeout(deadline); clearTimeout(killTimer); clearTimeout(finalTimer);
            // A descendant must not survive the supervised command, even if it
            // detached its stdout before the immediate child exited.
            if (process.platform === 'linux' && child?.pid) {
                try { process.kill(-child.pid, 'SIGKILL'); } catch {}
            }
            const diagnostics = { exitCode, signal: signal || null,
                stderr: Buffer.concat(stderr).toString('utf8').split(config.token).join('[service-token-omitted]'), stderrTruncated };
            let result;
            if (cancelled) result = unknownResult(cancelled.code, cancelled.message);
            else if (spawnError) result = unknownResult('WORKER_START_FAILED', 'The configured analysis worker could not be started.', { systemCode: spawnError.code });
            else {
                try {
                    result = JSON.parse(Buffer.concat(output).toString('utf8'));
                    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean') throw new Error('Invalid worker result.');
                } catch {
                    result = unknownResult('WORKER_RESULT_INVALID', 'The worker did not return a complete structured result. The operation will not be repeated automatically.');
                }
            }
            // Valid {ok:false,...} from exit code 1 is an application result;
            // preserve all returned evidence instead of replacing it with stderr.
            resolve({ result, diagnostics });
        };
        try {
            child = spawn(config.node, [config.worker], {
                cwd: config.workerDir,
                env: { ...config.childEnv, ADMIN_AGENT_TOKEN: '', ADMIN_TELEMETRY_ENABLED: '0',
                    // The wrapper provides the outer process/group deadline.
                    ADMIN_WORKER_DEADLINE_MS: String(Math.max(1000, config.deadlineMs - 1000)) },
                shell: false, windowsHide: true, detached: process.platform === 'linux',
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (error) { finish(null, null, error); return; }
        child.on('error', error => finish(null, null, error));
        child.on('close', (code, signal) => finish(code, signal));
        child.stdout.on('data', chunk => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > MAX_BYTES) { cancel('WORKER_OUTPUT_LIMIT', 'The worker output exceeded 32 MiB; the complete operation result is unavailable.'); return; }
            output.push(chunk);
        });
        child.stderr.on('data', chunk => {
            if (stderrBytes < MAX_STDERR) stderr.push(chunk.subarray(0, MAX_STDERR - stderrBytes));
            stderrBytes += chunk.length;
            stderrTruncated ||= stderrBytes > MAX_STDERR;
        });
        child.stdin.on('error', () => {}); // close/error receipts capture failure.
        child.stdin.end(JSON.stringify(request));
    });
    return { promise, cancel };
}

async function createAnalysisServer(options = {}) {
    const token = options.token ?? process.env.ADMIN_AGENT_TOKEN;
    if (!token || Buffer.byteLength(token) < 16) throw new Error('ADMIN_AGENT_TOKEN must contain at least 16 bytes.');
    const config = {
        token,
        node: options.node || process.env.ADMIN_ANALYSIS_NODE || process.execPath,
        worker: path.resolve(options.worker || process.env.ADMIN_ANALYSIS_WORKER || process.env.ADMIN_AGENT_WORKER || path.join(__dirname, '../src/adminSupport/worker.js')),
        workerDir: path.resolve(options.workerDir || process.env.ADMIN_ANALYSIS_WORKER_DIR || process.env.ADMIN_AGENT_WORKER_DIR || path.join(__dirname, '..')),
        stateDir: path.resolve(options.stateDir || process.env.ADMIN_ANALYSIS_STATE_DIR || DEFAULT_STATE),
        deadlineMs: Math.min(900000, Math.max(50, Number(options.deadlineMs ?? process.env.ADMIN_WORKER_DEADLINE_MS ?? process.env.ADMIN_ANALYSIS_DEADLINE_MS) || 110000)),
        childEnv: { ...process.env, ...(options.childEnv || {}) },
        allowedActions: options.allowedActions || (process.env.ADMIN_ANALYSIS_ACTIONS ? process.env.ADMIN_ANALYSIS_ACTIONS.split(',').map(value => value.trim()).filter(Boolean) : null),
    };
    await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    await fs.access(config.worker);
    const receipts = new Map();
    const filename = actionId => path.join(config.stateDir, `${hash(actionId)}.json`);
    for (const entry of await fs.readdir(config.stateDir)) {
        if (!entry.endsWith('.json')) continue;
        const receipt = JSON.parse(await fs.readFile(path.join(config.stateDir, entry), 'utf8'));
        if (!receipt?.actionId || entry !== `${hash(receipt.actionId)}.json`) throw new Error(`Invalid analysis receipt: ${entry}`);
        if (receipt.state === 'running') {
            receipt.state = 'unknown'; receipt.completedAt = timestamp();
            receipt.result = unknownResult('WORKER_INTERRUPTED', 'The analysis service stopped before a durable result was saved. Reconcile this receipt; the operation will not be repeated.');
            await atomicWrite(filename(receipt.actionId), receipt);
        }
        receipts.set(receipt.actionId, receipt);
    }
    let active = null;
    let closing = false;
    let persistenceError = null;

    async function execute(request, inputHash) {
        const receipt = { version: 1, actionId: request.actionId, type: request.type, inputHash, state: 'running', startedAt: timestamp() };
        // Save running before spawn. A crash between this write and spawning is
        // intentionally conservative: an uncertain operation stays uncertain.
        await atomicWrite(filename(request.actionId), receipt);
        receipts.set(request.actionId, receipt);
        const running = runWorker(request, config);
        active.cancel = running.cancel;
        if (closing) running.cancel('SERVICE_STOPPING', 'The analysis service is stopping; the operation result is unconfirmed.');
        const { result, diagnostics } = await running.promise;
        const unknown = result?.error?.code === 'DELIVERY_UNKNOWN' || result?.data?.outcome === 'delivery_unknown' || result?.error?.code === 'WORKER_DEADLINE';
        const finished = { ...receipt, state: unknown ? 'unknown' : 'completed', completedAt: timestamp(), result, diagnostics };
        try {
            await atomicWrite(filename(request.actionId), finished);
            receipts.set(request.actionId, finished);
        } catch (error) {
            persistenceError = 'Final result could not be durably saved.';
            // Keep the durable running receipt, then reconcile to unknown on
            // restart. Do not report success before its receipt is durable.
            const uncertain = { ...receipt, state: 'unknown', result: unknownResult('RECEIPT_WRITE_FAILED', persistenceError) };
            receipts.set(request.actionId, uncertain);
            return uncertain.result;
        }
        return result;
    }

    const server = http.createServer(async (request, response) => {
        try {
            const url = new URL(request.url, 'http://127.0.0.1');
            if (request.method === 'GET' && url.pathname === '/health') {
                sendJSON(response, persistenceError ? 503 : 200, { ok: !persistenceError, service: 'cbte-admin-analysis', busy: Boolean(active) });
                return;
            }
            if (!authorized(request.headers['x-admin-agent-token'], config.token)) {
                sendJSON(response, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } }); return;
            }
            if (request.method === 'GET' && url.pathname.startsWith('/receipts/')) {
                const actionId = decodeURIComponent(url.pathname.slice('/receipts/'.length));
                const receipt = receipts.get(actionId);
                sendJSON(response, receipt ? 200 : 404, receipt || { ok: false, error: { code: 'RECEIPT_NOT_FOUND' } }); return;
            }
            if (request.method !== 'POST' || url.pathname !== '/execute') {
                sendJSON(response, 404, { ok: false, error: { code: 'NOT_FOUND' } }); return;
            }
            const input = validateRequest(await readJSON(request));
            if (config.allowedActions ? !config.allowedActions.includes(input.type) : input.type === 'reports.build') {
                sendJSON(response, 403, { ok: false, error: { code: 'ACTION_NOT_ALLOWED', message: 'This analysis lane does not allow that action type.' } }); return;
            }
            const inputHash = hash(canonicalJSON({ type: input.type, input: input.input }));
            if (active?.actionId === input.actionId) {
                if (active.inputHash !== inputHash) { sendJSON(response, 409, { ok: false, error: { code: 'IDEMPOTENCY_CONFLICT', message: 'The action ID belongs to different input.' } }); return; }
                sendJSON(response, 200, await active.promise); return;
            }
            const receipt = receipts.get(input.actionId);
            if (receipt) {
                if (receipt.inputHash !== inputHash) { sendJSON(response, 409, { ok: false, error: { code: 'IDEMPOTENCY_CONFLICT', message: 'The action ID belongs to different input.' } }); return; }
                if (receipt.state !== 'running') { sendJSON(response, 200, receipt.result); return; }
                if (active?.actionId === input.actionId) { sendJSON(response, 200, await active.promise); return; }
                sendJSON(response, 200, unknownResult('WORKER_INTERRUPTED', 'No live worker owns the running receipt. It will not be repeated.')); return;
            }
            // active is assigned before the asynchronous durable write, closing
            // the acceptance race between simultaneous POST requests.
            if (active || closing || persistenceError) { sendJSON(response, 503, { ok: false, error: { code: 'ANALYSIS_BUSY', message: 'The analysis service is busy or cannot persist new actions.' } }); return; }
            active = { actionId: input.actionId, inputHash, promise: null, cancel: null };
            const task = execute(input, inputHash).finally(() => { active = null; });
            active.promise = task;
            // The task belongs to the receipt, not the HTTP connection. Closing
            // the browser/core request never cancels a running external action.
            sendJSON(response, 200, await task);
        } catch (error) {
            sendJSON(response, error.status || 500, { ok: false, error: { code: error.status ? 'INVALID_REQUEST' : 'ANALYSIS_FAILURE', message: error.status ? error.message : 'The analysis operation could not be completed.' } });
        }
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.keepAliveTimeout = 5000;
    return {
        server,
        listen: async (port) => {
            const listen = process.env.ADMIN_ANALYSIS_LISTEN || '127.0.0.1:30990';
            if (!/^127\.0\.0\.1:\d{1,5}$/.test(listen)) throw new Error('ADMIN_ANALYSIS_LISTEN must specify 127.0.0.1 and a port.');
            port ??= Number(listen.split(':')[1]);
            await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
            return server.address();
        },
        close: async () => {
            closing = true;
            active?.cancel?.('SERVICE_STOPPING', 'The analysis service is stopping; the external action result is unconfirmed.');
            if (active?.promise) await active.promise.catch(() => {});
            server.closeIdleConnections();
            if (server.listening) await new Promise(resolve => server.close(resolve));
        },
    };
}

if (require.main === module) {
    createAnalysisServer().then(async app => {
        await app.listen();
        let stopping = false;
        const stop = () => { if (stopping) return; stopping = true; void app.close().then(() => process.exit(0)); };
        process.on('SIGTERM', stop); process.on('SIGINT', stop);
        console.log('Management analysis service listening on loopback.');
    }).catch(error => { console.error(`Analysis service startup failed: ${error.message}`); process.exitCode = 1; });
}

module.exports = { createAnalysisServer, authorized, canonicalJSON };

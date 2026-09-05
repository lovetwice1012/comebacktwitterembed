'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { createAnalysisServer, canonicalJSON } = require('../../admin-agent/analysis-server.cjs');

const TOKEN = 'fixture-analysis-token-0123456789';
const fakeCLI = `
'use strict';
const fs = require('node:fs');
(async () => {
  let raw=''; for await (const chunk of process.stdin) raw += chunk;
  const request=JSON.parse(raw);
  fs.appendFileSync(process.env.FIXTURE_COUNT_FILE, request.actionId + '\\n');
  if (request.type === 'delay') await new Promise(resolve=>setTimeout(resolve, request.input.ms || 500));
  if (request.type === 'invalid') { process.stdout.write('not-json'); process.exit(0); }
  if (request.type === 'large') { process.stdout.write('x'.repeat(33*1024*1024)); return; }
  if (request.type === 'stderr') process.stderr.write('x'.repeat(100000));
  const failure=request.type === 'application.failure';
  process.stdout.write(JSON.stringify({ok:!failure,data:{actionId:request.actionId,input:request.input,
    childAgentToken:process.env.ADMIN_AGENT_TOKEN,telemetryEnabled:process.env.ADMIN_TELEMETRY_ENABLED},
    error:failure?{code:'FIXTURE_APPLICATION_FAILURE',message:'Expected fixture failure'}:undefined,
    events:[{event_id:'fixture-event',kind:'fixture',details:{preserved:true}}]}),()=>process.exit(failure?1:0));
})().catch(error=>{console.error(error);process.exit(2);});
`;

async function setup(t, overrides = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-analysis-test-'));
    const worker = path.join(directory, 'fixture-worker.cjs');
    const countFile = path.join(directory, 'executions.txt');
    const stateDir = path.join(directory, 'state');
    await fs.writeFile(worker, fakeCLI);
    const instances = [];
    const options = { token: TOKEN, worker, workerDir: directory, stateDir, deadlineMs: 3000,
        childEnv: { FIXTURE_COUNT_FILE: countFile }, ...overrides };
    async function start() {
        const app = await createAnalysisServer(options);
        const address = await app.listen(0);
        instances.push(app);
        return { app, url: `http://127.0.0.1:${address.port}` };
    }
    t.after(async () => {
        for (const app of instances.reverse()) await app.close();
        await fs.rm(directory, { recursive: true, force: true });
    });
    const initial = await start();
    return { ...initial, directory, worker, stateDir, start,
        count: async () => (await fs.readFile(countFile, 'utf8').catch(() => '')).split('\n').filter(Boolean) };
}
async function post(url, request, token = TOKEN) {
    const response = await fetch(`${url}/execute`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Agent-Token': token }, body: JSON.stringify(request) });
    return { status: response.status, data: await response.json() };
}
async function receipt(url, actionId) {
    const response = await fetch(`${url}/receipts/${actionId}`, { headers: { 'X-Admin-Agent-Token': TOKEN } });
    return { status: response.status, data: await response.json() };
}
async function until(fn, timeoutMs = 3000) {
    const untilAt = Date.now() + timeoutMs;
    while (Date.now() < untilAt) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 15)); }
    throw new Error('Condition did not become true before timeout.');
}

test('analysis health is minimal and execute/receipt endpoints require authentication', async t => {
    const fixture = await setup(t);
    const health = await (await fetch(`${fixture.url}/health`)).json();
    assert.deepEqual(health, { ok: true, service: 'cbte-admin-analysis', busy: false });
    assert.equal((await post(fixture.url, { actionId: 'a', type: 'echo', input: {} }, 'incorrect')).status, 401);
    assert.equal((await fetch(`${fixture.url}/receipts/a`)).status, 401);
    assert.deepEqual(await fixture.count(), []);
});

test('separate report lane enforces its configured action allowlist', async t => {
    const fixture = await setup(t, { allowedActions: ['reports.build'], deadlineMs: 900000 });
    assert.equal((await post(fixture.url, { actionId: 'forbidden', type: 'message.send', input: {} })).status, 403);
    assert.equal((await post(fixture.url, { actionId: 'report', type: 'reports.build', input: { kind: 'overview' } })).data.ok, true);
    assert.deepEqual(await fixture.count(), ['report']);
});

test('analysis results and receipts survive retries and process restart without another execution', async t => {
    const fixture = await setup(t);
    const request = { actionId: 'idempotent', type: 'echo', input: { b: 2, a: 1 } };
    const first = await post(fixture.url, request);
    assert.equal(first.status, 200);
    assert.equal(first.data.ok, true);
    assert.equal(first.data.data.childAgentToken, '');
    assert.equal(first.data.data.telemetryEnabled, '0');
    const reordered = { ...request, input: { a: 1, b: 2 } };
    assert.deepEqual((await post(fixture.url, reordered)).data, first.data);
    const stored = await receipt(fixture.url, request.actionId);
    assert.equal(stored.data.state, 'completed');
    assert.deepEqual(stored.data.result, first.data);
    await fixture.app.close();
    const restarted = await fixture.start();
    assert.deepEqual((await post(restarted.url, request)).data, first.data);
    assert.deepEqual(await fixture.count(), ['idempotent']);
    const persisted = (await fs.readFile(path.join(fixture.stateDir, `${crypto.createHash('sha256').update(request.actionId).digest('hex')}.json`), 'utf8'));
    assert.equal(persisted.includes(TOKEN), false);
    assert.equal(persisted.includes('FIXTURE_COUNT_FILE'), false);
});

test('same action with different input conflicts and separate jobs cannot run concurrently', async t => {
    const fixture = await setup(t);
    const running = post(fixture.url, { actionId: 'busy', type: 'delay', input: { ms: 350 } });
    await until(async () => (await receipt(fixture.url, 'busy')).data.state === 'running');
    assert.equal((await post(fixture.url, { actionId: 'busy', type: 'delay', input: { ms: 351 } })).status, 409);
    assert.equal((await post(fixture.url, { actionId: 'another', type: 'echo', input: {} })).status, 503);
    const identical = post(fixture.url, { actionId: 'busy', type: 'delay', input: { ms: 350 } });
    assert.deepEqual((await identical).data, (await running).data);
    assert.deepEqual(await fixture.count(), ['busy']);
});

test('exit code 1 with valid worker JSON preserves application failure and evidence', async t => {
    const fixture = await setup(t);
    const result = await post(fixture.url, { actionId: 'failure', type: 'application.failure', input: {} });
    assert.equal(result.status, 200);
    assert.equal(result.data.ok, false);
    assert.equal(result.data.error.code, 'FIXTURE_APPLICATION_FAILURE');
    assert.equal(result.data.events[0].details.preserved, true);
    const stored = await receipt(fixture.url, 'failure');
    assert.equal(stored.data.diagnostics.exitCode, 1);
    assert.equal(stored.data.state, 'completed');
});

test('deadline and invalid worker result become durable unknown outcomes that are never replayed', async t => {
    const fixture = await setup(t, { deadlineMs: 180 });
    const request = { actionId: 'deadline', type: 'delay', input: { ms: 10000 } };
    const result = await post(fixture.url, request);
    assert.equal(result.data.error.code, 'DELIVERY_UNKNOWN');
    assert.equal(result.data.error.causeCode, 'WORKER_DEADLINE');
    assert.equal((await receipt(fixture.url, 'deadline')).data.state, 'unknown');
    const count = await fixture.count();
    assert.deepEqual((await post(fixture.url, request)).data, result.data);
    assert.deepEqual(await fixture.count(), count);
    const invalid = await post(fixture.url, { actionId: 'invalid', type: 'invalid', input: {} });
    assert.equal(invalid.data.error.code, 'DELIVERY_UNKNOWN');
});

test('orphaned running receipt is reconciled to unknown on startup without spawning a worker', async t => {
    const fixture = await setup(t);
    await fixture.app.close();
    const request = { actionId: 'orphaned', type: 'message.send', input: { content: 'fixture only' } };
    await fs.writeFile(path.join(fixture.stateDir, `${crypto.createHash('sha256').update(request.actionId).digest('hex')}.json`), JSON.stringify({
        version: 1, actionId: request.actionId, type: request.type, state: 'running', startedAt: new Date().toISOString(),
        inputHash: crypto.createHash('sha256').update(canonicalJSON({ type: request.type, input: request.input })).digest('hex'),
    }));
    const restarted = await fixture.start();
    const result = await post(restarted.url, request);
    assert.equal(result.data.error.code, 'DELIVERY_UNKNOWN');
    assert.equal(result.data.error.causeCode, 'WORKER_INTERRUPTED');
    assert.equal((await receipt(restarted.url, 'orphaned')).data.state, 'unknown');
    assert.deepEqual(await fixture.count(), []);
});

test('client disconnection does not cancel a receipt-owned action and stderr remains bounded', async t => {
    const fixture = await setup(t);
    const req = http.request(`${fixture.url}/execute`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Agent-Token': TOKEN } });
    req.on('error', () => {});
    req.end(JSON.stringify({ actionId: 'disconnect', type: 'delay', input: { ms: 200 } }));
    await until(async () => (await receipt(fixture.url, 'disconnect')).data.state === 'running');
    req.destroy();
    await until(async () => (await receipt(fixture.url, 'disconnect')).data.state === 'completed');
    assert.deepEqual(await fixture.count(), ['disconnect']);
    await post(fixture.url, { actionId: 'stderr', type: 'stderr', input: {} });
    const stored = await receipt(fixture.url, 'stderr');
    assert.equal(stored.data.diagnostics.stderrTruncated, true);
    assert.equal(Buffer.byteLength(stored.data.diagnostics.stderr), 64 * 1024);
});

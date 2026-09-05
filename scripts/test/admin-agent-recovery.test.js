'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const load = require('./helpers/load-dashboard.cjs');
const owner = '796972193287503913';
const key = '4c67a8ed-3970-4bf8-a521-c7c9c9c0c9a8';
const invocation = '0123456789abcdef0123456789abcdef';

function socketMock(write) {
  return { createConnection(options) {
    const socket = new EventEmitter();
    socket.setEncoding = () => socket;
    socket.destroy = () => socket.emit('close');
    socket.write = value => write(socket, value, options);
    process.nextTick(() => socket.emit('connect'));
    return socket;
  } };
}

test('recovery validates a fixed service, current invocation and owner-namespaced idempotency key', () => {
  const api = load('lib/admin-agent-recovery.ts');
  const input = { type: 'agent.restart', input: { expectedInvocationId: invocation }, idempotencyKey: key };
  assert.deepEqual(api.validateRecoveryRequest(input, owner), api.validateRecoveryRequest(input, owner));
  assert.equal(api.validateRecoveryRequest(input, owner).id, `dashboard-recovery:${owner}:${key}`);
  for (const body of [
    { ...input, type: 'service.restart' }, { ...input, type: 'database.restart' },
    { ...input, unit: 'mysql.service' }, { ...input, input: { expectedInvocationId: invocation, unit: 'mysql.service' } },
    { ...input, input: {} }, { ...input, input: { expectedInvocationId: ';reboot' } },
    { ...input, idempotencyKey: 'different uncontrolled key' },
  ]) assert.throws(() => api.validateRecoveryRequest(body, owner));
});

test('same recovery receipt survives fragmented responses and does not repeat privileged execution', async () => {
  let executions = 0;
  const receipts = new Map();
  const api = load('lib/admin-agent-recovery.ts', { 'node:net': socketMock((socket, line, options) => {
    assert.equal(options.path, '/fixed/test-executor.sock');
    assert.equal(line.endsWith('\n'), true);
    const request = JSON.parse(line);
    if (!receipts.has(request.id)) {
      executions++;
      receipts.set(request.id, { ok: true, data: { data: { before: { InvocationID: invocation }, after: { InvocationID: 'f'.repeat(32), ActiveState: 'active' } }, error: null } });
    }
    const reply = JSON.stringify(receipts.get(request.id));
    setImmediate(() => { socket.emit('data', reply.slice(0, 15)); socket.emit('data', reply.slice(15) + '\n'); });
  }) });
  const request = api.validateRecoveryRequest({ type: 'agent.restart', input: { expectedInvocationId: invocation }, idempotencyKey: key }, owner);
  const first = await api.requestAgentRecovery(request, '/fixed/test-executor.sock', 1000);
  const second = await api.requestAgentRecovery(request, '/fixed/test-executor.sock', 1000);
  assert.deepEqual(second, first);
  assert.equal(executions, 1);
});

test('recovery transport bounds time, response size and rejects truncated responses', async () => {
  for (const send of [
    () => {},
    socket => setImmediate(() => socket.emit('data', 'x'.repeat(1024 * 1024 + 1))),
    socket => setImmediate(() => { socket.emit('data', '{"ok":true'); socket.emit('close'); }),
  ]) {
    const api = load('lib/admin-agent-recovery.ts', { 'node:net': socketMock(send) });
    await assert.rejects(api.requestAgentRecovery({ id: key, type: 'agent.status', input: {} }, '/unused.sock', 20));
  }
});

test('recovery route requires authenticated owner and same origin before touching executor', async () => {
  let user = owner, calls = 0;
  class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const validation = load('lib/admin-agent-recovery.ts');
  const route = load('app/api/admin/agent-recovery/route.ts', {
    'next/server': { NextResponse: { json: (body, options) => ({ body, status: options?.status || 200 }) } },
    '@/lib/api': { ApiError, requireAdminSession: async () => { if (!user) throw new ApiError(401, 'login required'); return { user: { id: user } }; }, errorResponse: error => ({ status: error.status || 500, body: { error: error.message } }) },
    '@/lib/admin-agent-recovery': { validateRecoveryRequest: validation.validateRecoveryRequest, requestAgentRecovery: async () => { calls++; return { ok: true, data: { data: { InvocationID: invocation, ActiveState: 'failed' }, error: null } }; } },
  });
  const request = (origin, type = 'agent.status') => ({ url: 'https://cbte.example/api/admin/agent-recovery', nextUrl: { origin: 'https://cbte.example' }, headers: new Map([['origin', origin], ['content-type', 'application/json']]), text: async () => JSON.stringify({ type, input: {}, idempotencyKey: key }) });
  user = null;
  assert.equal((await route.POST(request('https://cbte.example'))).status, 401);
  user = '123456789012345678';
  assert.equal((await route.POST(request('https://cbte.example'))).status, 403);
  user = owner;
  assert.equal((await route.POST(request('https://attacker.example'))).status, 403);
  assert.equal((await route.POST(request('https://cbte.example', 'service.restart'))).status, 400);
  assert.equal(calls, 0);
  const response = await route.POST(request('https://cbte.example'));
  assert.equal(response.status, 200);
  assert.equal(response.body.data.data.InvocationID, invocation);
  assert.equal(calls, 1);
});

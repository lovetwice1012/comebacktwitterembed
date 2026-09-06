"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function healthRoute(env = {}, file = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, '../../dashboard/app/api/health/route.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {}, dependencies = [];
  let opened = 0, closed = 0, bytesRequested = 0;
  const bytes = Buffer.from(typeof file.content === 'string' ? file.content : JSON.stringify(file.content ?? {}));
  // No fetch, DB, session or Discord API is available to this route.
  vm.runInNewContext(compiled, { exports, Buffer, process: { env }, require(id) {
    dependencies.push(id);
    if (id === 'next/server') return { NextResponse: { json: (body, options) => ({ body, options, status: options?.status || 200 }) } };
    assert.equal(id, 'node:fs/promises', 'health must not load expensive application dependencies');
    return { open: async (filename, mode) => {
      opened++;
      assert.equal(filename, env.CBTE_FLEET_LEASE_FILE);
      assert.equal(mode, 'r');
      if (file.missing) throw new Error('missing path /private/lease with secret token');
      return {
        stat: async () => ({ isFile: () => file.regular !== false, size: file.size ?? bytes.length }),
        read: async (buffer, offset, length, position) => {
          bytesRequested = Math.max(bytesRequested, length + offset);
          const count = Math.max(0, Math.min(length, bytes.length - position, file.chunkSize || Infinity));
          bytes.copy(buffer, offset, position, position + count);
          return { bytesRead: count };
        },
        close: async () => { closed++; },
      };
    } };
  } });
  return { route: exports, dependencies, stats: () => ({ opened, closed, bytesRequested }) };
}
const env = { CBTE_FLEET_LEASE_FILE: '/run/cbte-recovery/lease.json', CBTE_FLEET_NODE: 'oci', CBTE_FLEET_EPOCH: '7' };
const fresh = () => ({ node: 'oci', epoch: 7, state: 'active', instanceId: 'oci:guardian-current', validUntilUnixMs: Date.now() + 60000, leaseId: 'secret-lease-id', token: 'secret-token', reason: '/private/secret-path' });

test('unenrolled public health remains generic HTTP-only and does not read a lease or expensive dependency', async () => {
  const { route, dependencies, stats } = healthRoute();
  const before = Date.now(), result = await route.GET();
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.scope, 'dashboard_http_only');
  assert.deepEqual(Object.keys(result.body).sort(), ['ok', 'scope', 'time']);
  assert.ok(Date.parse(result.body.time) >= before && Date.parse(result.body.time) <= Date.now());
  assert.match(result.options.headers['cache-control'], /no-store/);
  assert.equal(route.dynamic, 'force-dynamic');
  assert.equal(stats().opened, 0);
  assert.deepEqual(dependencies.sort(), ['next/server', 'node:fs/promises']);
});

test('fresh active and renewal-unconfirmed leases return only public node, epoch and current guardian instance', async () => {
  for (const state of ['active', 'renewal_unconfirmed']) {
    const { route, stats } = healthRoute(env, { content: { ...fresh(), state }, chunkSize: 17 });
    const result = await route.GET();
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.node, 'oci');
    assert.equal(result.body.epoch, 7);
    assert.equal(result.body.instanceId, 'oci:guardian-current');
    assert.deepEqual(Object.keys(result.body).sort(), ['epoch', 'instanceId', 'node', 'ok', 'scope', 'time']);
    assert.equal(JSON.stringify(result.body).includes('secret'), false);
    assert.equal(stats().closed, 1);
    assert.ok(stats().bytesRequested <= 16385);
  }
});

test('stale, mismatched, inactive and missing identity leases fail closed without exposing file contents', async () => {
  for (const [lease, context] of [
    [{ ...fresh(), validUntilUnixMs: Date.now() - 1 }, env],
    [{ ...fresh(), node: 'primary' }, env],
    [{ ...fresh(), node: 'other' }, { ...env, CBTE_FLEET_NODE: 'other' }],
    [{ ...fresh(), epoch: 8 }, env],
    [{ ...fresh(), epoch: '7' }, env],
    [fresh(), { ...env, CBTE_FLEET_EPOCH: undefined }],
    [{ ...fresh(), state: 'stopped' }, env],
    [{ ...fresh(), instanceId: '' }, env],
    [{ ...fresh(), instanceId: undefined }, env],
    [{ ...fresh(), instanceId: 'x'.repeat(129) }, env],
    [{ ...fresh(), validUntilUnixMs: String(Date.now() + 60000) }, env],
  ]) {
    const result = await healthRoute(context, { content: lease }).route.GET();
    assert.equal(result.status, 503);
    assert.equal(result.body.ok, false);
    assert.deepEqual(Object.keys(result.body).sort(), ['ok', 'scope', 'time']);
    assert.equal(JSON.stringify(result.body).includes('secret'), false);
    assert.match(result.options.headers['cache-control'], /no-store/);
  }
});

test('missing, malformed, non-regular and growing oversized lease files fail within the read bound', async () => {
  for (const file of [
    { missing: true }, { content: '{malformed' }, { content: fresh(), regular: false },
    { content: 'x'.repeat(20000) }, { content: 'x'.repeat(20000), size: 10 },
  ]) {
    const { route, stats } = healthRoute(env, file);
    const result = await route.GET();
    assert.equal(result.status, 503);
    assert.equal(result.body.ok, false);
    assert.ok(stats().bytesRequested <= 16385);
    if (!file.missing) assert.equal(stats().closed, 1);
  }
});

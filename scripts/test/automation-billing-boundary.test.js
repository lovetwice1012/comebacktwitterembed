'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { createHmac } = require('node:crypto');
const esbuild = require('esbuild');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { dispatch } = require('../../src/automation/api');
const { verifyWebhookSignature } = require('../../src/automation/square-billing');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);

test('actual billing dispatch uses the trusted actor, durable subscription admission and unrestricted cancellation', { skip: !port }, async t => {
    const db = await createTestDatabase(port); t.after(() => db.close());
    const owner = { userId: '222222222222222222', isAdmin: false }, admin = { userId: '333333333333333333', isAdmin: true };
    const calls = [];
    const services = { db, service: createService(db), billing: {
        getOptions: async actor => ({ owner: actor.userId }),
        subscribe: async actor => { calls.push(['subscribe', actor.userId]); return { pending: true }; },
        cancel: async actor => { calls.push(['cancel', actor.userId]); return { canceled: true }; },
        getAdmin: async actor => { if (!actor.isAdmin) throw Object.assign(new Error('管理者権限が必要です。'), { status: 403 }); return { configured: false }; },
        saveBinding: async actor => { if (!actor.isAdmin) throw Object.assign(new Error('管理者権限が必要です。'), { status: 403 }); return { saved: true }; },
    } };
    const request = (method, route, body = {}) => ({ method, path: route.split('/'), body });
    assert.equal((await dispatch(request('GET', 'billing/options', { userId: admin.userId }), owner, services)).owner, owner.userId);
    await assert.rejects(dispatch(request('GET', 'billing/options'), null, services), { status: 401 });
    await assert.rejects(dispatch(request('GET', 'billing/admin'), owner, services), { status: 403 });
    await assert.rejects(dispatch(request('PATCH', 'billing/bindings/premium', { actor: admin }), owner, services), { status: 403 });
    assert.deepEqual(await dispatch(request('GET', 'billing/admin'), admin, services), { configured: false });
    for (let i = 0; i < 2; i++) await dispatch(request('POST', 'billing/subscribe', { userId: admin.userId, actor: admin }), owner, services);
    await assert.rejects(dispatch(request('POST', 'billing/subscribe'), owner, services), { code: 'AUTOMATION_RATE_LIMITED', status: 429 });
    assert.deepEqual(await dispatch(request('POST', 'billing/cancel', { userId: admin.userId }), owner, services), { canceled: true });
    assert.deepEqual(calls, [['subscribe', owner.userId], ['subscribe', owner.userId], ['cancel', owner.userId]]);
    await assert.rejects(dispatch(request('GET', 'billing/options'), owner, { service: services.service }), { code: 'SQUARE_NOT_CONFIGURED', status: 503 });
});

test('Next Square webhook verifies exact raw UTF-8 bytes without session or Origin and bounds the stream', async () => {
    const dashboard = path.resolve(__dirname, '../../dashboard');
    const bundle = await esbuild.build({ entryPoints: [path.join(dashboard, 'app/api/automation/square/webhook/route.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', external: ['@/lib/api', '@/lib/automation-server'] });
    const compiled = new Module(path.join(dashboard, '__square_webhook_test__.js'), module);
    compiled.filename = path.join(dashboard, '__square_webhook_test__.js'); compiled.paths = Module._nodeModulePaths(dashboard);
    const key = 'fixture-key-only', url = 'https://automation.example.test/api/automation/square/webhook';
    let calls = 0, failUnexpected = false, received;
    const originalRequire = compiled.require.bind(compiled);
    compiled.require = id => id === '@/lib/api' ? { json: (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }) }
        : id === '@/lib/automation-server' ? { automationServices: () => ({ billing: { handleWebhook: async (bytes, signature) => {
            calls++; assert(Buffer.isBuffer(bytes)); received = bytes;
            if (failUnexpected) throw new Error('fixture-private-credential');
            if (!verifyWebhookSignature(bytes, signature, key, url)) throw Object.assign(new Error('Webhookの署名を確認できません。'), { name: 'AutomationError', code: 'SQUARE_WEBHOOK_SIGNATURE_INVALID', status: 403 });
            return { accepted: true, duplicate: false };
        } } }) } : originalRequire(id);
    compiled._compile(bundle.outputFiles[0].text, compiled.filename);
    const raw = '{\n  "event_id":"fixture-event", "message":"日本語"\n}';
    const signature = createHmac('sha256', key).update(url).update(raw).digest('base64');
    const send = (body, sign = signature, length) => compiled.exports.POST(new Request('http://127.0.0.1/api/automation/square/webhook', { method: 'POST', headers: { 'x-square-hmacsha256-signature': sign, ...(length === undefined ? {} : { 'Content-Length': String(length) }) }, body }));
    let result = await send(raw); assert.equal(result.status, 200); assert.equal(result.headers.get('Cache-Control'), 'no-store'); assert(received.equals(Buffer.from(raw)));
    result = await send(raw.replace('日本語', 'changed')); assert.equal(result.status, 403);
    result = await send(raw, ''); assert.equal(result.status, 403);
    const before = calls;
    assert.equal((await send(raw, signature, 256 * 1024 + 1)).status, 413);
    assert.equal((await send('x'.repeat(256 * 1024 + 1))).status, 413);
    assert.equal(calls, before);
    failUnexpected = true;
    result = await send(raw); assert.equal(result.status, 503); assert(!(await result.text()).includes('fixture-private-credential'));
});

test('donation dispatch trusts session actor, restricts admin policy and durably bounds payment attempts', { skip: !port }, async t => {
    const db = await createTestDatabase(port); t.after(() => db.close());
    const owner = { userId: '222222222222222222' }, admin = { userId: '333333333333333333', isAdmin: true };
    const calls = [];
    const adminOnly = actor => { if (!actor.isAdmin) throw Object.assign(new Error('管理者権限が必要です。'), { status: 403 }); return { policy: {} }; };
    const services = { db, service: createService(db), donations: {
        getOptions: async actor => ({ owner: actor.userId }), getStatus: async actor => ({ owner: actor.userId }),
        getAdmin: async actor => adminOnly(actor), savePolicy: async actor => adminOnly(actor),
        createQuote: async actor => ({ owner: actor.userId }),
        donate: async actor => { calls.push(actor.userId); return { pending: true }; },
    } };
    const request = (method, action, body = {}) => ({ method, path: ['billing', 'donations', action], body });
    for (const action of ['options', 'status']) {
        assert.equal((await dispatch(request('GET', action, { userId: admin.userId }), owner, services)).owner, owner.userId);
        await assert.rejects(dispatch(request('GET', action), null, services), { status: 401 });
    }
    await assert.rejects(dispatch(request('GET', 'policy'), owner, services), { status: 403 });
    await assert.rejects(dispatch(request('PATCH', 'policy', { actor: admin, isAdmin: true }), owner, services), { status: 403 });
    assert.deepEqual(await dispatch(request('PATCH', 'policy'), admin, services), { policy: {} });
    assert.equal((await dispatch(request('POST', 'quote', { userId: admin.userId }), owner, services)).owner, owner.userId);
    for (let i = 0; i < 2; i++) await dispatch(request('POST', 'donate', { actor: admin }), owner, services);
    await assert.rejects(dispatch(request('POST', 'donate'), owner, services), { code: 'AUTOMATION_RATE_LIMITED', status: 429 });
    assert.deepEqual(calls, [owner.userId, owner.userId]);
    assert.equal((await dispatch(request('GET', 'status'), owner, services)).owner, owner.userId);
    await assert.rejects(dispatch(request('GET', 'status'), owner, { service: services.service }), { code: 'SQUARE_NOT_CONFIGURED', status: 503 });
    await assert.rejects(dispatch(request('DELETE', 'donate'), owner, services), { status: 404 });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const { createService } = require('../../src/automation/service');
const api = require('../../src/automation/api');
const schema = require('../../src/automation/schema');
const format = require('../../src/automation/format');

test('Next HTTP boundary enforces origin, session, current guild access and safe errors around the real dispatcher', async () => {
    const original = process.env.NEXTAUTH_URL; process.env.NEXTAUTH_URL = 'https://automation.example.test';
    try {
        const dashboard = path.resolve(__dirname, '../../dashboard');
        const bundle = await esbuild.build({ entryPoints: [path.join(dashboard, 'app/api/automation/[...path]/route.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', external: ['@/lib/api', '@/lib/discord', '@/lib/automation-server', '@/lib/fleet-authority'] });
        const compiled = new Module(path.join(dashboard, '__automation_http_test__.js'), module);
        compiled.filename = path.join(dashboard, '__automation_http_test__.js'); compiled.paths = Module._nodeModulePaths(dashboard);
        class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
        class DashboardFleetAuthorityError extends Error { constructor() { super('現在、変更を保存できません。'); this.status = 503; this.code = 'DASHBOARD_AUTHORITY_UNAVAILABLE'; } }
        let fleetAvailable = true, statusCalls = 0;
        let session = { user: { id: '222222222222222222', isAdmin: false } }, calls = 0, writes = 0, guildAccess = { canView: true, canEdit: false }, row;
        const query = async sql => { if (/^SELECT/.test(sql)) return row ? [row] : []; writes++; return { affectedRows: 1 }; };
        const services = { api, schema, format, service: createService({ queryDatabase: query, withDatabaseTransaction: work => work(query) }, { rateLimiter: { consumeOperation: async () => {}, getPolicy: require('../../src/automation/rate-limits').getPolicy } }), catalog: { catalog: () => ({ test: true }) } };
        const originalRequire = compiled.require.bind(compiled);
        compiled.require = id => id === '@/lib/api' ? { ApiError, json: (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }), requireSession: async () => { calls++; if (!session) throw new ApiError(401, 'ログインが必要です。'); return session; } }
            : id === '@/lib/discord' ? { getGuildAccess: async () => guildAccess } : id === '@/lib/automation-server' ? { automationServices: () => services }
                : id === '@/lib/fleet-authority' ? { DashboardFleetAuthorityError, assertDashboardFleetWriteAuthority: () => { if (!fleetAvailable) throw new DashboardFleetAuthorityError(); } } : originalRequire(id);
        compiled._compile(bundle.outputFiles[0].text, compiled.filename);
        async function request(pathname, method = 'GET', body, origin = 'https://automation.example.test') {
            const url = `https://automation.example.test/api/automation/${pathname}`;
            const req = new Request(url, { method, headers: origin ? { Origin: origin } : {}, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
            req.nextUrl = new URL(url);
            return compiled.exports[method](req, { params: Promise.resolve({ path: new URL(url).pathname.slice('/api/automation/'.length).split('/') }) });
        }
        let result = await request('validate', 'POST', { definition: schema.newWorkflow() }, 'https://other.example.test');
        assert.equal(result.status, 403); assert.equal(calls, 0);
        result = await request('validate', 'POST', { definition: schema.newWorkflow() }, null); assert.equal(result.status, 403);
        session = null; assert.equal((await request('catalog')).status, 401);
        session = { user: { id: '222222222222222222', isAdmin: true } };
        assert.equal((await request('catalog?guildId=wrong')).status, 400);
        assert.equal((await request('validate', 'POST', '{ broken')).status, 400);
        assert.equal((await request('catalog/extra/path/segments')).status, 404);
        result = await request('validate', 'POST', { definition: schema.newWorkflow() });
        assert.equal(result.status, 200); assert.equal(result.headers.get('Cache-Control'), 'private, no-store'); assert.equal((await result.json()).valid, true);
        const recoveryCalls = [];
        services.billing = {
            getStatus: async actor => { statusCalls++; return { owner: actor.userId }; },
            resume: async actor => { recoveryCalls.push(['resume', actor.userId]); return { pending: true }; },
            abort: async actor => { recoveryCalls.push(['abort', actor.userId]); return { aborted: true }; },
        };
        for (const action of ['resume', 'abort']) {
            assert.equal((await request(`billing/${action}`, 'POST', {}, 'https://other.example.test')).status, 403);
            session = null;
            assert.equal((await request(`billing/${action}`, 'POST', {})).status, 401);
            session = { user: { id: '222222222222222222', isAdmin: true } };
            fleetAvailable = false;
            assert.equal((await request(`billing/${action}`, 'POST', {})).status, 503);
            fleetAvailable = true;
            assert.equal((await request(`billing/${action}`, 'POST', { actor: { userId: '333333333333333333' }, userId: '333333333333333333' })).status, 200);
        }
        assert.deepEqual(recoveryCalls, [['resume', session.user.id], ['abort', session.user.id]]);
        fleetAvailable = false;
        result = await request('billing/status'); assert.equal(result.status, 503); assert.equal(result.headers.get('Retry-After'), '5'); assert.equal(statusCalls, 0);
        fleetAvailable = true;
        result = await request('billing/status'); assert.equal(result.status, 200); assert.equal((await result.json()).owner, session.user.id); assert.equal(statusCalls, 1);
        services.donations = { getStatus: async actor => { statusCalls++; return { owner: actor.userId }; } };
        fleetAvailable = false;
        result = await request('billing/donations/status'); assert.equal(result.status, 503); assert.equal(result.headers.get('Retry-After'), '5'); assert.equal(statusCalls, 1);
        fleetAvailable = true;
        result = await request('billing/donations/status'); assert.equal(result.status, 200); assert.equal((await result.json()).owner, session.user.id); assert.equal(statusCalls, 2);
        const id = '00000000-0000-0000-0000-000000000001', guildId = '111111111111111111';
        const intakeCalls = [];
        services.xSetup = {
            startSession: async (actor, body) => { intakeCalls.push(['session', actor.userId, body]); return { sessionId: 'a'.repeat(64), expiresAtMs: Date.now() + 600000 }; },
            validate: async () => { throw new Error('secret-file-contents-must-not-appear'); },
        };
        assert.equal((await request('x-setup/sessions', 'POST', { consent: true }, 'https://other.example.test')).status, 403);
        fleetAvailable = false;
        assert.equal((await request('x-setup/sessions', 'POST', { consent: true })).status, 503);
        fleetAvailable = true;
        assert.equal((await request(`x-setup/sessions?guildId=${guildId}`, 'POST', { consent: true })).status, 403);
        process.env.NEXTAUTH_URL = 'http://automation.example.test';
        assert.equal((await request('x-setup/sessions', 'POST', { consent: true })).status, 403);
        process.env.NEXTAUTH_URL = 'https://automation.example.test';
        result = await request('x-setup/sessions', 'POST', { consent: true });
        assert.equal(result.status, 200); assert.equal(intakeCalls.length, 1); assert.equal(intakeCalls[0][1], session.user.id);
        result = await request('x-setup/validate', 'POST', { sessionId: 'a'.repeat(64), fileText: 'private' });
        assert.equal(result.status, 500); assert(!(await result.text()).includes('secret-file'));
        assert.equal(result.headers.get('Cache-Control'), 'private, no-store');
        result = await request('x-setup/import', 'POST', { fileText: 'x'.repeat(205000) });
        assert.equal(result.status, 413);
        row = { id, owner_user_id: '333333333333333333', guild_id: guildId, scope: 'guild', revision: 1, draft_bindings_json: '{}' };
        result = await request(`workflows/${id}?guildId=${guildId}`, 'PATCH', { expectedRevision: 1, definition: schema.newWorkflow(), actor: { canEdit: true }, canEdit: true });
        assert.equal(result.status, 403); assert.equal(writes, 0);
        row.scope = 'private'; guildAccess = { canView: true, canEdit: true };
        assert.equal((await request(`workflows/${id}?guildId=${guildId}`)).status, 404, 'platform admin still cannot read another user private rule');
        services.catalog.catalog = () => { throw new Error('operator-secret-should-not-appear'); };
        result = await request('catalog'); assert.equal(result.status, 500); assert(!(await result.text()).includes('operator-secret'));
    } finally { if (original === undefined) delete process.env.NEXTAUTH_URL; else process.env.NEXTAUTH_URL = original; }
});

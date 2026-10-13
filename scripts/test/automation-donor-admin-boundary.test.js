'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), Module = require('node:module'), esbuild = require('esbuild');
const { dispatch } = require('../../src/automation/api');

test('donor HTTP boundary requires canonical origin, trusted global admin and fleet authority, with private responses and safe failures', async () => {
    const oldOrigin = process.env.NEXTAUTH_URL; process.env.NEXTAUTH_URL = 'https://fixture.example';
    try {
        const dashboard = path.resolve(__dirname, '../../dashboard');
        const bundle = await esbuild.build({ entryPoints: [path.join(dashboard, 'app/api/automation/[...path]/route.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', external: ['@/lib/api', '@/lib/discord', '@/lib/automation-server', '@/lib/fleet-authority'] });
        const compiled = new Module(path.join(dashboard, '__donor_boundary_fixture__.js'), module); compiled.filename = path.join(dashboard, '__donor_boundary_fixture__.js'); compiled.paths = Module._nodeModulePaths(dashboard);
        class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
        class DashboardFleetAuthorityError extends Error { constructor() { super('現在、変更を保存できません。'); this.status = 503; this.code = 'DASHBOARD_AUTHORITY_UNAVAILABLE'; } }
        let session = null, authority = true, admission = true, reads = 0, writes = 0, failRead = false;
        const services = { api: { dispatch }, service: { withOperation: async (actor, group, work) => { assert.equal(group, 'write'); assert.equal(actor.isAdmin, true); if (!admission) throw Object.assign(new Error('操作回数の上限に達しました。'), { name: 'AutomationError', code: 'AUTOMATION_RATE_LIMIT', status: 429, retryAfterMs: 60000 }); return work(); } }, donors: {
            list: async () => { reads++; if (failRead) throw new Error('Private SQL credential response'); return { items: [], total: 0 }; },
            get: async () => { reads++; return { safe: true }; },
            save: async () => { writes++; return { saved: true }; },
        } };
        const originalRequire = compiled.require.bind(compiled);
        compiled.require = id => id === '@/lib/api' ? { ApiError, json: (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }), requireSession: async () => { if (!session) throw new ApiError(401, 'ログインしてください。'); return session; } }
            : id === '@/lib/discord' ? { getGuildAccess: async () => ({ canView: true, canEdit: true }) }
                : id === '@/lib/automation-server' ? { automationServices: () => services }
                    : id === '@/lib/fleet-authority' ? { DashboardFleetAuthorityError, assertDashboardFleetWriteAuthority: () => { if (!authority) throw new DashboardFleetAuthorityError(); } } : originalRequire(id);
        compiled._compile(bundle.outputFiles[0].text, compiled.filename);
        const request = async (route, method = 'GET', body = undefined, origin = 'https://fixture.example') => {
            const url = `http://127.0.0.1:31089/api/automation/${route}`;
            const req = new Request(url, { method, headers: origin ? { Origin: origin } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); req.nextUrl = new URL(url);
            return compiled.exports[method](req, { params: Promise.resolve({ path: route.split('?')[0].split('/') }) });
        };
        assert.equal((await request('donors')).status, 401);
        session = { user: { id: '222222222222222222', isAdmin: false } };
        assert.equal((await request('donors?guildId=123456789012345678')).status, 403);
        assert.equal((await request('donors/222222222222222223', 'PATCH', { isAdmin: true })).status, 403); assert.equal(reads, 0); assert.equal(writes, 0);
        session = { user: { id: '444444444444444444', isAdmin: true } };
        assert.equal((await request('donors/222222222222222223', 'PATCH', {}, 'https://other.example')).status, 403);
        assert.equal((await request('donors/222222222222222223', 'PATCH', {}, null)).status, 403);
        authority = false;
        assert.equal((await request('donors/222222222222222223', 'PATCH', {})).status, 503); assert.equal(writes, 0);
        const read = await request('donors'); assert.equal(read.status, 200); assert.equal(read.headers.get('Cache-Control'), 'private, no-store');
        authority = true; admission = false;
        const limited = await request('donors/222222222222222223', 'PATCH', {}); assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '60'); assert.equal(writes, 0);
        admission = true;
        const saved = await request('donors/222222222222222223', 'PATCH', {}); assert.equal(saved.status, 200); assert.equal(saved.headers.get('Cache-Control'), 'private, no-store'); assert.equal(writes, 1);
        failRead = true;
        const failed = await request('donors'); assert.equal(failed.status, 500); assert.ok(!JSON.stringify(await failed.json()).includes('Private SQL credential response'));
    } finally { if (oldOrigin === undefined) delete process.env.NEXTAUTH_URL; else process.env.NEXTAUTH_URL = oldOrigin; }
});

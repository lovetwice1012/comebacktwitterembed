'use strict';

// In-memory Next route with synthetic identity and authority. The actual route,
// dispatcher, intake service and disposable database remain in use.
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const api = require('../../src/automation/api');

async function createSyntheticSetupHttp(db, setup) {
    const dashboard = path.resolve(__dirname, '../../dashboard');
    const bundle = await esbuild.build({ entryPoints: [path.join(dashboard, 'app/api/automation/[...path]/route.ts')], bundle: true,
        write: false, platform: 'node', format: 'cjs', packages: 'external', external: ['@/lib/api', '@/lib/discord', '@/lib/automation-server', '@/lib/fleet-authority'] });
    const compiled = new Module(path.join(dashboard, '__synthetic_mac_http__.js'), module);
    compiled.filename = path.join(dashboard, '__synthetic_mac_http__.js'); compiled.paths = Module._nodeModulePaths(dashboard);
    class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
    class DashboardFleetAuthorityError extends Error { constructor() { super('unavailable'); this.status = 503; } }
    let userId = '222222222222222222';
    const services = { api, db, xSetup: setup, service: { withOperation: async (_actor, _group, work) => work() } };
    const originalRequire = compiled.require.bind(compiled);
    compiled.require = id => id === '@/lib/api' ? { ApiError, json: (value, status = 200) => new Response(JSON.stringify(value), { status }),
        requireSession: async () => ({ user: { id: userId, isAdmin: false } }) }
        : id === '@/lib/discord' ? { getGuildAccess: async () => ({ canView: false, canEdit: false }) }
            : id === '@/lib/automation-server' ? { automationServices: () => services }
                : id === '@/lib/fleet-authority' ? { DashboardFleetAuthorityError, assertDashboardFleetWriteAuthority: () => {} } : originalRequire(id);
    compiled._compile(bundle.outputFiles[0].text, compiled.filename);
    return {
        setUser(value) { userId = value; },
        async post(route, body, origin = 'https://automation.example.test') {
            const url = `https://automation.example.test/api/automation/${route}`;
            const request = new Request(url, { method: 'POST', headers: { Origin: origin }, body: JSON.stringify(body) });
            request.nextUrl = new URL(url);
            const response = await compiled.exports.POST(request, { params: Promise.resolve({ path: route.split('/') }) });
            return { status: response.status, cacheControl: response.headers.get('Cache-Control'), body: await response.json() };
        },
    };
}
module.exports = { createSyntheticSetupHttp };

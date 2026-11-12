'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const { unzipSync } = require('fflate');
const root = path.resolve(__dirname, '../..');
function load(filename, modules, globals = {}) {
    const compiled = ts.transpileModule(fs.readFileSync(path.join(root, filename), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const exports = {};
    vm.runInNewContext(compiled, { exports, Buffer, Uint8Array, Response, URLSearchParams, process: { env: {} }, ...globals,
        require(name) { assert(Object.hasOwn(modules, name), `unexpected dependency ${name}`); return modules[name]; } });
    return exports;
}
function metadata() { return load('dashboard/lib/x-edge-setup-download.ts', { 'server-only': {}, 'node:crypto': { createHash },
    'node:fs/promises': {}, 'node:path': path, '@/lib/env': { repoRoot: () => root } }).X_EDGE_SETUP_DOWNLOAD; }
test('Edge preview download is pinned and contains only its reviewed package files', () => {
    const meta = metadata(), bytes = fs.readFileSync(path.join(root, 'artifacts', 'angelic-setup', meta.filename));
    assert.equal(bytes.length, meta.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), meta.sha256);
    const entries = unzipSync(bytes), manifest = JSON.parse(Buffer.from(entries['_app/package-manifest.json']).toString('utf8'));
    assert.equal(manifest.packageId, 'x-notification-edge-setup'); assert.equal(manifest.version, meta.version);
    for (const [name, hash] of Object.entries(manifest.files)) assert.equal(createHash('sha256').update(entries[`_app/${name}`]).digest('hex'), hash);
    assert.deepEqual(Object.keys(entries).sort(), [...Object.keys(manifest.files).map(name => `_app/${name}`), '_app/package-manifest.json', 'はじめに.txt', 'Edgeで開始.cmd'].sort());
    assert(!Object.keys(entries).some(name => /cookies|local state|preferences|profile/i.test(name)));
    const launcher = Buffer.from(entries['Edgeで開始.cmd']).toString('utf8'); assert(!/(?<!\r)\n/.test(launcher)); assert(launcher.includes('%~dp0_app\\Start-EdgeSetup.ps1'));
    for (const name of ['EdgeSetup.ps1', 'EdgeShared.ps1', 'Start-EdgeSetup.ps1', 'EdgeCalibration.ps1'])
        assert.deepEqual([...Buffer.from(entries[`_app/${name}`]).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});
test('Windows rebuild matches the published preview or reproducibly builds a newer candidate', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
    const meta = metadata(), built = await require('../build-edge-setup-package.cjs').buildArchive({ nodeExecutable: process.execPath });
    if (built.version === meta.version) {
        assert.equal(built.sha256, meta.sha256); assert.equal(built.archive.length, meta.bytes);
    } else {
        const candidate = /^0\.1\.0-edge-preview\.([1-9]\d*)$/.exec(built.version);
        const published = /^0\.1\.0-edge-preview\.([1-9]\d*)$/.exec(meta.version);
        assert(candidate && published && Number(candidate[1]) > Number(published[1]), 'candidate must advance the published preview');
        assert.notEqual(built.sha256, meta.sha256);
        const second = await require('../build-edge-setup-package.cjs').buildArchive({ nodeExecutable: process.execPath });
        assert.equal(second.version, built.version); assert.equal(second.sha256, built.sha256); assert.equal(second.archive.length, built.archive.length);
    }
});
test('Edge archive is included in the dashboard trace', () => {
    const config = load('dashboard/next.config.ts', { 'node:path': path }, { process: { env: {}, cwd: () => path.join(root, 'dashboard') } }).default;
    assert(config.outputFileTracingIncludes['/api/automation/x-setup/download-edge'].includes(`../artifacts/angelic-setup/${metadata().filename}`));
});
test('Edge download requires authentication, feature enablement and rollout eligibility', async () => {
    class ApiError extends Error { constructor(status) { super(); this.status = status; } }
    let loggedIn = false, reads = 0, state = { edgeEnabled: true, rollout: { mode: 'supporters', eligible: true, reasonCode: null } }, actor;
    const meta = { filename: 'fixture.zip', sha256: 'a'.repeat(64) }, globals = { process: { env: { X_NOTIFICATION_EDGE_ENABLED: '1' } } };
    const route = load('dashboard/app/api/automation/x-setup/download-edge/route.ts', {
        '@/lib/api': { ApiError, requireSession: async () => { if (!loggedIn) throw new ApiError(401); return { user: { id: '123456789', isAdmin: false } }; },
            json: (body, status) => new Response(JSON.stringify(body), { status }) },
        '@/lib/automation-server': { automationServices: () => ({ api: { dispatch: async (_request, value) => { actor = value; return state; } } }) },
        '@/lib/x-edge-setup-download': { X_EDGE_SETUP_DOWNLOAD: meta, readEdgeSetupDownload: async () => { reads++; return Buffer.from('fixture'); } },
    }, globals);
    assert.equal((await route.GET()).status, 401); assert.equal(reads, 0); loggedIn = true;
    globals.process.env.X_NOTIFICATION_EDGE_ENABLED = '0'; assert.equal((await route.GET()).status, 503); assert.equal(reads, 0);
    globals.process.env.X_NOTIFICATION_EDGE_ENABLED = '1'; state = { edgeEnabled: false, rollout: { mode: 'supporters', eligible: false, reasonCode: 'X_ROLLOUT_SUPPORTERS_ONLY' } };
    assert.equal((await route.GET()).status, 403); assert.equal(reads, 0);
    state = { edgeEnabled: true, rollout: { mode: 'disabled', eligible: false, reasonCode: 'X_ROLLOUT_DISABLED' } }; assert.equal((await route.GET()).status, 503);
    state = { edgeEnabled: true, rollout: { mode: 'supporters', eligible: true, reasonCode: null } }; const response = await route.GET();
    assert.equal(response.status, 200); assert.equal(reads, 1); assert.equal(actor.userId, '123456789');
    assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0'); assert.equal(response.headers.get('x-checksum-sha256'), meta.sha256);
});

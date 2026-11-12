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
    const source = fs.readFileSync(path.join(root, filename), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const exports = {};
    vm.runInNewContext(compiled, { exports, Buffer, Uint8Array, Response, URLSearchParams, process: { env: {} }, ...globals,
        require(name) { assert(Object.hasOwn(modules, name), `unexpected dependency ${name}`); return modules[name]; } });
    return exports;
}
test('download package is pinned, complete and includes no profile data', () => {
    const meta = load('dashboard/lib/x-chrome-setup-download.ts', { 'server-only': {}, 'node:crypto': { createHash },
        'node:fs/promises': {}, 'node:path': path, '@/lib/env': { repoRoot: () => root } }).X_CHROME_SETUP_DOWNLOAD;
    const bytes = fs.readFileSync(path.join(root, 'artifacts', 'angelic-setup', meta.filename));
    assert.equal(bytes.length, meta.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), meta.sha256);
    const entries = unzipSync(bytes), manifest = JSON.parse(Buffer.from(entries['_app/package-manifest.json']).toString('utf8'));
    assert.equal(manifest.packageId, 'x-notification-chrome-setup');
    for (const [name, hash] of Object.entries(manifest.files)) assert.equal(createHash('sha256').update(entries[`_app/${name}`]).digest('hex'), hash);
    assert.deepEqual(Object.keys(entries).sort(), [...Object.keys(manifest.files).map(name => `_app/${name}`), '_app/package-manifest.json',
        'はじめに.txt', 'Chromeで開始.cmd', 'Braveで開始.cmd'].sort());
    assert(!Object.keys(entries).some(name => /cookies|local state|preferences|profile/i.test(name)));
    for (const name of ['ChromeSetup.ps1', 'ChromeBroker.cjs', 'ChromeCapture.cjs']) {
        assert(!Buffer.from(entries[`_app/${name}`]).includes(Buffer.from('--remote-debugging-port')));
    }
    assert(Buffer.from(entries['_app/ChromeBroker.cjs']).includes(Buffer.from('--remote-debugging-pipe')));
    assert(Buffer.from(entries['Braveで開始.cmd']).includes(Buffer.from('-Browser brave')));
    for (const name of ['Chromeで開始.cmd', 'Braveで開始.cmd']) {
        const launcher = Buffer.from(entries[name]).toString('utf8');
        assert(!/(?<!\r)\n/.test(launcher), `${name} must use CRLF for cmd.exe`);
        assert(launcher.includes('%~dp0_app\\Start-ChromeSetup.ps1'));
    }
    for (const name of ['ChromeSetup.ps1', 'Start-ChromeSetup.ps1', 'ChromeSnapshot.ps1'])
        assert.deepEqual([...Buffer.from(entries[`_app/${name}`]).subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name} needs UTF-8 BOM for Windows PowerShell 5.1`);
});
test('Windows release rebuild matches the pinned Chrome download', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
    const meta = load('dashboard/lib/x-chrome-setup-download.ts', { 'server-only': {}, 'node:crypto': { createHash },
        'node:fs/promises': {}, 'node:path': path, '@/lib/env': { repoRoot: () => root } }).X_CHROME_SETUP_DOWNLOAD;
    const built = await require('../build-chrome-setup-package.cjs').buildArchive();
    assert.equal(built.version, meta.version); assert.equal(built.sha256, meta.sha256); assert.equal(built.archive.length, meta.bytes);
});
test('production file tracing includes the pinned Chrome download', () => {
    const meta = load('dashboard/lib/x-chrome-setup-download.ts', { 'server-only': {}, 'node:crypto': { createHash },
        'node:fs/promises': {}, 'node:path': path, '@/lib/env': { repoRoot: () => root } }).X_CHROME_SETUP_DOWNLOAD;
    const config = load('dashboard/next.config.ts', { 'node:path': path },
        { process: { env: {}, cwd: () => path.join(root, 'dashboard') } }).default;
    const entries = config.outputFileTracingIncludes['/api/automation/x-setup/download-chrome'];
    assert(entries.includes(`../artifacts/angelic-setup/${meta.filename}`));
    assert(entries.includes('../src/**/*.js')); assert(entries.includes('../packages/angelic-angel/dist/**'));
});
test('Chrome download authenticates first, respects rollout flag and returns private headers', async () => {
    class ApiError extends Error { constructor(status) { super(); this.status = status; } }
    let loggedIn = false, reads = 0, actor, shouldThrow = false, isAdmin = false;
    let state = { receiverEnabled: true, chromeEnabled: true, rollout: { mode: 'supporters', eligible: true, reasonCode: null } };
    const meta = { filename: 'fixture.zip', sha256: 'a'.repeat(64) };
    const globals = { process: { env: { X_NOTIFICATION_CHROME_ENABLED: '1' } } };
    const route = load('dashboard/app/api/automation/x-setup/download-chrome/route.ts', {
        '@/lib/api': { ApiError, requireSession: async () => { if (!loggedIn) throw new ApiError(401); return { user: { id: '123456789', isAdmin } }; },
            json: (body, status) => new Response(JSON.stringify(body), { status }) },
        '@/lib/automation-server': { automationServices: () => ({ api: { dispatch: async (_request, value) => {
            actor = value; if (shouldThrow) throw new Error('synthetic database failure'); return state;
        } } }) },
        '@/lib/x-chrome-setup-download': { X_CHROME_SETUP_DOWNLOAD: meta, readChromeSetupDownload: async () => { reads++; return Buffer.from('fixture'); } },
    }, globals);
    assert.equal((await route.GET()).status, 401); assert.equal(reads, 0);
    loggedIn = true; globals.process.env.X_NOTIFICATION_CHROME_ENABLED = '0';
    assert.equal((await route.GET()).status, 503); assert.equal(reads, 0);
    globals.process.env.X_NOTIFICATION_CHROME_ENABLED = '1';
    state = { receiverEnabled: false, chromeEnabled: false, rollout: { mode: 'supporters', eligible: false, reasonCode: 'X_ROLLOUT_SUPPORTERS_ONLY' } };
    const denied = await route.GET(); assert.equal(denied.status, 403); assert.equal((await denied.json()).code, 'X_ROLLOUT_SUPPORTERS_ONLY');
    assert.equal(reads, 0); assert.equal(actor.userId, '123456789');
    isAdmin = true; assert.equal((await route.GET()).status, 403); assert.equal(actor.isAdmin, true); assert.equal(reads, 0); isAdmin = false;
    state = { receiverEnabled: true, chromeEnabled: true, rollout: { mode: 'disabled', eligible: false, reasonCode: 'X_ROLLOUT_DISABLED' } };
    assert.equal((await route.GET()).status, 503); assert.equal(reads, 0);
    state = { receiverEnabled: false, chromeEnabled: true, rollout: { mode: 'supporters', eligible: true } };
    assert.equal((await route.GET()).status, 503); assert.equal(reads, 0);
    shouldThrow = true; assert.equal((await route.GET()).status, 503); assert.equal(reads, 0); shouldThrow = false;
    state = { receiverEnabled: true, chromeEnabled: true, rollout: { mode: 'supporters', eligible: true, reasonCode: null } };
    const response = await route.GET(); assert.equal(response.status, 200); assert.equal(reads, 1);
    assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-checksum-sha256'), meta.sha256);
    state = { receiverEnabled: true, chromeEnabled: true, rollout: { mode: 'public', eligible: true, reasonCode: null } };
    assert.equal((await route.GET()).status, 200); assert.equal(reads, 2);
});

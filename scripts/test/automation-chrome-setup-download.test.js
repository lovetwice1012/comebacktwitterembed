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
    vm.runInNewContext(compiled, { exports, Buffer, Uint8Array, Response, process: { env: {} }, ...globals,
        require(name) { assert(Object.hasOwn(modules, name), `unexpected dependency ${name}`); return modules[name]; } });
    return exports;
}
test('download package is pinned, complete and includes no profile data', () => {
    const meta = load('dashboard/lib/x-chrome-setup-download.ts', { 'server-only': {}, 'node:crypto': { createHash },
        'node:fs/promises': {}, 'node:path': path, '@/lib/env': { repoRoot: () => root } }).X_CHROME_SETUP_DOWNLOAD;
    const bytes = fs.readFileSync(path.join(root, 'artifacts', 'angelic-setup', meta.filename));
    assert.equal(bytes.length, meta.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), meta.sha256);
    const entries = unzipSync(bytes), manifest = JSON.parse(Buffer.from(entries['package-manifest.json']).toString('utf8'));
    assert.equal(manifest.packageId, 'x-notification-chrome-setup');
    for (const [name, hash] of Object.entries(manifest.files)) assert.equal(createHash('sha256').update(entries[name]).digest('hex'), hash);
    assert.deepEqual(Object.keys(entries).sort(), [...Object.keys(manifest.files), 'package-manifest.json'].sort());
    assert(!Object.keys(entries).some(name => /cookies|local state|preferences|profile/i.test(name)));
    for (const name of ['ChromeSetup.ps1', 'ChromeBroker.cjs', 'ChromeCapture.cjs']) {
        assert(!Buffer.from(entries[name]).includes(Buffer.from('--remote-debugging-port')));
    }
    assert(Buffer.from(entries['ChromeBroker.cjs']).includes(Buffer.from('--remote-debugging-pipe')));
});
test('Windows release rebuild matches the pinned Chrome download', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
    const meta = load('dashboard/lib/x-chrome-setup-download.ts', { 'server-only': {}, 'node:crypto': { createHash },
        'node:fs/promises': {}, 'node:path': path, '@/lib/env': { repoRoot: () => root } }).X_CHROME_SETUP_DOWNLOAD;
    const built = await require('../build-chrome-setup-package.cjs').buildArchive();
    assert.equal(built.version, meta.version); assert.equal(built.sha256, meta.sha256); assert.equal(built.archive.length, meta.bytes);
});
test('Chrome download authenticates first, respects rollout flag and returns private headers', async () => {
    class ApiError extends Error { constructor(status) { super(); this.status = status; } }
    let loggedIn = false, reads = 0;
    const meta = { filename: 'fixture.zip', sha256: 'a'.repeat(64) };
    const globals = { process: { env: { X_NOTIFICATION_CHROME_ENABLED: '1' } } };
    const route = load('dashboard/app/api/automation/x-setup/download-chrome/route.ts', {
        '@/lib/api': { ApiError, requireSession: async () => { if (!loggedIn) throw new ApiError(401); },
            json: (body, status) => new Response(JSON.stringify(body), { status }) },
        '@/lib/x-chrome-setup-download': { X_CHROME_SETUP_DOWNLOAD: meta, readChromeSetupDownload: async () => { reads++; return Buffer.from('fixture'); } },
    }, globals);
    assert.equal((await route.GET()).status, 401); assert.equal(reads, 0);
    loggedIn = true; globals.process.env.X_NOTIFICATION_CHROME_ENABLED = '0';
    assert.equal((await route.GET()).status, 503); assert.equal(reads, 0);
    globals.process.env.X_NOTIFICATION_CHROME_ENABLED = '1';
    const response = await route.GET(); assert.equal(response.status, 200); assert.equal(reads, 1);
    assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-checksum-sha256'), meta.sha256);
});

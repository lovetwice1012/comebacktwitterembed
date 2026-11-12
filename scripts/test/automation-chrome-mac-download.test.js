'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
function load(filename, modules, globals = {}) {
    const source = fs.readFileSync(path.join(root, filename), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const exports = {};
    vm.runInNewContext(compiled, { exports, Buffer, Uint8Array, Response, URL, URLSearchParams, process: { env: {} }, ...globals,
        require(name) { assert(Object.hasOwn(modules, name), `unexpected dependency ${name}`); return modules[name]; } });
    return exports;
}
test('unreleased Mac preview cannot be selected as a pinned distribution', () => {
    const { getChromeMacRelease } = require('../../src/automation/x-chrome-mac-release');
    for (const arch of ['arm64', 'x64', '../arm64', 'constructor', '']) assert.equal(getChromeMacRelease(arch), null);
});
test('release registry rejects malformed metadata and accepts only the exact architecture filename', () => {
    const original = fs.readFileSync(path.join(root, 'src/automation/x-chrome-mac-release.js'), 'utf8');
    function registry(arm64, x64) {
        const declarations = `arm64: ${JSON.stringify(arm64)}, x64: ${JSON.stringify(x64)}`;
        const source = original.replace('arm64: null, x64: null', declarations);
        assert.notEqual(source, original); const module = { exports: {} };
        vm.runInNewContext(source, { module, exports: module.exports, Object, Number }); return module.exports;
    }
    const valid = { version: '1.2.3', filename: 'chrome-mac-arm64-1.2.3.zip', bytes: 20, sha256: 'a'.repeat(64) };
    const selected = registry(valid, null).getChromeMacRelease('arm64');
    assert.equal(selected.filename, valid.filename); assert(Object.isFrozen(selected));
    for (const replacement of [{ ...valid, filename: '../secret.zip' }, { ...valid, filename: 'chrome-mac-x64-1.2.3.zip' },
        { ...valid, bytes: -1 }, { ...valid, sha256: 'A'.repeat(64) }, { ...valid, extra: true },
        { ...valid, version: '1.2.3-preview.1', filename: 'chrome-mac-arm64-1.2.3-preview.1.zip' }])
        assert.equal(registry(replacement, null).getChromeMacRelease('arm64'), null);
});
test('production tracing includes the Mac release registry and pinned archive pattern', () => {
    const config = load('dashboard/next.config.ts', { 'node:path': path },
        { process: { env: {}, cwd: () => path.join(root, 'dashboard') } }).default;
    const entries = config.outputFileTracingIncludes['/api/automation/x-setup/download-chrome-mac'];
    assert(entries.includes('../src/automation/x-chrome-mac-release.js'));
    assert(entries.includes('../src/**/*.js')); assert(entries.includes('../packages/angelic-angel/dist/**'));
    assert(entries.includes('../artifacts/angelic-setup/chrome-mac-*.zip'));
});
test('status exposes pinned Mac architectures only for enabled eligible users', async () => {
    const registryPath = require.resolve('../../src/automation/x-chrome-mac-release');
    const setupPath = require.resolve('../../src/automation/x-setup');
    const registry = require(registryPath), savedRegistry = require.cache[registryPath].exports, savedSetup = require.cache[setupPath];
    try {
        require.cache[registryPath].exports = { getChromeMacRelease: arch => arch === 'arm64' ? { pinned: true } : null };
        delete require.cache[setupPath];
        const { createXSetup } = require(setupPath);
        const db = { queryDatabase: async sql => sql.includes('SELECT is_donor') ? [{ is_donor: 0 }] : [] };
        const actor = { userId: '123456789012345678' }, base = { sealer: { seal() {} }, chromeEnabled: true, chromeMacEnabled: true, receiverEnabled: true, rolloutMode: 'public' };
        assert.deepEqual((await createXSetup(db, base).status(actor)).chromeMacDownloads, { arm64: true, x64: false });
        for (const changes of [{ chromeEnabled: false }, { chromeMacEnabled: false }, { receiverEnabled: false }, { rolloutMode: 'disabled' }, { rolloutMode: 'supporters' }])
            assert.deepEqual((await createXSetup(db, { ...base, ...changes }).status(actor)).chromeMacDownloads, { arm64: false, x64: false });
        assert.equal(registry.getChromeMacRelease('arm64'), null);
    } finally {
        require.cache[registryPath].exports = savedRegistry;
        if (savedSetup) require.cache[setupPath] = savedSetup; else delete require.cache[setupPath];
    }
});
test('Mac Chrome download verifies the exact pinned archive on each read', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'cbte-mac-release-test-'));
    const artifacts = path.join(base, 'artifacts'), directory = path.join(artifacts, 'angelic-setup');
    const bytes = Buffer.from('isolated synthetic signed release');
    const filename = 'chrome-mac-arm64-1.2.3.zip', file = path.join(directory, filename);
    const metadata = { filename, bytes: bytes.length, version: '1.2.3', sha256: createHash('sha256').update(bytes).digest('hex') };
    try {
        await fsp.mkdir(artifacts); await fsp.mkdir(directory); await fsp.writeFile(file, bytes);
        const lib = load('dashboard/lib/x-chrome-mac-setup-download.ts', { 'server-only': {}, 'node:crypto': { createHash },
            'node:fs/promises': fsp, 'node:path': path, '@/lib/env': { repoRoot: () => base },
            '@/lib/bot-require': { requireBotModule: () => ({ getChromeMacRelease: arch => arch === 'arm64' ? metadata : null }) } });
        assert.deepEqual(Buffer.from(await lib.readMacChromeSetupDownload('arm64')), bytes);
        await fsp.writeFile(file, Buffer.alloc(bytes.length, 65));
        await assert.rejects(lib.readMacChromeSetupDownload('arm64'), /X_SETUP_RELEASE_UNAVAILABLE/);
        await assert.rejects(lib.readMacChromeSetupDownload('x64'), /X_SETUP_RELEASE_UNAVAILABLE/);
    } finally {
        await fsp.unlink(file).catch(() => {}); await fsp.rmdir(directory).catch(() => {});
        await fsp.rmdir(artifacts).catch(() => {}); await fsp.rmdir(base).catch(() => {});
    }
});
test('Mac downloads share only concurrent reads of the same architecture and retry after failures', { timeout: 10000 }, async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'cbte-mac-concurrent-'));
    const artifacts = path.join(base, 'artifacts'), directory = path.join(artifacts, 'angelic-setup');
    const bytes = Buffer.from('isolated archive'), sha256 = createHash('sha256').update(bytes).digest('hex');
    const releases = Object.fromEntries(['arm64', 'x64'].map(arch => [arch, { filename: `chrome-mac-${arch}-1.2.3.zip`, bytes: bytes.length, version: '1.2.3', sha256 }]));
    const files = Object.values(releases).map(release => path.join(directory, release.filename));
    let opens = 0, unblock, started;
    const blocked = new Promise(resolve => { unblock = resolve; });
    const bothStarted = new Promise(resolve => { started = resolve; });
    const fsFacade = { lstat: fsp.lstat, async open(...args) { opens++; if (opens === 2) started(); await blocked; return fsp.open(...args); } };
    try {
        await fsp.mkdir(artifacts); await fsp.mkdir(directory); await Promise.all(files.map(file => fsp.writeFile(file, bytes)));
        const lib = load('dashboard/lib/x-chrome-mac-setup-download.ts', { 'server-only': {}, 'node:crypto': { createHash },
            'node:fs/promises': fsFacade, 'node:path': path, '@/lib/env': { repoRoot: () => base },
            '@/lib/bot-require': { requireBotModule: () => ({ getChromeMacRelease: arch => releases[arch] || null }) } });
        const arm1 = lib.readMacChromeSetupDownload('arm64'), arm2 = lib.readMacChromeSetupDownload('arm64');
        const intel = lib.readMacChromeSetupDownload('x64');
        await bothStarted; assert.equal(opens, 2); unblock();
        const values = await Promise.all([arm1, arm2, intel]);
        for (const value of values) assert.deepEqual(Buffer.from(value), bytes);
        await fsp.writeFile(files[0], Buffer.alloc(bytes.length, 65));
        const failed = await Promise.allSettled([lib.readMacChromeSetupDownload('arm64'), lib.readMacChromeSetupDownload('arm64')]);
        assert(failed.every(item => item.status === 'rejected')); assert.equal(opens, 3);
        await fsp.writeFile(files[0], bytes);
        assert.deepEqual(Buffer.from(await lib.readMacChromeSetupDownload('arm64')), bytes); assert.equal(opens, 4);
    } finally {
        unblock(); await Promise.all(files.map(file => fsp.unlink(file).catch(() => {})));
        await fsp.rmdir(directory).catch(() => {}); await fsp.rmdir(artifacts).catch(() => {}); await fsp.rmdir(base).catch(() => {});
    }
});
test('Mac Chrome route requires authentication, both flags, one supported architecture and a pinned artifact', async () => {
    class ApiError extends Error { constructor(status) { super(); this.status = status; } }
    let loggedIn = false, release = null, reads = 0, actor, status = { chromeEnabled: true, receiverEnabled: true,
        chromeMacDownloads: { arm64: true, x64: false }, rollout: { mode: 'supporters', eligible: true, reasonCode: null } };
    const globals = { process: { env: { X_NOTIFICATION_CHROME_ENABLED: '1', X_NOTIFICATION_CHROME_MAC_ENABLED: '1' } } };
    const route = load('dashboard/app/api/automation/x-setup/download-chrome-mac/route.ts', {
        '@/lib/api': { ApiError, requireSession: async () => { if (!loggedIn) throw new ApiError(401); return { user: { id: '123456789', isAdmin: false } }; },
            json: (body, status) => new Response(JSON.stringify(body), { status }) },
        '@/lib/automation-server': { automationServices: () => ({ api: { dispatch: async (_request, value) => { actor = value; return status; } } }) },
        '@/lib/x-chrome-mac-setup-download': { getMacChromeRelease: () => release,
            readMacChromeSetupDownload: async () => { reads++; return Buffer.from('fixture'); } },
    }, globals);
    const request = query => new Request(`https://example.test/api/automation/x-setup/download-chrome-mac${query}`);
    assert.equal((await route.GET(request('?arch=arm64'))).status, 401); assert.equal(reads, 0);
    loggedIn = true;
    for (const query of ['', '?arch=arm64&arch=x64', '?arch=../../secret', '?arch=arm64&extra=1'])
        assert.equal((await route.GET(request(query))).status, 400);
    assert.equal((await route.GET(request('?arch=arm64'))).status, 503); assert.equal(reads, 0);
    release = { filename: 'chrome-mac-arm64-1.2.3.zip', sha256: 'a'.repeat(64) };
    globals.process.env.X_NOTIFICATION_CHROME_MAC_ENABLED = '0'; assert.equal((await route.GET(request('?arch=arm64'))).status, 503);
    globals.process.env.X_NOTIFICATION_CHROME_MAC_ENABLED = '1'; globals.process.env.X_NOTIFICATION_CHROME_ENABLED = '0';
    assert.equal((await route.GET(request('?arch=arm64'))).status, 503); assert.equal(reads, 0);
    globals.process.env.X_NOTIFICATION_CHROME_ENABLED = '1';
    status = { chromeEnabled: false, receiverEnabled: true, chromeMacDownloads: { arm64: false, x64: false },
        rollout: { mode: 'supporters', eligible: false, reasonCode: 'X_ROLLOUT_SUPPORTERS_ONLY' } };
    assert.equal((await route.GET(request('?arch=arm64'))).status, 403); assert.equal(reads, 0);
    status = { chromeEnabled: true, receiverEnabled: false, chromeMacDownloads: { arm64: true, x64: false },
        rollout: { mode: 'public', eligible: true, reasonCode: null } };
    assert.equal((await route.GET(request('?arch=arm64'))).status, 503); assert.equal(reads, 0);
    status = { chromeEnabled: true, receiverEnabled: true, chromeMacDownloads: { arm64: false, x64: true },
        rollout: { mode: 'public', eligible: true, reasonCode: null } };
    assert.equal((await route.GET(request('?arch=arm64'))).status, 503); assert.equal(reads, 0);
    status = { chromeEnabled: true, receiverEnabled: true, chromeMacDownloads: { arm64: true, x64: false },
        rollout: { mode: 'disabled', eligible: false, reasonCode: 'X_ROLLOUT_DISABLED' } };
    assert.equal((await route.GET(request('?arch=arm64'))).status, 503); assert.equal(reads, 0);
    status = { chromeEnabled: true, receiverEnabled: true, chromeMacDownloads: { arm64: true, x64: false },
        rollout: { mode: 'supporters', eligible: true, reasonCode: null } };
    const result = await route.GET(request('?arch=arm64'));
    assert.equal(result.status, 200); assert.equal(reads, 1); assert.equal(actor.userId, '123456789');
    assert.equal(result.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.equal(result.headers.get('x-checksum-sha256'), release.sha256);
});

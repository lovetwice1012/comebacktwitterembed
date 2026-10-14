'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const { unzipSync } = require('fflate');
const { buildArchive, FILES } = require('../build-angelic-setup-package.cjs');

const ROOT = path.resolve(__dirname, '../..');
const PIN = Object.freeze({ version: '0.1.0-preview.4', filename: 'x-notification-setup-0.1.0-preview.4.zip',
    sha256: 'c41a47ecb694cc8afe19ccfab3420d492a5a327b8264cb84b46da9ab1d7325db', bytes: 68653,
    href: '/api/automation/x-setup/download' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function loadTs(filename, dependencies, globals = {}) {
    const source = syncFs.readFileSync(path.join(ROOT, filename), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const exports = {};
    vm.runInNewContext(compiled, { exports, Buffer, Uint8Array, Response, ...globals, require(id) {
        assert.ok(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`);
        return dependencies[id];
    } });
    return exports;
}

function helperWith(build) {
    return loadTs('dashboard/lib/x-setup-download.ts', {
        'server-only': {}, 'node:crypto': { createHash },
        '@/lib/bot-require': { requireBotModule(relativePath) {
            assert.equal(relativePath, 'scripts/build-angelic-setup-package.cjs');
            return { buildArchive: async (...args) => { assert.equal(args.length, 0); return build(); } };
        } },
    });
}

class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
function routeWith({ authError, archive, downloadError } = {}) {
    let authenticated = false, downloads = 0;
    const route = loadTs('dashboard/app/api/automation/x-setup/download/route.ts', {
        '@/lib/api': { ApiError, requireSession: async () => {
            if (authError) throw authError;
            authenticated = true;
            return { user: { id: '123456789012345678' }, accessToken: 'PRIVATE_SESSION' };
        }, json: (body, status) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }) },
        '@/lib/x-setup-download': { X_SETUP_DOWNLOAD: PIN, readXSetupDownload: async (...args) => {
            assert.equal(authenticated, true, 'archive access must happen after authentication');
            assert.equal(args.length, 0, 'request path/body must never select package input');
            downloads++;
            if (downloadError) throw downloadError;
            return archive;
        } },
    });
    return { route, downloads: () => downloads };
}

function assertPrivate(response) {
    assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.equal(response.headers.get('pragma'), 'no-cache');
    assert.equal(response.headers.get('expires'), '0');
    assert.equal(response.headers.get('vary'), 'Cookie');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-x-download-test-'));
    const source = path.join(directory, 'source');
    await fs.mkdir(source);
    for (const name of FILES) await fs.copyFile(path.join(ROOT, 'client/angelic-setup', name), path.join(source, name));
    t.after(async () => {
        assert.equal(path.dirname(directory).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
        assert.match(path.basename(directory), /^cbte-x-download-test-/);
        await fs.rm(directory, { recursive: true, force: true });
    });
    return { directory, source };
}

test('download builder reconstructs the exact pinned release from nine source files without a prebuilt artifact', async t => {
    const { directory, source } = await fixture(t);
    await fs.writeFile(path.join(source, '.env'), 'PRIVATE_ENV_MUST_NOT_PACKAGE');
    await fs.writeFile(path.join(source, 'push_keys.json'), 'PRIVATE_KEYS_MUST_NOT_PACKAGE');
    await fs.mkdir(path.join(source, 'firefox-profile'));
    await fs.writeFile(path.join(source, 'firefox-profile', 'cookies.sqlite'), 'PRIVATE_COOKIES_MUST_NOT_PACKAGE');
    const result = await buildArchive({ source });
    assert.equal(result.sha256, PIN.sha256);
    assert.equal(result.bytes, PIN.bytes);
    assert.equal(result.version, PIN.version);
    const archive = await helperWith(() => result).readXSetupDownload();
    assert.equal(hash(archive), PIN.sha256);
    const entries = unzipSync(archive);
    assert.deepEqual(Object.keys(entries).sort(), [...FILES, 'package-manifest.json'].sort());
    for (const marker of ['PRIVATE_ENV_MUST_NOT_PACKAGE', 'PRIVATE_KEYS_MUST_NOT_PACKAGE', 'PRIVATE_COOKIES_MUST_NOT_PACKAGE']) {
        assert.equal(Object.values(entries).some(bytes => Buffer.from(bytes).includes(marker)), false);
    }
    const manifest = JSON.parse(Buffer.from(entries['package-manifest.json']).toString('utf8'));
    assert.equal(manifest.packageId, 'x-notification-setup');
    assert.equal(manifest.version, PIN.version);
    assert.equal(manifest.capabilities.serverTransfer, false);
    for (const name of FILES) assert.equal(manifest.files[name], hash(entries[name]));
    assert.deepEqual((await fs.readdir(directory)).sort(), ['source'], 'in-memory distribution must write no files');
});

test('source edits, missing input, oversized input and changed ZIP/version cannot replace the pinned release', async t => {
    const { source } = await fixture(t);
    const original = await fs.readFile(path.join(source, 'README-ja.md'));
    await fs.appendFile(path.join(source, 'README-ja.md'), '\nchanged release');
    const changed = await buildArchive({ source });
    await assert.rejects(helperWith(() => changed).readXSetupDownload(), /X_SETUP_RELEASE_UNAVAILABLE/);
    await fs.writeFile(path.join(source, 'README-ja.md'), original);
    const valid = await buildArchive({ source });
    const sameLengthChanged = Buffer.from(valid.archive); sameLengthChanged[100] ^= 1;
    for (const result of [
        { ...valid, archive: sameLengthChanged },
        { ...valid, archive: valid.archive.subarray(0, -1) },
        { ...valid, version: 'unreleased-version' },
        { ...valid, archive: 'untrusted bytes' },
    ]) await assert.rejects(helperWith(() => result).readXSetupDownload(), /X_SETUP_RELEASE_UNAVAILABLE/);
    await fs.writeFile(path.join(source, 'README-ja.md'), Buffer.alloc(1024 * 1024 + 1));
    await assert.rejects(buildArchive({ source }), /invalid size/);
    await fs.unlink(path.join(source, 'README-ja.md'));
    await assert.rejects(helperWith(() => buildArchive({ source })).readXSetupDownload());
});

test('simultaneous downloads share bounded work, later downloads revalidate and failures recover', async () => {
    const valid = await buildArchive();
    let finish;
    const gate = new Promise(resolve => { finish = resolve; });
    let builds = 0, fail = false;
    const helper = helperWith(async () => {
        builds++;
        await gate;
        if (fail) throw new Error('PRIVATE_INPUT_FAILURE');
        return valid;
    });
    const burst = Array.from({ length: 30 }, () => helper.readXSetupDownload());
    assert.equal(builds, 1);
    finish();
    const archives = await Promise.all(burst);
    assert.equal(builds, 1);
    assert.ok(archives.every(archive => archive === archives[0]));
    fail = true;
    await assert.rejects(helper.readXSetupDownload(), /PRIVATE_INPUT_FAILURE/);
    assert.equal(builds, 2, 'finished work must not become a permanent source cache');
    fail = false;
    assert.equal(hash(await helper.readXSetupDownload()), PIN.sha256);
    assert.equal(builds, 3, 'a temporary source failure must not poison future downloads');
});

test('linked source directories and linked allowlisted files are refused without packaging private targets', async t => {
    const { directory, source } = await fixture(t);
    const linkedSource = path.join(directory, 'linked-source');
    await fs.symlink(source, linkedSource, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(buildArchive({ source: linkedSource }), /links and junctions/);
    await fs.unlink(path.join(source, 'README-ja.md'));
    const privateDirectory = path.join(directory, 'private');
    await fs.mkdir(privateDirectory);
    await fs.writeFile(path.join(privateDirectory, 'secret.txt'), 'PRIVATE_MUST_NOT_READ');
    await fs.symlink(privateDirectory, path.join(source, 'README-ja.md'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(buildArchive({ source }), /links and junctions/);
    assert.equal(await fs.readFile(path.join(privateDirectory, 'secret.txt'), 'utf8'), 'PRIVATE_MUST_NOT_READ');
});

test('unauthenticated and failed sessions cannot access archive inputs or disclose session errors', async () => {
    for (const [authError, status] of [
        [new ApiError(401, 'SECRET_SESSION /private/session'), 401],
        [new Error('SECRET_DB_PASSWORD /private/config.json'), 503],
    ]) {
        const { route, downloads } = routeWith({ authError });
        const response = await route.GET();
        assert.equal(response.status, status);
        assert.equal(downloads(), 0);
        assertPrivate(response);
        const body = await response.text();
        assert.equal(body.includes('SECRET'), false);
        assert.equal(body.includes('/private'), false);
        assert.match(body, /ログイン/);
    }
});

test('authenticated ZIP response has exact bytes, safe filename and private attachment headers', async () => {
    const { archive } = await buildArchive();
    const { route, downloads } = routeWith({ archive });
    // Extra request data cannot choose paths, files, versions or receive data.
    const response = await route.GET({ url: 'https://example.test/api/automation/x-setup/download?path=../../config.json&version=evil',
        body: new Proxy({}, { get() { throw new Error('Request body must not be read'); } }) });
    assert.equal(response.status, 200);
    assert.equal(downloads(), 1);
    assertPrivate(response);
    assert.equal(route.runtime, 'nodejs');
    assert.equal(route.dynamic, 'force-dynamic');
    assert.equal(route.POST, undefined);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.equal(response.headers.get('content-length'), String(PIN.bytes));
    assert.equal(response.headers.get('x-checksum-sha256'), PIN.sha256);
    assert.equal(response.headers.get('content-disposition'), `attachment; filename="${PIN.filename}"; filename*=UTF-8''${PIN.filename}`);
    assert.equal(hash(new Uint8Array(await response.arrayBuffer())), PIN.sha256);
});

test('unavailable or mismatched release returns an understandable private 503 without raw errors', async () => {
    const { route } = routeWith({ downloadError: new Error('SECRET_KEY /srv/private/config.json') });
    const response = await route.GET();
    assert.equal(response.status, 503);
    assertPrivate(response);
    assert.equal(response.headers.has('content-disposition'), false);
    const body = await response.text();
    assert.match(body, /X通知.*現在提供できません/);
    assert.equal(body.includes('SECRET'), false);
    assert.equal(body.includes('/srv'), false);
});

test('Next file tracing and Git attributes retain exact release inputs without tracing private folders', () => {
    const config = loadTs('dashboard/next.config.ts', { 'node:path': path }, { process: { cwd: () => path.join(ROOT, 'dashboard'), env: {} } }).default;
    const traced = config.outputFileTracingIncludes['/api/automation/x-setup/download'];
    for (const name of FILES) assert.ok(traced.includes(`../client/angelic-setup/${name}`));
    assert.ok(traced.includes('../scripts/build-angelic-setup-package.cjs'));
    assert.ok(traced.includes('../src/providers/_loader.js'));
    assert.ok(traced.includes('../node_modules/fflate/package.json'));
    assert.ok(traced.includes('../node_modules/fflate/lib/node.cjs'));
    assert.ok(traced.every(name => !name.includes('*') && !name.includes('.env') && !name.includes('profile') && !name.includes('push_keys')));
    const attributes = syncFs.readFileSync(path.join(ROOT, 'client/angelic-setup/.gitattributes'), 'utf8');
    for (const name of FILES) assert.ok(attributes.split(/\r?\n/).includes(`${name} -text`));
});

test('copied standalone trace layout resolves the fixed builder and reproduces the release without artifact files', async t => {
    const { directory } = await fixture(t);
    const standalone = path.join(directory, 'standalone'), dashboard = path.join(standalone, 'dashboard');
    await fs.mkdir(dashboard, { recursive: true });
    const config = loadTs('dashboard/next.config.ts', { 'node:path': path }, { process: { cwd: () => path.join(ROOT, 'dashboard'), env: {} } }).default;
    const traced = config.outputFileTracingIncludes['/api/automation/x-setup/download'];
    for (const relative of traced) {
        const original = path.resolve(ROOT, 'dashboard', relative), destination = path.resolve(dashboard, relative);
        assert.ok(destination.startsWith(`${standalone}${path.sep}`));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(original, destination);
    }
    const env = loadTs('dashboard/lib/env.ts', { 'server-only': {}, 'node:fs': syncFs, 'node:path': path },
        { process: { cwd: () => dashboard, env: {} } });
    assert.equal(env.repoRoot(), standalone);
    const builderPath = path.join(standalone, 'scripts/build-angelic-setup-package.cjs');
    const botRequire = loadTs('dashboard/lib/bot-require.ts', {
        'server-only': {}, 'node:path': path, '@/lib/env': env, [builderPath]: require(builderPath),
    });
    const helper = loadTs('dashboard/lib/x-setup-download.ts', {
        'server-only': {}, 'node:crypto': { createHash }, '@/lib/bot-require': botRequire,
    });
    const archive = await helper.readXSetupDownload();
    assert.equal(hash(archive), PIN.sha256);
    assert.equal(archive.byteLength, PIN.bytes);
    await assert.rejects(fs.stat(path.join(standalone, 'artifacts')), { code: 'ENOENT' });
    // Leave the shared require cache clean before fixture cleanup on Windows.
    for (const filename of Object.keys(require.cache)) if (filename.startsWith(`${standalone}${path.sep}`)) delete require.cache[filename];
});

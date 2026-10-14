'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { NODE_VERSION, NODE_EXE_SHA256, NODE_ZIP_SHA256, RELEASE_DIRECTORY, resolveProjectNode, runProjectNode } = require('../run-project-node.cjs');

const root = path.resolve(__dirname, '../..');
const installer = path.join(root, 'scripts/setup-project-node.ps1');
const code = value => error => error.code === value;
function removeOwnedFixture(directory) {
    const resolved = path.resolve(directory), temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
    assert(resolved.startsWith(temporaryRoot) && /^cbte-project-node-test-[^\\/]+$/.test(path.basename(resolved)));
    fs.rmSync(resolved, { recursive: true, force: true });
}
function syntheticWindowsFileSystem({ missing = false, linked = false, directory = false } = {}) {
    const visited = [], reads = [];
    return { visited, reads, lstatSync(candidate) {
        visited.push(candidate);
        if (missing) throw Object.assign(new Error('SYNTHETIC missing'), { code: 'ENOENT' });
        const executable = candidate.endsWith('node.exe');
        return { isSymbolicLink: () => linked, isFile: () => executable && !directory, isDirectory: () => !executable || directory };
    }, readFileSync(candidate) { reads.push(candidate); return Buffer.from('UNVERIFIED-EXECUTABLE'); } };
}

test('non-Windows uses the running Node without probing or changing a Windows cache', () => {
    const executable = resolveProjectNode({ platform: 'linux', execPath: '/owned/current/node',
        fileSystem: { lstatSync() { assert.fail('Windows filesystem must not be accessed'); } } });
    assert.equal(executable, '/owned/current/node');
});

test('Windows rejects a missing cache and gives setup instructions without downloading or searching PATH', () => {
    const fileSystem = syntheticWindowsFileSystem({ missing: true });
    assert.throws(() => resolveProjectNode({ platform: 'win32', version: '24.15.0', execPath: 'C:\\old\\node.exe',
        localAppData: 'C:\\Users\\synthetic\\AppData\\Local', fileSystem }), error => {
        assert.equal(error.code, 'PROJECT_NODE_MISSING'); assert.match(error.message, /setup-project-node\.ps1/); return true;
    });
    assert.equal(fileSystem.reads.length, 0);
    assert(!fileSystem.visited.some(candidate => candidate.includes('old')));
});

test('Windows resolves only the fixed version/cache path and refuses mismatched executable bytes', () => {
    const fileSystem = syntheticWindowsFileSystem();
    assert.throws(() => resolveProjectNode({ platform: 'win32', version: '24.15.0', execPath: 'C:\\old\\node.exe',
        localAppData: 'C:\\Users\\synthetic\\AppData\\Local', fileSystem }), code('PROJECT_NODE_HASH_MISMATCH'));
    assert.deepEqual(fileSystem.reads, [path.win32.join('C:\\Users\\synthetic\\AppData\\Local', 'cbte-runtimes', RELEASE_DIRECTORY, RELEASE_DIRECTORY, 'node.exe')]);
});

test('matching version does not bypass hash verification or fall back from an unverified running executable', () => {
    const fileSystem = syntheticWindowsFileSystem();
    assert.throws(() => resolveProjectNode({ platform: 'win32', version: NODE_VERSION, execPath: 'C:\\unverified\\node.exe',
        localAppData: 'C:\\other-cache', fileSystem }), code('PROJECT_NODE_HASH_MISMATCH'));
    assert.deepEqual(fileSystem.reads, ['C:\\unverified\\node.exe']);
});

test('Windows rejects relative/network/traversal paths, junctions and executable directories before reading bytes', () => {
    for (const localAppData of ['', '..\\outside', '\\\\server\\share', 'C:\\cache\\..\\escape', 'C:\\cache:stream']) {
        assert.throws(() => resolveProjectNode({ platform: 'win32', version: '24.15.0', localAppData }), code('PROJECT_NODE_PATH_INVALID'));
    }
    for (const scenario of [{ linked: true }, { directory: true }]) {
        const fileSystem = syntheticWindowsFileSystem(scenario);
        assert.throws(() => resolveProjectNode({ platform: 'win32', version: '24.15.0', localAppData: 'C:\\local', fileSystem }), code('PROJECT_NODE_PATH_INVALID'));
        assert.equal(fileSystem.reads.length, 0);
    }
});

test('launcher preserves arguments, cwd, environment and nonzero child exit without adding runtime flags', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cbte-project-node-test-'));
    t.after(() => removeOwnedFixture(directory));
    const resultFile = path.join(directory, 'observed.json');
    const args = ['-e', "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),value:process.env.PROJECT_RUNTIME_TEST,execArgv:process.execArgv}));process.exit(23)",
        resultFile, 'space value', '$literal & value', '--not-a-node-switch'];
    const result = await runProjectNode(args, { platform: 'linux', execPath: process.execPath, cwd: directory,
        env: { ...process.env, PROJECT_RUNTIME_TEST: 'synthetic-env-value' } });
    assert.deepEqual(result, { exitCode: 23, signal: null });
    const observed = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    assert.deepEqual(observed.args, args.slice(3)); assert.equal(observed.cwd, directory); assert.equal(observed.value, 'synthetic-env-value');
    assert.deepEqual(observed.execArgv, args.slice(0, 2));
    assert(!observed.execArgv.some(arg => /jitless|no-opt|no-turbo|no-maglev/.test(arg)));
});

test('launcher forwards signals, removes listeners and makes only one spawn attempt on failure', async () => {
    const parent = new EventEmitter(), child = new EventEmitter(), forwarded = [];
    child.kill = signal => { forwarded.push(signal); return true; };
    let spawns = 0;
    const running = runProjectNode(['script.js'], { platform: 'linux', execPath: '/owned/node', parent, spawn: (executable, args, options) => {
        spawns++; assert.equal(executable, '/owned/node'); assert.deepEqual(args, ['script.js']); assert.equal(options.stdio, 'inherit'); return child;
    } });
    parent.emit('SIGTERM'); assert.deepEqual(forwarded, ['SIGTERM']); child.emit('exit', null, 'SIGTERM');
    assert.deepEqual(await running, { exitCode: null, signal: 'SIGTERM' });
    assert.equal(parent.listenerCount('SIGTERM'), 0); assert.equal(spawns, 1);
    const failedChild = new EventEmitter();
    const failed = runProjectNode(['script.js'], { platform: 'linux', execPath: '/owned/node', parent, spawn: () => { spawns++; return failedChild; } });
    failedChild.emit('error', new Error('SYNTHETIC private exception'));
    await assert.rejects(failed, error => error.code === 'PROJECT_NODE_START_FAILED' && !error.message.includes('private'));
    assert.equal(spawns, 2); assert.equal(parent.listenerCount('SIGINT'), 0);
});

test('Windows verifies the installed official runtime before using it', () => {
    if (process.platform !== 'win32') return;
    // Windows acceptance runs through the setup-provided runtime. This checks
    // actual executable bytes rather than teaching a fake hasher the answer.
    const executable = resolveProjectNode();
    assert.equal(spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout.trim(), `v${NODE_VERSION}`);
});

if (process.platform === 'win32') {
    const engines = [path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe')].filter(executable => fs.existsSync(executable));
    const literal = value => "'" + value.replaceAll("'", "''") + "'";
    async function fixture(t) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cbte-project-node-test-'));
        t.after(() => removeOwnedFixture(directory));
        const release = path.join(directory, 'cbte-runtimes', RELEASE_DIRECTORY), executable = path.join(release, RELEASE_DIRECTORY, 'node.exe');
        return { directory, release, executable };
    }
    function invoke(engine, directory, source) {
        const script = path.join(directory, 'verify-installer.ps1');
        fs.writeFileSync(script, '\ufeff' + source);
        return spawnSync(engine, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
            encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, LOCALAPPDATA: directory },
        });
    }
    for (const engine of engines) {
        test(`${path.basename(engine)}: installer parses and shares exact official pins with launcher`, () => {
            const source = fs.readFileSync(installer, 'utf8');
            assert(source.includes(NODE_EXE_SHA256)); assert(source.includes(NODE_ZIP_SHA256));
            const result = spawnSync(engine, ['-NoProfile', '-NonInteractive', '-Command', `$tokens=$null;$errors=$null;$null=[Management.Automation.Language.Parser]::ParseFile(${literal(installer)},[ref]$tokens,[ref]$errors);if($errors.Count){exit 9}`], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
            assert.equal(result.status, 0, result.stderr);
        });
        test(`${path.basename(engine)}: installer refuses existing unverified files without overwrite or download`, async t => {
            const { directory, executable } = await fixture(t);
            fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.writeFileSync(executable, 'KEEP-UNVERIFIED-EXISTING');
            const result = invoke(engine, directory, `function Invoke-WebRequest { throw 'NETWORK-MUST-NOT-RUN' }\n& ${literal(installer)}\nexit $LASTEXITCODE`);
            assert.equal(result.status, 1); assert(!result.stderr.includes('NETWORK-MUST-NOT-RUN'));
            assert.match(result.stderr, /SHA-256/);
            assert.equal(fs.readFileSync(executable, 'utf8'), 'KEEP-UNVERIFIED-EXISTING');
        });
        test(`${path.basename(engine)}: invalid downloaded ZIP is never expanded and only owned temporary data is removed`, async t => {
            const { directory, release } = await fixture(t);
            const result = invoke(engine, directory, `function Invoke-WebRequest { param($Uri,$OutFile,[switch]$UseBasicParsing,$MaximumRedirection) [IO.File]::WriteAllText($OutFile,'SYNTHETIC-TAMPERED-ZIP') }\nfunction Expand-Archive { throw 'EXPANSION-MUST-NOT-RUN' }\n& ${literal(installer)}\nexit $LASTEXITCODE`);
            assert.equal(result.status, 1); assert(!result.stderr.includes('EXPANSION-MUST-NOT-RUN')); assert(!fs.existsSync(release));
            assert.match(result.stderr, /SHA-256/);
            assert.deepEqual(fs.readdirSync(path.join(directory, 'cbte-runtimes')), []);
        });
        test(`${path.basename(engine)}: cache junction cannot redirect installation into another directory`, async t => {
            const { directory } = await fixture(t);
            const outside = path.join(directory, 'unrelated-directory');
            fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'sentinel'), 'KEEP-UNRELATED-DATA');
            fs.symlinkSync(outside, path.join(directory, 'cbte-runtimes'), 'junction');
            const result = invoke(engine, directory, `function Invoke-WebRequest { throw 'NETWORK-MUST-NOT-RUN' }\n& ${literal(installer)}\nexit $LASTEXITCODE`);
            assert.equal(result.status, 1); assert(!result.stderr.includes('NETWORK-MUST-NOT-RUN'));
            assert.deepEqual(fs.readdirSync(outside), ['sentinel']); assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'KEEP-UNRELATED-DATA');
        });
        test(`${path.basename(engine)}: valid cached runtime is checked without download or global environment mutation`, async t => {
            const { directory, executable } = await fixture(t);
            fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.copyFileSync(resolveProjectNode(), executable);
            const result = invoke(engine, directory, `function Invoke-WebRequest { throw 'NETWORK-MUST-NOT-RUN' }\n& ${literal(installer)}\nif($LASTEXITCODE -and $LASTEXITCODE -ne 0){exit $LASTEXITCODE}`);
            assert.equal(result.status, 0, result.stderr);
            const observed = JSON.parse(result.stdout); assert.equal(observed.executable, executable); assert.equal(observed.globalNodeChanged, false);
            assert.equal(observed.sha256, NODE_EXE_SHA256);
        });
        test(`${path.basename(engine)}: valid hash cannot bypass missing OpenJS signature verification`, async t => {
            const { directory, executable } = await fixture(t);
            fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.copyFileSync(resolveProjectNode(), executable);
            const result = invoke(engine, directory, `function Invoke-WebRequest { throw 'NETWORK-MUST-NOT-RUN' }\nfunction Get-AuthenticodeSignature { [pscustomobject]@{Status=[Management.Automation.SignatureStatus]::NotSigned;SignerCertificate=$null} }\n& ${literal(installer)}\nexit $LASTEXITCODE`);
            assert.equal(result.status, 1); assert.match(result.stderr, /OpenJS Foundation/); assert(!result.stderr.includes('NETWORK-MUST-NOT-RUN'));
            assert(fs.existsSync(executable), 'Signature failure must not delete an existing cached file');
        });
    }
}

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { handoffWindowsNode, FAILURE_MESSAGE } = require('../windows-node-bootstrap.cjs');
const { assertSupportedRuntime, BUN_RUNTIME_DISABLED_MESSAGE } = require('../../src/runtime');

const indexPath = path.resolve(__dirname, '../../index.js');
const indexSource = fs.readFileSync(indexPath, 'utf8');
const pinned = 'C:\\Users\\synthetic\\AppData\\Local\\cbte-runtimes\\node-v24.21.0-win-x64\\node-v24.21.0-win-x64\\node.exe';
const boundary = new Error('SYNTHETIC_APPLICATION_BOUNDARY');

function fakeProcess(changes = {}) {
    const kills = [];
    return Object.assign(new EventEmitter(), {
        platform: 'win32', versions: { node: '24.15.0' }, execPath: 'C:\\old-node\\node.exe',
        execArgv: ['--stack-trace-limit=20'], argv: ['C:\\old-node\\node.exe', indexPath, '--literal', 'space & $value'],
        env: { LOCALAPPDATA: 'C:\\Users\\synthetic\\AppData\\Local', SYNTHETIC_BOOT_TEST: 'kept' },
        cwd: () => 'C:\\synthetic working directory', pid: 723,
        kill: (pid, signal) => { kills.push({ pid, signal }); return true; }, kills,
    }, changes);
}

function evaluate({ current = fakeProcess(), runtime, bunGuard = false,
    inspector = { url: () => undefined, close: () => assert.fail('Inactive inspector must not be closed') } } = {}) {
    const loads = [], errors = [], calls = [], installed = [];
    const implementation = runtime ?? {
        resolveProjectNode: () => pinned,
        runProjectNode: async (args, options) => { calls.push({ args, options }); return { exitCode: 0, signal: null }; },
    };
    const context = { process: current, __filename: indexPath, console: { error: message => errors.push(message) },
        require(name) {
            loads.push(name);
            if (name === './scripts/windows-node-bootstrap.cjs') return { handoffWindowsNode: entry => handoffWindowsNode(entry, {
                process: current, runtime: implementation, console: { error: message => errors.push(message) },
                inspector,
            }) };
            if (name === 'node:path') return path;
            if (name === './src/recoveryLease') {
                if (!bunGuard) throw boundary;
                return { install: () => installed.push(true) };
            }
            if (name === './src/runtime') return { assertSupportedRuntime: () => assertSupportedRuntime(current.versions, current.platform) };
            if (name === './src/discordTransport') return { loadDiscordRuntime: () => assert.fail('Bun must not load Discord') };
            assert.fail('Unexpected application dependency: ' + name);
        },
    };
    return { current, loads, errors, calls, installed, run: () => vm.runInNewContext(indexSource, context, { filename: indexPath }) };
}

test('actual npm-start entry hands off affected Windows Node before recovery/config/Discord/DB loads', async () => {
    const fixture = evaluate(); fixture.run();
    assert.deepEqual(fixture.loads, ['./scripts/windows-node-bootstrap.cjs']);
    await nextTurn();
    assert.equal(fixture.calls.length, 1);
    assert.deepEqual(fixture.calls[0].args, ['--stack-trace-limit=20', indexPath, '--literal', 'space & $value']);
    assert.equal(fixture.calls[0].options.env, fixture.current.env);
    assert.equal(fixture.calls[0].options.cwd, fixture.current.cwd());
    assert.equal(fixture.calls[0].options.parent, fixture.current);
    assert.equal(fixture.current.exitCode, 0); assert.deepEqual(fixture.errors, []);
});

test('verified pinned Windows child proceeds in the same entry without recursively spawning another child', () => {
    let verifications = 0;
    const fixture = evaluate({ current: fakeProcess({ versions: { node: '24.21.0' }, execPath: pinned.toUpperCase() }), runtime: {
        resolveProjectNode: () => { verifications++; return pinned; },
        runProjectNode: () => assert.fail('The pinned child must not hand off again'),
    } });
    assert.throws(fixture.run, error => error === boundary);
    assert.equal(verifications, 1);
    assert.deepEqual(fixture.loads, ['./scripts/windows-node-bootstrap.cjs', 'node:path', './src/recoveryLease']);
});

test('Linux and macOS preserve synchronous application startup without loading Windows helper or resolver', () => {
    for (const platform of ['linux', 'darwin']) {
        const fixture = evaluate({ current: fakeProcess({ platform }), runtime: {
            resolveProjectNode: () => assert.fail('Non-Windows must not inspect runtime cache'),
            runProjectNode: () => assert.fail('Non-Windows must not spawn a wrapper process'),
        } });
        assert.throws(fixture.run, error => error === boundary);
        assert.deepEqual(fixture.loads, ['node:path', './src/recoveryLease']);
    }
});

test('Windows Bun retains the original explicit rejection and cannot bypass it by handing off to Node', () => {
    const fixture = evaluate({ current: fakeProcess({ versions: { node: '24.15.0', bun: '1.3.14' } }), bunGuard: true });
    assert.throws(fixture.run, error => error.message === BUN_RUNTIME_DISABLED_MESSAGE);
    assert.equal(fixture.installed.length, 1);
    assert(!fixture.loads.includes('./scripts/windows-node-bootstrap.cjs'));
    assert(!fixture.loads.includes('./config.json'));
});

test('missing or tampered pinned runtime fails safely before application resources or child creation', async () => {
    for (const code of ['PROJECT_NODE_MISSING', 'PROJECT_NODE_HASH_MISMATCH']) {
        const fixture = evaluate({ runtime: {
            resolveProjectNode: () => { throw Object.assign(new Error('PRIVATE-FILE-CONTENTS'), { code }); },
            runProjectNode: () => assert.fail('An unverified runtime must never execute'),
        } });
        fixture.run(); await nextTurn();
        assert.deepEqual(fixture.loads, ['./scripts/windows-node-bootstrap.cjs']);
        assert.equal(fixture.current.exitCode, 1); assert.deepEqual(fixture.errors, [FAILURE_MESSAGE]);
        assert(!fixture.errors[0].includes('PRIVATE-FILE-CONTENTS'));
    }
});

test('handoff preserves nonzero child exit and never retries a rejected child launch', async () => {
    const result = evaluate({ runtime: { resolveProjectNode: () => pinned, runProjectNode: async () => ({ exitCode: 23, signal: null }) } });
    result.run(); await nextTurn(); assert.equal(result.current.exitCode, 23); assert.deepEqual(result.errors, []);
    let spawns = 0;
    const rejected = evaluate({ runtime: { resolveProjectNode: () => pinned,
        runProjectNode: () => { spawns++; return Promise.reject(new Error('PRIVATE-CHILD-EXCEPTION')); },
    } });
    rejected.run(); await nextTurn();
    assert.equal(spawns, 1); assert.equal(rejected.current.exitCode, 1); assert.deepEqual(rejected.errors, [FAILURE_MESSAGE]);
});

test('unavailable working directory is a safe bootstrap failure before application imports', () => {
    const fixture = evaluate({ current: fakeProcess({ cwd() { throw new Error('PRIVATE-DELETED-WORKING-DIRECTORY'); } }) });
    fixture.run(); assert.equal(fixture.current.exitCode, 1);
    assert.deepEqual(fixture.loads, ['./scripts/windows-node-bootstrap.cjs']);
    assert.deepEqual(fixture.errors, [FAILURE_MESSAGE]); assert.equal(fixture.calls.length, 0);
});

test('handoff propagates child termination signal to its own parent PID and handles unsupported signals safely', async () => {
    const fixture = evaluate({ runtime: { resolveProjectNode: () => pinned, runProjectNode: async () => ({ exitCode: null, signal: 'SIGTERM' }) } });
    fixture.run(); await nextTurn(); assert.deepEqual(fixture.current.kills, [{ pid: 723, signal: 'SIGTERM' }]);
    const unsupported = evaluate({ current: fakeProcess({ kill() { throw new Error('PRIVATE-OS-EXCEPTION'); } }),
        runtime: { resolveProjectNode: () => pinned, runProjectNode: async () => ({ exitCode: null, signal: 'SIGTERM' }) },
    });
    unsupported.run(); await nextTurn(); assert.equal(unsupported.current.exitCode, 1); assert.deepEqual(unsupported.errors, []);
});

test('active parent inspector closes after verification and before spawning with unchanged inspector flags/environment', async () => {
    const order = [];
    const current = fakeProcess({ execArgv: ['--inspect=127.0.0.1:9229', '--stack-trace-limit=20'] });
    current.env.NODE_OPTIONS = '--inspect=127.0.0.1:9229';
    const fixture = evaluate({ current, runtime: {
        resolveProjectNode: () => { order.push('verified'); return pinned; },
        runProjectNode: async (args, options) => {
            order.push('spawn'); assert.deepEqual(args.slice(0, 2), current.execArgv);
            assert.equal(options.env.NODE_OPTIONS, '--inspect=127.0.0.1:9229');
            return { exitCode: 0, signal: null };
        },
    }, inspector: { url: () => { order.push('inspector-url'); return 'ws://127.0.0.1:9229/synthetic'; },
        close: () => { order.push('inspector-close'); },
    } });
    fixture.run(); assert.deepEqual(order, ['verified', 'inspector-url', 'inspector-close']);
    await nextTurn(); assert.deepEqual(order, ['verified', 'inspector-url', 'inspector-close', 'spawn']);
    assert.deepEqual(fixture.errors, []);
});

test('inactive parent inspector is checked without closing it and the handoff proceeds', async () => {
    const order = [];
    const fixture = evaluate({ runtime: { resolveProjectNode: () => { order.push('verified'); return pinned; },
        runProjectNode: async () => { order.push('spawn'); return { exitCode: 0, signal: null }; },
    }, inspector: { url: () => { order.push('inactive'); return undefined; }, close: () => assert.fail('Inactive inspector was closed') } });
    fixture.run(); await nextTurn(); assert.deepEqual(order, ['verified', 'inactive', 'spawn']);
});

test('inspector failure stops before spawning or loading application resources', async () => {
    for (const operation of ['url', 'close']) {
        let spawns = 0;
        const fixture = evaluate({ runtime: { resolveProjectNode: () => pinned,
            runProjectNode: () => { spawns++; assert.fail('Failed inspector shutdown must prevent child startup'); },
        }, inspector: {
            url: () => { if (operation === 'url') throw new Error('PRIVATE-INSPECTOR-ERROR'); return 'ws://127.0.0.1:9229/synthetic'; },
            close: () => { throw new Error('PRIVATE-INSPECTOR-ERROR'); },
        } });
        fixture.run(); await nextTurn(); assert.equal(spawns, 0); assert.equal(fixture.current.exitCode, 1);
        assert.deepEqual(fixture.errors, [FAILURE_MESSAGE]); assert.deepEqual(fixture.loads, ['./scripts/windows-node-bootstrap.cjs']);
    }
});

test('Linux, Bun, failed verification and pinned same-process startup never access the inspector', () => {
    const cases = [
        { current: fakeProcess({ platform: 'linux' }), expected: false },
        { current: fakeProcess({ versions: { node: '24.15.0', bun: '1.3.14' } }), expected: false },
        { current: fakeProcess({ execPath: pinned, versions: { node: '24.21.0' } }), expected: false },
        { current: fakeProcess(), expected: true, failVerification: true },
    ];
    for (const scenario of cases) {
        const options = { process: scenario.current, console: { error() {} }, runtime: {
            resolveProjectNode: () => { if (scenario.failVerification) throw new Error('SYNTHETIC missing'); return pinned; },
            runProjectNode: () => assert.fail('No handoff should reach child creation'),
        } };
        Object.defineProperty(options, 'inspector', { get: () => assert.fail('Inspector must remain untouched') });
        assert.equal(handoffWindowsNode(indexPath, options), scenario.expected);
    }
});

for (const mode of ['execArgv', 'NODE_OPTIONS']) test(`real loopback inspector port is released for the child with ${mode} retained`, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cbte-node-inspector-test-'));
    t.after(() => {
        const resolved = path.resolve(directory);
        assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && /^cbte-node-inspector-test-[^\\/]+$/.test(path.basename(resolved)));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    const childPath = path.join(directory, 'synthetic-inspected-child.cjs');
    fs.writeFileSync(childPath, "const url=require('node:inspector').url();process.stdout.write(JSON.stringify({url,expectedPort:process.argv[2],flags:process.execArgv,nodeOptions:process.env.NODE_OPTIONS}));");
    const bootstrapPath = path.resolve(__dirname, '../windows-node-bootstrap.cjs');
    const runnerPath = path.resolve(__dirname, '../run-project-node.cjs');
    const program = `
const inspector=require('node:inspector');
const {EventEmitter}=require('node:events');
const {handoffWindowsNode}=require(${JSON.stringify(bootstrapPath)});
const {runProjectNode}=require(${JSON.stringify(runnerPath)});
inspector.open(0,'127.0.0.1',false);
const port=new URL(inspector.url()).port;
const flag='--inspect=127.0.0.1:'+port;
const current=Object.assign(new EventEmitter(),{
 platform:'win32',versions:{node:'24.15.0'},execPath:'C:\\\\synthetic-old\\\\node.exe',
 execArgv:${JSON.stringify(mode)}==='execArgv'?[flag]:[],
 argv:['synthetic-old',${JSON.stringify(childPath)},port],env:{...process.env},
 cwd:()=>process.cwd(),pid:process.pid,kill:(pid,signal)=>process.kill(pid,signal)
});
delete current.env.NODE_OPTIONS;
if(${JSON.stringify(mode)}==='NODE_OPTIONS')current.env.NODE_OPTIONS=flag;
Object.defineProperty(current,'exitCode',{set(value){process.exitCode=value;}});
handoffWindowsNode(${JSON.stringify(childPath)},{process:current,inspector,runtime:{
 resolveProjectNode:()=>process.execPath,
 runProjectNode:(args,options)=>runProjectNode(args,{...options,platform:'linux',execPath:process.execPath,parent:process})
}});
`;
    const result = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /address already in use|Starting inspector.*failed/i);
    const observed = JSON.parse(result.stdout);
    assert.equal(new URL(observed.url).port, observed.expectedPort);
    const expected = '--inspect=127.0.0.1:' + observed.expectedPort;
    if (mode === 'execArgv') assert.deepEqual(observed.flags, [expected]);
    else assert.equal(observed.nodeOptions, expected);
});

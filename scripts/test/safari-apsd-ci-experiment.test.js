'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createExecutor, disabledState, serviceState, syntheticChildEnvironment, runExperiment } = require('../native-test/safari-apsd-ci-experiment.cjs');

const validEnv = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', CBTE_SAFARI_APSD_EXPERIMENT: '1', RUNNER_TEMP: '/tmp/runner' };
const source = fs.readFileSync(path.join(__dirname, '../native-test/safari-apsd-ci-experiment.cjs'), 'utf8');
function fixture({ testStatus = 0, failEnable = false, bootstrapStatus = 0, processStatus = 1, finalProcessStatus = processStatus,
    initialLoaded = false, bootoutFails = false, bootoutAbsent = false, unknownService = false, unknownAfterBootout = false,
    platform = 'darwin', env = validEnv } = {}) {
    let disabled = true, loaded = initialLoaded, processChecks = 0, afterBootout = false, childOptions; const calls = [], reports = [];
    const fakeNode = '/fixture/node';
    const execute = (file, args, options) => {
        calls.push([file, ...args]);
        if (file === fakeNode) { childOptions = options; return { status: testStatus }; }
        if (args.includes('/usr/bin/pgrep')) return { status: processChecks++ === 0 ? processStatus : finalProcessStatus };
        if (args.includes('print-disabled')) return { status: 0, stdout: `"com.apple.apsd" => ${disabled ? 'disabled' : 'enabled'}\n` };
        if (args.includes('print')) return loaded ? { status: 0 } : unknownService || afterBootout && unknownAfterBootout ? { status: 1, stderr: 'private permission error' }
            : { status: 113, stderr: 'Bad request.\nCould not find service "com.apple.apsd" in domain for system\n' };
        if (args.includes('enable')) { disabled = false; return { status: failEnable ? 1 : 0 }; }
        if (args.includes('bootstrap')) { loaded = bootstrapStatus === 0; return { status: bootstrapStatus }; }
        if (args.includes('kickstart')) return { status: 0 };
        if (args.includes('bootout')) { afterBootout = true; if (bootoutFails) return { status: null, error: new Error('timeout') };
            loaded = false; return { status: bootoutAbsent ? 1 : 0 }; }
        if (args.includes('disable')) { disabled = true; return { status: 0 }; }
        throw new Error('unexpected command');
    };
    // Every OS call in this VM is a local in-memory stub. Production exports
    // no injectable executor, platform, or environment for the real operation.
    const module = { exports: {} };
    const fakeRequire = name => {
        if (name === 'node:child_process') return { spawnSync: execute };
        if (name === 'node:path') return path.posix;
        throw new Error('unexpected module');
    };
    vm.runInNewContext(source, { module, exports: module.exports, require: fakeRequire, __dirname: '/fixture',
        process: { platform, env, execPath: fakeNode, stdout: { write: value => reports.push(value) } } });
    return { run: module.exports.runExperiment, calls, reports, childOptions: () => childOptions, state: () => ({ disabled, loaded }) };
}

test('apsd disabled-state parser rejects missing and duplicate labels', () => {
    assert.equal(disabledState('"com.apple.apsd" => disabled'), true);
    assert.equal(disabledState('"com.apple.apsd" => enabled'), false);
    assert.equal(disabledState('"com.apple.apsd" => true'), true);
    assert.equal(disabledState('"com.apple.apsd" => false'), false);
    assert.equal(disabledState('"com.apple.apsd" => true\n"com.apple.apsd" => false'), 'unknown');
    assert.equal(disabledState('"com.apple.apsd.extra" => disabled'), 'unknown');
});
test('service absence is accepted only for the fixed label, domain and exit status', () => {
    assert.equal(serviceState({ status: 0 }), 'loaded');
    assert.equal(serviceState({ status: 113, stderr: 'Bad request.\nCould not find service "com.apple.apsd" in domain for system\n' }), 'not_loaded');
    for (const value of [{ status: 1, stderr: 'permission denied' }, { status: 113, stderr: 'Could not find service "other" in domain for system' },
        { status: 113, stderr: 'Could not find service "com.apple.apsd" in domain for user gui: 501' },
        { status: 113, stderr: 'private Could not find service "com.apple.apsd" in domain for system' }, { status: null, error: new Error('private') }])
        assert.equal(serviceState(value), 'unknown');
});
test('real executor pipes bounded stderr for classification without writing it to output', () => {
    let observed;
    const execute = createExecutor((file, args, options) => {
        observed = { file, args, options };
        return { status: 113, stderr: 'Bad request.\nCould not find service "com.apple.apsd" in domain for system\n' };
    });
    const result = execute('/usr/bin/sudo', ['-n', '/bin/launchctl', 'print', 'system/com.apple.apsd']);
    assert.deepEqual(observed.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(observed.options.maxBuffer, 262144);
    assert.equal(serviceState(result), 'not_loaded');
    assert.equal(serviceState({ ...result, status: 1, stderr: 'private error' }), 'unknown');
});
test('synthetic child does not inherit network debug or runtime injection variables', () => {
    const input = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', NODE_DEBUG: 'http2',
        NODE_DEBUG_NATIVE: 'secret', NODE_OPTIONS: '--inspect', NODE_EXTRA_CA_CERTS: 'secret', SSLKEYLOGFILE: 'secret',
        DYLD_INSERT_LIBRARIES: 'secret', LD_PRELOAD: 'secret', DEBUG: '*', CBTE_SAFARI_FIXTURE_HOST: 'external' };
    const child = syntheticChildEnvironment(input);
    for (const name of ['NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSLKEYLOGFILE', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'DEBUG'])
        assert.equal(Object.hasOwn(child, name), false);
    assert.equal(child.CBTE_SAFARI_FIXTURE_HOST, '127.0.0.1');
    assert.equal(child.CBTE_SAFARI_SYNTHETIC_GET_PROBE, '1'); assert.equal(input.NODE_DEBUG, 'http2');
});
test('disabled state is restored even if stopping the temporary service fails', () => {
    const f = fixture({ bootoutFails: true });
    assert.throws(() => f.run(),
        { code: 'FIXTURE_APSD_CLEANUP_FAILED' });
    assert.equal(f.state().disabled, true);
    assert(f.calls.some(call => call.includes('disable')));
});
test('nonzero bootout requires a verified absent service and an absent process', () => {
    const absent = fixture({ bootoutAbsent: true });
    assert.equal(JSON.stringify(absent.run()), JSON.stringify({ state: 'passed', restored: true }));
    for (const options of [{ bootoutAbsent: true, unknownAfterBootout: true }, { finalProcessStatus: 0 }, { finalProcessStatus: 2 }]) {
        const f = fixture(options);
        assert.throws(() => f.run(),
            { code: 'FIXTURE_APSD_CLEANUP_FAILED' });
        assert.equal(f.state().disabled, true);
    }
});
test('only a disabled and stopped hosted service is temporarily enabled and restored', () => {
    const f = fixture();
    assert.equal(JSON.stringify(f.run()), JSON.stringify({ state: 'passed', restored: true }));
    assert.deepEqual(f.state(), { disabled: true, loaded: false });
    assert.equal(f.calls.filter(call => call.includes('enable')).length, 1);
    assert.equal(f.calls.filter(call => call.includes('disable')).length, 1);
    assert.equal(f.childOptions().env.CBTE_SAFARI_SYNTHETIC_DB_PROBE, '1');
    assert.equal(f.childOptions().env.CBTE_SAFARI_SYNTHETIC_PUSH_PROBE, '1');
});
test('test or enable failures still restore the fixed service', () => {
    for (const options of [{ testStatus: 1 }, { failEnable: true }, { bootstrapStatus: 1 }]) {
        const f = fixture(options);
        assert.throws(() => f.run(), /^Error: FIXTURE_/);
        assert.deepEqual(f.state(), { disabled: true, loaded: false });
        assert(f.calls.some(call => call.includes('disable')));
    }
});
test('non-hosted, running, or already loaded services are never changed', () => {
    for (const [platform, env, options] of [['win32', validEnv, {}], ['darwin', { ...validEnv, RUNNER_ENVIRONMENT: 'self-hosted' }, {}],
        ['darwin', validEnv, { processStatus: 0 }], ['darwin', validEnv, { initialLoaded: true }], ['darwin', validEnv, { unknownService: true }]]) {
        const f = fixture({ ...options, platform, env });
        // Passing forged arguments is ignored; only the VM's process state is used.
        assert.throws(() => f.run({ platform: 'darwin', env: validEnv, execute: () => ({ status: 0 }) }), /^Error: FIXTURE_/);
        assert(!f.calls.some(call => call.includes('enable') || call.includes('disable') || call.includes('kickstart')));
    }
});
test('real non-Mac process ignores forged environment and executor arguments', { skip: process.platform === 'darwin' }, () => {
    let attempted = false;
    assert.throws(() => runExperiment({ platform: 'darwin', env: validEnv, execute: () => { attempted = true; } }),
        { code: 'FIXTURE_APSD_ENVIRONMENT_INVALID' });
    assert.equal(attempted, false);
});

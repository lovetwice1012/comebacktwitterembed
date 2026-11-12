'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createExecutor, disabledState, serviceState, runExperiment } = require('../native-test/safari-apsd-ci-experiment.cjs');

const validEnv = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', CBTE_SAFARI_APSD_EXPERIMENT: '1', RUNNER_TEMP: '/tmp/runner' };
function fixture({ testStatus = 0, failEnable = false, bootstrapStatus = 0, processStatus = 1, initialLoaded = false, bootoutFails = false, unknownService = false } = {}) {
    let disabled = true, loaded = initialLoaded; const calls = [], reports = [];
    const execute = (file, args) => {
        calls.push([file, ...args]);
        if (file === process.execPath) return { status: testStatus };
        if (args.includes('/usr/bin/pgrep')) return { status: processStatus };
        if (args.includes('print-disabled')) return { status: 0, stdout: `"com.apple.apsd" => ${disabled ? 'disabled' : 'enabled'}\n` };
        if (args.includes('print')) return loaded ? { status: 0 } : unknownService ? { status: 1, stderr: 'private permission error' }
            : { status: 113, stderr: 'Bad request.\nCould not find service "com.apple.apsd" in domain for system\n' };
        if (args.includes('enable')) { disabled = false; return { status: failEnable ? 1 : 0 }; }
        if (args.includes('bootstrap')) { loaded = bootstrapStatus === 0; return { status: bootstrapStatus }; }
        if (args.includes('kickstart')) return { status: 0 };
        if (args.includes('bootout')) { if (bootoutFails) return { status: null, error: new Error('timeout') }; loaded = false; return { status: 0 }; }
        if (args.includes('disable')) { disabled = true; return { status: 0 }; }
        throw new Error('unexpected command');
    };
    return { execute, report: value => reports.push(value), calls, reports, state: () => ({ disabled, loaded }) };
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
test('disabled state is restored even if stopping the temporary service fails', () => {
    const f = fixture({ bootoutFails: true });
    assert.throws(() => runExperiment({ platform: 'darwin', env: validEnv, execute: f.execute, report: f.report }),
        { code: 'FIXTURE_APSD_CLEANUP_FAILED' });
    assert.equal(f.state().disabled, true);
    assert(f.calls.some(call => call.includes('disable')));
});
test('only a disabled and stopped hosted service is temporarily enabled and restored', () => {
    const f = fixture();
    assert.deepEqual(runExperiment({ platform: 'darwin', env: validEnv, execute: f.execute, report: f.report }), { state: 'passed', restored: true });
    assert.deepEqual(f.state(), { disabled: true, loaded: false });
    assert.equal(f.calls.filter(call => call.includes('enable')).length, 1);
    assert.equal(f.calls.filter(call => call.includes('disable')).length, 1);
});
test('test or enable failures still restore the fixed service', () => {
    for (const options of [{ testStatus: 1 }, { failEnable: true }, { bootstrapStatus: 1 }]) {
        const f = fixture(options);
        assert.throws(() => runExperiment({ platform: 'darwin', env: validEnv, execute: f.execute, report: f.report }), /^Error: FIXTURE_/);
        assert.deepEqual(f.state(), { disabled: true, loaded: false });
        assert(f.calls.some(call => call.includes('disable')));
    }
});
test('non-hosted, running, or already loaded services are never changed', () => {
    for (const [platform, env, options] of [['win32', validEnv, {}], ['darwin', { ...validEnv, RUNNER_ENVIRONMENT: 'self-hosted' }, {}],
        ['darwin', validEnv, { processStatus: 0 }], ['darwin', validEnv, { initialLoaded: true }], ['darwin', validEnv, { unknownService: true }]]) {
        const f = fixture(options);
        assert.throws(() => runExperiment({ platform, env, execute: f.execute, report: f.report }), /^Error: FIXTURE_/);
        assert(!f.calls.some(call => call.includes('enable') || call.includes('disable') || call.includes('kickstart')));
    }
});

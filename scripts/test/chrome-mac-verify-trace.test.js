'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarize, observeVerifyInstalledChrome, classifySignatureError } = require('../native-test/chrome-mac-verify-trace.cjs');

test('verification observer reports fixed failure stages and boolean metadata changes', () => {
    const stat = { dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5 };
    const trace = { before: { app: stat }, after: { app: { ...stat, ctimeMs: 6 } }, signature: 'valid', outcome: 'failed', exception: null };
    const result = summarize(trace);
    assert.equal(result.stage, 'identity_changed'); assert.equal(result.changed.app.ctimeMs, true);
    assert.equal(result.changed.app.ino, false); assert.equal(result.changed.plist.ctimeMs, 'unknown');
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.equal(summarize({ ...trace, signature: 'failed', after: {} }).stage, 'codesign_failed');
    assert.equal(summarize({ ...trace, signature: 'timeout', after: {} }).stage, 'codesign_timeout');
    assert.equal(summarize({ ...trace, signature: 'terminated', after: {} }).stage, 'codesign_terminated');
    assert.equal(summarize({ ...trace, exception: { phase: 'after', operation: 'lstat' } }).stage, 'after_lstat');
    assert.equal(summarize({ ...trace, signature: 'not_started', after: {} }).stage, 'before_inspection_rejected');
});

test('signature termination is not labelled a timeout without explicit ETIMEDOUT', () => {
    assert.equal(classifySignatureError(null), 'valid');
    assert.equal(classifySignatureError({ code: 'ETIMEDOUT', killed: true, signal: 'SIGTERM' }), 'timeout');
    assert.equal(classifySignatureError({ killed: true, signal: 'SIGTERM' }), 'terminated');
    assert.equal(classifySignatureError({ signal: 'SIGKILL' }), 'terminated');
    assert.equal(classifySignatureError({ code: 1 }), 'failed');
});

test('unsupported-platform observation restores patched standard-library functions', { skip: process.platform === 'darwin' }, async () => {
    const fs = require('node:fs/promises'), child = require('node:child_process');
    const before = [fs.lstat, fs.realpath, fs.readlink, child.execFile];
    const result = await observeVerifyInstalledChrome();
    assert.equal(result.error?.code, 'X_CHROME_MAC_BROWSER_UNSUPPORTED');
    assert.deepEqual([fs.lstat, fs.realpath, fs.readlink, child.execFile], before);
});

test('standard-library wrappers are restored after successful and failed verifier calls', async () => {
    const fs = require('node:fs/promises'), child = require('node:child_process');
    const before = [fs.lstat, fs.realpath, fs.readlink, child.execFile];
    const app = '/Applications/Google Chrome.app';
    for (const mode of ['success', 'codesign_failure', 'lstat_failure', 'after_lstat_failure', 'ctime_change']) {
        let statCalls = 0;
        const fixture = {
            lstat: async () => {
                statCalls++;
                if (mode === 'lstat_failure' || mode === 'after_lstat_failure' && statCalls === 2) throw new Error('synthetic sensitive metadata');
                return { dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: mode === 'ctime_change' && statCalls === 2 ? 6 : 5 };
            },
            realpath: async filename => filename,
            readlink: async () => '1.2.3.4',
            execFile: (_file, _args, _options, callback) => {
                queueMicrotask(() => callback(mode === 'codesign_failure' ? new Error('synthetic sensitive output') : null, '', ''));
                return {};
            },
            verify: async ({ fs: observedFs, execFile }) => {
                const initial = await observedFs.lstat(app);
                await new Promise((resolve, reject) => execFile('/usr/bin/codesign', [], {}, error => error ? reject(error) : resolve()));
                const final = await observedFs.lstat(app);
                if (initial.ctimeMs !== final.ctimeMs) throw new Error('synthetic changed identity');
                return '/synthetic/executable';
            },
        };
        const result = await observeVerifyInstalledChrome({ fixture });
        assert.equal(result.diagnostic.stage, { success: 'success', codesign_failure: 'codesign_failed', lstat_failure: 'before_lstat',
            after_lstat_failure: 'after_lstat', ctime_change: 'identity_changed' }[mode]);
        assert.equal(Boolean(result.error), mode !== 'success');
        if (mode === 'ctime_change') assert.equal(result.diagnostic.changed.app.ctimeMs, true);
        assert.equal(JSON.stringify(result.diagnostic).includes('sensitive'), false);
        assert.deepEqual([fs.lstat, fs.realpath, fs.readlink, child.execFile], before);
    }
});

test('concurrent verification observer is rejected and the first observer restores functions', async () => {
    const fs = require('node:fs/promises'), child = require('node:child_process');
    const before = [fs.lstat, fs.realpath, fs.readlink, child.execFile];
    let release; const gate = new Promise(resolve => { release = resolve; });
    const fixture = { lstat: async () => ({}), realpath: async value => value, readlink: async () => '',
        execFile: () => ({}), verify: async () => { await gate; return '/synthetic/executable'; } };
    const first = observeVerifyInstalledChrome({ fixture });
    try {
        const second = await observeVerifyInstalledChrome({ fixture });
        assert.equal(second.error?.code, 'FIXTURE_VERIFY_TRACE_BUSY');
        assert.equal(second.diagnostic.stage, 'busy');
        assert.notEqual(fs.lstat, before[0]);
    } finally { release(); }
    assert.equal((await first).diagnostic.stage, 'success');
    assert.deepEqual([fs.lstat, fs.realpath, fs.readlink, child.execFile], before);
});

test('module resolution failure releases the busy guard and keeps standard-library functions intact', async () => {
    const fs = require('node:fs/promises'), child = require('node:child_process');
    const before = [fs.lstat, fs.realpath, fs.readlink, child.execFile];
    const fixture = { lstat: async () => ({}), realpath: async value => value, readlink: async () => '',
        execFile: () => ({}), verify: async () => '/synthetic/executable',
        resolveModulePath: () => { throw Object.assign(new Error('synthetic missing module'), { code: 'MODULE_NOT_FOUND' }); } };
    const failed = await observeVerifyInstalledChrome({ fixture });
    assert.equal(failed.error?.code, 'FIXTURE_VERIFY_TRACE_FAILED');
    assert.deepEqual([fs.lstat, fs.realpath, fs.readlink, child.execFile], before);
    const succeeded = await observeVerifyInstalledChrome({ fixture: { ...fixture, resolveModulePath: undefined } });
    assert.equal(succeeded.diagnostic.stage, 'success');
    assert.deepEqual([fs.lstat, fs.realpath, fs.readlink, child.execFile], before);
});

test('observer hides module and instrumentation errors while preserving safe verifier codes', async () => {
    const sensitivePath = '/private/synthetic-user/secret-key';
    const fixture = { lstat: async () => ({}), realpath: async value => value, readlink: async () => '',
        execFile: () => ({}), verify: async () => '/synthetic/executable',
        resolveModulePath: () => { throw Object.assign(new Error(`module missing at ${sensitivePath}`), { code: 'MODULE_NOT_FOUND', path: sensitivePath }); } };
    const missing = await observeVerifyInstalledChrome({ fixture });
    assert.equal(missing.error?.code, 'FIXTURE_VERIFY_TRACE_FAILED');
    assert.equal(missing.error?.message, 'FIXTURE_VERIFY_TRACE_FAILED');
    assert.equal(`${missing.error?.stack} ${JSON.stringify(missing.error)} ${JSON.stringify(missing.diagnostic)}`.includes(sensitivePath), false);
    for (const code of ['X_CHROME_MAC_BROWSER_UNSUPPORTED', 'X_CHROME_MAC_BROWSER_TIMEOUT', 'X_CHROME_MAC_BROWSER_INVALID']) {
        const known = await observeVerifyInstalledChrome({ fixture: { ...fixture, resolveModulePath: undefined,
            verify: async () => { throw Object.assign(new Error(code), { code, path: sensitivePath }); } } });
        assert.equal(known.error?.code, code); assert.equal(known.error?.message, code);
        assert.equal(`${known.error?.stack} ${JSON.stringify(known.error)} ${JSON.stringify(known.diagnostic)}`.includes(sensitivePath), false);
    }
    const spoof = await observeVerifyInstalledChrome({ fixture: { ...fixture, resolveModulePath: undefined,
        verify: async () => { throw Object.assign(new Error(`invalid at ${sensitivePath}`), { code: 'X_CHROME_MAC_BROWSER_INVALID' }); } } });
    assert.equal(spoof.error?.code, 'FIXTURE_VERIFY_TRACE_FAILED');
    assert.equal(`${spoof.error?.stack} ${JSON.stringify(spoof.error)}`.includes(sensitivePath), false);
});

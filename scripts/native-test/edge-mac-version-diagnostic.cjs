'use strict';

// Test-only wrapper around the unchanged production verification source.
// It records fixed status categories and timing, never raw paths, outputs,
// version strings, endpoints, credentials, or notification data.
const vm = require('node:vm');
const path = require('node:path');
const util = require('node:util');
const { createRequire } = require('node:module');
const { classifyCodesign } = require('./edge-mac-codesign-diagnostic.cjs');
const APP = '/Applications/Microsoft Edge.app';
const FILES = Object.freeze({ [APP]: 'app', [`${APP}/Contents/MacOS/Microsoft Edge`]: 'binary', [`${APP}/Contents/Info.plist`]: 'plist' });
const KINDS = new Set(['app_stat', 'binary_stat', 'plist_stat', 'app_realpath', 'binary_realpath', 'plist_realpath', 'codesign', 'plist_extract']);
const OUTCOMES = new Set(['directory', 'file', 'link', 'other', 'same', 'changed', 'missing', 'denied', 'error', 'valid',
    'invalid_version', 'timeout', 'output_limit', 'unavailable', 'resource_metadata', 'signature_rejected', 'signal', 'nonzero_exit']);

function classifyFailure(error) {
    if (error?.code === 'ENOENT') return 'missing';
    if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'denied';
    return 'error';
}
function formatVersionDiagnostics(value) {
    if (!Array.isArray(value) || value.length > 32) return 'unavailable';
    if (!value.every(item => item && Object.keys(item).sort().join(',') === 'kind,ms,outcome'
        && KINDS.has(item.kind) && OUTCOMES.has(item.outcome) && Number.isSafeInteger(item.ms) && item.ms >= 0 && item.ms <= 300000)) return 'unavailable';
    return value.map(item => `${item.kind}=${item.outcome}:${item.ms}ms`).join(',') || 'none';
}

function createInstrumentedVerifier({ fsApi, execFile, brokerSource, versionSource, fallbackRequire, processValue, clock = Date.now }) {
    const events = [];
    const record = (kind, outcome, start) => {
        if (events.length >= 32 || !KINDS.has(kind) || !OUTCOMES.has(outcome)) return;
        const elapsed = Math.max(0, Math.min(300000, Math.trunc(clock() - start)));
        events.push(Object.freeze({ kind, outcome, ms: elapsed }));
    };
    const trackedFs = { ...fsApi };
    for (const operation of ['lstat', 'realpath']) trackedFs[operation] = async name => {
        const label = typeof name === 'string' ? FILES[name] : undefined, started = clock();
        try {
            const result = await fsApi[operation](name);
            if (label) record(`${label}_${operation === 'lstat' ? 'stat' : 'realpath'}`,
                operation === 'realpath' ? result === name ? 'same' : 'changed'
                    : result.isSymbolicLink() ? 'link' : result.isDirectory() ? 'directory' : result.isFile() ? 'file' : 'other', started);
            return result;
        } catch (error) { if (label) record(`${label}_${operation === 'lstat' ? 'stat' : 'realpath'}`, classifyFailure(error), started); throw error; }
    };
    function wrappedExec(file, args, options, callback) {
        const fixed = file === '/usr/bin/codesign' ? 'codesign' : file === '/usr/bin/plutil' ? 'plist_extract' : null;
        const started = clock();
        return execFile(file, args, options, (error, stdout, stderr) => {
            if (fixed === 'codesign') record(fixed, classifyCodesign(error, stderr, clock() - started, options.timeout), started);
            if (fixed === 'plist_extract') {
                const outcome = error ? classifyCodesign(error, '', clock() - started, options.timeout)
                    : typeof stdout === 'string' && /^[0-9]{1,3}(?:\.[0-9]{1,5}){3}\r?\n?$/.test(stdout) ? 'valid' : 'invalid_version';
                record(fixed, outcome, started);
            }
            callback(error, stdout, stderr);
        });
    }
    wrappedExec[util.promisify.custom] = (...args) => new Promise((resolve, reject) => wrappedExec(...args,
        (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
    const childProcess = { ...fallbackRequire('node:child_process'), execFile: wrappedExec };
    function evaluate(source, requireOverrides) {
        const module = { exports: {} };
        vm.runInNewContext(source, { module, exports: module.exports, process: processValue, Buffer, Promise,
            require(name) { return Object.hasOwn(requireOverrides, name) ? requireOverrides[name] : fallbackRequire(name); } });
        return module.exports;
    }
    const shared = { 'node:fs/promises': trackedFs, 'node:child_process': childProcess };
    const broker = evaluate(brokerSource, shared);
    const version = evaluate(versionSource, { ...shared, './edge-mac-broker': broker });
    return Object.freeze({ verify: version.readVerifiedMacEdgeVersion, snapshot: () => events.map(item => ({ ...item })) });
}
function createHostedVersionDiagnostic() {
    if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
        || process.env.CBTE_MAC_EDGE_HOSTED !== '1') throw new Error('FIXTURE_DIAGNOSTIC_ENVIRONMENT_INVALID');
    const fs = require('node:fs'), root = path.resolve(__dirname, '../..'), source = name => fs.readFileSync(path.join(root, 'src', 'automation', name), 'utf8');
    return createInstrumentedVerifier({ fsApi: require('node:fs/promises'), execFile: require('node:child_process').execFile,
        brokerSource: source('edge-mac-broker.js'), versionSource: source('edge-mac-browser-version.js'),
        fallbackRequire: createRequire(path.join(root, 'src', 'automation', 'edge-mac-browser-version.js')), processValue: process });
}
module.exports = { createInstrumentedVerifier, createHostedVersionDiagnostic, formatVersionDiagnostics };

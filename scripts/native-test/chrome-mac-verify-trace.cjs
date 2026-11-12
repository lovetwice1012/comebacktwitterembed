'use strict';

// CI-only observer: the actual production verifier still performs every
// lstat, canonical-path check, strict codesign and before/after comparison.
// We record only fixed categories and boolean metadata differences, never
// filesystem values, paths, codesign output, profiles or credentials.
const fs = require('node:fs/promises');
const childProcess = require('node:child_process');
const APP = '/Applications/Google Chrome.app';
const VERSIONS = `${APP}/Contents/Frameworks/Google Chrome Framework.framework/Versions`;
const fields = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'];
const keys = ['app', 'executable', 'plist', 'current_link', 'framework_dir', 'framework_binary'];
const safeVerifierCodes = new Set(['X_CHROME_MAC_BROWSER_UNSUPPORTED', 'X_CHROME_MAC_BROWSER_TIMEOUT', 'X_CHROME_MAC_BROWSER_INVALID']);
let observing = false;

function classifyPath(filename) {
    if (filename === APP) return 'app';
    if (filename === `${APP}/Contents/MacOS/Google Chrome`) return 'executable';
    if (filename === `${APP}/Contents/Info.plist`) return 'plist';
    if (filename === `${VERSIONS}/Current`) return 'current_link';
    if (typeof filename !== 'string' || !filename.startsWith(`${VERSIONS}/`)) return null;
    const tail = filename.slice(VERSIONS.length + 1);
    if (/^\d+(?:\.\d+){3}$/.test(tail)) return 'framework_dir';
    if (/^\d+(?:\.\d+){3}\/Google Chrome Framework$/.test(tail)) return 'framework_binary';
    return null;
}
function snapshot(stat) { return Object.fromEntries(fields.map(field => [field, stat[field]])); }
function classifySignatureError(error) {
    if (!error) return 'valid';
    if (error.code === 'ETIMEDOUT') return 'timeout';
    if (error.killed === true || typeof error.signal === 'string') return 'terminated';
    return 'failed';
}
function sanitizedError(error) {
    // Do not return original exceptions or their properties: module loading,
    // system errors or test instrumentation can include local paths or output.
    const code = safeVerifierCodes.has(error?.code) && error?.message === error.code
        ? error.code : 'FIXTURE_VERIFY_TRACE_FAILED';
    return Object.assign(new Error(code), { code });
}
function summarize(trace) {
    const changed = {};
    for (const key of keys) {
        const before = trace.before[key], after = trace.after[key];
        changed[key] = Object.fromEntries(fields.map(field => [field, before && after ? before[field] !== after[field] : 'unknown']));
    }
    let stage = 'unknown';
    if (trace.exception) stage = `${trace.exception.phase}_${trace.exception.operation}`;
    else if (trace.signature === 'failed') stage = 'codesign_failed';
    else if (trace.signature === 'timeout') stage = 'codesign_timeout';
    else if (trace.signature === 'terminated') stage = 'codesign_terminated';
    else if (trace.signature === 'valid' && trace.outcome === 'failed') {
        stage = Object.values(changed).some(values => Object.values(values).includes(true)) ? 'identity_changed' : 'after_inspection_rejected';
    } else if (trace.signature === 'not_started' && trace.outcome === 'failed') stage = 'before_inspection_rejected';
    else if (trace.outcome === 'success') stage = 'success';
    return { stage, changed };
}

async function observeVerifyInstalledChrome({ fixture } = {}) {
    // These are process-wide standard-library functions. Never let a second
    // observer save and later restore another observer's temporary wrappers.
    if (observing) return { error: Object.assign(new Error('FIXTURE_VERIFY_TRACE_BUSY'), { code: 'FIXTURE_VERIFY_TRACE_BUSY' }),
        diagnostic: { stage: 'busy', changed: {} } };
    if (fixture && (typeof fixture.verify !== 'function' || ['lstat', 'realpath', 'readlink', 'execFile'].some(name => typeof fixture[name] !== 'function')
        || fixture.resolveModulePath !== undefined && typeof fixture.resolveModulePath !== 'function'))
        throw new Error('FIXTURE_VERIFY_TRACE_CONFIG_INVALID');
    observing = true;
    const trace = { before: {}, after: {}, phase: 'before', signature: 'not_started', outcome: 'failed', exception: null };
    const original = { lstat: fs.lstat, realpath: fs.realpath, readlink: fs.readlink, execFile: childProcess.execFile };
    // Injected calls exist only in this CI/test helper. Normal execution
    // delegates unchanged arguments to the actual standard-library functions.
    const delegate = fixture || original;
    let verifier, modulePath, originalCache;
    function wrapFs(operation) {
        return async (...args) => {
            const key = classifyPath(args[0]);
            try {
                const result = await delegate[operation](...args);
                if (key && operation === 'lstat') trace[trace.phase][key] = snapshot(result);
                return result;
            } catch (error) {
                if (key && !trace.exception) trace.exception = { phase: trace.phase, operation };
                throw error;
            }
        };
    }
    function wrappedExecFile(file, args, options, callback) {
        if (file !== '/usr/bin/codesign') return delegate.execFile(file, args, options, callback);
        trace.signature = 'started';
        return delegate.execFile(file, args, options, (error, stdout, stderr) => {
            trace.signature = classifySignatureError(error);
            if (!error) trace.phase = 'after';
            callback(error, stdout, stderr);
        });
    }
    try {
        modulePath = fixture?.resolveModulePath ? fixture.resolveModulePath() : require.resolve('../../src/automation/chrome-mac-broker');
        originalCache = require.cache[modulePath];
        fs.lstat = wrapFs('lstat'); fs.realpath = wrapFs('realpath'); fs.readlink = wrapFs('readlink');
        // The verifier captures execFile on import. Restore the shared module
        // immediately after the import; only this verifier instance uses the
        // observer, and it calls the original execFile with unchanged inputs.
        if (fixture) verifier = () => fixture.verify({ fs, execFile: wrappedExecFile });
        else {
            childProcess.execFile = wrappedExecFile;
            delete require.cache[modulePath];
            verifier = require(modulePath).verifyInstalledChrome;
            childProcess.execFile = original.execFile;
            if (originalCache) require.cache[modulePath] = originalCache; else delete require.cache[modulePath];
        }
        const executable = await verifier(); trace.outcome = 'success';
        return { executable, diagnostic: summarize(trace) };
    } catch (error) {
        return { error: sanitizedError(error), diagnostic: summarize(trace) };
    } finally {
        fs.lstat = original.lstat; fs.realpath = original.realpath; fs.readlink = original.readlink;
        childProcess.execFile = original.execFile;
        if (!fixture && modulePath) { if (originalCache) require.cache[modulePath] = originalCache; else delete require.cache[modulePath]; }
        observing = false;
    }
}
module.exports = { observeVerifyInstalledChrome, summarize, classifySignatureError };

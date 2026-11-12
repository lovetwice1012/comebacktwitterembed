'use strict';

// Diagnostic helpers for the fixed, disposable CI installation only. Never
// emit tool output, paths, identifiers or other dynamic process details.
const fs = require('node:fs/promises');
const path = require('node:path');
const APP = '/Applications/Microsoft Edge.app';

function classifyCodesign(error, stderr, elapsedMs, timeoutMs) {
    if (!error) return 'valid';
    if (error.killed === true && error.signal === 'SIGTERM' && elapsedMs >= timeoutMs - 500) return 'timeout';
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output_limit';
    if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return 'unavailable';
    if (typeof stderr === 'string' && /resource fork|Finder information|unsealed contents/i.test(stderr)) return 'resource_metadata';
    if (typeof stderr === 'string' && /not signed|signature|invalid/i.test(stderr)) return 'signature_rejected';
    if (error.signal) return 'signal';
    return Number.isInteger(error.code) ? 'nonzero_exit' : 'other';
}

function instrumentCodesign(execFile, report, clock = Date.now) {
    let attempts = 0;
    function run(executable, args, options, callback) {
        if (executable !== '/usr/bin/codesign') return execFile(executable, args, options, callback);
        const attempt = ++attempts, started = clock();
        return execFile(executable, args, options, (error, stdout, stderr) => {
            const elapsed = Math.max(0, clock() - started);
            try { report({ attempt, elapsedMs: elapsed, classification: classifyCodesign(error, stderr, elapsed, options.timeout) }); }
            catch { /* Diagnostic failure cannot change signature verification. */ }
            callback(error, stdout, stderr);
        });
    }
    return { run, attempts: () => attempts };
}

async function snapshotEdgeMetadata() {
    try {
        const records = [];
        for (const filename of [APP, path.join(APP, 'Contents/MacOS/Microsoft Edge'), path.join(APP, 'Contents/Info.plist')]) {
            const stat = await fs.lstat(filename);
            records.push([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.isSymbolicLink()]);
        }
        return JSON.stringify(records);
    } catch { return null; }
}

function metadataChanged(before, after) {
    return before === null || after === null ? 'unknown' : before === after ? 'false' : 'true';
}

module.exports = { classifyCodesign, instrumentCodesign, snapshotEdgeMetadata, metadataChanged };

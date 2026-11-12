'use strict';

// Local output only. The calling setup app obtains explicit user confirmation.
const { normalizeChromeTransfer } = require('./chrome-x-transfer');
const { publishMacPrivateFile } = require('./mac-private-export');
const path = require('node:path');
const fail = code => Object.assign(new Error(code), { code });

async function writeMacChromeExport({ directory, filename, file, confirmed, signal }) {
    if (process.platform === 'win32' || typeof process.getuid !== 'function' || confirmed !== true
        || typeof directory !== 'string' || !path.isAbsolute(directory) || typeof filename !== 'string'
        || !filename || filename === '.' || filename === '..' || filename.includes('/') || filename.includes('\\')
        || /[\u0000-\u001f\u007f]/.test(filename) || Buffer.byteLength(filename) > 200
        || signal !== undefined && !(signal instanceof AbortSignal)) throw fail('X_CHROME_EXPORT_INVALID');
    if (signal?.aborted) throw fail('X_CHROME_EXPORT_CANCELLED');
    let normalized;
    try { normalized = normalizeChromeTransfer(file); } catch { throw fail('X_CHROME_EXPORT_INVALID'); }
    if (normalized.push.productCategory !== 'com.chrome.macosx') throw fail('X_CHROME_EXPORT_INVALID');
    const body = Buffer.from(JSON.stringify(normalized), 'utf8');
    try { return await publishMacPrivateFile({ directory, filename, body, signal, errorPrefix: 'X_CHROME_EXPORT' }); }
    finally { body.fill(0); }
}
module.exports = { writeMacChromeExport };

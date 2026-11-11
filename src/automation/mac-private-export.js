'use strict';

// Publish already-validated bytes locally. Never replaces an existing name.
// The caller owns and clears the supplied buffer, including on failure.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

async function publishMacPrivateFile({ directory, filename, body, signal, errorPrefix }) {
    if (!['X_CHROME_EXPORT', 'X_FIREFOX_MAC_EXPORT', 'X_BRAVE_MAC_EXPORT'].includes(errorPrefix)) throw new Error('Invalid export error prefix');
    const fail = suffix => Object.assign(new Error(`${errorPrefix}_${suffix}`), { code: `${errorPrefix}_${suffix}` });
    if (process.platform === 'win32' || typeof process.getuid !== 'function'
        || typeof directory !== 'string' || !path.isAbsolute(directory) || typeof filename !== 'string'
        || !filename || filename === '.' || filename === '..' || filename.includes('/') || filename.includes('\\')
        || /[\u0000-\u001f\u007f]/.test(filename) || Buffer.byteLength(filename) > 200 // eslint-disable-line no-control-regex
        || !Buffer.isBuffer(body) || body.length > 32768
        || signal !== undefined && !(signal instanceof AbortSignal)) throw fail('INVALID');
    if (signal?.aborted) throw fail('CANCELLED');
    let handle, temporary, createdStat, published = false;
    try {
        const resolved = await fs.realpath(directory), stat = await fs.stat(resolved);
        if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o022)) throw fail('DIRECTORY_UNSAFE');
        temporary = path.join(resolved, `.x-notification-${randomBytes(16).toString('hex')}.tmp`);
        const destination = path.join(resolved, filename);
        handle = await fs.open(temporary, 'wx', 0o600);
        createdStat = await handle.stat(); await handle.chmod(0o600); createdStat = await handle.stat();
        if (!createdStat.isFile() || createdStat.uid !== process.getuid() || (createdStat.mode & 0o777) !== 0o600 || createdStat.nlink !== 1)
            throw fail('DIRECTORY_UNSAFE');
        if (signal?.aborted) throw fail('CANCELLED');
        await handle.writeFile(body); await handle.sync();
        if (signal?.aborted) throw fail('CANCELLED');
        const beforeLink = await fs.lstat(temporary);
        if (!beforeLink.isFile() || beforeLink.dev !== createdStat.dev || beforeLink.ino !== createdStat.ino || beforeLink.nlink !== 1)
            throw fail('DIRECTORY_UNSAFE');
        await fs.link(temporary, destination); published = true;
        return { filename, containsSensitiveData: true, encrypted: false, uploaded: false };
    } catch (error) {
        if (error?.code === 'EEXIST' && createdStat) throw fail('EXISTS');
        if (typeof error?.code === 'string' && error.code.startsWith(`${errorPrefix}_`)) throw error;
        throw fail('FAILED');
    } finally {
        if (handle) {
            try {
                const atPath = await fs.lstat(temporary);
                if (createdStat && atPath.dev === createdStat.dev && atPath.ino === createdStat.ino) await fs.unlink(temporary);
                else throw new Error('temporary file changed'); // eslint-disable-line no-unsafe-finally
            } catch (error) {
                // Cleanup failure must override success so a leftover is reported.
                if (error?.code !== 'ENOENT') throw fail(published ? 'CLEANUP_FAILED_AFTER_SAVE' : 'CLEANUP_FAILED'); // eslint-disable-line no-unsafe-finally
            } finally { await handle.close(); }
        }
    }
}
module.exports = { publishMacPrivateFile };

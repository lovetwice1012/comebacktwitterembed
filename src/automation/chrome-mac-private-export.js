'use strict';

// Local output only. The calling setup app must explain any other-site
// subscriptions and obtain the user's confirmation before calling this.
// No browser discovery, Keychain access, network or upload happens here.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { normalizeChromeTransfer } = require('./chrome-x-transfer');
const fail = code => Object.assign(new Error(code), { code });

async function writeMacChromeExport({ directory, filename, file, confirmed, signal }) {
    if (process.platform === 'win32' || typeof process.getuid !== 'function'
        || typeof directory !== 'string' || !path.isAbsolute(directory) || typeof filename !== 'string'
        || !filename || filename === '.' || filename === '..' || filename.includes('/') || filename.includes('\\')
        || /[\u0000-\u001f\u007f]/.test(filename) || Buffer.byteLength(filename) > 200
        || confirmed !== true || signal !== undefined && !(signal instanceof AbortSignal)) throw fail('X_CHROME_EXPORT_INVALID');
    if (signal?.aborted) throw fail('X_CHROME_EXPORT_CANCELLED');
    let normalized;
    try { normalized = normalizeChromeTransfer(file); } catch { throw fail('X_CHROME_EXPORT_INVALID'); }
    if (normalized.push.productCategory !== 'com.chrome.macosx') throw fail('X_CHROME_EXPORT_INVALID');
    const body = Buffer.from(JSON.stringify(normalized), 'utf8');
    if (body.length > 32768) { body.fill(0); throw fail('X_CHROME_EXPORT_INVALID'); }
    let handle, temporary, createdStat, published = false;
    try {
        const resolved = await fs.realpath(directory), stat = await fs.stat(resolved);
        if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o022)) throw fail('X_CHROME_EXPORT_DIRECTORY_UNSAFE');
        temporary = path.join(resolved, `.x-notification-${randomBytes(16).toString('hex')}.tmp`);
        const destination = path.join(resolved, filename);
        // Exclusive creation prevents overwriting an existing path or symlink.
        handle = await fs.open(temporary, 'wx', 0o600);
        createdStat = await handle.stat(); await handle.chmod(0o600); createdStat = await handle.stat();
        if (!createdStat.isFile() || createdStat.uid !== process.getuid() || (createdStat.mode & 0o777) !== 0o600 || createdStat.nlink !== 1)
            throw fail('X_CHROME_EXPORT_DIRECTORY_UNSAFE');
        if (signal?.aborted) throw fail('X_CHROME_EXPORT_CANCELLED');
        await handle.writeFile(body); await handle.sync();
        if (signal?.aborted) throw fail('X_CHROME_EXPORT_CANCELLED');
        const beforeLink = await fs.lstat(temporary);
        if (!beforeLink.isFile() || beforeLink.dev !== createdStat.dev || beforeLink.ino !== createdStat.ino || beforeLink.nlink !== 1)
            throw fail('X_CHROME_EXPORT_DIRECTORY_UNSAFE');
        // A hard link atomically creates the final name and never replaces an
        // existing file. Unsupported filesystems fail without publishing.
        await fs.link(temporary, destination); published = true;
        return { filename, containsSensitiveData: true, encrypted: false, uploaded: false };
    } catch (error) {
        if (error?.code === 'EEXIST' && createdStat) throw fail('X_CHROME_EXPORT_EXISTS');
        if (/^X_CHROME_EXPORT_[A-Z_]+$/.test(error?.code || '')) throw error;
        throw fail('X_CHROME_EXPORT_FAILED');
    } finally {
        body.fill(0);
        if (handle) {
            try {
                // Never unlink a different inode if the temporary name changed.
                const atPath = await fs.lstat(temporary);
                if (createdStat && atPath.dev === createdStat.dev && atPath.ino === createdStat.ino) await fs.unlink(temporary);
                else throw new Error('temporary file changed');
            } catch (error) {
                if (error?.code !== 'ENOENT') throw fail(published ? 'X_CHROME_EXPORT_CLEANUP_FAILED_AFTER_SAVE' : 'X_CHROME_EXPORT_CLEANUP_FAILED');
            } finally { await handle.close(); }
        }
    }
}
module.exports = { writeMacChromeExport };

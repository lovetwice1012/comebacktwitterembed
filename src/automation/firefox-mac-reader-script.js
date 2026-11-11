'use strict';

// Experimental: return the verified script bytes, never a path to reopen.
// The caller must obtain the digest from an authenticated package and clear
// the returned buffer after use. A digest alone is not a package signature.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, timingSafeEqual } = require('node:crypto');
const fail = () => Object.assign(new Error('X_FIREFOX_MAC_SCRIPT_INVALID'), { code: 'X_FIREFOX_MAC_SCRIPT_INVALID' });
const filenames = Object.freeze({ bootstrap: 'FirefoxXPCShellReader.js', reader: 'Read-PushSubscription.js' });
const MAX_BYTES = 1024 * 1024;

async function readVerifiedMacFirefoxScript({ filename, kind, expectedSha256 }) {
    if (process.platform === 'win32' || typeof process.getuid !== 'function' || !constants.O_NOFOLLOW
        || !Object.hasOwn(filenames, kind) || typeof filename !== 'string' || !path.isAbsolute(filename)
        || path.basename(filename) !== filenames[kind] || path.resolve(filename) !== filename
        || typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256)) throw fail();
    let handle, bytes;
    try {
        if (await fs.realpath(filename) !== filename) throw fail();
        handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || ![0, process.getuid()].includes(before.uid)
            || before.mode & 0o022 || before.size < 1 || before.size > MAX_BYTES) throw fail();
        bytes = Buffer.alloc(before.size + 1); let offset = 0;
        while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!bytesRead) break;
            offset += bytesRead;
        }
        const after = await handle.stat(), current = await fs.lstat(filename);
        if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
            || current.isSymbolicLink() || !current.isFile() || current.dev !== before.dev || current.ino !== before.ino
            || current.nlink !== 1 || current.uid !== before.uid || current.mode !== before.mode
            || await fs.realpath(filename) !== filename) throw fail();
        const actual = createHash('sha256').update(bytes.subarray(0, offset)).digest(), expected = Buffer.from(expectedSha256, 'hex');
        try { if (!timingSafeEqual(actual, expected)) throw fail(); } finally { actual.fill(0); expected.fill(0); }
        const result = Buffer.from(bytes.subarray(0, offset));
        return result;
    } catch { throw fail(); }
    finally {
        bytes?.fill(0);
        try { await handle?.close(); } catch { throw fail(); } // eslint-disable-line no-unsafe-finally
    }
}
module.exports = { readVerifiedMacFirefoxScript };

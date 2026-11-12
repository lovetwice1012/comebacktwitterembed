'use strict';

// Experimental stable Brave discovery. It does not launch the browser or
// inspect any ordinary browser profile or Keychain item.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const APP = '/Applications/Brave Browser.app';
const EXECUTABLE = path.join(APP, 'Contents/MacOS/Brave Browser');
const PLIST = path.join(APP, 'Contents/Info.plist');
// Identifier and signing team match Apple's published browser information.
const REQUIREMENT = '=anchor apple generic and identifier "com.brave.Browser" and certificate leaf[subject.OU] = "KL8N8XSYF4"';
const MAX_VERIFY_ATTEMPTS = 3;
const fail = code => Object.assign(new Error(code), { code });

function sameIdentity(a, b) {
    return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}
function sameMetadata(a, b) { return sameIdentity(a, b) && a.ctimeMs === b.ctimeMs; }

// A ctime change must not hide an in-place rewrite whose mtime was restored.
// Hash from a no-follow descriptor and reject any metadata change while read.
async function hashStableFile(filename, expected) {
    if (!constants.O_NOFOLLOW || !Number.isSafeInteger(expected.size) || expected.size < 1 || expected.size > 256 * 1024 * 1024)
        throw new Error('invalid signed file');
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const before = await handle.stat();
        if (!before.isFile() || !sameMetadata(before, expected)) throw new Error('signed file changed');
        const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024); let offset = 0;
        while (offset < before.size) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
            if (!bytesRead) throw new Error('signed file changed');
            hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
        }
        const after = await handle.stat();
        if (!after.isFile() || !sameMetadata(before, after)) throw new Error('signed file changed');
        return hash.digest('hex');
    } finally { await handle.close(); }
}

async function verifyInstalledMacBrave() {
    if (process.platform !== 'darwin') throw fail('X_BRAVE_MAC_BROWSER_UNSUPPORTED');
    try {
        async function inspect(filename, isApp) {
            const stat = await fs.lstat(filename);
            if (stat.isSymbolicLink() || (isApp ? !stat.isDirectory() : !stat.isFile())
                || await fs.realpath(filename) !== filename) throw new Error('invalid installation');
            return stat;
        }
        async function verifySignature() {
            await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', REQUIREMENT, APP],
                { timeout: 30000, maxBuffer: 16384, windowsHide: true });
        }
        let anchor, anchorHashes, anchorVersion;
        for (let attempt = 0; attempt < MAX_VERIFY_ATTEMPTS; attempt++) {
            const before = [await inspect(APP, true), await inspect(EXECUTABLE, false), await inspect(PLIST, false)];
            if (anchor && before.some((stat, index) => !sameIdentity(anchor[index], stat))) throw new Error('installation changed');
            const beforeHashes = [await hashStableFile(EXECUTABLE, before[1]), await hashStableFile(PLIST, before[2])];
            if (!anchor) { anchor = before; anchorHashes = beforeHashes; }
            else if (beforeHashes.some((hash, index) => hash !== anchorHashes[index])) throw new Error('signed file changed');
            await verifySignature();
            const { stdout } = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', PLIST],
                { timeout: 10000, maxBuffer: 1024, windowsHide: true });
            const browserVersion = typeof stdout === 'string' ? stdout.replace(/\r?\n$/, '') : '';
            if (!/^[0-9]{1,3}(?:\.[0-9]{1,5}){3}$/.test(browserVersion) || anchorVersion && browserVersion !== anchorVersion)
                throw new Error('invalid version');
            if (!anchorVersion) anchorVersion = browserVersion;
            await verifySignature();
            const after = [await inspect(APP, true), await inspect(EXECUTABLE, false), await inspect(PLIST, false)];
            if (after.some((stat, index) => !sameIdentity(before[index], stat) || !sameIdentity(anchor[index], stat))) throw new Error('installation changed');
            const afterHashes = [await hashStableFile(EXECUTABLE, after[1]), await hashStableFile(PLIST, after[2])];
            if (afterHashes.some((hash, index) => hash !== anchorHashes[index])) throw new Error('signed file changed');
            if (after.every((stat, index) => sameMetadata(before[index], stat)))
                return Object.freeze({ executable: EXECUTABLE, browserVersion });
            // Only ctime drift can reach another attempt. Run both strict
            // signature checks and all identity/content checks again.
        }
        throw new Error('installation unstable');
    } catch { throw fail('X_BRAVE_MAC_BROWSER_INVALID'); }
}
module.exports = { verifyInstalledMacBrave };

'use strict';

// Read just the push identifier from a tool-owned Firefox profile. The caller
// must separately prove Firefox has stopped and keep the browser's native
// profile lock while snapshotting. This helper's lease prevents concurrent
// setup operations; it is not a Firefox process or native-lock check.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { verifyMacFirefoxProfile } = require('./chrome-mac-profile');
const { beginMacProfileLease } = require('./chrome-mac-profile-lease');
const { withMacStoreLocks } = require('./chrome-mac-store-locks');
const fail = code => Object.assign(new Error(code), { code });
const MAX_FILE = 8 * 1024 * 1024, MAX_LINE = 65536;
const UAID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/;

async function readMacFirefoxUaid({ rootPath, profileId, lease }) {
    const operation = beginMacProfileLease(lease, { rootPath, profileId, browser: 'firefox' });
    try { return await readOwnedUaid({ rootPath, profileId }); } finally { operation.end(); }
}

async function readOwnedUaid({ rootPath, profileId, signal = undefined }) {
    let handle, buffer;
    function check() { if (signal?.aborted) throw fail('X_FIREFOX_MAC_LOCK_LOST'); }
    try {
        check();
        const profile = await verifyMacFirefoxProfile(rootPath, profileId);
        const filename = path.join(profile.profilePath, 'prefs.js');
        handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = await handle.stat();
        if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1
            || before.size < 1 || before.size > MAX_FILE) throw fail('X_FIREFOX_MAC_PREFS_INVALID');
        let found = null, line = '', total = 0;
        const decoder = new TextDecoder('utf-8', { fatal: true });
        function inspect(value) {
            if (value.length > MAX_LINE) throw fail('X_FIREFOX_MAC_PREFS_INVALID');
            if (!value.includes('dom.push.userAgentID')) return;
            const match = /^\s*user_pref\(\s*"dom\.push\.userAgentID"\s*,\s*"([0-9a-f-]+)"\s*\);\s*$/.exec(value);
            if (!match || found !== null || !UAID.test(match[1])) throw fail('X_FIREFOX_MAC_UAID_INVALID');
            found = match[1];
        }
        function consume(text, final = false) {
            line += text;
            for (;;) {
                const end = line.search(/[\r\n]/);
                if (end === -1 || !final && line[end] === '\r' && end === line.length - 1) break;
                const delimiter = line[end] === '\r' && line[end + 1] === '\n' ? 2 : 1;
                inspect(line.slice(0, end)); line = line.slice(end + delimiter);
            }
            if (line.length > MAX_LINE + (line.endsWith('\r') ? 1 : 0)) throw fail('X_FIREFOX_MAC_PREFS_INVALID');
        }
        buffer = Buffer.alloc(4096);
        for (;;) {
            check();
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            check();
            if (!bytesRead) break;
            total += bytesRead;
            if (total > MAX_FILE || total > before.size) throw fail('X_FIREFOX_MAC_PREFS_INVALID');
            consume(decoder.decode(buffer.subarray(0, bytesRead), { stream: true }));
        }
        consume(decoder.decode(), true); inspect(line);
        const after = await handle.stat(), current = await fs.lstat(filename);
        await verifyMacFirefoxProfile(rootPath, profileId);
        check();
        if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
            || after.ctimeMs !== before.ctimeMs || current.dev !== before.dev || current.ino !== before.ino
            || !current.isFile() || current.isSymbolicLink()) throw fail('X_FIREFOX_MAC_PREFS_CHANGED');
        if (found === null) throw fail('X_FIREFOX_MAC_UAID_UNAVAILABLE');
        return found;
    } catch (error) {
        if (/^X_(?:FIREFOX_MAC|CHROME_MAC_PROFILE)_[A-Z_]+$/.test(error?.code || '')) throw error;
        throw fail('X_FIREFOX_MAC_PREFS_INVALID');
    } finally {
        buffer?.fill(0);
        await handle?.close();
    }
}

// Keeps both the tool lease and Firefox's native fcntl lock throughout the
// identifier read and the caller's snapshot step. Nothing is uploaded here.
async function withMacFirefoxLockedUaid({ rootPath, profileId, helperPath, expectedSha256, work }) {
    if (typeof work !== 'function') throw fail('X_FIREFOX_MAC_ARGUMENTS_INVALID');
    return withMacStoreLocks({ rootPath, profileId, helperPath, expectedSha256, browser: 'firefox', profileLease: undefined,
        work: async ({ profilePath, signal }) => {
            const uaid = await readOwnedUaid({ rootPath, profileId, signal });
            if (signal.aborted) throw fail('X_FIREFOX_MAC_LOCK_LOST');
            return work({ profilePath, uaid, signal });
        } });
}
module.exports = { readMacFirefoxUaid, withMacFirefoxLockedUaid };

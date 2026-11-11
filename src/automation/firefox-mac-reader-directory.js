'use strict';

// Experimental controlled cwd for XPCShell. The supervisor must hold cleanup
// until every reader process is confirmed stopped; no process is started here.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { verifyMacFirefoxProfile } = require('./chrome-mac-profile');
const fail = code => Object.assign(new Error(code), { code });

async function withExperimentalMacFirefoxReaderDirectory({ rootPath, profileId, experimental, signal, work }) {
    if (experimental !== true || process.platform === 'win32' || typeof process.getuid !== 'function'
        || !constants.O_NOFOLLOW || !constants.O_DIRECTORY || typeof work !== 'function'
        || signal !== undefined && !(signal instanceof AbortSignal)) throw fail('X_FIREFOX_MAC_CWD_INVALID');
    if (signal?.aborted) throw fail('X_FIREFOX_MAC_CWD_CANCELLED');
    const profile = await verifyMacFirefoxProfile(rootPath, profileId);
    const directory = path.join(profile.rootPath, `firefox-reader-cwd-${randomBytes(16).toString('hex')}`);
    let created = false, original, handle, held = false, acceptingHold = true;
    function holdForReader() {
        if (!acceptingHold || held || signal?.aborted) throw fail('X_FIREFOX_MAC_CWD_INVALID');
        held = true; let released = false;
        return () => { if (!released) { released = true; held = false; } };
    }
    async function verify() {
        await verifyMacFirefoxProfile(rootPath, profileId);
        const current = await fs.lstat(directory), opened = await handle.stat();
        if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== process.getuid()
            || (current.mode & 0o777) !== 0o500 || current.dev !== original.dev || current.ino !== original.ino
            || opened.dev !== original.dev || opened.ino !== original.ino || await fs.realpath(directory) !== directory
            || (await fs.readdir(directory)).length !== 0) throw fail('X_FIREFOX_MAC_CWD_INVALID');
    }
    try {
        await fs.mkdir(directory, { mode: 0o700 }); created = true;
        handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        original = await handle.stat();
        const current = await fs.lstat(directory);
        if (!original.isDirectory() || current.isSymbolicLink() || !current.isDirectory() || current.uid !== process.getuid()
            || current.dev !== original.dev || current.ino !== original.ino) throw fail('X_FIREFOX_MAC_CWD_INVALID');
        await handle.chmod(0o500);
        await verify();
        if (signal?.aborted) throw fail('X_FIREFOX_MAC_CWD_CANCELLED');
        const result = await work({ directory, holdForReader });
        if (signal?.aborted) throw fail('X_FIREFOX_MAC_CWD_CANCELLED');
        return result;
    } catch (error) {
        if (error?.code === 'X_FIREFOX_MAC_CWD_CANCELLED') throw error;
        throw fail('X_FIREFOX_MAC_CWD_INVALID');
    } finally {
        acceptingHold = false;
        try {
            if (created) {
                if (!handle || !original || held) throw fail('X_FIREFOX_MAC_CWD_CLEANUP_FAILED'); // eslint-disable-line no-unsafe-finally
                await verify(); await fs.rmdir(directory);
            }
        } catch { throw fail('X_FIREFOX_MAC_CWD_CLEANUP_FAILED'); } // eslint-disable-line no-unsafe-finally
        finally { try { await handle?.close(); } catch { throw fail('X_FIREFOX_MAC_CWD_CLEANUP_FAILED'); } } // eslint-disable-line no-unsafe-finally
    }
}
module.exports = { withExperimentalMacFirefoxReaderDirectory };

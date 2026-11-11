'use strict';

// Local result handling only. The calling supervisor must verify the reader
// scripts, run the child in isolation and wait for the entire process tree to
// stop before consuming the result. This module never uploads or logs it.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { verifyMacFirefoxProfile } = require('./chrome-mac-profile');
const { parseUniqueJson } = require('./strict-json');
const { parseTransferFile } = require('./x-setup-transfer');
const fail = code => Object.assign(new Error(code), { code });
const prepared = new WeakMap();
const UAID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/;
const VERSION = /^[0-9A-Za-z._+-]{1,64}$/;

async function prepareMacFirefoxReaderResult({ rootPath, profileId, snapshotPath, expectedUaid, expectedVersion }) {
    try {
        if (process.platform === 'win32' || typeof process.getuid !== 'function' || !constants.O_NOFOLLOW
            || typeof snapshotPath !== 'string' || !path.isAbsolute(snapshotPath)
            || typeof expectedUaid !== 'string' || !UAID.test(expectedUaid)
            || typeof expectedVersion !== 'string' || !VERSION.test(expectedVersion)) throw new Error();
        const profile = await verifyMacFirefoxProfile(rootPath, profileId), snapshot = path.resolve(snapshotPath);
        const match = /^firefox-snapshot-([0-9a-f]{32})$/.exec(path.basename(snapshot));
        if (!match || path.dirname(snapshot) !== profile.rootPath || await fs.realpath(snapshot) !== snapshot) throw new Error();
        const identity = await fs.lstat(snapshot);
        if (!identity.isDirectory() || identity.isSymbolicLink() || identity.uid !== process.getuid()
            || (identity.mode & 0o777) !== 0o700) throw new Error();
        const resultPath = path.join(profile.rootPath, `firefox-result-${match[1]}.json`);
        try { await fs.lstat(resultPath); throw new Error('occupied'); }
        catch (error) { if (error?.code !== 'ENOENT') throw error; }
        const capability = Object.freeze({});
        prepared.set(capability, { rootPath, profileId, snapshot, identity, resultPath, expectedUaid, expectedVersion, used: false });
        return capability;
    } catch { throw fail('X_FIREFOX_MAC_RESULT_INVALID'); }
}

async function consumeMacFirefoxReaderResult(capability) {
    const state = capability && prepared.get(capability);
    if (!state || state.used) throw fail('X_FIREFOX_MAC_RESULT_INVALID');
    state.used = true; let handle, identity, bytes;
    try {
        await verifyMacFirefoxProfile(state.rootPath, state.profileId);
        const snapshot = await fs.lstat(state.snapshot);
        if (!snapshot.isDirectory() || snapshot.isSymbolicLink() || snapshot.dev !== state.identity.dev
            || snapshot.ino !== state.identity.ino || await fs.realpath(state.snapshot) !== state.snapshot) throw new Error();
        handle = await fs.open(state.resultPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await handle.stat();
        if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600
            || info.nlink !== 1 || info.size < 1 || info.size > 32768) throw new Error();
        identity = info; bytes = Buffer.alloc(info.size + 1); let offset = 0;
        while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!bytesRead) break; offset += bytesRead;
        }
        const after = await handle.stat();
        if (offset !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs)
            throw new Error();
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
        const output = parseUniqueJson(text, 32);
        if (!output || typeof output !== 'object' || Array.isArray(output)
            || Object.keys(output).sort().join(',') !== 'export,ok,otherSubscriptionCount' || output.ok !== true
            || !Number.isInteger(output.otherSubscriptionCount) || output.otherSubscriptionCount < 0 || output.otherSubscriptionCount > 63)
            throw new Error();
        const file = parseTransferFile(JSON.stringify(output.export));
        if (file.version !== 1 || file.push.uaid !== state.expectedUaid || file.provenance.browserVersion !== state.expectedVersion)
            throw new Error();
        return { file, otherSubscriptionCount: output.otherSubscriptionCount };
    } catch { throw fail('X_FIREFOX_MAC_RESULT_INVALID'); }
    finally {
        bytes?.fill(0);
        if (handle) {
            try {
                if (identity) {
                    const current = await fs.lstat(state.resultPath);
                    if (current.dev !== identity.dev || current.ino !== identity.ino || !current.isFile()
                        || current.isSymbolicLink() || current.uid !== process.getuid() || current.nlink !== 1)
                        throw fail('X_FIREFOX_MAC_RESULT_CLEANUP_FAILED');
                    await fs.unlink(state.resultPath);
                }
            } catch { throw fail('X_FIREFOX_MAC_RESULT_CLEANUP_FAILED'); }
            finally { await handle.close(); }
        }
    }
}
module.exports = { prepareMacFirefoxReaderResult, consumeMacFirefoxReaderResult };

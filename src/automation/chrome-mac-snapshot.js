'use strict';

// Copies only notification-store files from an owned, stopped profile while
// the appropriate LevelDB locks and the profile launch lock are held. The callback must
// use the temporary snapshot synchronously and must not retain its path.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { parseUniqueJson } = require('./strict-json');
const { withMacStoreLocks } = require('./chrome-mac-store-locks');
const fail = code => Object.assign(new Error(code), { code });
const LEVELDB_FILE = /^(?:CURRENT|LOCK|LOG|LOG\.old|MANIFEST-[0-9]+|[0-9]+\.(?:log|ldb|sst))$/;
const MAX_TOTAL = 128 * 1024 * 1024, MAX_FILE = 64 * 1024 * 1024;

async function cleanSnapshot(root, token, identity, browser) {
    const prefix = browser === 'edge' ? 'edge' : 'chrome';
    const storeName = browser === 'edge' ? 'EdgePushStorageWithConnectTokenAndKey' : 'GCM Store';
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.dev !== identity.dev || stat.ino !== identity.ino
        || path.basename(root) !== `${prefix}-snapshot-${token}`) throw fail('X_CHROME_MAC_SNAPSHOT_CLEANUP_FAILED');
    const files = [], directories = [];
    async function collect(dir, depth) {
        const names = await fs.readdir(dir);
        if (names.length > 256 || files.length + directories.length + names.length > 1024) throw fail('X_CHROME_MAC_SNAPSHOT_CLEANUP_FAILED');
        for (const name of names) {
            const file = path.join(dir, name), info = await fs.lstat(file);
            if (info.isSymbolicLink() || info.uid !== process.getuid()) throw fail('X_CHROME_MAC_SNAPSHOT_CLEANUP_FAILED');
            const allowedDir = depth === 0 && name === 'Default' || depth === 1 && name === storeName
                || browser === 'chrome' && depth === 2 && name === 'Encryption';
            const allowedFile = depth === 0 && name === 'snapshot-owner.json' || browser === 'chrome' && depth === 1 && name === 'Preferences'
                || (depth === 2 || browser === 'chrome' && depth === 3) && LEVELDB_FILE.test(name);
            if (info.isDirectory() && allowedDir) { await collect(file, depth + 1); directories.push(file); }
            else if (info.isFile() && info.nlink === 1 && allowedFile) {
                if (depth === 0) {
                    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
                    try {
                        const markerInfo = await handle.stat();
                        if (markerInfo.size > 4096 || markerInfo.dev !== info.dev || markerInfo.ino !== info.ino) throw fail('X_CHROME_MAC_SNAPSHOT_CLEANUP_FAILED');
                        const marker = parseUniqueJson(await handle.readFile('utf8'));
                        if (Object.keys(marker).sort().join(',') !== 'appId,kind,token' || marker.appId !== 'x-notification-setup'
                            || marker.kind !== `${prefix}-snapshot-v1` || marker.token !== token) throw fail('X_CHROME_MAC_SNAPSHOT_CLEANUP_FAILED');
                    } finally { await handle.close(); }
                }
                files.push({ file, info });
            } else throw fail('X_CHROME_MAC_SNAPSHOT_CLEANUP_FAILED');
        }
    }
    await collect(root, 0);
    for (const { file, info } of files) {
        const current = await fs.lstat(file);
        if (current.dev !== info.dev || current.ino !== info.ino) throw fail('X_CHROME_MAC_SNAPSHOT_CLEANUP_FAILED');
        await fs.unlink(file);
    }
    for (const dir of directories) await fs.rmdir(dir);
    await fs.rmdir(root);
}

async function withMacBrowserSnapshot({ rootPath, profileId, helperPath, expectedSha256, work, browser }) {
    if (typeof work !== 'function') throw fail('X_CHROME_MAC_SNAPSHOT_INVALID');
    return withMacStoreLocks({ rootPath, profileId, helperPath, expectedSha256, browser, work: async ({ profilePath, signal }) => {
        const prefix = browser === 'edge' ? 'edge' : 'chrome';
        const storeName = browser === 'edge' ? 'EdgePushStorageWithConnectTokenAndKey' : 'GCM Store';
        const token = randomBytes(16).toString('hex'), snapshot = path.join(rootPath, `${prefix}-snapshot-${token}`);
        let identity, total = 0;
        function check() { if (signal.aborted) throw fail('X_CHROME_MAC_SNAPSHOT_CANCELLED'); }
        async function copy(source, target, maxSize) {
            check(); const input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW); let output;
            try {
                const stat = await input.stat();
                if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || stat.size > maxSize || total + stat.size > MAX_TOTAL)
                    throw fail('X_CHROME_MAC_SNAPSHOT_INVALID');
                total += stat.size; output = await fs.open(target, 'wx', 0o600);
                const buffer = Buffer.alloc(65536); let offset = 0;
                try {
                    while (offset < stat.size) {
                        check(); const result = await input.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
                        if (!result.bytesRead) throw fail('X_CHROME_MAC_SNAPSHOT_INVALID');
                        let written = 0;
                        while (written < result.bytesRead) { const r = await output.write(buffer, written, result.bytesRead - written, offset + written); if (!r.bytesWritten) throw fail('X_CHROME_MAC_SNAPSHOT_INVALID'); written += r.bytesWritten; }
                        offset += result.bytesRead;
                    }
                    const after = await input.stat();
                    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw fail('X_CHROME_MAC_SNAPSHOT_INVALID');
                    await output.sync(); check();
                } finally { buffer.fill(0); }
            } finally { await output?.close(); await input.close(); }
        }
        try {
            await fs.mkdir(snapshot, { mode: 0o700 }); identity = await fs.lstat(snapshot);
            await fs.mkdir(path.join(snapshot, 'Default'), { mode: 0o700 });
            const targetStore = path.join(snapshot, 'Default', storeName); await fs.mkdir(targetStore, { mode: 0o700 });
            if (browser === 'chrome') await fs.mkdir(path.join(targetStore, 'Encryption'), { mode: 0o700 });
            const marker = await fs.open(path.join(snapshot, 'snapshot-owner.json'), 'wx', 0o600);
            try { await marker.writeFile(JSON.stringify({ appId: 'x-notification-setup', kind: `${prefix}-snapshot-v1`, token })); await marker.sync(); }
            finally { await marker.close(); }
            if (browser === 'chrome') await copy(path.join(profilePath, 'Default', 'Preferences'), path.join(snapshot, 'Default', 'Preferences'), 4 * 1024 * 1024);
            const sourceStore = path.join(profilePath, 'Default', storeName);
            const stores = browser === 'chrome' ? [[sourceStore, targetStore, true],
                [path.join(sourceStore, 'Encryption'), path.join(targetStore, 'Encryption'), false]] : [[sourceStore, targetStore, false]];
            for (const [source, target, allowEncryption] of stores) {
                const entries = await fs.readdir(source, { withFileTypes: true });
                if (entries.length > 256) throw fail('X_CHROME_MAC_SNAPSHOT_INVALID');
                for (const entry of entries) {
                    check();
                    if (allowEncryption && entry.name === 'Encryption' && entry.isDirectory()) continue;
                    if (entry.name === 'LOCK' && entry.isFile()) continue;
                    if (!LEVELDB_FILE.test(entry.name) || !entry.isFile()) throw fail('X_CHROME_MAC_SNAPSHOT_INVALID');
                    await copy(path.join(source, entry.name), path.join(target, entry.name), MAX_FILE);
                }
            }
            check(); return await work({ snapshotPath: snapshot, token, signal });
        } finally {
            if (identity) await cleanSnapshot(snapshot, token, identity, browser);
        }
    } });
}
const withMacChromeSnapshot = options => withMacBrowserSnapshot({ ...options, browser: 'chrome' });
const withMacEdgeSnapshot = options => withMacBrowserSnapshot({ ...options, browser: 'edge' });
module.exports = { withMacChromeSnapshot, withMacEdgeSnapshot };

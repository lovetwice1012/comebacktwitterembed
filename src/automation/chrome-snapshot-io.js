'use strict';

// Reads only a tool-owned, stopped-browser snapshot. Process creation, copying,
// consent and protected output are the PowerShell caller's responsibility.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createDecipheriv } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { buildChromeTransfer, selectChromeMapping } = require('./chrome-snapshot-reader');
const fault = code => Object.assign(new Error(code), { code });

async function checked(root, parts, kind) {
    let current = root;
    for (const [index, component] of parts.entries()) {
        if (!component || component === '.' || component === '..' || component.includes('/') || component.includes('\\')) throw fault('X_CHROME_SNAPSHOT_INVALID');
        current = path.join(current, component);
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : kind === 'directory' ? !stat.isDirectory() : !stat.isFile()))
            throw fault('X_CHROME_SNAPSHOT_INVALID');
    }
    return current;
}
async function readBounded(root, parts, limit) {
    const filename = await checked(root, parts, 'file'), handle = await fs.open(filename, 'r');
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw fault('X_CHROME_SNAPSHOT_INVALID');
        const content = Buffer.alloc(stat.size + 1); let offset = 0;
        while (offset < content.length) {
            const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
            if (!bytesRead) break;
            offset += bytesRead;
        }
        if (offset !== stat.size) throw fault('X_CHROME_SNAPSHOT_INVALID');
        try { return new TextDecoder('utf-8', { fatal: true }).decode(content.subarray(0, offset)); }
        catch { throw fault('X_CHROME_SNAPSHOT_INVALID'); }
    } finally { await handle.close(); }
}
function b64(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 8192) throw fault('X_CHROME_SNAPSHOT_INVALID');
    const result = Buffer.from(value, 'base64');
    if (result.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) throw fault('X_CHROME_SNAPSHOT_INVALID');
    return result;
}
async function verifyLeveldb(directory, allowEncryptionDirectory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (entries.length > 256) throw fault('X_CHROME_SNAPSHOT_INVALID');
    let total = 0;
    for (const entry of entries) {
        const candidate = path.join(directory, entry.name), stat = await fs.lstat(candidate);
        if (stat.isSymbolicLink()) throw fault('X_CHROME_SNAPSHOT_INVALID');
        if (entry.name === 'Encryption' && allowEncryptionDirectory && stat.isDirectory()) continue;
        if (!stat.isFile() || !/^(?:CURRENT|LOCK|LOG|LOG\.old|MANIFEST-[0-9]+|[0-9]+\.(?:log|ldb|sst))$/.test(entry.name))
            throw fault('X_CHROME_SNAPSHOT_INVALID');
        total += stat.size;
        if (stat.size > 64 * 1024 * 1024 || total > 128 * 1024 * 1024) throw fault('X_CHROME_SNAPSHOT_INVALID');
    }
}
async function readChromeSnapshot({ snapshotPath, token, subscription, browserVersion, engineVersion, dbFactory, unprotect, parseJson, platform = 'windows', macPassword }) {
    let deviceStore, encryptionStore, key;
    try {
        if (typeof snapshotPath !== 'string' || !path.isAbsolute(snapshotPath) || !/^[0-9a-f]{32}$/.test(token)
            || path.basename(snapshotPath) !== `chrome-snapshot-${token}` || typeof dbFactory !== 'function'
            || !['windows', 'macos'].includes(platform) || (platform === 'windows' && typeof unprotect !== 'function')
            || (platform === 'macos' && !Buffer.isBuffer(macPassword)) || typeof parseJson !== 'function') throw fault('X_CHROME_SNAPSHOT_INVALID');
        const root = path.resolve(snapshotPath), rootStat = await fs.lstat(root), resolved = await fs.realpath(root);
        if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || (process.platform === 'win32' ? resolved.toLowerCase() !== root.toLowerCase() : resolved !== root)) throw fault('X_CHROME_SNAPSHOT_INVALID');
        const marker = parseJson(await readBounded(root, ['snapshot-owner.json'], 4096));
        if (!marker || marker.appId !== 'x-notification-setup' || marker.kind !== 'chrome-snapshot-v1' || marker.token !== token
            || Object.keys(marker).sort().join(',') !== 'appId,kind,token') throw fault('X_CHROME_SNAPSHOT_INVALID');
        const preferences = parseJson(await readBounded(root, ['Default', 'Preferences'], 4 * 1024 * 1024));
        const { appId, productCategory } = selectChromeMapping(preferences, { allowMac: platform === 'macos' });
        if ((platform === 'macos') !== (productCategory === 'com.chrome.macosx')) throw fault('X_CHROME_SNAPSHOT_UNSUPPORTED');
        if (platform === 'windows') {
            const localState = parseJson(await readBounded(root, ['Local State'], 1024 * 1024));
            const wrapped = b64(localState?.os_crypt?.encrypted_key);
            if (wrapped.subarray(0, 5).toString('ascii') !== 'DPAPI' || wrapped.length <= 5) throw fault('X_CHROME_SNAPSHOT_UNSUPPORTED');
            key = await unprotect(Buffer.from(wrapped.subarray(5)));
            if (!Buffer.isBuffer(key) || key.length !== 32) throw fault('X_CHROME_SNAPSHOT_UNSUPPORTED');
        }
        const storePath = await checked(root, ['Default', 'GCM Store'], 'directory');
        const encryptionPath = await checked(root, ['Default', 'GCM Store', 'Encryption'], 'directory');
        await verifyLeveldb(storePath, true); await verifyLeveldb(encryptionPath, false);
        // Opening LevelDB may write lock/log files only in this snapshot.
        deviceStore = dbFactory(storePath); encryptionStore = dbFactory(encryptionPath);
        await deviceStore.open(); await encryptionStore.open();
        const deviceId = (await deviceStore.get('device_aid_key')).toString('utf8');
        const tokenBytes = await deviceStore.get('device_token_key');
        let securityToken;
        if (platform === 'macos') securityToken = require('./chrome-mac-token-crypto').decryptMacChromiumDeviceToken(tokenBytes, macPassword);
        else {
            if (!Buffer.isBuffer(tokenBytes) || tokenBytes.length < 32 || tokenBytes.subarray(0, 3).toString('ascii') !== 'v10')
                throw fault('X_CHROME_SNAPSHOT_UNSUPPORTED');
            const decipher = createDecipheriv('aes-256-gcm', key, tokenBytes.subarray(3, 15));
            decipher.setAuthTag(tokenBytes.subarray(-16));
            securityToken = Buffer.concat([decipher.update(tokenBytes.subarray(15, -16)), decipher.final()]).toString('utf8');
        }
        const records = [];
        for await (const [recordKey, value] of encryptionStore.iterator({ gte: appId, lt: appId + '\uffff', limit: 5 })) {
            if (records.length >= 4) throw fault('X_CHROME_SNAPSHOT_AMBIGUOUS');
            records.push({ key: recordKey, value });
        }
        return buildChromeTransfer({ preferences, subscription, records, deviceId, securityToken, browserVersion, engineVersion, allowMac: platform === 'macos' });
    } catch (error) {
        const code = typeof error?.code === 'string' && /^X_CHROME_SNAPSHOT_[A-Z_]+$/.test(error.code)
            ? error.code : 'X_CHROME_SNAPSHOT_INVALID';
        throw fault(code);
    } finally {
        if (Buffer.isBuffer(key)) key.fill(0);
        if (encryptionStore) await encryptionStore.close().catch(() => {});
        if (deviceStore) await deviceStore.close().catch(() => {});
    }
}
module.exports = { readChromeSnapshot };

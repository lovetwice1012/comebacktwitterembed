'use strict';

// Reads only a marked, tool-owned snapshot. The caller owns browser shutdown,
// copying, access control, consent, and removal of the snapshot.
const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { parseUniqueJson } = require('./strict-json');
const { buildEdgeTransferFromStore } = require('./edge-wns-snapshot');
const invalid = () => Object.assign(new Error('X_EDGE_WNS_SNAPSHOT_INVALID'), { code: 'X_EDGE_WNS_SNAPSHOT_INVALID' });
async function checked(root, parts, directory) {
    let current = root;
    for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || (index < parts.length - 1 || directory ? !stat.isDirectory() : !stat.isFile())) throw invalid();
    }
    return current;
}
async function marker(root) {
    const filename = await checked(root, ['snapshot-owner.json'], false), handle = await fs.open(filename, 'r');
    let content;
    try {
        const stat = await handle.stat(); if (!stat.isFile() || stat.size < 1 || stat.size > 4096) throw invalid();
        content = Buffer.alloc(stat.size + 1); let offset = 0;
        while (offset < content.length) { const read = await handle.read(content, offset, content.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
        if (offset !== stat.size) throw invalid();
        return parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(content.subarray(0, offset)));
    } finally { content?.fill(0); await handle.close(); }
}
async function verifyLeveldb(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (!entries.length || entries.length > 256) throw invalid();
    let total = 0;
    for (const entry of entries) {
        const stat = await fs.lstat(path.join(directory, entry.name));
        if (stat.isSymbolicLink() || !stat.isFile() || !/^(?:CURRENT|LOCK|LOG|LOG\.old|MANIFEST-[0-9]+|[0-9]+\.(?:log|ldb|sst))$/.test(entry.name)) throw invalid();
        total += stat.size;
        if (stat.size > 64 * 1024 * 1024 || total > 128 * 1024 * 1024) throw invalid();
    }
}
async function readEdgeSnapshot({ snapshotPath, token, expected, browserVersion, agent, client, dbFactory }) {
    let store; const records = [];
    try {
        if (typeof snapshotPath !== 'string' || !path.isAbsolute(snapshotPath) || typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)
            || path.basename(snapshotPath) !== `edge-snapshot-${token}` || typeof dbFactory !== 'function') throw invalid();
        const root = path.resolve(snapshotPath), stat = await fs.lstat(root), real = await fs.realpath(root);
        if (stat.isSymbolicLink() || !stat.isDirectory() || (process.platform === 'win32' ? real.toLowerCase() !== root.toLowerCase() : real !== root)) throw invalid();
        const owner = await marker(root);
        if (!owner || typeof owner !== 'object' || Array.isArray(owner) || Object.keys(owner).sort().join(',') !== 'appId,kind,token'
            || owner.appId !== 'x-notification-setup' || owner.kind !== 'edge-snapshot-v1' || owner.token !== token) throw invalid();
        const directory = await checked(root, ['Default', 'EdgePushStorageWithConnectTokenAndKey'], true);
        await verifyLeveldb(directory);
        store = dbFactory(directory); await store.open();
        for await (const item of store.iterator({ limit: 129 })) {
            try {
                if (!Array.isArray(item) || item.length !== 2 || !Buffer.isBuffer(item[0]) || !Buffer.isBuffer(item[1])
                    || item[0].length > 4096 || item[1].length > 65536 || records.length >= 128) throw invalid();
                // Own a copy, since the adapter may reuse its iterator buffers.
                records.push(Buffer.from(item[1]));
            } finally { if (Array.isArray(item) && Buffer.isBuffer(item[1])) item[1].fill(0); }
        }
        return await buildEdgeTransferFromStore({ records, expected, browserVersion, agent, client });
    } catch { throw invalid(); }
    finally { for (const record of records) record.fill(0); if (store) await store.close().catch(() => {}); }
}
module.exports = { readEdgeSnapshot };

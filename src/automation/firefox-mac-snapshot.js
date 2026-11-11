'use strict';

// Experimental local snapshot: only Firefox's Push IndexedDB and its own
// associated blobs are copied. The caller must read the copy within `work`;
// it is removed before the native profile lock is released. No upload occurs.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { withMacFirefoxLockedUaid } = require('./firefox-mac-uaid');
const fail = code => Object.assign(new Error(code), { code });
const DB = '2918063365piupsah', MAX_TOTAL = 128 * 1024 * 1024, MAX_FILES = 512;

async function withMacFirefoxSnapshot({ rootPath, profileId, helperPath, expectedSha256, work }) {
    if (typeof work !== 'function') throw fail('X_FIREFOX_MAC_SNAPSHOT_INVALID');
    return withMacFirefoxLockedUaid({ rootPath, profileId, helperPath, expectedSha256, work: async ({ profilePath, uaid, signal }) => {
        const snapshot = path.join(rootPath, `firefox-snapshot-${randomBytes(16).toString('hex')}`);
        const created = []; let total = 0, count = 0, untrackedCreation = false;
        function check() { if (signal.aborted) throw fail('X_FIREFOX_MAC_SNAPSHOT_CANCELLED'); }
        async function directory(filename) {
            check(); await fs.mkdir(filename, { mode: 0o700 }); untrackedCreation = true;
            const info = await fs.lstat(filename); created.push({ filename, info, directory: true }); untrackedCreation = false;
            if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw fail('X_FIREFOX_MAC_SNAPSHOT_INVALID');
        }
        async function sourceDirectory(filename) {
            check(); const info = await fs.lstat(filename);
            if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || await fs.realpath(filename) !== filename)
                throw fail('X_FIREFOX_MAC_SNAPSHOT_INVALID');
            return info;
        }
        async function sameDirectory(filename, before) {
            const after = await sourceDirectory(filename);
            if (before.dev !== after.dev || before.ino !== after.ino) throw fail('X_FIREFOX_MAC_SNAPSHOT_INVALID');
        }
        async function copy(source, target, limit) {
            check(); const input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW); let output, buffer;
            try {
                const before = await input.stat();
                if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1 || before.size > limit
                    || (total += before.size) > MAX_TOTAL) throw fail('X_FIREFOX_MAC_SNAPSHOT_INVALID');
                output = await fs.open(target, 'wx', 0o600); untrackedCreation = true;
                const info = await output.stat(); created.push({ filename: target, info, directory: false }); untrackedCreation = false;
                buffer = Buffer.alloc(65536); let offset = 0;
                while (offset < before.size) {
                    check(); const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
                    if (!bytesRead) throw fail('X_FIREFOX_MAC_SNAPSHOT_INVALID');
                    let written = 0;
                    while (written < bytesRead) {
                        const result = await output.write(buffer, written, bytesRead - written, offset + written);
                        if (!result.bytesWritten) throw fail('X_FIREFOX_MAC_SNAPSHOT_INVALID');
                        written += result.bytesWritten;
                    }
                    offset += bytesRead;
                }
                const after = await input.stat(), current = await fs.lstat(source);
                if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
                    || before.dev !== current.dev || before.ino !== current.ino || !current.isFile() || current.isSymbolicLink()
                    || current.uid !== process.getuid() || current.nlink !== 1)
                    throw fail('X_FIREFOX_MAC_SNAPSHOT_INVALID');
                await output.sync(); check();
            } finally { buffer?.fill(0); try { await output?.close(); } finally { await input.close(); } }
        }
        async function copyBlobs(source, target, depth) {
            if (depth > 16) throw fail('X_FIREFOX_MAC_SNAPSHOT_INVALID');
            const original = await sourceDirectory(source); await directory(target);
            const entries = await fs.readdir(source, { withFileTypes: true });
            if (entries.length > MAX_FILES - count) throw fail('X_FIREFOX_MAC_SNAPSHOT_INVALID');
            for (const entry of entries) {
                check(); if (++count > MAX_FILES || /[\u0000-\u001f\u007f/\\]/.test(entry.name)
                    || entry.name === '.' || entry.name === '..') throw fail('X_FIREFOX_MAC_SNAPSHOT_INVALID');
                const from = path.join(source, entry.name), to = path.join(target, entry.name);
                if (entry.isDirectory()) await copyBlobs(from, to, depth + 1);
                else if (entry.isFile()) await copy(from, to, 32 * 1024 * 1024);
                else throw fail('X_FIREFOX_MAC_SNAPSHOT_INVALID');
            }
            await sameDirectory(source, original);
        }
        async function cleanup() {
            if (untrackedCreation) throw fail('X_FIREFOX_MAC_SNAPSHOT_CLEANUP_FAILED');
            const byName = new Map(created.map(item => [item.filename, item]));
            async function verify(item) {
                const info = await fs.lstat(item.filename);
                if (info.dev !== item.info.dev || info.ino !== item.info.ino || info.uid !== process.getuid()
                    || info.isSymbolicLink() || (item.directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1))
                    throw fail('X_FIREFOX_MAC_SNAPSHOT_CLEANUP_FAILED');
            }
            // Validate the complete tree before removing anything. Unexpected
            // entries, renamed directories and replacements must be retained.
            for (const item of created) {
                await verify(item);
                if (item.directory) {
                    const expected = created.filter(other => path.dirname(other.filename) === item.filename)
                        .map(other => path.basename(other.filename)).sort();
                    const actual = (await fs.readdir(item.filename)).sort();
                    if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index]))
                        throw fail('X_FIREFOX_MAC_SNAPSHOT_CLEANUP_FAILED');
                }
            }
            for (const item of [...created].reverse()) {
                let parent = path.dirname(item.filename);
                while (byName.has(parent)) { await verify(byName.get(parent)); parent = path.dirname(parent); }
                await verify(item);
                if (item.directory) await fs.rmdir(item.filename); else await fs.unlink(item.filename);
            }
        }
        try {
            await directory(snapshot);
            let source = profilePath, target = snapshot;
            const sourceDirectories = [];
            for (const part of ['storage', 'permanent', 'chrome', 'idb']) {
                source = path.join(source, part); target = path.join(target, part);
                sourceDirectories.push({ filename: source, info: await sourceDirectory(source) }); await directory(target);
            }
            for (const suffix of ['.sqlite', '.sqlite-wal', '.sqlite-shm', '.sqlite-journal']) {
                const filename = path.join(source, DB + suffix);
                try { await fs.lstat(filename); }
                catch (error) { if (error?.code === 'ENOENT' && suffix !== '.sqlite') continue; throw error; }
                await copy(filename, path.join(target, DB + suffix), 64 * 1024 * 1024);
            }
            const blobs = path.join(source, `${DB}.files`);
            let present = true;
            try { await fs.lstat(blobs); } catch (error) { if (error?.code === 'ENOENT') present = false; else throw error; }
            if (present) await copyBlobs(blobs, path.join(target, `${DB}.files`), 0);
            for (const item of sourceDirectories) await sameDirectory(item.filename, item.info);
            check(); return await work({ snapshotPath: snapshot, uaid, signal });
        } catch (error) {
            if (/^X_FIREFOX_MAC_SNAPSHOT_[A-Z_]+$/.test(error?.code || '')) throw error;
            throw fail('X_FIREFOX_MAC_SNAPSHOT_INVALID');
        } finally {
            try { await cleanup(); } catch { throw fail('X_FIREFOX_MAC_SNAPSHOT_CLEANUP_FAILED'); }
        }
    } });
}
module.exports = { withMacFirefoxSnapshot };

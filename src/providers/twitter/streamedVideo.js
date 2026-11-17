'use strict';

// Stream eligible X videos to a private temporary file. Discord's REST manager
// can upload a file-backed Blob without copying the whole video into the heap.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { lookup } = require('../autoWatch/publicDns');
const { validateTwitterMediaUrl } = require('./twitterSourceParser/mediaUrlPolicy');

const SMALL_LIMIT = 16 * 1024 * 1024;
const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_ACTIVE = { small: 16, large: 4 };
let activeSmall = 0, activeLarge = 0, reservedDiskBytes = 0;
let lastSweepAt = 0;
async function removeStale(root, options = {}) {
    const now = options.now ?? Date.now();
    let entries;
    try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        const match = /^cbte-video-(\d+)-[A-Za-z0-9]{6}$/.exec(entry.name);
        if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        const directory = path.join(root, entry.name);
        try {
            const stat = await fsp.lstat(directory);
            if (!stat.isDirectory() || now - stat.mtimeMs < 24 * 60 * 60 * 1000
                || typeof process.getuid === 'function' && stat.uid !== process.getuid()) continue;
            const alive = options.isAlive || (pid => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== 'ESRCH'; } });
            if (alive(Number(match[1]))) continue;
            // Never recurse or follow links: only our exact file is removed.
            await fsp.unlink(path.join(directory, 'video'));
            await fsp.rmdir(directory);
        } catch { /* Leave unrecognized, in-use or inaccessible entries alone. */ }
    }
}
function reserve(bytes) {
    const small = Number.isSafeInteger(bytes) && bytes > 0 && bytes <= SMALL_LIMIT;
    if (small ? activeSmall >= MAX_ACTIVE.small : activeLarge >= MAX_ACTIVE.large) return null;
    if (small) activeSmall++; else activeLarge++;
    let released = false;
    return () => { if (!released) { released = true; if (small) activeSmall--; else activeLarge--; } };
}
function eligible(files) {
    if (!Array.isArray(files) || files.length !== 1) return null;
    const file = files[0], raw = typeof file === 'string' ? file : file?.attachment;
    if (typeof raw !== 'string') return null;
    try {
        const parsed = validateTwitterMediaUrl(raw, 'video');
        const name = typeof file === 'object' && file.name ? String(file.name) : path.basename(raw);
        if (!name || /[\r\n\0]/.test(name)) return null;
        return { url: parsed.url, name };
    } catch { return null; }
}

// Return null when streaming is unavailable: no Discord request was sent, so the
// existing sender can safely continue. Never retry an uncertain Discord POST.
async function prepare(files, deps = {}) {
    const item = eligible(files);
    if (!item || typeof fs.openAsBlob !== 'function') return null;
    const root = deps.tmpdir || os.tmpdir();
    if (!deps.tmpdir && Date.now() - lastSweepAt > 60 * 60 * 1000) {
        lastSweepAt = Date.now();
        removeStale(root).catch(() => {});
    }
    const fetch = deps.fetch || require('node-fetch');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000); timeout.unref?.();
    let response, agent, directory, release, succeeded = false;
    try {
        agent = new https.Agent({ keepAlive: false, lookup: deps.lookup || lookup });
        response = await fetch(item.url.href, { agent, redirect: 'manual', signal: controller.signal });
        // Avoid adding another redirect-following path; the existing sender
        // handles redirects when this optimization cannot use the first URL.
        if (!response?.ok || !response.body) throw new Error('media unavailable');
        const header = response.headers?.get?.('content-length');
        const declared = header && /^\d+$/.test(header) ? Number(header) : null;
        if (declared !== null && (!Number.isSafeInteger(declared) || declared > MAX_BYTES)) return null;
        release = reserve(declared);
        if (!release) return null;
        // Leave space for normal service writes. If capacity is uncertain or
        // insufficient, skip the temporary file and use the legacy sender.
        const space = await (deps.statfs || fsp.statfs)(root);
        const available = Number(space.bavail) * Number(space.bsize);
        const planned = declared || MAX_BYTES;
        const required = planned + reservedDiskBytes + 128 * 1024 * 1024;
        if (!Number.isSafeInteger(available) || available < required) return null;
        // Account for other concurrent uploads even before their writes become
        // visible to statfs. Counting written bytes twice is conservative.
        reservedDiskBytes += planned;
        const releaseSlot = release;
        let diskReleased = false;
        release = () => {
            releaseSlot();
            if (!diskReleased) { diskReleased = true; reservedDiskBytes -= planned; }
        };
        directory = await fsp.mkdtemp(path.join(root, `cbte-video-${process.pid}-`));
        const filename = path.join(directory, 'video');
        let bytes = 0;
        const meter = new Transform({ transform(chunk, _enc, done) {
            bytes += chunk.length;
            if (bytes > MAX_BYTES || declared !== null && bytes > declared) return done(new Error('media size exceeded'));
            done(null, chunk);
        } });
        await pipeline(response.body, meter, fs.createWriteStream(filename, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
        if (!bytes || declared !== null && bytes !== declared) throw new Error('media length mismatch');
        const blob = await fs.openAsBlob(filename, { type: response.headers?.get?.('content-type') || 'application/octet-stream' });
        succeeded = true;
        const cleanup = async () => {
            try { await fsp.unlink(filename); await fsp.rmdir(directory); }
            finally { release(); }
        };
        return { blob, name: item.name, cleanup };
    } catch { return null; }
    finally {
        clearTimeout(timeout); response?.body?.destroy?.(); agent?.destroy();
        if (!succeeded) {
            if (directory) { try { await fsp.unlink(path.join(directory, 'video')); } catch {} try { await fsp.rmdir(directory); } catch {} }
            release?.();
        }
    }
}
module.exports = { prepare, _internal: { eligible, reserve, removeStale, SMALL_LIMIT, MAX_BYTES } };

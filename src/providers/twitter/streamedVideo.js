'use strict';

// Stage attachment bytes in private files so Discord REST can stream multipart
// uploads without an extra full-size in-memory copy. An unavailable optimization
// returns null before Discord is contacted; the existing sender remains usable.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { lookup, isPublicAddress } = require('../autoWatch/publicDns');
const { filetypeinfo } = require('magic-bytes.js');
const { OverwrittenMimeTypes } = require('@discordjs/rest');

const SMALL_LIMIT = 16 * 1024 * 1024;
const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_BATCH_BYTES = 5 * MAX_BYTES;
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
            const names = await fsp.readdir(directory);
            if (names.some(name => name !== 'video' && !/^part-(?:[0-9])$/.test(name))) continue;
            for (const name of names) await fsp.unlink(path.join(directory, name));
            await fsp.rmdir(directory);
        } catch { /* Preserve unknown, in-use and inaccessible entries. */ }
    }
}
function reserve(bytes) {
    const small = Number.isSafeInteger(bytes) && bytes > 0 && bytes <= SMALL_LIMIT;
    if (small ? activeSmall >= MAX_ACTIVE.small : activeLarge >= MAX_ACTIVE.large) return null;
    if (small) activeSmall++; else activeLarge++;
    let released = false;
    return () => { if (!released) { released = true; if (small) activeSmall--; else activeLarge--; } };
}
function publicUrl(value) {
    if (typeof value !== 'string' || value.length > 8192) throw new Error('unsupported source');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('unsupported source');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(hostname) && !isPublicAddress(hostname)) throw new Error('non-public source');
    url.hash = '';
    return url;
}
function eligible(files) {
    if (!Array.isArray(files) || !files.length || files.length > 10) return null;
    try {
        return files.map(file => {
            const raw = typeof file === 'string' || Buffer.isBuffer(file) ? file : file?.attachment;
            const name = typeof file === 'object' && !Buffer.isBuffer(file) && file?.name != null
                ? String(file.name) : typeof raw === 'string' ? path.basename(raw) : 'file.jpg';
            if (!name || /[\r\n\0]/.test(name)) throw new Error('invalid filename');
            if (Buffer.isBuffer(raw)) return { data: raw, name };
            return { url: publicUrl(raw), name };
        });
    } catch { return null; }
}
function safeContentType(data) {
    try { const mime = filetypeinfo(data)?.[0]?.mime; return OverwrittenMimeTypes[mime] || mime || ''; }
    catch { return ''; }
}
async function prepare(files, deps = {}) {
    const items = eligible(files);
    if (!items || typeof fs.openAsBlob !== 'function') return null;
    const root = deps.tmpdir || os.tmpdir();
    if (!deps.tmpdir && Date.now() - lastSweepAt > 60 * 60 * 1000) { lastSweepAt = Date.now(); removeStale(root).catch(() => {}); }
    const fetch = deps.fetch || require('node-fetch');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000); timeout.unref?.();
    let directory, release, reserved = 0, total = 0, succeeded = false;
    const created = [];
    const releaseResources = () => { release?.(); release = null; reservedDiskBytes -= reserved; reserved = 0; };
    const cleanupFiles = async () => {
        let failure;
        for (const filename of created) try { await fsp.unlink(filename); } catch (error) { if (error?.code !== 'ENOENT') failure ||= error; }
        if (directory) try { await fsp.rmdir(directory); } catch (error) { if (error?.code !== 'ENOENT') failure ||= error; }
        if (failure) throw failure;
    };
    try {
        if (items.length > 1) { release = reserve(null); if (!release) return null; }
        directory = await fsp.mkdtemp(path.join(root, `cbte-video-${process.pid}-`));
        const tasks = items.map(async (item, index) => {
            let response, agent;
            try {
                let declared, contentType;
                if (item.data) { declared = item.data.length; contentType = safeContentType(item.data); }
                else {
                    let target = item.url;
                    for (let redirects = 0; ; redirects++) {
                        agent = new (target.protocol === 'https:' ? https.Agent : http.Agent)({ keepAlive: false, lookup: deps.lookup || lookup });
                        response = await fetch(target.href, { agent, redirect: 'manual', signal: controller.signal,
                            headers: { 'User-Agent': 'undici', Accept: '*/*', 'Accept-Language': '*', 'Sec-Fetch-Mode': 'cors',
                                'Accept-Encoding': target.protocol === 'https:' ? 'br, gzip, deflate' : 'gzip, deflate' } });
                        if (![301, 302, 303, 307, 308].includes(response.status)) break;
                        const location = response.headers?.get?.('location');
                        if (!location || redirects >= 3) throw new Error('unsupported redirect');
                        target = publicUrl(new URL(location, target).href);
                        response.body?.destroy?.(); agent.destroy(); response = null; agent = null;
                    }
                    if (!response?.ok || !response.body) throw new Error('media unavailable');
                    const header = response.headers?.get?.('content-length');
                    const encoding = response.headers?.get?.('content-encoding');
                    // node-fetch decodes compressed bodies while the header
                    // still describes the compressed wire representation.
                    declared = (!encoding || encoding.toLowerCase() === 'identity') && header && /^\d+$/.test(header) ? Number(header) : null;
                    contentType = response.headers?.get?.('content-type') || '';
                }
                if (declared !== null && (!Number.isSafeInteger(declared) || declared > MAX_BYTES)) throw new Error('media size exceeded');
                if (!release) { release = reserve(declared); if (!release) throw new Error('capacity unavailable'); }
                const space = await (deps.statfs || fsp.statfs)(root);
                const available = Number(space.bavail) * Number(space.bsize), planned = declared || MAX_BYTES;
                if (!Number.isSafeInteger(available) || available < planned + reservedDiskBytes + 128 * 1024 * 1024) throw new Error('disk capacity unavailable');
                reservedDiskBytes += planned; reserved += planned;
                const filename = path.join(directory, `part-${index}`); created.push(filename);
                if (item.data) { total += item.data.length; if (total > MAX_BATCH_BYTES) throw new Error('batch too large'); await fsp.writeFile(filename, item.data, { flag: 'wx', mode: 0o600, signal: controller.signal }); }
                else {
                    let bytes = 0;
                    const meter = new Transform({ transform(chunk, _enc, done) {
                        bytes += chunk.length; total += chunk.length;
                        if (total > MAX_BATCH_BYTES || bytes > MAX_BYTES || declared !== null && bytes > declared) return done(new Error('media size exceeded'));
                        done(null, chunk);
                    } });
                    await pipeline(response.body, meter, fs.createWriteStream(filename, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
                    if (!bytes || declared !== null && bytes !== declared) throw new Error('media length mismatch');
                }
                if (!contentType) {
                    const file = await fsp.open(filename, 'r');
                    try { const header = Buffer.alloc(4096), { bytesRead } = await file.read(header, 0, header.length, 0); contentType = safeContentType(header.subarray(0, bytesRead)); }
                    finally { await file.close(); }
                }
                const blob = await fs.openAsBlob(filename, { type: contentType });
                return { blob, name: item.name };
            } catch (error) { controller.abort(); throw error; }
            finally { response?.body?.destroy?.(); agent?.destroy(); }
        });
        // Wait for every task to settle before touching their temporary files.
        const settled = await Promise.allSettled(tasks);
        if (settled.some(item => item.status === 'rejected')) return null;
        const output = settled.map(item => /** @type {PromiseFulfilledResult<any>} */ (item).value);
        succeeded = true;
        const cleanup = async () => { try { await cleanupFiles(); } finally { releaseResources(); } };
        return { files: output, blob: output[0].blob, name: output[0].name, cleanup };
    } catch { return null; }
    finally {
        clearTimeout(timeout); controller.abort();
        if (!succeeded) { try { await cleanupFiles(); } catch { console.warn('[streamedVideo] temporary media cleanup failed'); } releaseResources(); }
    }
}
module.exports = { prepare, _internal: { eligible, publicUrl, reserve, removeStale, SMALL_LIMIT, MAX_BYTES } };

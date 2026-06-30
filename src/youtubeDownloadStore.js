'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const fetch = require('node-fetch');

let _config = {};
try {
    const requireFn = require;
    _config = requireFn('../config.json');
} catch {
    _config = {};
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;
const DEFAULT_ROOT_DIR = path.join(__dirname, '..', 'data', 'youtube_downloads');
const DEFAULT_API_BASE_URL = 'https://yt-dlp.arcdc.jp';
const DEFAULT_PUBLIC_BASE_URL = 'https://download.youtube.cbte.sprink.cloud';
const ROUTE_PREFIX = '/youtube-downloads';
const MP4_720_FORMAT = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]';

let rootDirOverride = null;
let publicBaseUrlOverride = null;
let cleanupTimer = null;
let indexQueue = Promise.resolve();

function youtubeDownloadConfig() {
    return _config.youtubeDownload || _config.youtube_download || {};
}

function getRootDir() {
    return rootDirOverride
        || process.env.YOUTUBE_DOWNLOAD_DIR
        || youtubeDownloadConfig().dir
        || DEFAULT_ROOT_DIR;
}

function getFilesDir() {
    return path.join(getRootDir(), 'files');
}

function getIndexPath() {
    return path.join(getRootDir(), 'index.json');
}

function getApiBaseUrl() {
    return (process.env.YOUTUBE_DLP_API_BASE_URL
        || youtubeDownloadConfig().apiBaseUrl
        || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
}

function getPublicBaseUrl() {
    return (publicBaseUrlOverride
        || process.env.YOUTUBE_DOWNLOAD_PUBLIC_BASE_URL
        || youtubeDownloadConfig().publicBaseUrl
        || _config.publicBaseUrl
        || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, '');
}

function ttlMs() {
    const configured = Number(process.env.YOUTUBE_DOWNLOAD_TTL_MS || youtubeDownloadConfig().ttlMs);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TTL_MS;
}

function downloadPreset() {
    return {
        formatCode: youtubeDownloadConfig().formatCode || MP4_720_FORMAT,
        presetKey: youtubeDownloadConfig().presetKey || 'mp4-720',
        audioOption: youtubeDownloadConfig().audioOption || 'none',
    };
}

async function ensureDirs() {
    await fsp.mkdir(getFilesDir(), { recursive: true });
}

async function readIndex() {
    try {
        const parsed = JSON.parse(await fsp.readFile(getIndexPath(), 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
        if (err && err.code === 'ENOENT') return {};
        throw err;
    }
}

async function writeIndex(index) {
    await ensureDirs();
    const tmpPath = getIndexPath() + '.tmp';
    await fsp.writeFile(tmpPath, JSON.stringify(index, null, 2));
    await fsp.rename(tmpPath, getIndexPath());
}

function updateIndex(mutator) {
    indexQueue = indexQueue.catch(() => {}).then(async () => {
        const index = await readIndex();
        const result = await mutator(index);
        await writeIndex(index);
        return result;
    });
    return indexQueue;
}

function safeFilename(value, fallback) {
    const text = decodeURIComponent(String(value || fallback || 'youtube-download.mp4'))
        .replace(/[<>:"/\\|?*]/g, '_')
        .split('')
        .map(ch => ch.charCodeAt(0) < 32 ? '_' : ch)
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
    return (text || fallback || 'youtube-download.mp4').slice(0, 180);
}

function filenameFromDisposition(header, fallback) {
    if (!header) return fallback;
    const encoded = header.match(/filename\*=UTF-8''([^;]+)/i);
    if (encoded) return safeFilename(encoded[1], fallback);
    const quoted = header.match(/filename="([^"]+)"/i);
    if (quoted) return safeFilename(quoted[1], fallback);
    const bare = header.match(/filename=([^;]+)/i);
    if (bare) return safeFilename(bare[1], fallback);
    return fallback;
}

function contentTypeForFilename(filename) {
    const ext = path.extname(filename).toLowerCase();
    if (ext === '.mp4') return 'video/mp4';
    if (ext === '.mkv') return 'video/x-matroska';
    if (ext === '.webm') return 'video/webm';
    if (ext === '.mp3') return 'audio/mpeg';
    if (ext === '.m4a') return 'audio/mp4';
    if (ext === '.opus') return 'audio/ogg';
    return 'application/octet-stream';
}

function contentDisposition(filename) {
    return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function publicUrlForRecord(record) {
    return `${getPublicBaseUrl()}${ROUTE_PREFIX}/${encodeURIComponent(record.token)}/${encodeURIComponent(record.filename)}`;
}

function recordDir(token) {
    return path.join(getFilesDir(), token);
}

function recordFilePath(record) {
    return path.join(recordDir(record.token), record.filename);
}

async function deleteRecordFiles(token) {
    const dir = recordDir(token);
    const root = path.resolve(getFilesDir());
    const target = path.resolve(dir);
    if (!target.startsWith(root + path.sep)) return;
    await fsp.rm(target, { recursive: true, force: true });
}

async function cleanupExpiredDownloads(nowMs = Date.now()) {
    await ensureDirs();
    const index = await readIndex();
    let changed = false;
    for (const [token, record] of Object.entries(index)) {
        if (!record || Number(record.expiresAtMs) <= nowMs) {
            await deleteRecordFiles(token);
            delete index[token];
            changed = true;
        }
    }

    const known = new Set(Object.keys(index));
    const entries = await fsp.readdir(getFilesDir(), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (known.has(entry.name)) continue;
        const dir = path.join(getFilesDir(), entry.name);
        const stat = await fsp.stat(dir).catch(() => null);
        if (!stat || stat.mtimeMs + ttlMs() <= nowMs) {
            await fsp.rm(dir, { recursive: true, force: true });
        }
    }

    if (changed) await writeIndex(index);
    return Object.keys(index).length;
}

async function startRemoteDownload(url) {
    const body = { url, ...downloadPreset() };
    const res = await fetch(`${getApiBaseUrl()}/api/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const retryAfter = res.headers?.get ? res.headers.get('retry-after') : null;
        const err = Object.assign(new Error(`yt-dlp API returned ${res.status}`), {
            status: res.status,
            retryAfter,
        });
        throw err;
    }
    const json = await res.json();
    if (!json?.jobId) throw new Error('yt-dlp API did not return jobId');
    return json.jobId;
}

async function fetchRemoteFile(jobId) {
    const res = await fetch(`${getApiBaseUrl()}/api/download?jobId=${encodeURIComponent(jobId)}`);
    if (!res.ok) {
        const err = Object.assign(new Error(`yt-dlp file fetch returned ${res.status}`), {
            status: res.status,
        });
        throw err;
    }
    return res;
}

async function downloadYouTubeToCache(url, nowMs = Date.now()) {
    await cleanupExpiredDownloads(nowMs);
    await ensureDirs();

    const token = crypto.randomBytes(18).toString('base64url');
    const jobId = await startRemoteDownload(url);
    const res = await fetchRemoteFile(jobId);
    const fallbackName = `youtube-${token}.mp4`;
    const filename = filenameFromDisposition(res.headers?.get?.('content-disposition'), fallbackName);
    const dir = recordDir(token);
    await fsp.mkdir(dir, { recursive: true });
    const tmpPath = path.join(dir, filename + '.tmp');
    const finalPath = path.join(dir, filename);

    try {
        await pipeline(res.body, fs.createWriteStream(tmpPath));
        await fsp.rename(tmpPath, finalPath);
        const stat = await fsp.stat(finalPath);
        const record = {
            token,
            jobId,
            url,
            filename,
            sizeBytes: stat.size,
            createdAtMs: nowMs,
            expiresAtMs: nowMs + ttlMs(),
        };
        await updateIndex(index => {
            index[token] = record;
            return record;
        });
        return { ...record, publicUrl: publicUrlForRecord(record) };
    } catch (err) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        throw err;
    }
}

async function getRecord(token) {
    const index = await readIndex();
    return index[token] || null;
}

async function handleDownloadRequest(req, res) {
    await cleanupExpiredDownloads();
    const token = String(req.params.token || '');
    if (!/^[A-Za-z0-9_-]{16,}$/.test(token)) {
        res.status(404).send('Not found');
        return;
    }

    const record = await getRecord(token);
    if (!record || Number(record.expiresAtMs) <= Date.now()) {
        if (record) await cleanupExpiredDownloads();
        res.status(410).send('Expired');
        return;
    }

    const filePath = recordFilePath(record);
    const root = path.resolve(getFilesDir());
    const target = path.resolve(filePath);
    if (!target.startsWith(root + path.sep)) {
        res.status(404).send('Not found');
        return;
    }

    if (!fs.existsSync(target)) {
        res.status(404).send('Not found');
        return;
    }

    res.setHeader('Content-Type', contentTypeForFilename(record.filename));
    res.setHeader('Content-Disposition', contentDisposition(record.filename));
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(target).pipe(res);
}

function startCleanupTimer(intervalMs = DEFAULT_CLEANUP_INTERVAL_MS) {
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupExpiredDownloads().catch(err => console.warn('[youtubeDownloadStore] startup cleanup failed:', err?.message || err));
    cleanupTimer = setInterval(() => {
        cleanupExpiredDownloads().catch(err => console.warn('[youtubeDownloadStore] cleanup failed:', err?.message || err));
    }, intervalMs);
    if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
}

function stopCleanupTimer() {
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = null;
}

function configureForTest(rootDir, publicBaseUrl = 'https://example.test') {
    rootDirOverride = rootDir;
    publicBaseUrlOverride = publicBaseUrl;
    stopCleanupTimer();
    indexQueue = Promise.resolve();
}

module.exports = {
    ROUTE_PREFIX,
    cleanupExpiredDownloads,
    configureForTest,
    contentTypeForFilename,
    downloadYouTubeToCache,
    getPublicBaseUrl,
    handleDownloadRequest,
    publicUrlForRecord,
    startCleanupTimer,
    stopCleanupTimer,
    _internal: {
        downloadPreset,
        filenameFromDisposition,
        getFilesDir,
        getIndexPath,
        getRootDir,
        readIndex,
        safeFilename,
        ttlMs,
        writeIndex,
    },
};

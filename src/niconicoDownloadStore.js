'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const {
    cookieHeader,
    createHlsContentUrl,
    fetchWatchData,
    parseNiconicoUrl,
    pickBestDomandOutput,
} = require('./niconicoApi');

let _config = {};
try {
    const requireFn = require;
    _config = requireFn('../config.json');
} catch {
    _config = {};
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;
const DEFAULT_ROOT_DIR = path.join(__dirname, '..', 'data', 'niconico_downloads');
const DEFAULT_PUBLIC_BASE_URL = 'https://download.niconico.cbte.sprink.cloud';
const ROUTE_PREFIX = '/niconico-downloads';

let rootDirOverride = null;
let publicBaseUrlOverride = null;
let cleanupTimer = null;
let indexQueue = Promise.resolve();
let spawnImpl = spawn;

function niconicoDownloadConfig() {
    return _config.niconicoDownload || _config.niconico_download || {};
}

function getRootDir() {
    return rootDirOverride
        || process.env.NICONICO_DOWNLOAD_DIR
        || niconicoDownloadConfig().dir
        || DEFAULT_ROOT_DIR;
}

function getFilesDir() {
    return path.join(getRootDir(), 'files');
}

function getIndexPath() {
    return path.join(getRootDir(), 'index.json');
}

function getPublicBaseUrl() {
    return (publicBaseUrlOverride
        || process.env.NICONICO_DOWNLOAD_PUBLIC_BASE_URL
        || niconicoDownloadConfig().publicBaseUrl
        || _config.publicBaseUrl
        || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, '');
}

function getFfmpegPath() {
    return process.env.FFMPEG_PATH
        || process.env.NICONICO_FFMPEG_PATH
        || niconicoDownloadConfig().ffmpegPath
        || 'ffmpeg';
}

function ttlMs() {
    const configured = Number(process.env.NICONICO_DOWNLOAD_TTL_MS || niconicoDownloadConfig().ttlMs);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TTL_MS;
}

function boolFromConfig(value) {
    if (value === true || value === false) return value;
    if (value === undefined || value === null || value === '') return false;
    return /^(1|true|yes|on)$/i.test(String(value));
}

function isDownloadButtonEnabled() {
    const envValue = process.env.NICONICO_DOWNLOAD_BUTTON_ENABLED;
    if (envValue !== undefined && envValue !== null && envValue !== '') {
        return boolFromConfig(envValue);
    }

    const configured = niconicoDownloadConfig().buttonEnabled;
    if (configured !== undefined && configured !== null && configured !== '') {
        return boolFromConfig(configured);
    }

    return true;
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
    const text = String(value || fallback || 'niconico-download.mp4')
        .replace(/[<>:"/\\|?*]/g, '_')
        .split('')
        .map(ch => ch.charCodeAt(0) < 32 ? '_' : ch)
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
    return (text || fallback || 'niconico-download.mp4').slice(0, 180);
}

function filenameForWatchData(watchData, videoId) {
    const rawTitle = watchData?.video?.title || `niconico-${videoId}`;
    const base = safeFilename(rawTitle, `niconico-${videoId}`).replace(/\.+$/g, '');
    const withoutMp4 = base.replace(/\.mp4$/i, '');
    return `${withoutMp4 || `niconico-${videoId}`}.mp4`;
}

function contentTypeForFilename(filename) {
    const ext = path.extname(filename).toLowerCase();
    if (ext === '.mp4') return 'video/mp4';
    if (ext === '.m4a') return 'audio/mp4';
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

function ffmpegHeaders(cookieJar) {
    const domandCookie = cookieHeader(cookieJar, ['domand_bid']);
    const lines = [
        'User-Agent: niconico.py',
        'Referer: https://www.nicovideo.jp/',
    ];
    if (domandCookie) lines.unshift(`Cookie: ${domandCookie}`);
    return lines.join('\r\n') + '\r\n';
}

function appendLimitedLog(current, chunk, maxLength = 8000) {
    const text = current + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    return text.length > maxLength ? text.slice(text.length - maxLength) : text;
}

function runFfmpeg(hlsContentUrl, outputPath, cookieJar) {
    const args = [
        '-y',
        '-headers',
        ffmpegHeaders(cookieJar),
        '-protocol_whitelist',
        'file,http,https,tcp,tls,crypto',
        '-i',
        hlsContentUrl,
        '-c',
        'copy',
        '-movflags',
        'faststart',
        outputPath,
    ];

    return new Promise((resolve, reject) => {
        let log = '';
        let child;
        try {
            child = spawnImpl(getFfmpegPath(), args, { windowsHide: true });
        } catch (err) {
            reject(Object.assign(new Error(`Failed to start ffmpeg: ${err.message}`), { cause: err }));
            return;
        }

        child.stdout?.on?.('data', chunk => { log = appendLimitedLog(log, chunk); });
        child.stderr?.on?.('data', chunk => { log = appendLimitedLog(log, chunk); });
        child.on('error', err => {
            reject(Object.assign(new Error(`Failed to start ffmpeg: ${err.message}`), { cause: err, ffmpegLog: log }));
        });
        child.on('close', code => {
            if (code === 0) {
                resolve({ log });
                return;
            }
            reject(Object.assign(new Error(`ffmpeg exited with code ${code}${log ? `: ${log}` : ''}`), {
                code,
                ffmpegLog: log,
            }));
        });
    });
}

async function downloadNiconicoToCache(url, nowMs = Date.now()) {
    const parsed = parseNiconicoUrl(url);
    if (!parsed) throw new Error('No downloadable Niconico video URL was found');

    await cleanupExpiredDownloads(nowMs);
    await ensureDirs();

    const token = crypto.randomBytes(18).toString('base64url');
    const cookieJar = new Map();
    const watchData = await fetchWatchData(parsed.id, cookieJar);
    const output = pickBestDomandOutput(watchData);
    if (!output) throw new Error('No available Niconico DOMAND output was found');

    const hlsContentUrl = await createHlsContentUrl(watchData, [output.ids], cookieJar);
    const filename = filenameForWatchData(watchData, parsed.id);
    const dir = recordDir(token);
    await fsp.mkdir(dir, { recursive: true });
    const tmpPath = path.join(dir, `${path.basename(filename, '.mp4')}.${token}.tmp.mp4`);
    const finalPath = path.join(dir, filename);

    try {
        await runFfmpeg(hlsContentUrl, tmpPath, cookieJar);
        await fsp.rename(tmpPath, finalPath);
        const stat = await fsp.stat(finalPath);
        const record = {
            token,
            url: parsed.originalUrl || url,
            filename,
            sizeBytes: stat.size,
            createdAtMs: nowMs,
            expiresAtMs: nowMs + ttlMs(),
            videoId: parsed.id,
            outputLabel: output.label,
            outputIds: output.ids,
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
    cleanupExpiredDownloads().catch(err => console.warn('[niconicoDownloadStore] startup cleanup failed:', err?.message || err));
    cleanupTimer = setInterval(() => {
        cleanupExpiredDownloads().catch(err => console.warn('[niconicoDownloadStore] cleanup failed:', err?.message || err));
    }, intervalMs);
    if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
}

function stopCleanupTimer() {
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = null;
}

function configureForTest(rootDir, publicBaseUrl = 'https://example.test', nextSpawnImpl = spawn) {
    rootDirOverride = rootDir;
    publicBaseUrlOverride = publicBaseUrl;
    spawnImpl = nextSpawnImpl;
    stopCleanupTimer();
    indexQueue = Promise.resolve();
}

module.exports = {
    ROUTE_PREFIX,
    cleanupExpiredDownloads,
    configureForTest,
    contentTypeForFilename,
    downloadNiconicoToCache,
    getPublicBaseUrl,
    handleDownloadRequest,
    isDownloadButtonEnabled,
    publicUrlForRecord,
    startCleanupTimer,
    stopCleanupTimer,
    _internal: {
        boolFromConfig,
        ffmpegHeaders,
        filenameForWatchData,
        getFilesDir,
        getFfmpegPath,
        getIndexPath,
        getRootDir,
        readIndex,
        runFfmpeg,
        safeFilename,
        ttlMs,
        writeIndex,
    },
};

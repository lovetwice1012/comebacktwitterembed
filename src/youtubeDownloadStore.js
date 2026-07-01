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
const DEFAULT_PUBLIC_BASE_URL = 'https://cbte.sprink.cloud';
const ROUTE_PREFIX = '/youtube-downloads';
const UNIFIED_ROUTE_PREFIX = '/media/youtube';
const BEST_FORMAT = 'bestvideo+bestaudio/best';
const MUSIC_AUDIO_FORMAT = '774/bestaudio';

let rootDirOverride = null;
let publicBaseUrlOverride = null;
let cleanupTimer = null;
let indexQueue = Promise.resolve();

function youtubeDownloadConfig() {
    return _config.youtubeDownload || _config.youtube_download || {};
}

function dashboardConfig() {
    return _config.dashboard || {};
}

function mediaDeliveryConfig() {
    return _config.mediaDelivery || _config.media_delivery || {};
}

function getRootDir() {
    return rootDirOverride
        || process.env.YOUTUBE_DOWNLOAD_DIR
        || mediaDeliveryConfig().youtubeDownloadDir
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
        || process.env.MEDIA_DELIVERY_PUBLIC_BASE_URL
        || process.env.DASHBOARD_PUBLIC_BASE_URL
        || process.env.NEXTAUTH_URL
        || mediaDeliveryConfig().publicBaseUrl
        || dashboardConfig().publicBaseUrl
        || dashboardConfig().baseUrl
        || youtubeDownloadConfig().publicBaseUrl
        || _config.publicBaseUrl
        || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, '');
}

function useLegacyPublicRoute() {
    const configured = mediaDeliveryConfig().useLegacyRoutes;
    if (configured === true || configured === false) return configured;
    return /^(1|true|yes|on)$/i.test(String(process.env.MEDIA_DELIVERY_USE_LEGACY_ROUTES || ''));
}

function publicRoutePrefix() {
    return useLegacyPublicRoute() ? ROUTE_PREFIX : UNIFIED_ROUTE_PREFIX;
}

function ttlMs() {
    const configured = Number(process.env.YOUTUBE_DOWNLOAD_TTL_MS || mediaDeliveryConfig().ttlMs || youtubeDownloadConfig().ttlMs);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TTL_MS;
}

function boolFromConfig(value) {
    if (value === true || value === false) return value;
    if (value === undefined || value === null || value === '') return false;
    return /^(1|true|yes|on)$/i.test(String(value));
}

function isDownloadButtonEnabled() {
    return boolFromConfig(process.env.YOUTUBE_DOWNLOAD_BUTTON_ENABLED)
        || boolFromConfig(mediaDeliveryConfig().youtubeDownloadButtonEnabled)
        || boolFromConfig(youtubeDownloadConfig().buttonEnabled);
}

function downloadPreset() {
    return {
        formatCode: BEST_FORMAT,
        presetKey: 'best',
        audioOption: 'none',
    };
}

function musicDownloadPreset() {
    return {
        formatCode: MUSIC_AUDIO_FORMAT,
        presetKey: '774-opus',
        audioOption: 'none',
    };
}

function isYouTubeMusicUrl(url) {
    try {
        return new URL(url).hostname.toLowerCase() === 'music.youtube.com';
    } catch {
        return false;
    }
}

function presetKey(preset) {
    return JSON.stringify({
        formatCode: preset?.formatCode || '',
        presetKey: preset?.presetKey || null,
        audioOption: preset?.audioOption || 'none',
    });
}

function uniquePresets(presets) {
    const seen = new Set();
    return presets.filter((preset) => {
        const key = presetKey(preset);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function downloadPresetsForUrl(url) {
    if (isYouTubeMusicUrl(url)) return [musicDownloadPreset()];
    return uniquePresets([downloadPreset()]);
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
    return `${getPublicBaseUrl()}${publicRoutePrefix()}/${encodeURIComponent(record.token)}/${encodeURIComponent(record.filename)}`;
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

function requestBodyForPreset(url, preset) {
    const body = {
        url,
        formatCode: preset.formatCode,
        audioOption: preset.audioOption || 'none',
    };
    if (preset.presetKey) body.presetKey = preset.presetKey;
    else body.presetKey = null;
    return body;
}

async function startRemoteDownload(url, preset) {
    const body = requestBodyForPreset(url, preset);
    const res = await fetch(`${getApiBaseUrl()}/api/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const retryAfter = res.headers?.get ? res.headers.get('retry-after') : null;
        const errorBody = await readErrorBody(res);
        const details = errorBody ? `: ${errorBody}` : '';
        const err = Object.assign(new Error(`yt-dlp API returned ${res.status}${details}`), {
            status: res.status,
            retryAfter,
            body: errorBody,
        });
        throw err;
    }
    const json = await res.json();
    if (!json?.jobId) throw new Error('yt-dlp API did not return jobId');
    return json.jobId;
}

async function readErrorBody(res) {
    try {
        const text = await res.text();
        return String(text || '').slice(0, 1000);
    } catch {
        return '';
    }
}

function readNodeStreamText(stream, timeoutMs = 2500, maxChars = 6000) {
    return new Promise((resolve) => {
        let text = '';
        let settled = false;
        const timer = setTimeout(() => finish(), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();

        function cleanup() {
            clearTimeout(timer);
            stream.off?.('data', onData);
            stream.off?.('end', finish);
            stream.off?.('error', finish);
        }

        function finish() {
            if (settled) return;
            settled = true;
            cleanup();
            if (typeof stream.destroy === 'function') stream.destroy();
            resolve(text.slice(0, maxChars));
        }

        function onData(chunk) {
            text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
            if (text.length >= maxChars) finish();
        }

        stream.on?.('data', onData);
        stream.on?.('end', finish);
        stream.on?.('error', finish);
    });
}

function progressTextFromSse(raw) {
    const lines = [];
    const blocks = String(raw || '').replace(/\r/g, '').split(/\n\n+/);
    for (const block of blocks) {
        let eventName = '';
        const dataLines = [];
        for (const line of block.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }

        const dataText = dataLines.join('\n').trim();
        if (!dataText) continue;

        let message = dataText;
        try {
            const parsed = JSON.parse(dataText);
            if (typeof parsed === 'string') message = parsed;
            else message = parsed.error || parsed.message || parsed.log || parsed.line || parsed.status || parsed.filename || JSON.stringify(parsed);
        } catch {
            // Plain text SSE data is expected from log events.
        }

        lines.push(eventName && eventName !== 'message' ? `${eventName}: ${message}` : message);
    }
    return lines.join('\n').trim().slice(0, 4000);
}

async function fetchProgressLog(jobId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    if (typeof timer.unref === 'function') timer.unref();

    try {
        const res = await fetch(`${getApiBaseUrl()}/api/progress?jobId=${encodeURIComponent(jobId)}`, {
            headers: { Accept: 'text/event-stream' },
            signal: controller.signal,
        });
        if (!res.ok || !res.body) return '';
        const raw = await readNodeStreamText(res.body);
        return progressTextFromSse(raw);
    } catch {
        return '';
    } finally {
        clearTimeout(timer);
    }
}

async function fetchRemoteFile(jobId) {
    const res = await fetch(`${getApiBaseUrl()}/api/download?jobId=${encodeURIComponent(jobId)}`);
    if (!res.ok) {
        const body = await readErrorBody(res);
        const progressLog = await fetchProgressLog(jobId);
        const details = [
            body,
            progressLog ? `progress:\n${progressLog}` : '',
        ].filter(Boolean).join('\n');
        const suffix = details ? `: ${details}` : '';
        const err = Object.assign(new Error(`yt-dlp file fetch returned ${res.status}${suffix}`), {
            status: res.status,
            stage: 'file',
            body,
            progressLog,
        });
        throw err;
    }
    return res;
}

function shouldRetryWithNextPreset(err, presetIndex, presets) {
    if (presetIndex >= presets.length - 1) return false;
    if (err?.stage !== 'file') return false;
    return Number(err.status) === 500;
}

function fallbackFilenameForPreset(token, preset) {
    const formatCode = String(preset?.formatCode || '');
    const audioOption = String(preset?.audioOption || 'none');
    if (formatCode === MUSIC_AUDIO_FORMAT || (audioOption !== 'none' && /audio|774|bestaudio/.test(formatCode))) {
        return `youtube-${token}.webm`;
    }
    return `youtube-${token}.mp4`;
}

async function createRemoteDownload(url, presets) {
    let lastError = null;
    for (let i = 0; i < presets.length; i++) {
        const preset = presets[i];
        try {
            const jobId = await startRemoteDownload(url, preset);
            const res = await fetchRemoteFile(jobId);
            return { jobId, res, preset };
        } catch (err) {
            err.formatCode = preset.formatCode;
            err.presetKey = preset.presetKey || null;
            if (err instanceof Error && !err.message.includes('formatCode=')) {
                err.message += ` (formatCode=${preset.formatCode}, presetKey=${preset.presetKey || 'none'})`;
            }
            lastError = err;
            if (!shouldRetryWithNextPreset(err, i, presets)) break;
        }
    }
    throw lastError || new Error('yt-dlp download failed');
}

async function downloadYouTubeToCache(url, nowMs = Date.now()) {
    await cleanupExpiredDownloads(nowMs);
    await ensureDirs();

    const token = crypto.randomBytes(18).toString('base64url');
    const presets = downloadPresetsForUrl(url);
    const { jobId, res, preset } = await createRemoteDownload(url, presets);
    const fallbackName = fallbackFilenameForPreset(token, preset);
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
            formatCode: preset.formatCode,
            presetKey: preset.presetKey || null,
            audioOption: preset.audioOption || 'none',
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

async function listCachedDownloads() {
    await ensureDirs();
    const index = await readIndex();
    return Object.values(index);
}

async function deleteCachedDownload(token) {
    if (!/^[A-Za-z0-9_-]{16,}$/.test(String(token || ''))) return false;
    let record = null;
    await updateIndex(index => {
        record = index[token] || null;
        if (record) delete index[token];
        return record;
    });
    await deleteRecordFiles(token);
    return Boolean(record);
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
    UNIFIED_ROUTE_PREFIX,
    cleanupExpiredDownloads,
    configureForTest,
    contentTypeForFilename,
    downloadYouTubeToCache,
    deleteCachedDownload,
    getPublicBaseUrl,
    handleDownloadRequest,
    isDownloadButtonEnabled,
    listCachedDownloads,
    publicUrlForRecord,
    startCleanupTimer,
    stopCleanupTimer,
    _internal: {
        boolFromConfig,
        downloadPresetsForUrl,
        publicRoutePrefix,
        downloadPreset,
        fallbackFilenameForPreset,
        filenameFromDisposition,
        getFilesDir,
        getIndexPath,
        getRootDir,
        isYouTubeMusicUrl,
        musicDownloadPreset,
        requestBodyForPreset,
        readIndex,
        safeFilename,
        ttlMs,
        writeIndex,
    },
};

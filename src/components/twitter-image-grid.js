'use strict';

// Assemble up to 20 photographs without retaining them on disk. This module has
// no Discord side effects: callers decide who can see or replace the result.
const https = require('node:https');
const { lookup } = require('../providers/autoWatch/publicDns');

const MAX_IMAGES = 20;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// Twenty legitimate large attachments must remain usable; memory is bounded
// separately by the number of concurrently downloaded/decoded inputs.
const MAX_TOTAL_INPUT_BYTES = MAX_IMAGES * MAX_IMAGE_BYTES;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_OUTPUT_PIXELS = 16_000_000;
const MAX_DIMENSION = 8192;
const DEFAULT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 24 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const TOTAL_TIMEOUT_MS = 90000;
const MAX_REDIRECTS = 3;
const MAX_CONCURRENT = 2;
const MAX_WAITING = 8;
const INPUT_CONCURRENCY = 2;
const FORMAT_INFO = Object.freeze({ jpeg: ['image/jpeg', 'jpg'], png: ['image/png', 'png'], webp: ['image/webp', 'webp'] });
let active = 0;
const waiting = [];

function failure(code, message) { return Object.assign(new Error(message), { code }); }
async function acquire() {
    if (active < MAX_CONCURRENT) { active++; return; }
    if (waiting.length >= MAX_WAITING) throw failure('IMAGE_GRID_BUSY', '画像の処理が混み合っています。時間をおいて再度お試しください。');
    await new Promise(resolve => waiting.push(resolve));
}
function release() { const next = waiting.shift(); if (next) next(); else active--; }

function boundedInteger(value, fallback, min, max, name) {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw failure('IMAGE_GRID_OPTIONS', `${name}の値を確認してください。`);
    return value;
}
function gridOptions(options, count) {
    if (options == null) options = {};
    if (typeof options !== 'object' || Array.isArray(options)) throw failure('IMAGE_GRID_OPTIONS', '画像の配置を確認してください。');
    const columns = boundedInteger(options.columns, Math.ceil(Math.sqrt(count)), 1, MAX_IMAGES, '列数');
    const cellWidth = boundedInteger(options.cellWidth, 512, 128, 2048, '画像の幅');
    const cellHeight = boundedInteger(options.cellHeight, 512, 128, 2048, '画像の高さ');
    const gap = boundedInteger(options.gap, 0, 0, 64, '画像の間隔');
    const quality = boundedInteger(options.quality, 85, 30, 95, '画質');
    const maxOutputBytes = boundedInteger(options.maxOutputBytes, DEFAULT_OUTPUT_BYTES, 256 * 1024, MAX_OUTPUT_BYTES, 'ファイルサイズ');
    const fit = options.fit === undefined ? 'contain' : options.fit;
    const format = options.format === undefined ? 'jpeg' : options.format;
    const background = options.background === undefined ? '#ffffff' : options.background;
    if (!['contain', 'cover'].includes(fit) || !Object.hasOwn(FORMAT_INFO, format) || typeof background !== 'string' || !/^#[0-9a-f]{6}$/i.test(background))
        throw failure('IMAGE_GRID_OPTIONS', '画像の配置や形式を確認してください。');
    return { columns, cellWidth, cellHeight, gap, quality, maxOutputBytes, fit, format, background };
}

function validateUrl(value) {
    if (typeof value !== 'string' || value.length > 4096) throw failure('IMAGE_GRID_URL', '画像のリンクを確認してください。');
    let url; try { url = new URL(value); } catch { throw failure('IMAGE_GRID_URL', '画像のリンクを確認してください。'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || url.hash)
        throw failure('IMAGE_GRID_URL', '画像のリンクを確認してください。');
    const twitter = url.hostname === 'pbs.twimg.com' && /^\/media\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]+)?(?::(?:orig|large|medium|small|thumb))?$/.test(url.pathname);
    const discord = ['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
        && /^\/(?:ephemeral-)?attachments\/\d{1,25}\/\d{1,25}\/[^/]+$/.test(url.pathname);
    if (!twitter && !discord) throw failure('IMAGE_GRID_URL', '対応している画像のリンクを使用してください。');
    return url;
}
function imageFormat(data) {
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
    if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
    if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    if (data.length >= 16 && data.toString('ascii', 4, 8) === 'ftyp') {
        const shortSize = data.readUInt32BE(0);
        const extended = shortSize === 1;
        if (extended && data.length < 24) throw failure('IMAGE_GRID_FORMAT', '画像の形式を確認してください。');
        const size = extended ? data.readBigUInt64BE(8) : BigInt(shortSize);
        const brandOffset = extended ? 16 : 8, firstCompatible = brandOffset + 8;
        if (size < BigInt(firstCompatible) || size > BigInt(data.length) || size > 4096n || (Number(size) - firstCompatible) % 4 !== 0)
            throw failure('IMAGE_GRID_FORMAT', '画像の形式を確認してください。');
        const brands = [data.toString('ascii', brandOffset, brandOffset + 4)];
        for (let offset = firstCompatible; offset < Number(size); offset += 4) brands.push(data.toString('ascii', offset, offset + 4));
        // AVIS denotes an image sequence; never silently flatten a video or animation.
        if (brands.includes('avif') && !brands.includes('avis')) return 'avif';
    }
    throw failure('IMAGE_GRID_FORMAT', '画像の形式を確認してください。');
}

async function fetchImage(value, fetchImpl, signal, total) {
    let url = validateUrl(value);
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
        // The socket uses the validated DNS result itself, preventing a second
        // resolution from redirecting the request to a private address.
        const agent = new https.Agent({ keepAlive: false, lookup });
        let response;
        try {
            response = await fetchImpl(url.href, { redirect: 'manual', agent, signal, timeout: REQUEST_TIMEOUT_MS, size: MAX_IMAGE_BYTES });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const location = response.headers.get('location');
                if (!location || redirect === MAX_REDIRECTS) throw failure('IMAGE_GRID_DOWNLOAD', '画像を取得できませんでした。');
                url = validateUrl(new URL(location, url).href);
                response.body?.destroy();
                continue;
            }
            if (!response.ok || !response.body) throw failure('IMAGE_GRID_DOWNLOAD', '画像を取得できませんでした。');
            const length = response.headers.get('content-length');
            if (length && (!/^\d+$/.test(length) || Number(length) > MAX_IMAGE_BYTES)) throw failure('IMAGE_GRID_INPUT_SIZE', '画像のサイズが大きすぎます。');
            const chunks = []; let bytes = 0;
            for await (const chunk of response.body) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length; total.bytes += buffer.length;
                if (bytes > MAX_IMAGE_BYTES || total.bytes > MAX_TOTAL_INPUT_BYTES) throw failure('IMAGE_GRID_INPUT_SIZE', '画像のサイズが大きすぎます。');
                chunks.push(buffer);
            }
            if (!bytes) throw failure('IMAGE_GRID_FORMAT', '画像を読み込めませんでした。');
            const result = Buffer.concat(chunks, bytes); imageFormat(result); return result;
        } catch (error) {
            response?.body?.destroy();
            if (error?.code?.startsWith('IMAGE_GRID_')) throw error;
            throw failure('IMAGE_GRID_DOWNLOAD', '画像を取得できませんでした。');
        } finally { agent.destroy(); }
    }
    throw failure('IMAGE_GRID_DOWNLOAD', '画像を取得できませんでした。');
}

async function mapConcurrent(items, count, fn, controller) {
    const output = new Array(items.length); let next = 0, failureReason;
    const workers = Array.from({ length: Math.min(items.length, count) }, async () => {
        while (true) {
            if (controller.signal.aborted) return;
            const i = next++; if (i >= items.length) return;
            try { output[i] = await fn(items[i], i); }
            catch (error) { if (!failureReason) failureReason = error; controller.abort(); return; }
        }
    });
    // A peer may still be decoding when another peer fails. Do not release the
    // global permit until every in-flight operation has actually stopped.
    await Promise.all(workers);
    if (failureReason) throw failureReason;
    if (controller.signal.aborted) throw failure('IMAGE_GRID_TIMEOUT', '画像の処理に時間がかかりました。再度お試しください。');
    return output;
}

function geometry(count, options) {
    const columns = Math.min(options.columns, count), rows = Math.ceil(count / columns);
    const unscaledWidth = columns * options.cellWidth + (columns - 1) * options.gap;
    const unscaledHeight = rows * options.cellHeight + (rows - 1) * options.gap;
    const scale = Math.min(1, MAX_DIMENSION / unscaledWidth, MAX_DIMENSION / unscaledHeight, Math.sqrt(MAX_OUTPUT_PIXELS / (unscaledWidth * unscaledHeight)));
    const cellWidth = Math.max(1, Math.floor(options.cellWidth * scale));
    const cellHeight = Math.max(1, Math.floor(options.cellHeight * scale));
    const gap = Math.floor(options.gap * scale);
    return { columns, rows, cellWidth, cellHeight, gap, width: columns * cellWidth + (columns - 1) * gap,
        height: rows * cellHeight + (rows - 1) * gap, scaled: scale < 1 };
}

async function composeTwitterImageGrid(urls, options, deps = {}) {
    if (!Array.isArray(urls) || urls.length < 1 || urls.length > MAX_IMAGES) throw failure('IMAGE_GRID_COUNT', '画像は1〜20枚で指定してください。');
    // Validate every URL before doing any I/O, including when tests inject a fetch.
    urls.forEach(validateUrl);
    const config = gridOptions(options, urls.length), layout = geometry(urls.length, config);
    // A missing native addon must not prevent the rest of the Bot from starting.
    // The explicitly requested operation reports an error before any download.
    let sharp;
    try {
        // The CJS runtime value is callable; TypeScript resolves this package's
        // declarations through its ESM default export in this project.
        sharp = /** @type {typeof import('sharp').default} */ (/** @type {unknown} */ (require('sharp')));
    } catch { throw failure('IMAGE_GRID_UNAVAILABLE', '画像をまとめる機能を利用できません。'); }
    await acquire();
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
    timeout.unref?.();
    try {
        const fetchImpl = deps.fetch || require('node-fetch');
        const total = { bytes: 0 };
        // Do not retain all source files while decoding: fetch and resize one
        // source within each bounded worker, then retain only its small tile.
        const overlays = await mapConcurrent(urls, INPUT_CONCURRENCY, async (url, i) => {
            let data = await fetchImage(url, fetchImpl, controller.signal, total);
            try {
                const format = imageFormat(data);
                const input = sharp(data, { failOn: 'warning', limitInputPixels: MAX_INPUT_PIXELS, autoOrient: true, animated: false });
                const metadata = await input.metadata();
                if (!Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height) || metadata.width < 1 || metadata.height < 1
                    || metadata.width * metadata.height > MAX_INPUT_PIXELS || (metadata.pages || 1) > 1
                    || format === 'avif' && (metadata.format !== 'heif' || metadata.compression !== 'av1')) throw new Error('invalid image');
                const resized = await input.resize(layout.cellWidth, layout.cellHeight, { fit: config.fit, background: config.background }).png().toBuffer();
                return { input: resized, left: (i % layout.columns) * (layout.cellWidth + layout.gap), top: Math.floor(i / layout.columns) * (layout.cellHeight + layout.gap) };
            } catch { throw failure('IMAGE_GRID_FORMAT', '画像を読み込めませんでした。'); }
            finally { data = null; }
        }, controller);
        if (controller.signal.aborted) throw failure('IMAGE_GRID_TIMEOUT', '画像の処理に時間がかかりました。再度お試しください。');
        const composite = sharp({ create: { width: layout.width, height: layout.height, channels: 4, background: config.background } }).composite(overlays);
        let data = await composite.png().toBuffer(), width = layout.width, height = layout.height;
        let quality = config.quality, adapted = layout.scaled;
        for (let attempt = 0; attempt < 8; attempt++) {
            if (controller.signal.aborted) throw failure('IMAGE_GRID_TIMEOUT', '画像の処理に時間がかかりました。再度お試しください。');
            const transform = sharp(data, { limitInputPixels: MAX_OUTPUT_PIXELS });
            if (config.format === 'jpeg') data = await transform.jpeg({ quality }).toBuffer();
            else if (config.format === 'webp') data = await transform.webp({ quality }).toBuffer();
            else data = await transform.png().toBuffer();
            if (controller.signal.aborted) throw failure('IMAGE_GRID_TIMEOUT', '画像の処理に時間がかかりました。再度お試しください。');
            if (data.length <= config.maxOutputBytes) return { data, contentType: FORMAT_INFO[config.format][0], filename: `twitter-grid.${FORMAT_INFO[config.format][1]}`,
                width, height, columns: layout.columns, rows: layout.rows, adapted };
            adapted = true;
            if (config.format !== 'png' && quality > 40) quality = Math.max(40, quality - 15);
            else { width = Math.max(1, Math.floor(width * 0.8)); height = Math.max(1, Math.floor(height * 0.8)); data = await sharp(data).resize(width, height).png().toBuffer(); }
        }
        throw failure('IMAGE_GRID_OUTPUT_SIZE', 'まとめた画像が大きすぎます。画像の大きさを小さくしてください。');
    } catch (error) {
        if (error?.code?.startsWith('IMAGE_GRID_')) throw error;
        throw failure('IMAGE_GRID_PROCESS', '画像をまとめられませんでした。');
    } finally { clearTimeout(timeout); controller.abort(); release(); }
}

module.exports = { composeTwitterImageGrid, _internal: { validateUrl, imageFormat, gridOptions, geometry, fetchImage } };

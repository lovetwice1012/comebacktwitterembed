'use strict';

// Discord.js downloads URL attachments itself, without redirect validation or
// a pinned DNS lookup. Fetch X media here before handing bytes to Discord.
const https = require('node:https');
const { lookup: publicLookup } = require('../autoWatch/publicDns');

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15000;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_DECODES = 2;
const MAX_WAITING_DECODES = 8;
let activeDecodes = 0;
const decodeWaiters = [];
function error(code) { return Object.assign(new Error(code), { code }); }

async function acquireDecode(signal) {
    if (signal.aborted) throw error('TWITTER_MEDIA_TIMEOUT');
    if (activeDecodes < MAX_IMAGE_DECODES) { activeDecodes++; return; }
    if (decodeWaiters.length >= MAX_WAITING_DECODES) throw error('TWITTER_MEDIA_BUSY');
    await new Promise((resolve, reject) => {
        const waiter = { resolve, reject, signal, abort: null };
        waiter.abort = () => {
            const index = decodeWaiters.indexOf(waiter);
            if (index >= 0) decodeWaiters.splice(index, 1);
            reject(error('TWITTER_MEDIA_TIMEOUT'));
        };
        signal.addEventListener('abort', waiter.abort, { once: true });
        decodeWaiters.push(waiter);
    });
}
function releaseDecode() {
    while (decodeWaiters.length) {
        const waiter = decodeWaiters.shift();
        waiter.signal.removeEventListener('abort', waiter.abort);
        if (!waiter.signal.aborted) { waiter.resolve(); return; }
    }
    activeDecodes--;
}
async function validateImageDecode(data, signal) {
    await acquireDecode(signal);
    try {
        let sharp;
        try { sharp = /** @type {any} */ (require('sharp')); } catch { throw error('TWITTER_MEDIA_DECODER_UNAVAILABLE'); }
        try {
            // Decode a bounded small output to verify image data without
            // altering the original bytes eventually submitted to Discord.
            await sharp(data, { failOn: 'warning', limitInputPixels: MAX_IMAGE_PIXELS, animated: false })
                .resize({ width: 1, height: 1, fit: 'inside', withoutEnlargement: true }).raw().toBuffer();
        } catch { throw error('TWITTER_MEDIA_FORMAT'); }
        if (signal.aborted) throw error('TWITTER_MEDIA_TIMEOUT');
    } finally { releaseDecode(); }
}

const { validateTwitterMediaUrl } = require('./twitterSourceParser/mediaUrlPolicy');

function detectTwitterMediaFormat(data, kind) {
    if (!Buffer.isBuffer(data)) throw error('TWITTER_MEDIA_FORMAT');
    if (kind === 'photo') {
        if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
        if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
        if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'webp';
        if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) return 'gif';
    }
    if (data.length >= 16 && data.toString('ascii', 4, 8) === 'ftyp') {
        const shortSize = data.readUInt32BE(0), extended = shortSize === 1;
        if (extended && data.length < 24) throw error('TWITTER_MEDIA_FORMAT');
        const size = extended ? data.readBigUInt64BE(8) : BigInt(shortSize);
        const brandOffset = extended ? 16 : 8, firstCompatible = extended ? 24 : 16;
        if (size < BigInt(firstCompatible) || size > BigInt(data.length) || size > 4096n || (Number(size) - firstCompatible) % 4 !== 0)
            throw error('TWITTER_MEDIA_FORMAT');
        const brands = [data.toString('ascii', brandOffset, brandOffset + 4)];
        for (let offset = firstCompatible; offset < Number(size); offset += 4) brands.push(data.toString('ascii', offset, offset + 4));
        const avif = brands.includes('avif') || brands.includes('avis');
        if (kind === 'photo' && avif) return 'avif';
        if (kind === 'video' && !avif && brands.some(brand => /^(?:isom|iso[2-9]|mp4[12]|avc1|dash|M4V\x20|qt\x20\x20|MSNV|3gp[456]|3g2a)$/.test(brand))) return 'mp4';
    }
    throw error('TWITTER_MEDIA_FORMAT');
}

async function fetchTwitterMedia(raw, options = {}) {
    const maxBytes = options.maxBytes ?? MAX_MEDIA_BYTES, timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_MEDIA_BYTES
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) throw error('TWITTER_MEDIA_INVALID_LIMIT');
    let current = validateTwitterMediaUrl(raw, options.kind || 'any');
    const originalKind = current.kind, fetchImpl = options.fetch || require('node-fetch');
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
        for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
            // Validation and the socket use the same DNS result. A second
            // unvalidated lookup cannot replace it with a private address.
            const agent = new https.Agent({ keepAlive: false, lookup: options.lookup || publicLookup });
            let response;
            try {
                response = await fetchImpl(current.url.href, { agent, redirect: 'manual', timeout: timeoutMs,
                    signal: controller.signal, size: maxBytes });
                if ([301, 302, 303, 307, 308].includes(response.status)) {
                    const location = response.headers?.get?.('location');
                    if (!location || redirect === MAX_REDIRECTS) throw error('TWITTER_MEDIA_REDIRECT');
                    let next;
                    try { next = new URL(location, current.url).href; } catch { throw error('TWITTER_MEDIA_REDIRECT'); }
                    current = validateTwitterMediaUrl(next, originalKind);
                    response.body?.destroy?.();
                    continue;
                }
                if (!response.ok || !response.body) throw error('TWITTER_MEDIA_FETCH_FAILED');
                const length = response.headers?.get?.('content-length');
                if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw error('TWITTER_MEDIA_TOO_LARGE');
                const chunks = []; let total = 0;
                for await (const chunk of response.body) {
                    const buffer = Buffer.from(chunk); total += buffer.length;
                    if (total > maxBytes) throw error('TWITTER_MEDIA_TOO_LARGE');
                    chunks.push(buffer);
                }
                if (!total) throw error('TWITTER_MEDIA_FETCH_FAILED');
                const data = Buffer.concat(chunks, total), format = detectTwitterMediaFormat(data, originalKind);
                if (originalKind === 'photo') await validateImageDecode(data, controller.signal);
                return { data, contentType: response.headers?.get?.('content-type') || null, format, kind: originalKind };
            } finally { response?.body?.destroy?.(); agent.destroy(); }
        }
        throw error('TWITTER_MEDIA_REDIRECT');
    } catch (cause) {
        if (String(cause?.code || '').startsWith('TWITTER_MEDIA_')) throw cause;
        throw error(controller.signal.aborted ? 'TWITTER_MEDIA_TIMEOUT' : 'TWITTER_MEDIA_FETCH_FAILED');
    } finally { clearTimeout(timeout); controller.abort(); }
}

module.exports = { validateTwitterMediaUrl, fetchTwitterMedia, detectTwitterMediaFormat, MAX_MEDIA_BYTES };

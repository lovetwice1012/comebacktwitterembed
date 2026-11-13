'use strict';

// Resolve Instagram image attachments before any Discord call. Only this
// bounded preflight can be retried; a Discord request is never retried here.
const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const fetch = require('node-fetch');
const { publicAddress } = require('../../automation/transport');

// Exceeding these temporary preparation budgets leaves the original file URLs
// to the existing Discord path; it does not change the platform's upload limit.
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const TOTAL_DEADLINE_MS = 20000;
const ATTEMPT_DEADLINE_MS = 15000;
const MAX_REDIRECTS = 3;
const MAX_PREPARATIONS = 2;
const DOWNLOAD_CONCURRENCY = 3;
let activePreparations = 0;
const TRANSIENT = new Set(['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNABORTED', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'UND_ERR_SOCKET', 'PREPARE_TIMEOUT']);

function instagramCdn(raw) {
    try {
        const url = new URL(raw);
        const host = url.hostname.toLowerCase();
        if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
            || !(host === 'cdninstagram.com' || host.endsWith('.cdninstagram.com') || host === 'fbcdn.net' || host.endsWith('.fbcdn.net'))) return null;
        return url;
    } catch { return null; }
}

function urlClass(raw) {
    try {
        const url = new URL(raw), host = url.hostname.toLowerCase().replace(/\.$/, '');
        if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
            || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || net.isIP(host.replace(/^\[|\]$/g, ''))) return 'unsafe';
        return instagramCdn(raw) ? 'supported' : 'unsupported';
    } catch { return 'unsafe'; }
}

function eligible(files) {
    return Array.isArray(files) && files.length > 0 && files.length <= 10 && files.every(file =>
        file && typeof file === 'object' && typeof file.attachment === 'string'
        && typeof file.name === 'string' && /\.(?:jpe?g|png|webp|gif)$/i.test(file.name));
}

const prepError = code => Object.assign(new Error(code), { code });
function beforeDeadline(promise, deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(prepError('PREPARE_TIMEOUT'));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(prepError('PREPARE_TIMEOUT')), remaining);
        Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(timer));
    });
}

function createPreparer({ lookup = dns.lookup, fetchImpl = fetch, totalDeadlineMs = TOTAL_DEADLINE_MS, attemptDeadlineMs = ATTEMPT_DEADLINE_MS } = {}) {
    function resolvePublic(hostname, deadline, cache) {
        if (!cache.has(hostname)) {
            const pending = (async () => {
                for (let attempt = 0; attempt < 2; attempt++) {
                    let addresses;
                    try { addresses = await beforeDeadline(lookup(hostname, { all: true }), Math.min(deadline, Date.now() + attemptDeadlineMs)); }
                    catch (error) {
                        const code = error?.code || error?.cause?.code;
                        if (!attempt && ['EAI_AGAIN', 'ETIMEDOUT', 'PREPARE_TIMEOUT'].includes(code) && Date.now() < deadline) continue;
                        throw prepError('MEDIA_DNS_FAILURE');
                    }
                    if (!addresses.length || addresses.some(record => !publicAddress(record.address))) throw prepError('UNSAFE_MEDIA_ADDRESS');
                    return addresses;
                }
                throw prepError('MEDIA_DNS_FAILURE');
            })();
            cache.set(hostname, pending);
        }
        return cache.get(hostname);
    }
    async function download(raw, deadline, cache, redirects = 0, addressOffset = 0) {
        const url = instagramCdn(raw);
        if (!url || redirects > MAX_REDIRECTS) throw prepError('UNSAFE_MEDIA_URL');
        const addresses = await resolvePublic(url.hostname, deadline, cache);
        // Keep all validated addresses available to Node's Happy Eyeballs;
        // retry rotates the first address for older single-address callers.
        const offset = addressOffset % addresses.length;
        const targets = [...addresses.slice(offset), ...addresses.slice(0, offset)];
        const target = targets[0];
        const agent = new https.Agent({ lookup: (_host, options, callback) => options?.all
            ? callback(null, targets.map(record => ({ address: record.address, family: record.family })))
            : callback(null, target.address, target.family) });
        const controller = new AbortController();
        const remaining = Math.min(attemptDeadlineMs, deadline - Date.now());
        if (remaining <= 0) { agent.destroy(); throw prepError('PREPARE_TIMEOUT'); }
        const timer = setTimeout(() => controller.abort(), remaining);
        try {
            const response = await fetchImpl(url.href, { agent, redirect: 'manual', signal: controller.signal, size: MAX_FILE_BYTES });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                response.body?.destroy?.();
                const location = response.headers?.get?.('location');
                if (!location) throw prepError('MEDIA_REDIRECT_INVALID');
                return await download(new URL(location, url).href, deadline, cache, redirects + 1, addressOffset);
            }
            if (!response.ok) throw Object.assign(prepError('MEDIA_FETCH_FAILED'), { status: response.status });
            const type = response.headers?.get?.('content-type') || '';
            if (!/^image\/(?:jpeg|png|webp|gif)(?:\s*;|$)/i.test(type)) throw prepError('MEDIA_TYPE_UNSUPPORTED');
            const buffer = await response.buffer();
            if (!buffer.length || buffer.length > MAX_FILE_BYTES) throw prepError('MEDIA_SIZE_EXCEEDED');
            return buffer;
        } catch (error) {
            if (controller.signal.aborted) throw prepError('PREPARE_TIMEOUT');
            if (error?.type === 'max-size') throw prepError('MEDIA_SIZE_EXCEEDED');
            throw error;
        } finally { clearTimeout(timer); agent.destroy(); }
    }
    return async function prepare(files) {
        if (!eligible(files)) return null;
        const classes = files.map(file => urlClass(file.attachment));
        if (classes.includes('unsafe')) throw Object.assign(prepError('INSTAGRAM_ATTACHMENT_PREPARE_FAILED'), { cause: { code: 'UNSAFE_MEDIA_URL' } });
        if (classes.includes('unsupported')) return null;
        const urls = files.map(file => instagramCdn(file.attachment));
        if (activePreparations >= MAX_PREPARATIONS) return null;
        activePreparations++;
        let released = false, transferred = false;
        const release = () => { if (!released) { released = true; activePreparations--; } };
        try {
            const deadline = Date.now() + totalDeadlineMs;
            const ready = new Array(files.length); let total = 0, next = 0;
            /** @type {{ failure: null | { fallback?: boolean, code?: string } }} */
            const state = { failure: null };
            const addresses = new Map();
            // Every original host is checked before any image can fall back to
            // Discord's existing downloader. Redirects are checked separately.
            const checks = await Promise.allSettled(urls.map(url => resolvePublic(url.hostname, deadline, addresses)));
            if (checks.some(check => check.status === 'rejected')) throw Object.assign(prepError('INSTAGRAM_ATTACHMENT_PREPARE_FAILED'), { cause: { code: 'MEDIA_ADDRESS_INVALID' } });
            async function worker() {
                while (!state.failure && next < files.length) {
                    const index = next++, file = files[index]; let buffer;
                    for (let attempt = 0; attempt < 2 && !state.failure; attempt++) {
                        try { buffer = await download(file.attachment, deadline, addresses, 0, attempt); break; }
                        catch (error) {
                            const code = error?.code || error?.cause?.code;
                            if (code === 'MEDIA_SIZE_EXCEEDED' || code === 'MEDIA_TYPE_UNSUPPORTED') { state.failure ||= { fallback: true }; break; }
                            if (attempt || !TRANSIENT.has(code) || Date.now() >= deadline) {
                                // Never log signed URLs or response bodies.
                                const safeCode = /^[A-Z0-9_]{1,64}$/.test(String(code || '')) ? String(code) : 'UNKNOWN';
                                if (TRANSIENT.has(code)) state.failure ||= { fallback: true };
                                else state.failure = { code: safeCode };
                                break;
                            }
                        }
                    }
                    if (state.failure) break;
                    total += buffer.length;
                    if (total > MAX_TOTAL_BYTES) { state.failure = { fallback: true }; break; }
                    ready[index] = { ...file, attachment: buffer, fallbackUrl: file.fallbackUrl || file.attachment };
                }
            }
            await Promise.all(Array.from({ length: Math.min(files.length, DOWNLOAD_CONCURRENCY) }, () => worker()));
            if (state.failure?.fallback) return null;
            if (state.failure) throw Object.assign(prepError('INSTAGRAM_ATTACHMENT_PREPARE_FAILED'), { cause: { code: state.failure.code } });
            transferred = true;
            return { files: ready, release };
        } finally { if (!transferred) release(); }
    };
}

module.exports = { prepare: createPreparer(), createPreparer, _internal: { instagramCdn, urlClass, eligible, MAX_FILE_BYTES, MAX_TOTAL_BYTES } };

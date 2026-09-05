'use strict';

const { positiveInteger } = require('./databasePool');
const telemetry = require('./adminSupport/telemetry');
const crypto = require('crypto');
const { Readable } = require('stream');

async function nextBeforeAbort(iterator, signal) {
    if (!signal) return iterator.next();
    if (signal.aborted) throw Object.assign(new Error('HTTP response body deadline reached.'), { name: 'AbortError', code: 'EVIDENCE_BODY_ABORTED' });
    return new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('HTTP response body deadline reached.'), { name: 'AbortError', code: 'EVIDENCE_BODY_ABORTED' }));
        signal.addEventListener('abort', abort, { once: true });
        iterator.next().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

// Read at most the evidence limit plus one stream chunk, then expose every
// original byte (including the unread tail) to the provider. A node-fetch clone
// would stall on the unconsumed original branch's high-water mark for large
// error bodies. This uses one upstream reader and a bounded replay prefix.
async function boundedResponsePrefix(response, limit, signal) {
    const original = response.body;
    const chunks = [];
    let bytes = 0, complete = false, readError = null, iterator = null;
    if (original && typeof original[Symbol.asyncIterator] === 'function') {
        iterator = original[Symbol.asyncIterator]();
        try {
            while (bytes <= limit) {
                const next = await nextBeforeAbort(iterator, signal);
                if (next.done) { complete = true; break; }
                const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
                chunks.push(chunk); bytes += chunk.length;
            }
        } catch (error) { readError = error; }
    } else {
        const buffer = original == null ? Buffer.alloc(0) : Buffer.isBuffer(original) ? original : Buffer.from(String(original));
        chunks.push(buffer); bytes = buffer.length; complete = true;
    }
    const prefix = Buffer.concat(chunks, Math.min(bytes, limit));
    const replacement = Readable.from((async function* () {
        for (const chunk of chunks) yield chunk;
        if (readError) throw readError;
        if (!complete && iterator) {
            while (true) {
                const next = await nextBeforeAbort(iterator, signal);
                if (next.done) break;
                yield next.value;
            }
        }
    })(), { objectMode: false });
    const { Response } = require('node-fetch');
    const reconstructed = new Response(replacement, { status: response.status, statusText: response.statusText,
        headers: response.headers, url: response.url, counter: response.redirected ? 1 : 0,
        size: response.size, timeout: response.timeout });
    return { response: reconstructed, prefix, bytes, complete, error: readError,
        dispose: () => { replacement.destroy(); if (original && typeof original.destroy === 'function') original.destroy(); } };
}

function capturedText(text) {
    let redacted = false;
    try {
        const value = JSON.parse(text);
        const sanitized = JSON.stringify(value, (key, item) => {
            if (/^(access_token|refresh_token|id_token|client_secret|api_key|authorization|password|secret|x-admin-agent-token)$/i.test(key)) {
                redacted = true; return '[credential omitted]';
            }
            return item;
        });
        return { body: redacted ? sanitized : text, credentialsRedacted: redacted };
    } catch { return { body: text, credentialsRedacted: false }; }
}

function safeUrl(url) {
    try {
        const parsed = new URL(String(url));
        parsed.username = ''; parsed.password = '';
        parsed.pathname = parsed.pathname.replace(/(\/api\/webhooks\/\d+\/)[^/]+/, '$1[credential-omitted]');
        for (const key of parsed.searchParams.keys()) {
            if (/token|key|secret|auth|password/i.test(key)) parsed.searchParams.set(key, '[credential omitted]');
        }
        return parsed.toString();
    } catch { return String(url); }
}

async function observedFetch(fetchImpl, url, options) {
    const context = telemetry.current();
    if (!telemetry.enabled() && !context?.preview && !context?.events && !context?.httpAttempts) return fetchImpl(url, options);
    const started = performance.now();
    const requestId = crypto.randomUUID();
    const bodyBytes = typeof options.body === 'string' ? Buffer.from(options.body) : Buffer.isBuffer(options.body) ? options.body : null;
    const request = { requestId, url: safeUrl(url), method: options.method || 'GET',
        requestHeaders: telemetry.serializable(options.headers || {}), timeoutMs: options.timeout,
        requestBody: typeof options.body === 'string' ? capturedText(options.body.slice(0, 262144)).body : undefined,
        requestBodyHash: bodyBytes ? crypto.createHash('sha256').update(bodyBytes).digest('hex') : null,
        requestBodyPresent: options.body !== undefined && options.body !== null };
    telemetry.event('http', 'started', request, { span_id: requestId });
    if (context?.replay) {
        // Child contexts share this set. Match requests, not response-completion
        // order; parallel fetches and recursive quotes can complete out of order.
        context.replayState ||= { consumed: new Set() };
        const eligible = context.replay.map((attempt, index) => ({ attempt, index })).filter(({ attempt, index }) => {
            if (context.replayState.consumed.has(index) || attempt.url !== request.url || (attempt.method || 'GET') !== request.method) return false;
            if (attempt.requestBodyHash !== undefined) return attempt.requestBodyHash === request.requestBodyHash;
            return (attempt.requestBody || undefined) === (request.requestBody || undefined);
        }).sort((a, b) => (a.attempt.invocationOrder ?? a.index) - (b.attempt.invocationOrder ?? b.index));
        const chosen = eligible[0];
        const next = chosen?.attempt;
        if (!next || next.truncated || next.body === undefined && !(next.error && !next.status)) {
            const error = Object.assign(new Error(`Saved HTTP evidence unavailable for ${request.method} ${request.url}; network access is disabled during replay.`), { code: 'REPLAY_EVIDENCE_MISSING' });
            telemetry.event('http', 'failed', { ...request, error: telemetry.errorData(error) });
            throw error;
        }
        context.replayState.consumed.add(chosen.index);
        if (next.error && !next.status) {
            context.httpAttempts?.push({ ...next, replayed: true });
            throw Object.assign(new Error(next.error.message || 'Recorded HTTP failure'), next.error);
        }
        const { Response } = require('node-fetch');
        const body = next.bodyEncoding === 'base64' ? Buffer.from(next.body, 'base64') : next.body;
        context.httpAttempts?.push({ ...next, replayed: true });
        return new Response(body, { status: next.status, headers: next.headers, url: next.responseUrl || next.url });
    }
    const attempt = { ...request, invocationOrder: context?.httpAttempts?.length || 0, bodyState: 'awaiting_headers' };
    context?.httpAttempts?.push(attempt);
    let response;
    try { response = await fetchImpl(url, options); } catch (error) {
        Object.assign(attempt, { durationMs: performance.now() - started, error: telemetry.errorData(error) });
        telemetry.event('http', 'failed', attempt, { span_id: requestId });
        throw error;
    }
    Object.assign(attempt, { status: response.status, statusText: response.statusText,
        responseUrl: safeUrl(response.url || url), redirected: response.redirected,
        headers: telemetry.serializable(Object.fromEntries(response.headers.entries())), headersMs: performance.now() - started,
        bodyState: 'not_consumed' });
    telemetry.event('http', 'headers', attempt, { span_id: requestId });
    const limit = Math.min(positiveInteger(process.env.ADMIN_HTTP_EVIDENCE_BYTES, 1048576, 4194304), Number(options.size) > 0 ? Number(options.size) : Infinity);
    const textual = /json|text|xml|html|javascript|urlencoded/i.test(response.headers.get('content-type') || 'text/plain');
    const savePrefix = (captured, reason) => {
        const value = textual ? capturedText(captured.prefix.toString('utf8')) : { body: captured.prefix.toString('base64'), credentialsRedacted: false };
        Object.assign(attempt, { ...value, bodyEncoding: textual ? 'utf8' : 'base64', bytes: captured.bytes,
            savedBytes: captured.prefix.length, totalBytes: captured.complete ? captured.bytes : null,
            bytesComplete: captured.complete, truncated: captured.bytes > limit || !captured.complete,
            bodyState: captured.error ? 'failed' : captured.complete && captured.bytes <= limit ? 'complete' : 'truncated',
            durationMs: performance.now() - started, captureReason: reason,
            ...(captured.error ? { error: telemetry.errorData(captured.error) } : {}) });
        telemetry.event('http', captured.error ? 'failed' : 'completed', attempt, { span_id: requestId });
    };
    let prefetched;
    if (context && response.ok === false) {
        prefetched = await boundedResponsePrefix(response, limit, options.signal);
        savePrefix(prefetched, 'non_success_response');
        response = prefetched.response;
    }
    let providerConsumed = false;
    if (context?.preview) {
        telemetry.deferCapture(async () => {
            if (providerConsumed) return;
            if (prefetched) { prefetched.dispose(); return; }
            if (response.bodyUsed || response.body?.readableDidRead || response.body?.readableEnded) {
                Object.assign(attempt, { bodyState: 'stream_consumed_without_capture', durationMs: performance.now() - started });
                telemetry.event('http', 'capture_unavailable', attempt, { span_id: requestId });
                return;
            }
            const captured = await boundedResponsePrefix(response, limit, options.signal);
            savePrefix(captured, 'unused_diagnostic_response');
            captured.dispose();
        });
    }
    // Consume exactly the body that the provider consumes, without cloning a
    // response or introducing a competing reader of the network stream.
    const originalBuffer = typeof response.buffer === 'function' ? response.buffer.bind(response) : async () => Buffer.from(await response.arrayBuffer());
    const consume = async () => {
        providerConsumed = true;
        try {
            const buffer = await originalBuffer();
            const captured = textual ? capturedText(buffer.subarray(0, limit).toString('utf8')) : { body: buffer.subarray(0, limit).toString('base64'), credentialsRedacted: false };
            Object.assign(attempt, { ...captured,
                bodyEncoding: textual ? 'utf8' : 'base64', bytes: buffer.length, truncated: buffer.length > limit,
                savedBytes: Math.min(buffer.length, limit), totalBytes: buffer.length, bytesComplete: true,
                bodyState: buffer.length > limit ? 'truncated' : 'complete', durationMs: performance.now() - started });
            telemetry.event('http', 'completed', attempt, { span_id: requestId });
            return buffer;
        } catch (error) {
            Object.assign(attempt, { bodyState: 'failed', error: telemetry.errorData(error), durationMs: performance.now() - started });
            telemetry.event('http', 'failed', attempt, { span_id: requestId });
            throw error;
        }
    };
    response.buffer = consume;
    response.arrayBuffer = async () => { const data = await consume(); return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength); };
    response.text = async () => (await consume()).toString('utf8');
    response.json = async () => {
        const text = await response.text();
        try { return JSON.parse(text); } catch (error) {
            telemetry.event('parse', 'failed', { requestId, url: request.url, expected: 'JSON', error: telemetry.errorData(error) });
            throw error;
        }
    };
    return response;
}

function withDeadline(fetchImpl, defaultTimeoutMs = positiveInteger(process.env.BOT_PROVIDER_TIMEOUT_MS, 30000, 300000)) {
    return (url, options = {}) => {
        const timeoutMs = positiveInteger(options.timeout, defaultTimeoutMs, 300000);
        const deadline = AbortSignal.timeout(timeoutMs);
        const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
        // The signal remains active while consuming the body and across
        // redirects. Aborting destroys the actual node-fetch request/stream.
        return observedFetch(fetchImpl, url, { ...options, timeout: timeoutMs, signal });
    };
}

module.exports = { withDeadline };

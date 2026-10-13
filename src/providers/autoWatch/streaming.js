'use strict';

// Limits apply to the small metadata projection, never to the downloaded page.
// Parsing is performed in the isolated fetch worker, outside the Bot process.
const { parser } = require('stream-json');
const { StringDecoder } = require('node:string_decoder');
const { once } = require('node:events');
const { finished } = require('node:stream/promises');
const MAX_SCALAR = 64 * 1024;
const MAX_DEPTH = 64;
const MAX_NODES = 50000;
const MAX_RETAINED = 16 * 1024 * 1024;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function pressure() {
    return Object.assign(new Error('Automatic-watch metadata temporarily exceeds its isolated processing budget.'),
        { code: 'AUTO_WATCH_RESOURCE_PRESSURE', retryAfterMs: 60000 });
}

function createBudget() {
    let bytes = 0, nodes = 0;
    return { add(value = '', count = 1) {
        bytes += Buffer.byteLength(String(value)) + count * 48;
        nodes += count;
        if (bytes > MAX_RETAINED || nodes > MAX_NODES) throw pressure();
    } };
}

async function* responseChunks(response) {
    // Only test doubles without a real body use text(). Network responses are
    // always consumed with backpressure, without response.text()/buffer().
    if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
        yield await response.text();
        return;
    }
    const decoder = new StringDecoder('utf8');
    try {
        for await (const chunk of response.body) {
            const text = decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            if (text) yield text;
        }
        const tail = decoder.end();
        if (tail) yield tail;
    } finally {
        if (!response.body.readableEnded && typeof response.body.destroy === 'function') response.body.destroy();
    }
}

function matches(pattern, path, i = 0, j = 0) {
    if (i === pattern.length) return j === path.length;
    if (pattern[i] === '**') return matches(pattern, path, i + 1, j)
        || j < path.length && matches(pattern, path, i, j + 1);
    return j < path.length && (pattern[i] === '*' || String(pattern[i]) === String(path[j]))
        && matches(pattern, path, i + 1, j + 1);
}

// Keep explicit empty/null ancestors (e.g. data.user:null or errors:[{}]). A
// recursive '**' search does not retain every unrelated container it traverses.
function explicitPrefix(pattern, path) {
    if (path.length > pattern.length) return false;
    for (let i = 0; i < path.length; i++) {
        if (pattern[i] === '**' || pattern[i] !== '*' && String(pattern[i]) !== String(path[i])) return false;
    }
    return true;
}

function createJsonProjector(paths, budget = createBudget()) {
    const patterns = (paths || []).map(path => Array.isArray(path) ? path : String(path).split('.'));
    const stream = parser({ packKeys: false, packStrings: false, packNumbers: false,
        streamKeys: true, streamStrings: true, streamNumbers: true });
    const frames = [];
    let result, scalar = '', scalarKind = '', scalarKeep = false, scalarPath = [], error;
    const completed = finished(stream);
    // Attach immediately: malformed input must never become an unhandled rejection.
    completed.catch(() => {});
    const selected = path => patterns.some(pattern => matches(pattern, path));
    const prefix = path => patterns.some(pattern => explicitPrefix(pattern, path));
    const pathNow = () => {
        const parent = frames.at(-1);
        return parent ? [...parent.path, parent.array ? parent.index : parent.key] : [];
    };
    const safePath = path => path.every(key => key !== null && !UNSAFE_KEYS.has(String(key)));
    const ensure = frame => {
        if (frame.output !== undefined) return frame.output;
        budget.add('', 1);
        frame.output = frame.array ? [] : Object.create(null);
        const parent = frames[frames.indexOf(frame) - 1];
        if (parent) {
            const key = frame.path.at(-1);
            if (!safePath(frame.path)) return frame.output;
            const output = ensure(parent);
            // Compact arrays retain source ordering without allocating sparse
            // arrays from attacker-selected large numeric indices.
            if (parent.array) output.push(frame.output);
            else { budget.add(key, 0); output[key] = frame.output; }
        } else result = frame.output;
        return frame.output;
    };
    const finishValue = () => { const parent = frames.at(-1); if (parent?.array) parent.index++; };
    const put = (path, value, textReserved = false) => {
        if (!safePath(path)) return;
        budget.add(!textReserved && typeof value === 'string' ? value : '', 1);
        const parent = frames.at(-1);
        if (!parent) { result = value; return; }
        const output = ensure(parent), key = path.at(-1);
        if (parent.array) output.push(value);
        else { budget.add(key, 0); output[key] = value; }
    };
    const consume = token => {
        switch (token.name) {
        case 'startObject': case 'startArray': {
            if (frames.length >= MAX_DEPTH) throw pressure();
            const path = pathNow(), parent = frames.at(-1);
            const frame = { path, array: token.name === 'startArray', index: 0, key: null,
                whole: !!parent?.whole || selected(path), output: undefined };
            frames.push(frame);
            if (safePath(path) && (!path.length || frame.whole || prefix(path))) ensure(frame);
            break;
        }
        case 'endObject': case 'endArray': frames.pop(); finishValue(); break;
        case 'startKey': scalarKind = 'key'; scalar = ''; break;
        case 'endKey': frames.at(-1).key = scalar; scalarKind = ''; scalar = ''; break;
        case 'startString': case 'startNumber':
            scalarKind = token.name === 'startString' ? 'string' : 'number'; scalar = ''; scalarPath = pathNow();
            scalarKeep = safePath(scalarPath) && (!!frames.at(-1)?.whole || selected(scalarPath));
            break;
        case 'stringChunk': case 'numberChunk':
            if (scalarKind === 'key') {
                scalar += String(token.value);
                if (scalar.length > MAX_SCALAR) throw pressure();
            } else if (scalarKeep) {
                budget.add(token.value, 0);
                scalar += String(token.value);
            }
            break;
        case 'endString': case 'endNumber':
            if (scalarKeep) put(scalarPath, scalarKind === 'number' ? Number(scalar) : scalar, true);
            scalar = ''; scalarKind = ''; finishValue(); break;
        case 'nullValue': case 'trueValue': case 'falseValue': {
            const path = pathNow();
            if (safePath(path) && (frames.at(-1)?.whole || selected(path) || token.name === 'nullValue' && prefix(path))) put(path, token.value);
            finishValue(); break;
        }
        }
    };
    stream.on('data', token => {
        if (error) return;
        try { consume(token); } catch (failure) { error = failure; stream.destroy(failure); }
    });
    stream.on('error', failure => {
        // Only the JSON parser's errors are normalized here. Network/body
        // failures propagate from responseChunks with their original identity.
        if (!failure.code) failure.code = 'AUTO_WATCH_INVALID_RESPONSE';
        error ||= failure;
    });
    return {
        async write(text) {
            if (error) throw error;
            if (!stream.write(text)) await once(stream, 'drain');
            if (error) throw error;
        },
        async end() { stream.end(); await completed; if (error) throw error; return result; },
        destroy(failure) { stream.destroy(failure); },
    };
}

async function readJsonProjection(response, paths) {
    const projection = createJsonProjector(paths);
    try {
        for await (const text of responseChunks(response)) await projection.write(text);
        return await projection.end();
    } catch (error) { projection.destroy(); throw error; }
}

function escapeAttribute(value) { return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

async function readHtmlProjection(response, options = {}) {
    const markers = options.markers || [], preserveHtml = options.preserveHtml === true || options.keepMarkup === true;
    const budget = createBudget(), output = [];
    const append = text => { if (text) { budget.add(text); output.push(text); } };
    let mode = 'html', tag = '', tagQuote = '', tagAsset = null, pending = '', rawTag = '', attrs = '';
    let activeMarker = '', projection = null, jsonDepth = 0, inString = false, escaped = false, jsonTail = '';
    const closeRaw = () => { mode = 'html'; pending = ''; rawTag = ''; activeMarker = ''; };
    const finishJson = async () => {
        const value = await projection.end(); projection = null;
        const json = JSON.stringify(value ?? {});
        // Scalar data cannot introduce executable markup into the projection.
        const safeJson = json.replace(/</g, '\\u003c');
        append(`<script${attrs}>${activeMarker && !['__NEXT_DATA__', 'application/ld+json'].includes(activeMarker) ? activeMarker + ' = ' : ''}${safeJson}</script>`);
        mode = 'raw'; pending = '';
    };
    const openTag = () => {
        const name = tag.match(/^<\s*(\/?)\s*([a-z][a-z0-9:-]*)/i);
        if (!name) { mode = 'html'; return; }
        const closing = !!name[1], tagName = name[2].toLowerCase();
        if (!closing && ['script', 'style'].includes(tagName)) {
            rawTag = tagName; mode = 'raw'; pending = ''; activeMarker = ''; attrs = '';
            if (tagName === 'script') {
                const id = tag.match(/\bid\s*=\s*(["'])(.*?)\1/i)?.[2];
                const type = tag.match(/\btype\s*=\s*(["'])(.*?)\1/i)?.[2];
                if (id) attrs += ` id="${escapeAttribute(id)}"`;
                if (type) attrs += ` type="${escapeAttribute(type)}"`;
                activeMarker = markers.find(marker => marker === id || marker === type) || '';
                if (activeMarker) mode = 'jsonSearch';
            }
        } else {
            mode = 'html';
            if (preserveHtml && !['img', 'link', 'meta', 'iframe', 'object', 'embed', 'script', 'style'].includes(tagName)) {
                append(tag);
            }
        }
    };
    const process = async text => {
        let i = 0;
        while (i < text.length) {
            if (mode === 'html') {
                const next = text.indexOf('<', i), end = next < 0 ? text.length : next;
                if (preserveHtml) append(text.slice(i, end));
                i = end;
                if (next < 0) break;
                tag = '<'; tagQuote = ''; tagAsset = null; mode = 'tag'; i++;
            } else if (mode === 'tag') {
                const ch = text[i++];
                if (tagAsset === null && /[\s/>]/.test(ch)) {
                    tagAsset = /^<\s*(?:img|link|meta|iframe|object|embed)\b/i.test(tag);
                }
                if (!tagAsset || tag.length < MAX_SCALAR) tag += ch;
                if (tag.length > MAX_RETAINED) throw pressure();
                if (tagQuote) { if (ch === tagQuote) tagQuote = ''; }
                else if (ch === '"' || ch === "'") tagQuote = ch;
                else if (ch === '>') openTag();
            } else if (mode === 'raw' || mode === 'jsonSearch') {
                const combined = pending + text.slice(i);
                const close = combined.toLowerCase().indexOf(`</${rawTag}`);
                let markerIndex = -1, markerName = '';
                if (mode === 'raw' && rawTag === 'script') {
                    for (const marker of markers) {
                        if (['__NEXT_DATA__', 'application/ld+json'].includes(marker)) continue;
                        const at = combined.indexOf(marker);
                        if (at >= 0 && (markerIndex < 0 || at < markerIndex)) { markerIndex = at; markerName = marker; }
                    }
                }
                if (markerIndex >= 0 && (close < 0 || markerIndex < close)) {
                    const offset = markerIndex + markerName.length;
                    activeMarker = markerName; mode = 'jsonSearch'; pending = '';
                    const remaining = combined.slice(offset); text = remaining; i = 0;
                    continue;
                }
                if (mode === 'jsonSearch') {
                    const jsonAt = combined.search(/[[{]/);
                    if (jsonAt >= 0 && (close < 0 || jsonAt < close)) {
                        projection = createJsonProjector(options.paths || [], budget);
                        jsonDepth = 0; inString = false; escaped = false; jsonTail = ''; mode = 'json'; pending = '';
                        text = combined.slice(jsonAt); i = 0; continue;
                    }
                }
                if (close >= 0) {
                    text = combined.slice(close); i = 0; closeRaw(); continue;
                }
                pending = combined.slice(-Math.max(128, ...markers.map(marker => marker.length + 4)));
                break;
            } else if (mode === 'json') {
                text = jsonTail + text.slice(i); i = 0; jsonTail = '';
                const closing = `</${rawTag}`, lower = text.toLowerCase(), closeAt = lower.indexOf(closing);
                let end = closeAt < 0 ? text.length : closeAt;
                if (closeAt < 0) {
                    for (let length = Math.min(closing.length - 1, text.length); length > 0; length--) {
                        if (closing.startsWith(lower.slice(-length))) { end -= length; jsonTail = text.slice(end); break; }
                    }
                }
                const start = i;
                try { for (; i < end; i++) {
                    const ch = text[i];
                    if (inString) {
                        if (escaped) escaped = false;
                        else if (ch === '\\') escaped = true;
                        else if (ch === '"') inString = false;
                    } else if (ch === '"') inString = true;
                    else if (ch === '{' || ch === '[') { if (++jsonDepth > MAX_DEPTH) throw pressure(); }
                    else if (ch === '}' || ch === ']') {
                        if (--jsonDepth === 0) {
                            i++; await projection.write(text.slice(start, i)); await finishJson(); break;
                        }
                    }
                }
                if (projection && i > start) await projection.write(text.slice(start, i));
                if (projection && closeAt >= 0) throw Object.assign(new SyntaxError('Incomplete hydration JSON.'), { code: 'AUTO_WATCH_INVALID_RESPONSE' });
                if (projection) break;
                jsonTail = '';
                } catch (error) {
                    if (!options.ignoreInvalidScripts || error.code !== 'AUTO_WATCH_INVALID_RESPONSE') throw error;
                    projection?.destroy(); projection = null; mode = 'raw';
                    const close = text.toLowerCase().indexOf(`</${rawTag}`, start);
                    if (close >= 0) { text = text.slice(close); i = 0; pending = ''; jsonTail = ''; }
                    else { pending = (text + jsonTail).slice(-128); jsonTail = ''; break; }
                }
            }
        }
    };
    try {
        for await (const text of responseChunks(response)) await process(text);
        const unfinished = /** @type {ReturnType<typeof createJsonProjector> | null} */ (projection);
        if (unfinished) {
            unfinished.destroy();
            if (options.ignoreInvalidScripts) return output.join('');
            throw Object.assign(new SyntaxError('Incomplete hydration JSON.'), { code: 'AUTO_WATCH_INVALID_RESPONSE' });
        }
        return output.join('');
    } catch (error) {
        (/** @type {ReturnType<typeof createJsonProjector> | null} */ (projection))?.destroy();
        throw error;
    }
}

module.exports = { createBudget, createJsonProjector, readHtmlProjection, readJsonProjection, responseChunks };

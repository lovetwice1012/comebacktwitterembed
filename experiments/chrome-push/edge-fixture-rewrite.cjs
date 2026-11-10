'use strict';
// Research relay for one disposable local profile, not a production client.
const { Transform } = require('node:stream');
const { syntheticReconnectSignature } = require('./edge-fixture-signature.cjs');
const fail = () => new Error('PROBE_REWRITE_INVALID');

function rewriteSyntheticBind(frame, key, expectedToken, nextNonce) {
    if (!Buffer.isBuffer(frame) || frame.length > 262144) throw fail();
    const text = frame.toString('ascii');
    if (!/^BND \d+ CON\\WNS /.test(text)) throw fail();
    const get = tag => {
        const found = [...text.matchAll(new RegExp(`<${tag}>([^<]+)</${tag}>`, 'g'))];
        if (found.length !== 1) throw fail();
        return found[0][1];
    };
    const token = get('reconnect-token'), nonce = get('nonce'), signature = get('signature');
    if (token !== expectedToken || nonce === nextNonce) throw fail();
    const before = syntheticReconnectSignature(key, token, nonce), after = syntheticReconnectSignature(key, token, nextNonce);
    try {
        if (before.toString('base64') !== signature) throw fail();
        const changed = text.replace(`<nonce>${nonce}</nonce>`, `<nonce>${nextNonce}</nonce>`)
            .replace(`<signature>${signature}</signature>`, `<signature>${after.toString('base64')}</signature>`);
        const output = Buffer.from(changed, 'ascii');
        if (output.length !== frame.length) { output.fill(0); throw fail(); }
        return output;
    } finally { before.fill(0); after.fill(0); }
}

function createSyntheticRewriteStream({ key, token, nonce, onRewrite }) {
    let pending = Buffer.alloc(0), rewritten = false;
    return new Transform({
        transform(chunk, _encoding, callback) {
            try {
                if (!Buffer.isBuffer(chunk) || pending.length + chunk.length > 262144) throw fail();
                pending = Buffer.concat([pending, chunk]);
                while (pending.length) {
                    const end = pending.indexOf('\r\n');
                    if (end < 0) { if (pending.length > 512) throw fail(); break; }
                    if (end > 512) throw fail();
                    const header = pending.subarray(0, end);
                    if (header.some(value => value < 0x20 || value > 0x7e)) throw fail();
                    const parts = header.toString('ascii').split(' '), length = parts.at(-1);
                    if (!/^\d{1,6}$/.test(length)) throw fail();
                    const frameLength = end + 2 + Number(length);
                    if (frameLength > 262144) throw fail();
                    if (pending.length < frameLength) break;
                    let frame = Buffer.from(pending.subarray(0, frameLength));
                    pending = Buffer.from(pending.subarray(frameLength));
                    if (parts[0] === 'BND' && parts.includes('CON\\WNS')) {
                        if (rewritten) throw fail();
                        const replaced = rewriteSyntheticBind(frame, key, token, nonce); frame.fill(0); frame = replaced;
                        rewritten = true; onRewrite();
                    }
                    this.push(frame);
                }
                callback();
            } catch { callback(fail()); }
        },
        flush(callback) { if (pending.length) callback(fail()); else callback(); },
        destroy(error, callback) { pending.fill(0); key.fill(0); callback(error); },
    });
}
module.exports = { rewriteSyntheticBind, createSyntheticRewriteStream };

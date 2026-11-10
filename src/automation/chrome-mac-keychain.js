'use strict';

// Reads only Chrome's named Safe Storage item, after explicit local consent.
// The caller may use the supplied buffer only for the dedicated-profile token
// and must never include it in a transfer file, log, command line or network.
const { spawn } = require('node:child_process');
const fail = code => Object.assign(new Error(code), { code });

async function withMacChromeKeychainPassword({ confirmed, signal, work }) {
    if (process.platform !== 'darwin' || confirmed !== true || typeof work !== 'function'
        || signal !== undefined && !(signal instanceof AbortSignal)) throw fail('X_CHROME_MAC_KEYCHAIN_INVALID');
    if (signal?.aborted) throw fail('X_CHROME_MAC_KEYCHAIN_CANCELLED');
    let password;
    try {
        password = await new Promise((resolve, reject) => {
            let child, finished = false, size = 0, timer; const chunks = [];
            function finish(error) {
                if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
                if (error) { for (const chunk of chunks) chunk.fill(0); reject(fail(error)); return; }
                const joined = Buffer.concat(chunks); for (const chunk of chunks) chunk.fill(0);
                // `security -w` appends one newline; Chrome's generated key is
                // a nonempty ASCII string and never contains embedded newlines.
                const length = joined.length && joined[joined.length - 1] === 10 ? joined.length - 1 : 0;
                if (!length || length > 4096 || joined.subarray(0, length).some(byte => byte < 0x21 || byte > 0x7e)) {
                    joined.fill(0); reject(fail('X_CHROME_MAC_KEYCHAIN_INVALID')); return;
                }
                const result = Buffer.from(joined.subarray(0, length)); joined.fill(0); resolve(result);
            }
            function stopChild() { try { child?.kill(); } catch { /* Already stopped. */ } }
            function cancel() { stopChild(); finish('X_CHROME_MAC_KEYCHAIN_CANCELLED'); }
            try {
                child = spawn('/usr/bin/security', ['find-generic-password', '-s', 'Chrome Safe Storage', '-a', 'Chrome', '-w'],
                    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
                child.stdout.on('data', chunk => {
                    if (finished) { if (Buffer.isBuffer(chunk)) chunk.fill(0); return; }
                    if (!Buffer.isBuffer(chunk) || (size += chunk.length) > 4097) {
                        if (Buffer.isBuffer(chunk)) chunk.fill(0); stopChild(); finish('X_CHROME_MAC_KEYCHAIN_INVALID'); return;
                    }
                    chunks.push(Buffer.from(chunk)); chunk.fill(0);
                });
                child.stdout.on('error', () => finish('X_CHROME_MAC_KEYCHAIN_UNAVAILABLE'));
                child.once('error', () => finish('X_CHROME_MAC_KEYCHAIN_UNAVAILABLE'));
                child.once('close', code => finish(code === 0 ? null : 'X_CHROME_MAC_KEYCHAIN_UNAVAILABLE'));
                signal?.addEventListener('abort', cancel, { once: true });
                if (signal?.aborted) return cancel();
                timer = setTimeout(() => { stopChild(); finish('X_CHROME_MAC_KEYCHAIN_TIMEOUT'); }, 60000);
            } catch { finish('X_CHROME_MAC_KEYCHAIN_UNAVAILABLE'); }
        });
        if (signal?.aborted) throw fail('X_CHROME_MAC_KEYCHAIN_CANCELLED');
        return await work(password);
    } finally { password?.fill(0); }
}
module.exports = { withMacChromeKeychainPassword };

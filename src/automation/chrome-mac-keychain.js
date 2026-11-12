'use strict';

// Reads only the selected browser's fixed Safe Storage item after consent.
// The caller may use the supplied buffer only for the dedicated-profile token
// and must never include it in a transfer file, log, command line or network.
const { spawn } = require('node:child_process');
const fail = code => Object.assign(new Error(code), { code });

async function withMacKeychainPassword({ confirmed, signal, work, browser }) {
    const selected = browser === 'chrome' ? { service: 'Chrome Safe Storage', account: 'Chrome', prefix: 'X_CHROME_MAC_KEYCHAIN' }
        : browser === 'brave' ? { service: 'Brave Safe Storage', account: 'Brave', prefix: 'X_BRAVE_MAC_KEYCHAIN' } : null;
    if (!selected) throw fail('X_CHROME_MAC_KEYCHAIN_INVALID');
    const code = suffix => `${selected.prefix}_${suffix}`;
    if (process.platform !== 'darwin' || confirmed !== true || typeof work !== 'function'
        || signal !== undefined && !(signal instanceof AbortSignal)) throw fail(code('INVALID'));
    if (signal?.aborted) throw fail(code('CANCELLED'));
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
                    joined.fill(0); reject(fail(code('INVALID'))); return;
                }
                const result = Buffer.from(joined.subarray(0, length)); joined.fill(0); resolve(result);
            }
            function stopChild() { try { child?.kill(); } catch { /* Already stopped. */ } }
            function cancel() { stopChild(); finish(code('CANCELLED')); }
            try {
                child = spawn('/usr/bin/security', ['find-generic-password', '-s', selected.service, '-a', selected.account, '-w'],
                    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
                child.stdout.on('data', chunk => {
                    if (finished) { if (Buffer.isBuffer(chunk)) chunk.fill(0); return; }
                    if (!Buffer.isBuffer(chunk) || (size += chunk.length) > 4097) {
                        if (Buffer.isBuffer(chunk)) chunk.fill(0); stopChild(); finish(code('INVALID')); return;
                    }
                    chunks.push(Buffer.from(chunk)); chunk.fill(0);
                });
                child.stdout.on('error', () => finish(code('UNAVAILABLE')));
                child.once('error', () => finish(code('UNAVAILABLE')));
                child.once('close', status => finish(status === 0 ? null : code('UNAVAILABLE')));
                signal?.addEventListener('abort', cancel, { once: true });
                if (signal?.aborted) return cancel();
                timer = setTimeout(() => { stopChild(); finish(code('TIMEOUT')); }, 60000);
            } catch { finish(code('UNAVAILABLE')); }
        });
        if (signal?.aborted) throw fail(code('CANCELLED'));
        return await work(password);
    } finally { password?.fill(0); }
}
const withMacChromeKeychainPassword = options => withMacKeychainPassword({ ...options, browser: 'chrome' });
const withMacBraveKeychainPassword = options => withMacKeychainPassword({ ...options, browser: 'brave' });
module.exports = { withMacChromeKeychainPassword, withMacBraveKeychainPassword };

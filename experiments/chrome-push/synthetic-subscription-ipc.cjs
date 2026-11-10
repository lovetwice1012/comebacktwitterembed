'use strict';
// A child creates a new local test profile. Nothing here reads user profiles;
// generated subscription secrets are transferred only over the private IPC.
const { fork } = require('node:child_process');
const path = require('node:path');
async function createSyntheticSubscription(browser) {
    if (!['chrome', 'brave'].includes(browser)) throw new Error('FIXTURE_BROWSER_INVALID');
    const env = { ...process.env, CHROMIUM_PROBE_BROWSER: browser, CHROME_FIXTURE_SYNTHETIC_IPC: '1', CHROME_FIXTURE_BLOCK_INITIAL: '1' };
    for (const key of ['CHROME_FIXTURE_LINUX', 'CHROME_FIXTURE_MYSQL_PORT', 'CHROME_FIXTURE_REOPEN', 'CHROME_FIXTURE_RUNTIME', 'CHROME_FIXTURE_OTHER']) delete env[key];
    const child = fork(path.join(__dirname, 'packaged-e2e.cjs'), [], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let data, diagnostic = '';
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4096); });
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { child.kill(); reject(new Error('FIXTURE_CHILD_TIMEOUT')); }, 90000);
            child.once('message', value => { data = value; });
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', code => { clearTimeout(timer); if (code === 0 && data?.browser === browser) resolve();
                else { const safe = diagnostic.match(/\b(?:FIXTURE|X_CHROME)_[A-Z_]+\b/)?.[0] || 'FIXTURE_CHILD_FAILED'; reject(new Error(safe)); } });
        });
        return data;
    } finally { if (child.exitCode === null) child.kill(); }
}
module.exports = { createSyntheticSubscription };

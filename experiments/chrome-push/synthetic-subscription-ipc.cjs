'use strict';
// A child creates a new local test profile. Nothing here reads user profiles;
// generated subscription secrets are transferred only over the private IPC.
const { fork } = require('node:child_process');
const path = require('node:path');
async function createSyntheticSubscription(browser) {
    if (!['chrome', 'brave'].includes(browser)) throw new Error('FIXTURE_BROWSER_INVALID');
    const env = { ...process.env, CHROMIUM_PROBE_BROWSER: browser, CHROME_FIXTURE_SYNTHETIC_IPC: '1', CHROME_FIXTURE_BLOCK_INITIAL: '1' };
    for (const key of ['CHROME_FIXTURE_LINUX', 'CHROME_FIXTURE_MYSQL_PORT', 'CHROME_FIXTURE_REOPEN', 'CHROME_FIXTURE_RUNTIME', 'CHROME_FIXTURE_OTHER']) delete env[key];
    const child = fork(path.join(__dirname, 'packaged-e2e.cjs'), [], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let data;
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { child.kill(); reject(new Error('FIXTURE_CHILD_TIMEOUT')); }, 90000);
            child.once('message', value => { data = value; });
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', code => { clearTimeout(timer); if (code === 0 && data?.browser === browser) resolve(); else reject(new Error('FIXTURE_CHILD_FAILED')); });
        });
        return data;
    } finally { if (child.exitCode === null) child.kill(); }
}
module.exports = { createSyntheticSubscription };

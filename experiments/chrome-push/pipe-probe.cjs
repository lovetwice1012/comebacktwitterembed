'use strict';
// Synthetic Chrome probe for inherited DevTools pipes. No account, cookies,
// external website, open debugging TCP port or user profile is used.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
async function removeOwnedProfile(profile, temp) {
    const resolved = await fs.realpath(profile);
    if (path.dirname(resolved).toLowerCase() !== temp.toLowerCase() || !/^cbte-chrome-pipe-probe-[A-Za-z0-9]+$/.test(path.basename(resolved))) throw new Error('PIPE_CLEANUP_INVALID');
    await fs.rm(resolved, { recursive: true });
}
async function main() {
    const temp = await fs.realpath(os.tmpdir()), profile = await fs.mkdtemp(path.join(temp, 'cbte-chrome-pipe-probe-'));
    const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--remote-debugging-pipe',
        `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    try {
        const result = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('PIPE_TIMEOUT')), 15000); let pending = Buffer.alloc(0);
            chrome.stdio[4].on('data', chunk => {
                pending = Buffer.concat([pending, chunk]); const end = pending.indexOf(0);
                if (end < 0) return;
                clearTimeout(timer);
                try { resolve(JSON.parse(pending.subarray(0, end).toString('utf8'))); } catch { reject(new Error('PIPE_RESPONSE_INVALID')); }
            });
            chrome.on('exit', () => { clearTimeout(timer); reject(new Error('PIPE_CHROME_EXITED')); });
            chrome.stdio[3].write(Buffer.from(JSON.stringify({ id: 1, method: 'Browser.getVersion' }) + '\0'));
        });
        if (result.id !== 1 || !result.result?.product?.startsWith('Chrome/')) throw new Error('PIPE_RESPONSE_INVALID');
        console.log(JSON.stringify({ inheritedPipeWorks: true, debuggerTcpPortUsed: false }));
    } finally {
        if (chrome.exitCode === null) { chrome.kill(); await new Promise(resolve => chrome.once('exit', resolve)); }
        await removeOwnedProfile(profile, temp);
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

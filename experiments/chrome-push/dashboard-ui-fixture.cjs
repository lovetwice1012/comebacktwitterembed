'use strict';
// Local, synthetic browser verification. No user account or external API is used.
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const esbuild = require('esbuild');
const CDP = require('chrome-remote-interface');
const root = path.resolve(__dirname, '../..'), dashboard = path.join(root, 'dashboard');
const local = createRequire(path.join(dashboard, 'package.json'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function removeOwnedProfile(profile, temp) {
    const actual = await fs.realpath(profile);
    if (path.dirname(actual).toLowerCase() !== temp.toLowerCase() || !/^cbte-chrome-ui-fixture-[A-Za-z0-9]+$/.test(path.basename(actual))) throw new Error('UI_CLEANUP_INVALID');
    await fs.rm(actual, { recursive: true });
}
async function main() {
    const entry = `import React from 'react';import{createRoot}from'react-dom/client';
import{XNotificationSetupScreen}from'./dashboard/components/automation/x-notification-setup-screen';
import './dashboard/app/globals.css';createRoot(document.getElementById('root')!).render(<main className="mx-auto max-w-5xl space-y-4 p-4"><h1>X通知の受信設定</h1><XNotificationSetupScreen/></main>);`;
    const built = await esbuild.build({ absWorkingDir: root, stdin: { contents: entry, resolveDir: root, sourcefile: 'chrome-ui-fixture.tsx', loader: 'tsx' },
        bundle: true, write: false, outfile: 'app.js', platform: 'browser', jsx: 'automatic', nodePaths: [path.join(dashboard, 'node_modules')],
        alias: { react: path.dirname(local.resolve('react/package.json')), 'react-dom': path.dirname(local.resolve('react-dom/package.json')) },
        define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' } });
    const assets = new Map(), theme = local(path.join(dashboard, 'tailwind.config.ts')).default;
    for (const file of built.outputFiles) {
        const name = path.basename(file.path);
        const text = name.endsWith('.css') ? (await local('postcss')([local('tailwindcss')({ ...theme, content: [
            path.join(dashboard, 'components/**/*.{ts,tsx}').replaceAll('\\', '/'), { raw: entry, extension: 'tsx' }] }), local('autoprefixer')
        ]).process(file.text, { from: undefined })).css : file.text;
        assets.set(`/${name}`, text);
    }
    const status = { available: true, receiverEnabled: true, chromeEnabled: true,
        rollout: { mode: 'supporters', eligible: true, reasonCode: null, reason: null },
        download: { url: '/api/automation/x-setup/download', version: '0.1.0-preview.4', sha256: 'a'.repeat(64) },
        subscriptions: [], maxFileBytes: 32768, nextCursor: null };
    const server = http.createServer((req, res) => {
        if (req.url === '/api/automation/x-setup') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(status)); return; }
        if (assets.has(req.url)) { res.writeHead(200, { 'Content-Type': req.url.endsWith('.css') ? 'text/css' : 'application/javascript' }); res.end(assets.get(req.url)); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const temp = await fs.realpath(os.tmpdir()), profile = await fs.mkdtemp(path.join(temp, 'cbte-chrome-ui-fixture-'));
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const child = spawn(chrome, ['--headless=new', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
        '--no-first-run', `http://127.0.0.1:${server.address().port}/`], { windowsHide: true, stdio: 'ignore' });
    let cdp;
    try {
        let port;
        for (let i = 0; i < 100 && !port; i++) { try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { await wait(100); } }
        if (!port) throw new Error('UI_BROWSER_START_FAILED');
        cdp = await CDP({ port }); await cdp.Page.enable();
        const load = new Promise(resolve => cdp.Page.loadEventFired(resolve));
        await cdp.Page.navigate({ url: `http://127.0.0.1:${server.address().port}/` }); await load;
        for (let i = 0; i < 100; i++) {
            const ready = await cdp.Runtime.evaluate({ returnByValue: true, expression: `!![...document.querySelectorAll('label')].find(x=>x.textContent.trim()==='Chrome')` });
            if (ready.result.value) break; await wait(100);
        }
        await cdp.Runtime.evaluate({ expression: `[...document.querySelectorAll('label')].find(x=>x.textContent.trim()==='Chrome').querySelector('input').click()` });
        await wait(100);
        const output = path.join(root, 'docs', 'qa', 'chrome-x-setup'); await fs.mkdir(output, { recursive: true });
        const reports = [];
        for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
            await cdp.Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile: name === 'mobile' });
            await wait(150);
            const metrics = await cdp.Runtime.evaluate({ returnByValue: true, expression: `({width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,text:document.body.innerText,link:document.querySelector('a[download]')?.getAttribute('href')})` });
            if (metrics.result.value.scrollWidth > metrics.result.value.width || metrics.result.value.link !== '/api/automation/x-setup/download-chrome'
                || !metrics.result.value.text.includes('監視したいアカウントごとに投稿通知をオン')) throw new Error('UI_LAYOUT_FAILED');
            const image = await cdp.Page.captureScreenshot({ format: 'png', captureBeyondViewport: true });
            await fs.writeFile(path.join(output, `${name}.png`), Buffer.from(image.data, 'base64'));
            reports.push({ viewport: name, width, horizontalOverflow: false });
        }
        console.log(JSON.stringify({ reports, output }));
    } finally {
        await cdp?.close().catch(() => {});
        if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
        await new Promise(resolve => server.close(resolve));
        await removeOwnedProfile(profile, temp);
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

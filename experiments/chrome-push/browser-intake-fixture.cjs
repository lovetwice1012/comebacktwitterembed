'use strict';
// Local browser acceptance: synthetic keys, isolated MariaDB and loopback only.
const assert = require('node:assert/strict');
const { createECDH, generateKeyPairSync, randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createTestDatabase } = require('../../scripts/lib/automation-test-db');
const { dispatch } = require('../../src/automation/api');
const { createService } = require('../../src/automation/service');
const { createXSetup } = require('../../src/automation/x-setup');
const { createTransferPublicSealer } = require('../../src/automation/x-setup-transfer');
const root = path.resolve(__dirname, '../..'), dashboard = path.join(root, 'dashboard');
const localRequire = createRequire(path.join(dashboard, 'package.json'));
function transfer(kind) {
    const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
    const point = ecdh.getPublicKey(), privateKey = ecdh.getPrivateKey().toString('hex').padStart(64, '0');
    const push = { deviceId: kind === 'brave' ? '123456790' : '123456789', securityToken: '987654321', appId: `wp:https://x.com/#${randomUUID().toUpperCase().slice(0, -3)}-V2`,
        productCategory: kind === 'brave' ? 'com.brave.windows' : 'com.chrome.windows', authorizedEntity: 'fixture_sender', scope: 'https://x.com/',
        p256dhPublicKey: point.toString('base64url'), authenticationSecret: randomBytes(16).toString('base64url'),
        p256dhPrivateKey: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url'), d: Buffer.from(privateKey, 'hex').toString('base64url') } };
    return { format: 'x-notification-subscription', version: 2, provenance: { kind: `${kind}-gcm`, adapterVersion: '1.0.0',
        browserVersion: kind === 'brave' ? '157.1.99.55' : '157.0.8103.39', ...(kind === 'brave' ? { engineVersion: '157.0.8103.39' } : {}), readMethod: `${kind}-gcm-snapshot` }, push };
}
async function main() {
    assert.equal(Number(process.env.AUTOMATION_TEST_DB_PORT), 33631, 'Use isolated fixture DB port 33631');
    const playwright = require('playwright-core'), esbuild = require('esbuild');
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const sealer = createTransferPublicSealer({ activeKeyId: 'synthetic', publicKeys: { synthetic: publicKey } });
    const db = await createTestDatabase(33631), actor = { userId: '222222222222222222' };
    let server, browser;
    try {
        const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {XNotificationSetupScreen} from './dashboard/components/automation/x-notification-setup-screen'; import './dashboard/app/globals.css'; createRoot(document.getElementById('root')!).render(<main className="mx-auto max-w-5xl space-y-4 p-4"><h1>ローカル試験</h1><XNotificationSetupScreen /></main>);`;
        const built = await esbuild.build({ absWorkingDir: root, stdin: { contents: entry, resolveDir: root, sourcefile: 'fixture.tsx', loader: 'tsx' },
            bundle: true, write: false, outfile: 'app.js', platform: 'browser', jsx: 'automatic', nodePaths: [path.join(dashboard, 'node_modules')],
            alias: { react: path.dirname(localRequire.resolve('react/package.json')), 'react-dom': path.dirname(localRequire.resolve('react-dom/package.json')) },
            define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' } });
        const assets = new Map();
        for (const file of built.outputFiles) {
            const name = path.basename(file.path);
            let text = file.text;
            if (name.endsWith('.css')) {
                const theme = localRequire(path.join(dashboard, 'tailwind.config.ts')).default;
                text = (await localRequire('postcss')([localRequire('tailwindcss')({ ...theme, content: [path.join(dashboard, 'components/**/*.{ts,tsx}').replaceAll('\\', '/'), { raw: entry, extension: 'tsx' }] }), localRequire('autoprefixer')]).process(text, { from: undefined })).css;
            }
            assets.set('/' + name, text);
        }
        const services = { db, service: createService(db), xSetup: createXSetup(db, { sealer, rolloutMode: 'public', chromeEnabled: true, braveEnabled: true, receiverEnabled: true }) };
        const token = randomBytes(24).toString('hex'); let origin;
        server = http.createServer(async (req, res) => {
            try {
                if (!origin || req.headers.host !== new URL(origin).host) { res.writeHead(403).end(); return; }
                const url = new URL(req.url, origin);
                if (url.pathname.startsWith('/api/automation/')) {
                    if (req.headers.cookie !== `fixture=${token}` || (req.method !== 'GET' && req.headers.origin !== origin)) { res.writeHead(403).end(); return; }
                    const chunks = []; let length = 0;
                    for await (const chunk of req) { length += chunk.length; if (length > 65536) throw new Error('fixture limit'); chunks.push(chunk); }
                    const body = length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
                    const result = await dispatch({ method: req.method, path: url.pathname.slice('/api/automation/'.length).split('/'), search: url.searchParams, body }, actor, services);
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(result)); return;
                }
                if (assets.has(url.pathname)) { res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }).end(assets.get(url.pathname)); return; }
                if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }).end('<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script></html>'); return; }
                res.writeHead(404).end();
            } catch (error) { console.error('FIXTURE_API', /^[A-Z_]+$/.test(error.code || '') ? error.code : 'FAILED'); res.writeHead(Number(error.status) || 503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: error.code || 'FIXTURE_FAILED' })); }
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
        const renderer = process.env.CBTE_FIXTURE_BROWSER || 'chrome';
        const executables = { chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            brave: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe' };
        if (!Object.hasOwn(executables, renderer)) throw new Error('FIXTURE_BROWSER_INVALID');
        browser = await playwright.chromium.launch({ headless: true, executablePath: executables[renderer] });
        const output = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-intake-ui-'));
        for (const [kind, width] of [['chrome', 1440], ['brave', 390]]) {
            console.log(`fixture-stage:${kind}`);
            const file = transfer(kind), context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
            await context.addCookies([{ name: 'fixture', value: token, url: origin, httpOnly: true }]);
            let external = 0, errors = 0;
            await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : (++external, route.abort()));
            const page = await context.newPage(); page.on('pageerror', () => errors++); page.setDefaultTimeout(10000);
            await page.goto(origin);
            if (kind === 'brave') await page.getByRole('button', { name: '受信情報を追加・登録し直す' }).click();
            await page.getByRole('radio', { name: kind === 'brave' ? 'Brave' : 'Chrome', exact: true }).check();
            const label = kind === 'brave' ? 'Brave' : 'Chrome';
            await page.getByRole('link', { name: `${label}用ツールをダウンロード` }).waitFor();
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            await page.screenshot({ path: path.join(output, `${kind}-prepare.png`), fullPage: true });
            await page.getByRole('button', { name: 'ファイルを登録する' }).click();
            await page.getByRole('checkbox', { name: /^サーバーでX通知を受信/ }).check();
            const input = page.locator('input[type=file]');
            const selectedFile = { name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) };
            await input.setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('not a transfer file') });
            await page.getByRole('alert').filter({ hasText: 'JSONファイルを選んでください' }).waitFor();
            assert.equal(await input.inputValue(), '');
            await input.setInputFiles(selectedFile);
            await page.getByText('ファイルを選択しました。「ファイルの内容を確認」で次へ進めます。', { exact: true }).waitFor();
            assert((await input.inputValue()).endsWith('synthetic.json'));
            await page.getByRole('button', { name: 'ファイルの選択を取り消す' }).click();
            assert.equal(await input.inputValue(), '');
            await input.setInputFiles(selectedFile);
            await page.getByRole('button', { name: 'ファイルの内容を確認' }).click();
            const review = page.getByRole('region', { name: 'X通知ファイルの登録確認' }); await review.waitFor();
            assert((await review.textContent()).includes(`${label} ${file.provenance.browserVersion}`));
            assert((await input.inputValue()).endsWith('synthetic.json'));
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            await page.screenshot({ path: path.join(output, `${kind}-review.png`), fullPage: true });
            await page.getByRole('button', { name: 'この受信情報を登録' }).click();
            await page.getByRole('status').filter({ hasText: '受信情報を登録しました。' }).waitFor();
            const rows = await db.queryDatabase('SELECT browser_kind,sealed_json FROM automation_x_subscriptions WHERE owner_user_id=?', [actor.userId]);
            assert(rows.some(row => row.browser_kind === kind && !row.sealed_json.includes(file.push.p256dhPrivateKey.d)));
            await page.reload();
            const card = page.locator('article.nx-receiver-card').filter({ hasText: `${label} ${file.provenance.browserVersion}` });
            await card.waitFor(); await card.locator('summary').click();
            assert((await card.textContent()).includes(`${label} ${file.provenance.browserVersion}`));
            assert.equal(await page.evaluate(secret => document.documentElement.outerHTML.includes(secret) || Object.values(localStorage).includes(secret) || Object.values(sessionStorage).includes(secret), file.push.p256dhPrivateKey.d), false);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            assert.equal(external, 0); assert.equal(errors, 0);
            await context.close();
        }
        console.log(JSON.stringify({ renderer, chromeDesktop: true, braveMobile: true, realIntakeApi: true, encryptedRecords: 2, externalRequests: 0, pageErrors: 0, screenshots: output }));
    } finally {
        if (browser) await browser.close();
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        await db.close();
    }
}
main().catch(error => { console.error('BROWSER_INTAKE_FIXTURE_FAILED', error.message); process.exitCode = 1; });

'use strict';
/* global document, localStorage, sessionStorage, innerWidth, scrollTo */

// Development-only browser acceptance fixture. No production account, credential,
// browser profile, Firefox, Mozilla, X or notification worker is used.
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createHash, generateKeyPairSync, randomBytes, randomUUID } = require('node:crypto');
const ts = require('typescript');
const { createTestDatabase } = require('./lib/automation-test-db');
const { dispatch } = require('../src/automation/api');
const { createService } = require('../src/automation/service');
const { createXSetup } = require('../src/automation/x-setup');

const ROOT = path.resolve(__dirname, '..'), DASHBOARD = path.join(ROOT, 'dashboard');
const OUTPUT = path.join(ROOT, 'docs/angelic-angel/positive-copy-browser');
const localRequire = createRequire(path.join(DASHBOARD, 'package.json'));
const PIN = { bytes: 68653, sha256: 'c41a47ecb694cc8afe19ccfab3420d492a5a327b8264cb84b46da9ab1d7325db' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const actor = Object.freeze({ userId: '222222222222222222' });

function loadTs(filename, dependencies) {
    const source = syncFs.readFileSync(path.join(ROOT, filename), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const exports = {};
    vm.runInNewContext(compiled, { exports, Buffer, Uint8Array, Response, require(id) {
        assert.ok(Object.hasOwn(dependencies, id), `Unexpected fixture import: ${id}`);
        return dependencies[id];
    } });
    return exports;
}

function syntheticTransfer() {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' });
    return { format: 'x-notification-subscription', version: 1,
        provenance: { kind: 'firefox-pushdb', adapterVersion: '1.0.0', browserVersion: '160.0a1', readMethod: 'gecko-indexeddb-readonly' },
        push: { uaid: randomUUID(), channelID: randomUUID(), pushEndpoint: `https://updates.push.services.mozilla.com/wpush/v2/synthetic-browser-fixture-${randomUUID()}`,
            scope: 'https://x.com/', originAttributes: '',
            p256dhPublicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url'),
            authenticationSecret: randomBytes(16).toString('base64url'),
            p256dhPrivateKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, ext: true, key_ops: ['deriveBits'] } } };
}

async function browserAssets() {
    const entry = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {XNotificationSetupScreen} from './dashboard/components/automation/x-notification-setup-screen';
import './dashboard/app/globals.css';
createRoot(document.getElementById('root')!).render(<main className="mx-auto max-w-5xl space-y-4 p-4"><p data-fixture-banner className="rounded border border-amber-500 bg-amber-50 p-3 text-sm">ローカル検証用：架空の受信情報のみ使用しています。</p><h1 className="text-2xl font-semibold">X通知の受信設定</h1><XNotificationSetupScreen /></main>);`;
    const built = await require('esbuild').build({ absWorkingDir: ROOT,
        stdin: { contents: entry, resolveDir: ROOT, sourcefile: 'x-setup-browser-entry.tsx', loader: 'tsx' },
        bundle: true, write: false, outfile: 'app.js', platform: 'browser', jsx: 'automatic',
        nodePaths: [path.join(DASHBOARD, 'node_modules')],
        alias: { react: path.dirname(localRequire.resolve('react/package.json')), 'react-dom': path.dirname(localRequire.resolve('react-dom/package.json')) },
        define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' } });
    const assets = new Map(), theme = localRequire(path.join(DASHBOARD, 'tailwind.config.ts')).default;
    for (const file of built.outputFiles) {
        const name = path.basename(file.path);
        const content = name.endsWith('.css') ? (await localRequire('postcss')([
            localRequire('tailwindcss')({ ...theme, content: [
                path.join(DASHBOARD, 'components/**/*.{ts,tsx}').replaceAll('\\', '/'), { raw: entry, extension: 'tsx' },
            ] }), localRequire('autoprefixer'),
        ]).process(file.text, { from: undefined })).css : file.text;
        assets.set(`/${name}`, content);
    }
    return assets;
}

async function main() {
    const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
    assert.equal(port, 33621, 'Use the explicitly reviewed loopback fixture: AUTOMATION_TEST_DB_PORT=33621');
    const { createTransferPublicSealer } = require('../src/automation/x-setup-transfer');
    assert.equal(typeof createTransferPublicSealer, 'function', 'Public-key intake constructor must be available; no symmetric fallback');
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const sealer = createTransferPublicSealer({ activeKeyId: 'fixture', publicKeys: { fixture: publicKey } });
    assert.equal(typeof sealer.open, 'undefined');
    const file = syntheticTransfer(), fileBytes = Buffer.from(JSON.stringify(file));
    const secrets = [file.push.uaid, file.push.channelID, file.push.pushEndpoint, file.push.p256dhPublicKey,
        file.push.authenticationSecret, file.push.p256dhPrivateKey.d];
    const checks = [], requests = [], screenshots = [], pageErrors = [], externalRequests = [];
    let db, server, browser, origin, stage = 'start', timedOut = false, completed = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        if (browser) void browser.close();
        if (server) server.closeAllConnections();
    }, 120000);
    timeout.unref();
    const startedAt = new Date().toISOString();
    try {
        stage = 'build fixture assets';
        const assets = await browserAssets();
        stage = 'create disposable database';
        db = await createTestDatabase(port);
        assert.match(db.schema, /^cbte_automation_test_[0-9a-f]{20}$/);
        const services = { db, service: createService(db), xSetup: createXSetup(db, { sealer, rolloutMode: 'public' }) };
        const cookie = `x_setup_fixture=${randomBytes(24).toString('hex')}`;
        const download = loadTs('dashboard/lib/x-setup-download.ts', {
            'server-only': {}, 'node:crypto': { createHash }, '@/lib/bot-require': { requireBotModule(relative) {
                assert.equal(relative, 'scripts/build-angelic-setup-package.cjs');
                return require('../scripts/build-angelic-setup-package.cjs');
            } },
        });
        class ApiError extends Error { constructor(status) { super('Fixture login required'); this.status = status; } }
        server = http.createServer(async (req, res) => {
            let url, status = 500;
            try {
                if (!origin || req.headers.host !== new URL(origin).host) { status = 403; res.writeHead(status); res.end(); return; }
                url = new URL(req.url, origin);
                res.setHeader('Cache-Control', 'private, no-store');
                const authenticated = req.headers.cookie?.split(/;\s*/).includes(cookie) === true;
                if (url.pathname === '/api/automation/x-setup/download' && req.method === 'GET') {
                    const route = loadTs('dashboard/app/api/automation/x-setup/download/route.ts', {
                        '@/lib/api': { ApiError, requireSession: async () => { if (!authenticated) throw new ApiError(401); return { user: { id: actor.userId } }; },
                            json: (body, code) => new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } }) },
                        '@/lib/x-setup-download': download,
                    });
                    const response = await route.GET(); status = response.status;
                    res.writeHead(status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return;
                }
                if (/^\/api\/automation\/x-setup(?:\/|$)/.test(url.pathname)) {
                    if (!authenticated) { status = 401; res.writeHead(status); res.end('{"code":"AUTH_REQUIRED"}'); return; }
                    if (req.method !== 'GET' && req.headers.origin !== origin) { status = 403; res.writeHead(status); res.end('{"code":"BAD_ORIGIN"}'); return; }
                    const chunks = []; let size = 0;
                    for await (const chunk of req) { size += chunk.length; if (size > 65536) throw Object.assign(new Error(), { status: 413, code: 'BODY_TOO_LARGE' }); chunks.push(chunk); }
                    const body = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
                    const result = await dispatch({ method: req.method, path: url.pathname.slice('/api/automation/'.length).split('/'), search: url.searchParams, body }, actor, services);
                    status = 200; res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' }); res.end(JSON.stringify(result)); return;
                }
                if (req.method === 'GET' && assets.has(url.pathname)) {
                    status = 200; res.writeHead(status, { 'Content-Type': url.pathname.endsWith('.css') ? 'text/css;charset=utf-8' : 'text/javascript;charset=utf-8' }); res.end(assets.get(url.pathname)); return;
                }
                if (req.method === 'GET' && url.pathname === '/dashboard/automation/x-setup') {
                    status = 200; res.writeHead(status, { 'Content-Type': 'text/html;charset=utf-8',
                        'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'" });
                    res.end('<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/app.css"><title>X通知の受信設定・ローカル検証</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>'); return;
                }
                status = 404; res.writeHead(status); res.end();
            } catch (error) {
                status = Number(error.status) || 503;
                res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' });
                res.end(JSON.stringify({ code: typeof error.code === 'string' ? error.code : 'FIXTURE_FAILED', error: '選択したファイルや操作を確認してください。' }));
            } finally {
                // Request metadata only. Never record upload/session bodies or URLs.
                requests.push({ method: req.method, path: url?.pathname?.replace(/\/subscriptions\/[^/]+$/, '/subscriptions/:id') || 'rejected-host', status });
            }
        });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        origin = `http://127.0.0.1:${server.address().port}`;
        checks.push('ephemeral-loopback-server-with-local-fake-session-and-real-dispatch');
        process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(ROOT, 'node_modules/.cache/ux-browser');
        const { chromium } = require('../design-previews/qa/node_modules/playwright');
        stage = 'launch isolated headless browser';
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, serviceWorkers: 'block' });
        await context.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=')[1], url: origin, httpOnly: true, sameSite: 'Strict' }]);
        await context.route('**/*', route => {
            if (new URL(route.request().url()).origin === origin) return route.continue();
            externalRequests.push('blocked-external-request'); return route.abort();
        });
        const page = await context.newPage(); page.setDefaultTimeout(10000);
        page.on('pageerror', () => pageErrors.push('browser-page-error'));
        const privatePage = async () => {
            const exposed = await page.evaluate(values => {
                const html = document.documentElement.outerHTML;
                return { secretVisible: values.some(value => html.includes(value)), localStorageEntries: localStorage.length, sessionStorageEntries: sessionStorage.length };
            }, secrets);
            assert.deepEqual(exposed, { secretVisible: false, localStorageEntries: 0, sessionStorageEntries: 0 });
        };
        const noOverflow = async () => {
            const result = await page.evaluate(() => ({ document: document.documentElement.scrollWidth <= innerWidth,
                outside: [...document.querySelectorAll('body *')].filter(element => {
                    const rect = element.getBoundingClientRect();
                    return rect.width && rect.height && (rect.left < -1 || rect.right > innerWidth + 1);
                }).length }));
            assert.equal(result.document, true); assert.equal(result.outside, 0);
        };
        const capture = async name => {
            await privatePage(); await noOverflow();
            await fs.mkdir(OUTPUT, { recursive: true });
            const filename = `${name}.png`, bytes = await page.screenshot({ path: path.join(OUTPUT, filename), fullPage: true });
            screenshots.push({ filename, bytes: bytes.length, sha256: hash(bytes), viewport: page.viewportSize() });
        };
        const rows = table => db.queryDatabase(`SELECT * FROM ${table}`);
        const count = async table => (await rows(table)).length;
        const waitLoaded = () => page.getByText('登録した受信情報は、ここに表示されます。', { exact: true }).waitFor();
        const consent = page.getByRole('checkbox', { name: /^サーバーでX通知を受信・復号/ });
        const input = page.locator('input[type="file"]');
        const validate = page.getByRole('button', { name: 'ファイルの内容を確認', exact: true });
        stage = 'desktop initial instructions and consent';
        await page.goto(`${origin}/dashboard/automation/x-setup`); await waitLoaded();
        const disclosure = await page.locator('body').textContent();
        for (const pattern of [/他サイトの秘密鍵は含みません/, /暗号化された通知や識別情報もサーバーへ届く/, /運営側でそのデータを取得することは可能/, /別途明確な許可/, /Firefoxでも受け取れなくなる/]) assert.match(disclosure, pattern);
        assert.match(await consent.getAttribute('type'), /checkbox/);
        checks.push('mixed-site-reception-capability-discard-and-separate-permission-disclosed-before-upload');
        assert.equal(await input.isDisabled(), true); await capture('desktop-instructions');
        stage = 'authenticated pinned package download';
        const pendingDownload = page.waitForEvent('download');
        await page.locator('a[download]').click();
        const received = await pendingDownload, receivedPath = await received.path(), packageBytes = await fs.readFile(receivedPath);
        assert.equal(received.suggestedFilename(), 'x-notification-setup-0.1.0-preview.4.zip');
        assert.equal(packageBytes.length, PIN.bytes); assert.equal(hash(packageBytes), PIN.sha256); await received.delete();
        checks.push('actual-authenticated-download-route-pinned-release-bytes');
        await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => scrollTo(0, 0)); await capture('mobile-instructions');
        checks.push('desktop1440-and-mobile390-no-horizontal-overflow');
        stage = 'manual invalid file validation';
        await consent.check();
        const writesBefore = requests.filter(request => request.method !== 'GET').length;
        await input.setInputFiles({ name: 'x-notification-invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"invalid":') });
        await page.getByText('ファイルを選択しました。「ファイルの内容を確認」で次へ進めます。', { exact: true }).waitFor();
        assert.equal(requests.filter(request => request.method !== 'GET').length, writesBefore);
        await validate.click(); await page.getByRole('alert').filter({ hasText: '今回のファイルは、登録用の形式' }).waitFor();
        assert.equal(await count('automation_x_subscriptions'), 0); await privatePage();
        checks.push('manual-file-choice-does-no-network-write-invalid-json-refused-by-real-api');
        stage = 'synthetic P256 file review';
        await input.setInputFiles({ name: 'x-notification-synthetic.json', mimeType: 'application/json', buffer: fileBytes });
        await page.getByText('ファイルを選択しました。「ファイルの内容を確認」で次へ進めます。', { exact: true }).waitFor();
        await validate.click();
        const review = page.getByRole('region', { name: 'X通知ファイルの登録確認', exact: true });
        await review.waitFor(); assert.match(await review.textContent(), /Firefox 160\.0a1/);
        assert.equal(await count('automation_x_subscriptions'), 0); await capture('mobile-review');
        checks.push('real-api-preview-shows-only-safe-metadata-and-does-not-save');
        stage = 'explicit final save and encrypted database';
        await page.getByRole('button', { name: 'この受信情報を登録', exact: true }).click();
        await page.getByRole('status').filter({ hasText: '受信情報を登録しました。' }).waitFor();
        assert.equal(await count('automation_x_subscriptions'), 1);
        const stored = (await rows('automation_x_subscriptions'))[0];
        for (const secret of secrets) assert.equal(stored.sealed_json.includes(secret), false);
        assert.equal(stored.key_id, 'fixture');
        const envelope = JSON.parse(stored.sealed_json); assert.equal(envelope.version, 2);
        assert.equal(await consent.isChecked(), false); assert.equal(await input.inputValue(), ''); await privatePage();
        await page.setViewportSize({ width: 1440, height: 1000 }); await capture('desktop-saved');
        checks.push('explicit-final-save-stores-hybrid-envelope-without-plaintext-and-clears-selection');
        stage = 'restarted service and browser reload persistence';
        services.xSetup = createXSetup(db, { sealer });
        await page.reload(); await page.getByRole('article', { name: '受信情報1', exact: true }).waitFor();
        assert.equal((await services.xSetup.status(actor)).receiverEnabled, false); await privatePage();
        checks.push('service-restart-and-browser-reload-retain-safe-metadata-with-receiver-disabled');
        stage = 'delete confirmation and cancellation';
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole('button', { name: '受信情報を削除', exact: true }).click();
        await page.getByRole('region', { name: '受信情報の削除確認', exact: true }).waitFor();
        assert.equal(await count('automation_x_subscriptions'), 1); await capture('mobile-delete-confirm');
        await page.getByRole('button', { name: '削除を取り消す', exact: true }).click();
        assert.equal(await count('automation_x_subscriptions'), 1);
        await page.getByRole('button', { name: '受信情報を削除', exact: true }).click();
        await page.getByRole('button', { name: 'この受信情報を削除', exact: true }).click();
        await page.getByRole('status').filter({ hasText: 'サービス上の受信情報を削除しました。' }).waitFor();
        assert.equal(await count('automation_x_subscriptions'), 0);
        await page.reload(); await waitLoaded(); await privatePage();
        assert.equal(await count('automation_notification_slots'), 0); assert.equal(await count('automation_x_monitors'), 0);
        checks.push('delete-requires-confirmation-cancel-preserves-data-confirm-removes-and-reload-stays-empty');
        checks.push('no-notification-slots-no-monitors-no-worker-or-external-delivery');
        assert.equal(require.cache[path.join(ROOT, 'src/db.js')], undefined);
        assert.equal(require.cache[path.join(ROOT, 'config.json')], undefined);
        assert.deepEqual(pageErrors, []); assert.deepEqual(externalRequests, []); assert.equal(timedOut, false);
        checks.push('no-secret-values-in-dom-or-web-storage-zero-external-requests-zero-page-errors');
        completed = true;
    } catch (error) {
        // Assertions involve safe state/counts. Raw request/file/key data is never logged.
        console.error(JSON.stringify({ stage, code: error.code || error.name || 'FAILED', timedOut }));
        throw new Error('Local X notification browser verification failed');
    } finally {
        clearTimeout(timeout);
        if (browser) await browser.close();
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        if (db) await db.close();
    }
    if (completed) {
        const report = { startedAt, finishedAt: new Date().toISOString(), checks, screenshots, requests,
            fixtureOnly: true, productionIO: false, actualOAuthLoginVerified: false, actualFirefoxVerified: false,
            actualPushDeliveryVerified: false, database: { host: '127.0.0.1', port, disposableSchemaRemoved: true },
            intakeEncryption: 'public-key-hybrid', pageErrors, externalRequests: externalRequests.length };
        const serialized = JSON.stringify(report, null, 2) + '\n';
        for (const secret of secrets) assert.equal(serialized.includes(secret), false);
        await fs.mkdir(OUTPUT, { recursive: true }); await fs.writeFile(path.join(OUTPUT, 'browser.json'), serialized);
        console.log(JSON.stringify({ passed: checks.length, pageErrors: pageErrors.length, externalRequests: externalRequests.length, screenshots: screenshots.length, disposableSchemaRemoved: true }));
    }
}
main().catch(() => { process.exitCode = 1; });

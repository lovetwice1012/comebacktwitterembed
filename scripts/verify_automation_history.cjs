'use strict';
// Fresh local browser + the disposable SQL harness only. No user profiles or
// external navigation. Generated evidence belongs to this test run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, 'node_modules/.cache/ux-browser');
const { chromium, expect } = require('../design-previews/qa/node_modules/playwright/test');
const fixture = new URL(process.env.AUTOMATION_AUDIT_UI_URL || '');
if (fixture.hostname !== '127.0.0.1' || fixture.protocol !== 'http:' || !fixture.port) throw new Error('Explicit loopback fixture required');
async function main() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ja-JP', serviceWorkers: 'block' });
    const result = { at: new Date().toISOString(), checks: [], pageErrors: [], externalRequests: [], mutations: [], realMessages: 0 };
    const folder = path.join(root, 'docs/audits/completion/history');
    fs.mkdirSync(folder, { recursive: true });
    await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === fixture.origin) return route.continue();
        result.externalRequests.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    let accept = true, lastDialog = '', id;
    page.on('dialog', dialog => { lastDialog = dialog.message(); void (accept ? dialog.accept() : dialog.dismiss()); });
    page.on('pageerror', error => result.pageErrors.push(error.message));
    page.on('request', request => { if (request.method() !== 'GET') result.mutations.push({ method: request.method(), path: new URL(request.url()).pathname }); });
    const button = name => page.getByRole('button', { name, exact: true });
    const name = page.getByRole('textbox', { name: 'ルール名', exact: true });
    const ready = () => expect(button('下書きを保存')).toBeEnabled();
    const check = label => { assert.deepEqual(result.pageErrors, []); result.checks.push(label); console.log(`PASS ${label}`); };
    const read = async resource => { const response = await page.request.get(new URL(`/api/automation/${resource}`, fixture).href); assert.equal(response.status(), 200); return response.json(); };
    const saved = () => read(`workflows/${id}`);
    try {
        await page.goto(fixture.href); await button('スタジオ').click(); await button('新しいルール').click(); await ready();
        await name.fill('history first');
        const creation = page.waitForResponse(response => new URL(response.url()).pathname === '/api/automation/workflows' && response.request().method() === 'POST');
        await button('下書きを保存').click(); id = (await (await creation).json()).id; await ready();
        await expect(button('再開')).toBeDisabled();
        check('an unapplied saved draft does not offer an unusable resume action');
        await button('適用').click(); await expect(button('停止')).toBeEnabled(); await ready();
        const active = (await saved()).activeRevision;
        await name.fill('history second'); await button('下書きを保存').click(); await ready();
        const afterSecond = await saved(); assert.equal(afterSecond.activeRevision, active);
        await button('変更履歴').click(); await expect(button('この版を下書きに復元').first()).toBeVisible();
        check('saved unapplied editions appear in history and do not alter the active edition');
        await name.fill('unsaved must survive'); accept = false;
        const beforeRestoreCount = result.mutations.filter(row => row.path.endsWith('/restore')).length;
        await button('この版を下書きに復元').last().click();
        await expect(name).toHaveValue('unsaved must survive'); assert.match(lastDialog, /未保存/);
        assert.equal(result.mutations.filter(row => row.path.endsWith('/restore')).length, beforeRestoreCount);
        assert.equal((await saved()).revision, afterSecond.revision);
        check('declining restore preserves unsaved edits and performs no server mutation');
        accept = true;
        await button('この版を下書きに復元').last().click(); await expect(name).toHaveValue('history first'); await ready();
        assert.equal((await saved()).activeRevision, active); assert.equal((await saved()).revision, afterSecond.revision + 1);
        check('confirmed restore creates a new draft edition while the running edition stays pinned');
        await name.fill('unsaved export'); accept = false;
        await button('共有用エクスポート').click(); assert.match(lastDialog, /未保存.*含まれません/);
        await expect(name).toHaveValue('unsaved export');
        check('export distinguishes saved content from unsaved edits without discarding them');
        await button('テキスト').click();
        await page.getByRole('textbox', { name: 'ルールJSONまたはYAML', exact: true }).fill('nodes: [invalid');
        await expect(button('下書きを保存')).toBeDisabled();
        await expect(page.locator('.automation-workbench').getByRole('button', { name: '複製', exact: true }).first()).toBeDisabled();
        check('invalid raw text cannot be silently discarded by duplicating the older valid graph');
        await page.screenshot({ path: path.join(folder, 'history-guard.png'), fullPage: true });
        assert.deepEqual(result.externalRequests, []);
        fs.writeFileSync(path.join(folder, 'result.json'), JSON.stringify({ ...result, status: 'passed' }, null, 2));
    } catch (error) {
        fs.writeFileSync(path.join(folder, 'result.json'), JSON.stringify({ ...result, status: 'failed', error: error.stack }, null, 2));
        throw error;
    } finally { await context.close(); await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

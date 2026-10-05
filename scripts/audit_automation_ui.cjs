'use strict';

// Source-application browser tests, isolated from user profiles and production.
// The required fixture server uses a disposable SQL schema and fake Discord.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, 'node_modules/.cache/ux-browser');
const { chromium } = require('../design-previews/qa/node_modules/playwright');
const fixture = new URL(process.env.AUTOMATION_AUDIT_UI_URL || '');
if (fixture.hostname !== '127.0.0.1' || fixture.protocol !== 'http:' || !fixture.port) throw new Error('An explicit loopback fixture URL is required');
const folder = path.join(root, 'docs/audits');
const scenario = process.env.AUTOMATION_AUDIT_UI_SCENARIO === 'basic' ? 'basic' : 'selection';
fs.mkdirSync(folder, { recursive: true });

async function main() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ja-JP' });
    const result = { auditedAt: new Date().toISOString(), scenario, fixtureOnly: true, productionAuthenticationTested: false,
        liveMessagesSent: 0, pageErrors: [], blockedExternalRequests: [], observations: [] };
    await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === fixture.origin) return route.continue();
        result.blockedExternalRequests.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => result.pageErrors.push({ message: error.message, stack: error.stack }));
    let unloadDialogs = 0;
    page.on('dialog', async dialog => { if (dialog.type() === 'beforeunload') unloadDialogs++; await dialog.accept(); });
    try {
        await page.goto(fixture.href);
        await page.getByRole('button', { name: 'ルール', exact: true }).click();
        await page.getByRole('button', { name: /セール告知 \/ 毎朝9時/ }).click();
        await page.locator('.react-flow__node').filter({ hasText: 'condition' }).waitFor();
        result.observations.push({ id: 'editor_opened', ...await geometry(page) });
        await page.screenshot({ path: path.join(folder, 'automation-editor-before-selection.png'), fullPage: true });
        if (scenario === 'selection') {
            await page.locator('.react-flow__node').filter({ hasText: 'condition' }).click();
            await page.getByRole('combobox', { name: '比較方法', exact: true }).waitFor();
            const options = await page.getByRole('combobox', { name: '比較方法', exact: true }).locator('option').allTextContents();
            result.observations.push({ id: 'comparison_vocabulary', shownOptions: options, internalTokensExposed: options.includes('notContains') });
        }
        result.observations.push({ id: 'desktop_geometry', ...await geometry(page) });
        await page.screenshot({ path: path.join(folder, 'automation-editor-desktop.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        result.observations.push({ id: 'mobile_geometry', ...await geometry(page) });
        await page.screenshot({ path: path.join(folder, 'automation-editor-mobile.png'), fullPage: true });
        await page.setViewportSize({ width: 1440, height: 1000 });
        const originalName = await page.getByRole('textbox', { name: 'ルール名', exact: true }).inputValue();
        const changedName = `${originalName} (unsaved audit)`;
        await page.getByRole('textbox', { name: 'ルール名', exact: true }).fill(changedName);
        await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(b => b.textContent === '下書きを保存' && !b.disabled));
        await page.reload();
        await page.getByRole('button', { name: 'ルール', exact: true }).click();
        await page.getByRole('button', { name: /セール告知 \/ 毎朝9時/ }).click();
        const restoredName = await page.getByRole('textbox', { name: 'ルール名', exact: true }).inputValue();
        result.observations.push({ id: 'unsaved_graph_reload', originalName, editedName: changedName, restoredName,
            beforeUnloadDialogs: unloadDialogs, changeLost: restoredName !== changedName,
            limitation: 'This proves no restored draft or beforeunload dialog in this scripted reload; it is not a test of every navigation method.' });
        result.status = 'completed';
    } catch (error) {
        result.status = 'incomplete'; result.error = error.message; process.exitCode = 1;
        result.finalVisibleText = await page.locator('body').innerText();
        await page.screenshot({ path: path.join(folder, `automation-editor-failure-${scenario}.png`), fullPage: true });
    }
    finally {
        fs.writeFileSync(path.join(folder, `automation-ui-audit-${scenario}.json`), JSON.stringify(result, null, 2) + '\n');
        console.log(JSON.stringify(result, null, 2)); await browser.close();
    }
}
async function geometry(page) {
    return page.evaluate(() => {
        const flow = document.querySelector('.react-flow'), rect = flow?.getBoundingClientRect();
        return { viewport: { width: innerWidth, height: innerHeight }, document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
            canvas: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
            visibleInputs: Array.from(document.querySelectorAll('input,select,textarea,button')).filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0; }).length };
    });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const mysql = require('mysql2/promise');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve('node_modules/.cache/ux-browser');
const { chromium, expect } = require('../design-previews/qa/node_modules/playwright/test');
const fixture = new URL(process.env.AUTOMATION_AUDIT_UI_URL || '');
const schema = process.env.AUTOMATION_TEST_SCHEMA || '';
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (fixture.hostname !== '127.0.0.1' || fixture.protocol !== 'http:' || !fixture.port || !/^cbte_automation_test_[0-9a-f]{20}$/.test(schema) || !Number.isInteger(port) || port < 1024 || port === 3306) throw new Error('Explicit disposable loopback fixtures are required');
const userId = '222222222222222222';
async function main() {
    const db = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: process.env.AUTOMATION_TEST_DB_PASSWORD || '', database: schema });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(); const errors = [], external = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', dialog => dialog.accept());
    await page.route('**/*', route => { if (new URL(route.request().url()).origin === fixture.origin) return route.continue(); external.push(route.request().url()); return route.abort(); });
    try {
        await db.execute('UPDATE users SET is_donor=0,additional_auto_extract_slots=100 WHERE user_id=?', [userId]);
        await page.goto(fixture.href);
        const add = page.getByRole('button', { name: '通知を追加', exact: true });
        await expect(page.getByText('新着自動展開の登録・再開・対象や通知先の変更は、寄付者のみ利用できます。既存の監視は一覧・停止・削除できます。')).toBeVisible();
        await expect(add).toBeDisabled();
        const destinations = await (await page.request.get(new URL('/api/automation/destinations', fixture).href)).json();
        const denied = await page.request.post(new URL('/api/automation/monitors/auto', fixture).href, { headers: { origin: fixture.origin }, data: { name: 'forged donor', providerId: 'github', source: 'octocat', destinationId: destinations.items[0].id, is_donor: 1, isDonor: true } });
        assert.equal(denied.status(), 403); assert.equal((await denied.json()).code, 'AUTO_WATCH_DONOR_REQUIRED');
        await page.getByRole('button', { name: '価格', exact: true }).click(); await expect(add).toBeEnabled();
        await db.execute('UPDATE users SET is_donor=1 WHERE user_id=?', [userId]);
        await page.reload(); await expect(add).toBeEnabled(); await add.click();
        await page.getByRole('textbox', { name: 'アカウントURL / ID', exact: true }).fill('https://github.com/octocat');
        await page.getByRole('textbox', { name: '名前（省略可）', exact: true }).fill('寄付者の新着通知');
        await page.getByRole('button', { name: '確認して通知を保存', exact: true }).click();
        await expect(page.getByRole('heading', { name: '寄付者の新着通知', exact: true })).toBeVisible();
        await db.execute('UPDATE users SET is_donor=0 WHERE user_id=?', [userId]);
        await page.reload(); await expect(add).toBeDisabled();
        await expect(page.getByRole('button', { name: '停止', exact: true })).toBeEnabled();
        await page.getByRole('button', { name: '停止', exact: true }).click();
        await expect(page.getByRole('button', { name: '再開', exact: true })).toBeDisabled();
        await page.getByRole('button', { name: '削除', exact: true }).first().click();
        await expect(page.getByRole('heading', { name: '寄付者の新着通知', exact: true })).toHaveCount(0);
        assert.deepEqual(errors, []); assert.deepEqual(external, []);
        const result = { passed: true, fixtureOnly: true, realDiscordMessages: 0, checks: ['non-donor admin with additional slots cannot register', 'forged donor API request returns 403', 'donor can create an actual monitor', 'revoked donor cannot resume', 'non-donor can stop and delete an existing monitor', 'price registration unchanged'], pageErrors: errors, externalRequests: external };
        fs.writeFileSync('docs/qa/auto-watch-donors-browser-2026-10-05.json', JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
    } finally { await db.execute('UPDATE users SET is_donor=1,additional_auto_extract_slots=0 WHERE user_id=?', [userId]); await db.end(); await browser.close(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });

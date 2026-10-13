/* global document, localStorage, sessionStorage */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium } = require('./playwright-qa.cjs').loadPlaywrightForQA();
const { startHarness } = require('./dashboard-ui-harness.cjs');

const owner = '796972193287503913';
const otherAdmin = '933314562487386122';
const guild = '111111111111111111';
const readonly = '333333333333333333';
const folder = path.resolve('docs/qa/dashboard-ui-rollout-2026-10-13');

async function main() {
  await fs.mkdir(folder, { recursive: true });
  const fixtures = [], checks = [], browserErrors = [], externalRequests = [];
  let browser;
  try {
    // Independent loopback servers model separately authenticated viewers.
    // The version is chosen by the real server policy before any page request.
    for (const [label, fakeViewerId, expected] of [['owner', owner, 'preview'], ['other-admin', otherAdmin, 'legacy'], ['ordinary', '123456789012345678', 'legacy'], ['guest', null, 'legacy'], ['invalid', 'invalid', 'legacy']]) {
      const harness = await startHarness({ port: 0, fakeViewerId });
      fixtures.push({ label, fakeViewerId, expected, ...harness });
      assert.equal(harness.uiVersion, expected);
    }
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
    await context.route('**/*', async route => {
      if (fixtures.some(fixture => route.request().url().startsWith(fixture.url + '/'))) return route.continue();
      externalRequests.push(route.request().url()); await route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => browserErrors.push(error.message));
    const visit = async (fixture, route) => {
      await page.goto(fixture.url + route);
      await page.locator('[data-fixture-banner]').waitFor();
      assert.equal(await page.locator('html').getAttribute('data-dashboard-ui'), fixture.expected);
      assert.equal(await page.locator('.dashboard-app').count(), fixture.expected === 'preview' ? 1 : 0);
    };
    const photo = async name => page.screenshot({ path: path.join(folder, `${name}.jpg`), type: 'jpeg', quality: 88, fullPage: true });
    for (const fixture of fixtures) {
      await visit(fixture, `/dashboard?mode=user&preview=true&uiVersion=preview&userId=${owner}&guildId=${owner}`);
      const bootstrap = await (await page.request.get(fixture.url + '/fixture/bootstrap')).json();
      assert.equal(bootstrap.viewer.id, fixture.fakeViewerId);
      assert.equal(bootstrap.uiVersion, fixture.expected);
      await page.evaluate(id => {
        localStorage.setItem('dashboard_ui', 'preview'); localStorage.setItem('dashboard_ui_user', id);
        sessionStorage.setItem('dashboard_ui_preview', 'true'); document.cookie = `dashboard_ui=preview; path=/`;
      }, owner);
      await page.reload(); await page.locator('[data-fixture-banner]').waitFor();
      assert.equal(await page.locator('html').getAttribute('data-dashboard-ui'), fixture.expected);
      assert.equal(await page.locator('.dashboard-app').count(), fixture.expected === 'preview' ? 1 : 0);
      checks.push({ check: `${fixture.label}-server-policy-ignores-url-cookie-and-browser-storage`, version: bootstrap.uiVersion, fakeViewerId: fixture.fakeViewerId });
      if (!['owner', 'other-admin'].includes(fixture.label)) continue;
      await photo(`${fixture.label}-home`);
      await visit(fixture, `/dashboard/${guild}/providers/twitter?preview=true`);
      const legacyCard = heading => page.locator('div.rounded-lg.border.bg-card.text-card-foreground').filter({ has: page.getByRole('heading', { name: heading, exact: true }) }).first();
      const enabled = fixture.expected === 'preview' ? page.getByRole('checkbox', { name: 'リンクを展開', exact: true }) : legacyCard('リンクを展開').locator('input[type=checkbox]').first();
      await enabled.waitFor();
      assert.equal(await page.locator('.dashboard-sidebar').count(), fixture.expected === 'legacy' ? 1 : 0);
      assert.equal(await enabled.isChecked(), true);
      const density = fixture.expected === 'preview' ? page.getByRole('combobox', { name: '表示する情報量', exact: true }) : legacyCard('表示する情報量').locator('select');
      assert.equal(await density.inputValue(), 'standard');
      assert.equal(await (fixture.expected === 'preview' ? page.locator('#setting-bannedWords') : legacyCard('指定した語を含む投稿を除外')).isVisible(), fixture.expected === 'legacy');
      if (fixture.expected === 'preview') {
        const allSettings = page.getByRole('button', { name: /^すべての設定/ });
        await allSettings.click();
        for (const setting of bootstrap.settings[`${guild}:twitter`]) assert.equal(await page.locator(`#setting-${setting.key}`).isVisible(), true, `all settings reveals ${setting.key}`);
        checks.push({ check: 'owner-all-settings-reveals-every-fixture-setting', total: bootstrap.settings[`${guild}:twitter`].length });
      }
      await photo(`${fixture.label}-settings`);
      checks.push({ check: `${fixture.label}-settings-version-and-defaults`, version: fixture.expected });
      await visit(fixture, '/dashboard/personal-links');
      const personalForm = page.getByRole('form', { name: fixture.expected === 'preview' ? 'リンク・通知を登録' : '登録・編集フォーム', exact: true });
      await page.getByRole('heading', { name: 'あとで見る・通知', exact: true }).waitFor();
      assert.equal(await personalForm.isVisible(), fixture.expected === 'legacy');
      await photo(`${fixture.label}-personal`);
      checks.push({ check: `${fixture.label}-desktop-personal-form-default`, initialFormVisible: fixture.expected === 'legacy' });
      await visit(fixture, `/dashboard/${guild}/preview`);
      assert.equal(await page.getByRole('combobox', { name: '表示を確認するサービス', exact: true }).count(), fixture.expected === 'preview' ? 1 : 0);
      await photo(`${fixture.label}-preview`);
      await visit(fixture, `/dashboard/${guild}/logs`);
      assert.equal(await page.locator('pre').count(), fixture.expected === 'legacy' ? bootstrap.auditLogs.length * 2 : 0);
      assert.equal(await page.getByRole('searchbox', { name: '変更履歴を検索', exact: true }).count(), fixture.expected === 'preview' ? 1 : 0);
      await photo(`${fixture.label}-history`);
      await visit(fixture, `/dashboard/${guild}/access`);
      await page.getByText('fixture_reviewer', { exact: false }).first().waitFor();
      await photo(`${fixture.label}-access`);
      await visit(fixture, `/dashboard/${readonly}/access`);
      assert.equal(await page.getByRole('link', { name: 'サーバーを選び直す', exact: true }).count(), fixture.expected === 'preview' ? 1 : 0);
      const rejected = await page.request.post(`${fixture.url}/api/guilds/${readonly}/access`, { data: { targetType: 'user', targetIds: ['666666666666666666'], accessLevel: 'edit' }, headers: { Origin: fixture.url } });
      assert.equal(rejected.status(), 403);
      checks.push({ check: `${fixture.label}-preview-history-access-snapshots-and-view-only-denial` });
      await page.setViewportSize({ width: 390, height: 844 });
      await visit(fixture, `/dashboard/${guild}/providers/twitter`);
      assert.equal(await enabled.isEnabled(), true);
      if (fixture.expected === 'preview') {
        const toggle = page.getByRole('button', { name: /メニュー/ });
        await toggle.click(); assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
        await page.keyboard.press('Escape'); assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      }
      await photo(`${fixture.label}-mobile-settings`);
      checks.push({ check: `${fixture.label}-mobile-version-navigation` });
      await page.setViewportSize({ width: 1440, height: 1024 });
    }
    // Repeat the owner after visiting unrelated accounts using the same browser
    // context. The selected identity comes from each server's startup session.
    const ownerFixture = fixtures[0];
    await visit(ownerFixture, '/dashboard?mode=user');
    assert.equal(await page.locator('.guild-directory-row').count(), 3);
    checks.push({ check: 'owner-preview-retained-after-other-accounts' });
    assert.deepEqual(browserErrors, []); assert.deepEqual(externalRequests, []);
    for (const fixture of fixtures) {
      const evidence = await (await page.request.get(fixture.url + '/fixture/evidence')).json();
      assert.equal(evidence.productionIO, false);
      assert.deepEqual(evidence.mutations, []);
    }
    const legacyManifest = JSON.parse(await fs.readFile(path.resolve('dashboard/legacy/legacy-manifest.json'), 'utf8'));
    const report = { date: '2026-10-13', fixtureOnly: true, productionIO: false, legacyPresentationSource: { releaseRevision: legacyManifest.snapshot.releaseRevision, buildId: legacyManifest.snapshot.buildId, manifestSha256: legacyManifest.snapshot.manifestSha256 }, checks, browserErrors, externalRequests, screenshots: (await fs.readdir(folder)).filter(name => name.endsWith('.jpg')) };
    await fs.writeFile(path.join(folder, 'browser-checks.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (browser) await browser.close();
    for (const fixture of fixtures) await fixture.close();
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });

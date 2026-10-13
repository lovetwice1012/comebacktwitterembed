'use strict';
/* global document, innerWidth */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('./playwright-qa.cjs').loadPlaywrightForQA();
const { startHarness } = require('./dashboard-ui-harness.cjs');

async function main() {
  const folder = path.resolve('docs/qa/dashboard-ui-preference-2026-10-13');
  await fs.mkdir(folder, { recursive: true });
  const fixtures = [], errors = [], checks = [];
  let browser;
  try {
    const ordinary = await startHarness({ port: 0, fakeViewerId: '123456789012345678' }); fixtures.push(ordinary);
    const guest = await startHarness({ port: 0, fakeViewerId: null }); fixtures.push(guest);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => fixtures.some(f => route.request().url().startsWith(f.url+'/')) ? route.continue() : route.abort());
    const visit = async (url, expected) => {
      await page.goto(url); await page.locator('[data-fixture-banner]').waitFor();
      assert.equal(await page.locator('html').getAttribute('data-dashboard-ui'), expected);
    };
    const control = page.getByRole('switch', { name: '新しいダッシュボードを使う' });
    await visit(ordinary.url+'/dashboard?mode=user', 'legacy');
    assert.equal(await control.getAttribute('aria-checked'), 'false');
    await page.screenshot({ path: path.join(folder,'ordinary-legacy-desktop.jpg'), type:'jpeg',quality:85 });
    checks.push('ordinary-default-legacy-toggle-visible');
    await page.route('**/api/me/dashboard-ui', route => route.fulfill({status:503,contentType:'application/json',body:'{"error":"fixture unavailable"}'}));
    await control.click(); await page.getByRole('alert').filter({hasText:'切り替えられませんでした'}).waitFor();
    assert.equal(await control.getAttribute('aria-checked'),'false');
    await page.unroute('**/api/me/dashboard-ui');
    checks.push('failed-save-preserves-legacy-and-allows-retry');
    await control.click(); await page.waitForFunction(()=>document.documentElement.dataset.dashboardUi==='preview');
    await page.locator('[data-fixture-banner]').waitFor();
    assert.equal(await control.getAttribute('aria-checked'),'true');
    assert.equal(await page.locator('.dashboard-app').count(),1);
    await page.reload(); await page.locator('[data-fixture-banner]').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-dashboard-ui'),'preview');
    const cookies=await context.cookies(ordinary.url);
    assert.ok(cookies.some(cookie=>cookie.name==='cbte_dashboard_ui_123456789012345678' && cookie.httpOnly && cookie.sameSite==='Lax'));
    checks.push('ordinary-switch-and-reload-retains-signed-http-only-preference');
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(folder,'ordinary-preview-mobile.jpg'),type:'jpeg',quality:85});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const bounds=await control.boundingBox(); assert.ok(bounds.width>=44 && bounds.height>=44);
    await control.click(); await page.waitForFunction(()=>document.documentElement.dataset.dashboardUi==='legacy');
    await page.locator('[data-fixture-banner]').waitFor();
    await page.screenshot({path:path.join(folder,'ordinary-legacy-mobile.jpg'),type:'jpeg',quality:85});
    checks.push('mobile-switch-back-without-horizontal-overflow');
    await visit(guest.url+'/dashboard?ui=preview','legacy');
    assert.equal(await control.count(),0);
    const response=await page.request.post(guest.url+'/api/me/dashboard-ui',{data:{version:'preview'},headers:{Origin:guest.url}});
    assert.equal(response.status(),401);
    checks.push('guest-toggle-hidden-and-api-denied');
    assert.deepEqual(errors,[]);
    await fs.writeFile(path.join(folder,'browser.json'),JSON.stringify({checks,errors,fixtureOnly:true,productionIO:false,actualOAuthLoginVerified:false},null,2)+'\n');
    console.log(JSON.stringify({passed:checks.length,errors,fixtureOnly:true}));
  } finally {
    if(browser) await browser.close();
    for(const fixture of fixtures) await fixture.close();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});

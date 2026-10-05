'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve('node_modules/.cache/ux-browser');
const { chromium } = require('../design-previews/qa/node_modules/playwright');
const { startHarness } = require('./admin-workspace-ui-harness.cjs');

async function main() {
  const harness = await startHarness();
  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch (error) { await harness.close(); throw error; }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 } });
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => { if (route.request().url().startsWith(harness.url)) await route.continue(); else { external.push(route.request().url()); await route.abort(); } });
  const output = path.resolve('docs/qa/admin-workspace'); await fs.mkdir(output, { recursive: true });
  const guild = '111111111111111111', channel = '333333333333333333', user = '222222222222222222';
  const nav = name => page.getByRole('navigation', { name: '管理画面', exact: true }).getByRole('button', { name, exact: true });
  async function waitFor(test) { for (let i = 0; i < 100; i++) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Expected state did not appear'); }
  try {
    await page.goto(harness.url + '/admin');
    await page.getByRole('heading', { name: '対応が必要なこと' }).waitFor();
    await page.getByText('取得先がHTTP 429を返しました', { exact: true }).filter({ visible: true }).first().waitFor();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, 'overview.png'), fullPage: true });
    await nav('調査').click();
    await page.getByLabel('サーバー名・ID').fill(guild);
    await page.getByLabel('チャンネル名・ID').fill(channel);
    await page.getByLabel('対象ユーザーID').fill(user);
    await waitFor(() => harness.stats.requests.some(item => item.path.endsWith('/runs') && item.query.guildId === guild && item.query.channelId === channel && item.query.userId === user));
    await page.getByRole('button', { name: 'run-1 の詳細', exact: true }).click();
    const details = page.getByRole('complementary', { name: '事象の詳細' });
    await details.getByRole('heading', { name: '処理の経過' }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('selected'), 'run-1');
    await details.getByRole('button', { name: 'URLを検証', exact: true }).click();
    await waitFor(async () => await page.getByLabel('検証するURL').inputValue() === 'https://x.com/example/status/1');
    assert.equal(await page.getByLabel('検証するURL').inputValue(), 'https://x.com/example/status/1');
    await page.goBack();
    await details.getByRole('heading', { name: '処理の経過' }).waitFor();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, 'investigation.png'), fullPage: true });
    await page.reload();
    await details.getByRole('heading', { name: '処理の経過' }).waitFor();
    assert.equal(await page.getByLabel('チャンネル名・ID').inputValue(), channel);
    await nav('運用・復旧').click();
    await page.goBack();
    await details.getByRole('heading', { name: '処理の経過' }).waitFor();
    await details.getByRole('button', { name: '閉じる' }).click();
    await page.getByRole('button', { name: '次の100件を追加' }).click();
    await page.getByRole('button', { name: 'run-3 の詳細', exact: true }).waitFor();
    await page.route('**/api/admin/agent/runs?**', async route => {
      if (new URL(route.request().url()).searchParams.get('channelId') === '999') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '検索APIの検証用エラー' }) });
      else await route.fallback();
    });
    await page.getByLabel('チャンネル名・ID').fill('999');
    await page.getByRole('alert').filter({ hasText: '検索APIの検証用エラー' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'run-1 の詳細', exact: true }).count(), 0);
    await page.getByLabel('チャンネル名・ID').fill(channel);
    await page.getByRole('button', { name: 'run-1 の詳細', exact: true }).waitFor();
    await nav('サーバー・設定').click();
    assert.equal(await page.getByLabel('サーバー名・ID').inputValue(), guild);
    await page.getByRole('button', { name: '現在の設定を取得', exact: true }).click();
    await page.getByLabel('設定項目', { exact: true }).selectOption('enabled');
    await page.getByRole('checkbox', { name: '有効にする' }).uncheck();
    await page.getByRole('checkbox', { name: '対象サーバーと変更内容を確認しました' }).check();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, 'settings.png'), fullPage: true });
    await page.getByRole('button', { name: '変更を保存', exact: true }).click();
    await waitFor(() => harness.stats.mutations.length === 1);
    assert.equal(harness.stats.mutations[0].input.guildId, guild);
    assert.equal(harness.stats.mutations[0].input.value, false);
    assert.equal(harness.stats.mutations[0].input.expectedHash, 'revision-1');
    assert.equal(await page.getByRole('checkbox', { name: '対象サーバーと変更内容を確認しました' }).isChecked(), false);
    await nav('分析').click();
    await page.getByRole('button', { name: 'サーバーの利用状況', exact: true }).click();
    await waitFor(() => harness.stats.requests.some(item => item.path.endsWith('/guild-analytics-preview') && item.query.guild_id === guild));
    await nav('調査').click();
    await page.getByLabel('Discordの投稿リンク').fill(`https://discord.com/channels/${guild}/${channel}/555555555555555550`);
    await page.getByRole('button', { name: '対象を指定', exact: true }).click();
    await waitFor(() => harness.stats.requests.some(item => item.path.endsWith('/runs') && item.query.messageId === '555555555555555550'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'run-1 の詳細', exact: true }).waitFor();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'page must fit mobile width');
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    const report = { passed: true, checks: ['overview', 'server/channel/user filters', 'selected detail reload', 'back navigation', 'cursor pagination', 'inspection URL carried from selected record', 'query failure distinguished from empty results', 'settings diff and confirmation', 'expectedHash mutation', 'shared analytics filters', 'Discord link search', '390px layout'], browserErrors: errors, externalRequests: external, mutationCount: harness.stats.mutations.length };
    await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } catch (error) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }); console.error('Page errors:', errors); throw error; }
  finally { await browser.close(); await harness.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

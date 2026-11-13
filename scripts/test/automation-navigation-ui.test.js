'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const { catalog } = require('../../src/automation/catalog');

test('notification navigation keeps secondary tools accessible and dismisses its menu', async () => {
  const f = await reactFixture('export { AutomationWorkspace } from "./components/automation/automation-workspace";');
  f.set('sessionStorage', f.dom.window.sessionStorage);
  f.set('confirm', () => true);
  f.set('SVGElement', f.dom.window.SVGElement);
  f.set('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  f.dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  f.set('fetch', async address => {
    const route = new URL(address, 'http://fixture').pathname.slice('/api/automation/'.length);
    const data = route === 'catalog' ? catalog() : route === 'providers' ? { auto: [], price: [], autoRegistration: { eligible: true } }
      : route === 'entitlements' ? { plan: { name: '無料', priority: 0, dayLimit: 24, minuteLimit: 5 }, slots: { used: 0, max: 5, available: 5 }, usage: { entries: [] } }
      : { items: [], nextCursor: null };
    return new Response(JSON.stringify(data), { status: 200 });
  });
  try {
    await f.render(f.React.createElement(f.exports.AutomationWorkspace, { viewerId: '222222222222222222' }));
    await f.settle();
    const menu = f.container.querySelector('.automation-more-navigation');
    assert(menu); const summary = menu.querySelector('summary');
    assert.equal(summary.textContent, 'その他');
    for (const label of ['通知一覧', '配信予定・履歴', '通知ルール']) assert([...f.container.querySelectorAll('nav[aria-label="通知メニュー"] > button')].some(button => button.textContent === label));
    for (const label of ['辞書', '共有ルール']) assert([...menu.querySelectorAll('button')].some(button => button.textContent === label));
    menu.open = true;
    await f.act(async () => document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(menu.open, false); assert.equal(document.activeElement, summary);
    menu.open = true;
    await f.act(async () => document.body.dispatchEvent(new f.dom.window.Event('pointerdown', { bubbles: true })));
    assert.equal(menu.open, false);
    menu.open = true; await f.click('辞書');
    assert.equal(menu.open, false); assert.equal(document.activeElement, summary);
    assert.equal(menu.dataset.active, 'true');
  } finally { await f.close(); }
});

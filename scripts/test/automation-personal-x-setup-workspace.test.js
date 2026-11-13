'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomBytes, randomUUID } = require('node:crypto');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const { continueNotificationSource, openNotification, xFixtureResponse } = require('./helpers/notification-registration-fixture.cjs');
const { fixture: makeFirefoxFile } = require('./helpers/x-push-fixture.cjs');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createXSetup } = require('../../src/automation/x-setup');
const { createTransferPublicSealer } = require('../../src/automation/x-setup-transfer');
const { dispatch } = require('../../src/automation/api');
const { catalog } = require('../../src/automation/catalog');
const owner = '222222222222222222', other = '333333333333333333', guildId = '444444444444444444';
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const req = (method, path, body = {}, search = new URLSearchParams()) => ({ method, path: path.split('/'), body, search });
const failure = code => error => error.code === code;
test('the owner-only setup path cannot carry a guild or a different user in the query', async () => {
  const f = await reactFixture('export { personalXSetupUrl } from "./components/automation/automation-workspace";');
  try {
    for (const path of ['x-setup', 'x-setup/sessions', 'x-setup/validate', 'x-setup/import', 'x-setup/subscriptions/abc-def', 'x-setup?afterId=abc-def'])
      assert.equal(f.exports.personalXSetupUrl(path), `/api/automation/${path}`);
    for (const path of ['x-setup?guildId=444444444444444444', 'x-setup?ownerUserId=333333333333333333', 'x-setup?userId=333333333333333333', 'x-setup?afterId=a&guildId=4', 'x-setup?afterId=a&afterId=b', 'x-setup/sessions?afterId=a', 'x-setup/../monitors', 'x-setup%2Fvalidate'])
      assert.throws(() => f.exports.personalXSetupUrl(path));
  } finally { await f.close(); }
});
async function waitFor(f, predicate, label) {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (predicate()) return;
    await f.act(async () => new Promise(resolve => setTimeout(resolve, 50)));
  }
  assert.fail(`Timed out waiting for ${label}: ${f.container.textContent.slice(0, 500)}`);
}
async function fixture({ guild = guildId, canEdit = true, failImport = false, delayValidation = false, failDestinationRefresh = false, seedReceivers = 0, mixedRows = false, deepLink = '', delaySetupPage = false, repeatSetupCursor = false, failSetupPage = false } = {}) {
  assert(port >= 1024 && port !== 3306, 'An isolated test database port is required');
  const db = await createTestDatabase(port);
  try {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const sealer = createTransferPublicSealer({ activeKeyId: 'synthetic', publicKeys: { synthetic: publicKey } });
    const setup = createXSetup(db, { sealer, rolloutMode: 'public', chromeEnabled: true, braveEnabled: true, receiverEnabled: true });
    let receiverIds = [], foreignId = '';
    if (seedReceivers) {
      const rows = Array.from({ length: seedReceivers }, () => [randomUUID(), owner, randomBytes(32).toString('hex'), randomBytes(32).toString('hex'), randomBytes(32).toString('hex'), '{}', 'synthetic', 'firefox', '160.0a1', 1, 1, 1]);
      await db.queryDatabase('INSERT INTO automation_x_subscriptions (id,owner_user_id,uaid_hash,channel_hash,content_hash,sealed_json,key_id,browser_kind,browser_version,revision,created_at_ms,updated_at_ms) VALUES ?', [rows]);
      receiverIds = rows.map(row => row[0]).sort();
      if (deepLink === 'foreign') {
        foreignId = randomUUID();
        await db.queryDatabase('INSERT INTO automation_x_subscriptions (id,owner_user_id,uaid_hash,channel_hash,content_hash,sealed_json,key_id,browser_kind,browser_version,revision,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [foreignId, other, randomBytes(32).toString('hex'), randomBytes(32).toString('hex'), randomBytes(32).toString('hex'), '{}', 'synthetic', 'firefox', '160.0a1', 1, 1, 1]);
      }
    }
    const services = { db, xSetup: setup, service: { withOperation: async (_actor, _kind, work) => work() } };
    const f = await reactFixture('export { AutomationWorkspace } from "./components/automation/automation-workspace";');
    f.receiverIds = receiverIds; f.deepLinkId = deepLink === 'last' ? receiverIds.at(-1) : deepLink === 'foreign' ? foreignId : '';
    f.delaySetupPage = delaySetupPage; f.repeatSetupCursor = repeatSetupCursor; f.failSetupPage = failSetupPage;
    if (f.deepLinkId) f.dom.window.history.replaceState({}, '', `/?xSubscriptionId=${f.deepLinkId}#x-notifications`);
    f.set('sessionStorage', f.dom.window.sessionStorage); f.confirmAnswer = true; f.confirmCalls = 0;
    f.set('confirm', () => { f.confirmCalls++; return f.confirmAnswer; });
    f.set('SVGElement', f.dom.window.SVGElement); f.set('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    f.dom.window.HTMLElement.prototype.scrollIntoView = function () {};
    f.calls = []; f.db = db; f.services = services;
    f.set('fetch', async (address, options = {}) => {
      const u = new URL(address, 'http://fixture'), path = u.pathname.slice('/api/automation/'.length), method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : {};
      f.calls.push({ path, method, body, guild: u.searchParams.get('guildId'), search: u.searchParams });
      let result;
      if (path === 'x-setup' || path.startsWith('x-setup/')) {
        try {
          if (delayValidation && path === 'x-setup/validate') await new Promise(resolve => { f.releaseValidation = resolve; });
          if (f.delaySetupPage && path === 'x-setup' && u.searchParams.has('afterId')) await new Promise(resolve => { f.releaseSetupPage = resolve; });
          if (f.failSetupPage && path === 'x-setup' && u.searchParams.has('afterId')) throw Object.assign(new Error('synthetic failure'), { status: 503, code: 'SYNTHETIC_FAILURE' });
          if (failImport && path === 'x-setup/import') throw Object.assign(new Error('synthetic failure'), { status: 503, code: 'SYNTHETIC_FAILURE' });
          result = await dispatch(req(method, path, body, u.searchParams), { userId: owner, guildId: u.searchParams.get('guildId') || undefined }, services);
          if (f.repeatSetupCursor && path === 'x-setup' && u.searchParams.has('afterId')) result.nextCursor = u.searchParams.get('afterId');
        } catch (error) { return new Response(JSON.stringify({ code: error.code, error: error.message }), { status: error.status || 500 }); }
      } else if (path === 'catalog') result = catalog();
      else if (path === 'providers') result = { auto: [{ id: 'youtube' }], price: [], autoRegistration: { eligible: true } };
      else if (path === 'entitlements') result = { plan: { name: '無料', priority: 0, dayLimit: 24, minuteLimit: 5 }, slots: { used: 0, max: 5, available: 5 }, usage: { entries: [] } };
      else if (path === 'monitors/auto/preview' && method === 'POST') result = { providerId: 'youtube', source: body.source, intervalMinutes: 60 };
      else if (path === 'channels') result = { items: [{ id: '555555555555555555', name: 'notifications', canCreateWebhook: true }] };
      else if (path === 'destinations' && method === 'POST') { f.savedDestination = { id: 'shared-destination', name: body.name, scope: body.scope, kind: 'webhook', enabled: true, revision: 1 }; result = { id: f.savedDestination.id }; }
      else if (path === 'destinations/shared-destination' && method === 'GET') {
        if (failDestinationRefresh) return new Response(JSON.stringify({ code: 'DESTINATION_REFRESH_FAILED', error: '一覧を再読み込みしてください。' }), { status: 503 });
        result = f.savedDestination;
      }
      else if (path === 'monitors/auto' && mixedRows) result = { items: [
        { id: '1', name: '自分の通知', kind: 'auto', scope: 'private', ownerId: owner, providerId: 'youtube', source: 'https://youtube.com/@private', enabled: true, revision: 1 },
        { id: '2', name: 'サーバーの通知', kind: 'auto', scope: 'guild', ownerId: other, providerId: 'youtube', source: 'https://youtube.com/@shared', enabled: true, revision: 1 },
      ], nextCursor: null };
      else if (['workflows','destinations','dictionaries','monitors/auto','monitors/price'].includes(path)) result = { items: [], nextCursor: null };
      else if (path === 'x-monitors' && mixedRows) result = { ...xFixtureResponse(path), items: [{ id: '3', accountId: '12345', accountHandle: 'example_x', name: 'Xの通知', enabled: true, state: 'ready', poolKind: 'free', notificationSettings: {}, workflowStatus: null, destinationStatus: null, subscriptionState: 'unconfigured', revision: 1, quality: { planId: 'free', priority: 0, minuteLimit: 5, dayLimit: 24, intervalMinutes: 60 } }] };
      else if (xFixtureResponse(path) !== undefined) result = xFixtureResponse(path);
      else throw new Error(`unexpected synthetic route: ${path}`);
      return new Response(JSON.stringify(result), { status: 200 });
    });
    await f.render(f.React.createElement(f.exports.AutomationWorkspace, { viewerId: owner, guildId: guild, canEdit }));
    await f.settle(); await f.act(async () => new Promise(resolve => setTimeout(resolve, 60)));
    const close = f.close; f.close = async () => { try { await close(); } finally { await db.close(); } };
    return f;
  } catch (error) { await db.close(); throw error; }
}
async function chooseFile(f) {
  const bytes = Buffer.from(JSON.stringify(makeFirefoxFile()));
  const input = f.container.querySelector('input[type="file"][accept=".json,application/json"]'); assert(input);
  const file = { name: 'synthetic.json', size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await f.act(async () => input.dispatchEvent(new f.dom.window.Event('change', { bubbles: true })));
}
async function openSetup(f) {
  await openNotification(f, 'x');
  await f.click('あとで接続する');
  await f.fill(f.field('Xアカウント名'), 'example_user');
  await f.click('戻る');
  await f.click('接続を準備する');
  await waitFor(f, () => f.container.querySelector('[aria-label="X通知の接続手順"]'), 'setup guide');
}
async function selectFirefox(f) {
  const radio = [...f.container.querySelectorAll('input[name="x-setup-browser"]')].find(node => node.parentElement.textContent.trim() === 'Firefox');
  assert(radio); await f.act(async () => radio.click());
}
test('the server workspace shows personal, shared and X notifications together without a scope switch', { timeout: 90000 }, async () => {
  for (const canEdit of [true, false]) {
    const f = await fixture({ mixedRows: true, canEdit });
    try {
      await waitFor(f, () => f.container.textContent.includes('Xの通知') && f.container.textContent.includes('サーバーの通知'), 'combined notifications');
      const list = f.container.querySelector('[aria-label="登録した通知"]'); assert(list);
      for (const name of ['自分の通知', 'サーバーの通知', 'Xの通知']) assert(list.textContent.includes(name));
      assert(!f.container.querySelector('.automation-header select'));
      const personal = [...list.querySelectorAll('article')].find(node => node.textContent.includes('自分の通知'));
      const shared = [...list.querySelectorAll('article')].find(node => node.textContent.includes('サーバーの通知'));
      const edit = node => [...node.querySelectorAll('button')].find(button => button.textContent.trim() === '設定を変更');
      assert.equal(edit(personal).disabled, false); assert.equal(edit(shared).disabled, !canEdit);
      assert.equal(f.calls.some(call => call.path === 'x-monitors' && call.guild === guildId), true);
      assert(f.calls.filter(call => call.path === 'x-setup').every(call => call.guild === null));
    } finally { await f.close(); }
  }
});
test('server workspace opens owner-only setup, imports a file and retains the X draft', { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    await openSetup(f);
    const scope = f.container.querySelector('.automation-header select'); assert.equal(scope, null);
    const radios = [...f.container.querySelectorAll('input[name="x-setup-browser"]')].map(node => node.parentElement.textContent.trim());
    assert.deepEqual(radios, ['Firefox','Chrome','Brave']);
    assert(f.calls.some(call => call.path === 'monitors/auto' && call.guild === guildId));
    assert(f.calls.filter(call => call.path === 'x-setup').every(call => call.guild === null));
    await selectFirefox(f); await f.click('作成したファイルを登録');
    const consent = f.field('サーバーでX通知を受信・復号'); assert(consent); await f.act(async () => consent.click());
    await chooseFile(f); await f.click('ファイルの内容を確認');
    await waitFor(f, () => f.container.querySelector('[aria-label="X通知ファイルの登録確認"]'), 'file review');
    await f.click('この受信情報を登録');
    await waitFor(f, () => Boolean(f.field('使用する自分の受信情報')?.value), 'saved receiver');
    assert.equal(f.field('Xアカウント名').value, 'example_user');
    const choice = f.field('使用する自分の受信情報'); assert(choice && choice.value);
    const rows = await f.db.queryDatabase('SELECT owner_user_id,browser_kind FROM automation_x_subscriptions');
    assert.equal(rows.length, 1); assert.equal(rows[0].owner_user_id, owner); assert.equal(rows[0].browser_kind, 'firefox');
    for (const call of f.calls.filter(call => call.path === 'x-setup' || call.path.startsWith('x-setup/'))) {
      assert.equal(call.guild, null); assert(!Object.hasOwn(call.body, 'userId')); assert(!Object.hasOwn(call.body, 'ownerUserId'));
    }
  } finally { await f.close(); }
});
test('failed import keeps the X draft and never writes a subscription', { timeout: 90000 }, async () => {
  const f = await fixture({ failImport: true });
  try {
    await openSetup(f); await selectFirefox(f); await f.click('作成したファイルを登録'); await f.act(async () => f.field('サーバーでX通知を受信・復号').click());
    await chooseFile(f); await f.click('ファイルの内容を確認');
    await waitFor(f, () => f.container.querySelector('[aria-label="X通知ファイルの登録確認"]'), 'file review');
    await f.click('この受信情報を登録'); await waitFor(f, () => f.calls.some(call => call.path === 'x-setup/import') && f.container.querySelector('[role="alert"]'), 'import error');
    assert(f.container.querySelector('[role="alert"]'));
    assert.equal(f.field('Xアカウント名').value, 'example_user');
    assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_x_subscriptions'))[0].n), 0);
  } finally { await f.close(); }
});
test('closing nested setup asks before discarding a selected file and keeps the monitor draft', { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    await openSetup(f); await selectFirefox(f); await f.click('作成したファイルを登録');
    await f.act(async () => f.field('サーバーでX通知を受信・復号').click()); await chooseFile(f);
    const setupDialog = [...f.container.querySelectorAll('dialog[open]')].find(dialog => dialog.querySelector('h2')?.textContent === 'Xとの接続');
    assert(setupDialog); assert.equal(setupDialog.querySelectorAll('h2').length, 1);
    assert.equal([...setupDialog.querySelectorAll('button')].filter(button => button.textContent === '戻る').length, 1);
    assert.equal([...setupDialog.querySelectorAll('button')].filter(button => button.textContent === '通知の設定に戻る').length, 0);
    const back = [...setupDialog.querySelectorAll('button')].find(button => button.textContent === '戻る');
    f.confirmAnswer = false; await f.act(async () => back.click());
    assert.equal(f.confirmCalls, 1); assert(setupDialog.open); assert(f.field('サーバーでX通知を受信・復号').checked);
    assert(f.container.querySelector('input[type="file"][accept=".json,application/json"]'));
    f.confirmAnswer = true; await f.act(async () => back.click());
    assert.equal(f.confirmCalls, 2); assert(!f.container.querySelector('[aria-label="X通知の接続手順"]'));
    assert.equal(f.field('Xアカウント名').value, 'example_user');
    assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_x_subscriptions'))[0].n), 0);
  } finally { await f.close(); }
});
test('nested setup cannot close while file validation is in flight', { timeout: 90000 }, async () => {
  const f = await fixture({ delayValidation: true });
  try {
    await openSetup(f); await selectFirefox(f); await f.click('作成したファイルを登録');
    await f.act(async () => f.field('サーバーでX通知を受信・復号').click()); await chooseFile(f);
    await f.click('ファイルの内容を確認');
    await waitFor(f, () => typeof f.releaseValidation === 'function', 'pending validation');
    const dialog = [...f.container.querySelectorAll('dialog[open]')].find(node => node.querySelector('h2')?.textContent === 'Xとの接続');
    const back = [...dialog.querySelectorAll('button')].find(button => button.textContent === '戻る');
    assert(back?.disabled); await f.act(async () => back.click()); assert(dialog.open);
    await f.act(async () => f.releaseValidation());
    await waitFor(f, () => f.container.querySelector('[aria-label="X通知ファイルの登録確認"]'), 'completed validation');
    assert(dialog.open); assert.equal(f.field('Xアカウント名').value, 'example_user');
  } finally { if (f.releaseValidation) f.releaseValidation(); await f.close(); }
});
test('dispatcher rejects guild-scoped setup and ignores spoofed owner identity', { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    await f.act(async () => {
      await assert.rejects(dispatch(req('GET','x-setup'), { userId: owner, guildId }, f.services), failure('X_SETUP_PRIVATE_ONLY'));
      await assert.rejects(dispatch(req('POST','x-setup/sessions',{ consent: true, ownerUserId: other }), { userId: owner }, f.services), failure('X_SETUP_INVALID_INPUT'));
      const session = await dispatch(req('POST','x-setup/sessions',{ consent: true }), { userId: owner }, f.services);
      await assert.rejects(dispatch(req('POST','x-setup/validate',{ sessionId: session.sessionId, fileText: JSON.stringify(makeFirefoxFile()) }), { userId: other }, f.services), failure('X_SETUP_SESSION_INVALID'));
    });
  } finally { await f.close(); }
});
test('receiver pagination in a server workspace uses the owner-only API', { timeout: 90000 }, async () => {
  const f = await fixture({ seedReceivers: 101 });
  try {
    await openNotification(f, 'x');
    await waitFor(f, () => [...f.container.querySelectorAll('button')].some(button => button.textContent.trim() === '受信情報の候補をさらに表示'), 'receiver pagination');
    const select = f.field('使用する自分の受信情報'); assert(select); assert.equal(select.options.length, 101);
    await f.click('受信情報の候補をさらに表示');
    await waitFor(f, () => f.field('使用する自分の受信情報')?.options.length === 102, 'next receiver page');
    const call = f.calls.find(row => row.path === 'x-setup' && row.search.has('afterId')); assert(call); assert.equal(call.guild, null);
  } finally { await f.close(); }
});
test('a deep link finds the 101st owned receiver without requesting a guild', { timeout: 90000 }, async () => {
  const f = await fixture({ seedReceivers: 101, deepLink: 'last' });
  try {
    await waitFor(f, () => f.field('使用する自分の受信情報')?.value === f.deepLinkId, 'deep-linked receiver');
    const pages = f.calls.filter(row => row.path === 'x-setup' && row.search.has('afterId'));
    assert.equal(pages.length, 1); assert.equal(pages[0].guild, null);
  } finally { await f.close(); }
});
test('a deep link cannot open another owner receiver and reports an absent connection', { timeout: 90000 }, async () => {
  const f = await fixture({ seedReceivers: 101, deepLink: 'foreign' });
  try {
    await waitFor(f, () => f.container.textContent.includes('選んだ接続を確認できませんでした'), 'missing receiver');
    assert.equal(f.container.querySelector('form[aria-label="X監視の登録設定"]'), null);
    const pages = f.calls.filter(row => row.path === 'x-setup' && row.search.has('afterId'));
    assert.equal(pages.length, 1); assert(pages.every(row => row.guild === null));
  } finally { await f.close(); }
});
test('repeating receiver cursors and page failures are retriable without claiming absence', { timeout: 90000 }, async () => {
  for (const option of ['repeatSetupCursor', 'failSetupPage']) {
    const f = await fixture({ seedReceivers: 101, deepLink: 'last', [option]: true });
    try {
      await waitFor(f, () => f.container.textContent.includes('接続一覧を読み込めませんでした'), 'receiver page error');
      assert.doesNotMatch(f.container.textContent, /選んだ接続を確認できませんでした/);
      assert.equal(f.container.querySelector('form[aria-label="X監視の登録設定"]'), null);
      f[option] = false; await f.click('接続を再確認');
      await waitFor(f, () => f.field('使用する自分の受信情報')?.value === f.deepLinkId, 'receiver retry');
      assert(f.calls.filter(row => row.path === 'x-setup' && row.search.has('afterId')).every(row => row.guild === null));
    } finally { await f.close(); }
  }
});
test('a delayed deep-link page cannot replace an X draft started by the user', { timeout: 90000 }, async () => {
  const f = await fixture({ seedReceivers: 101, deepLink: 'last', delaySetupPage: true });
  try {
    await waitFor(f, () => typeof f.releaseSetupPage === 'function', 'delayed receiver page');
    await openNotification(f, 'x'); await f.click('あとで接続する'); await f.fill(f.field('Xアカウント名'), 'kept_draft');
    f.delaySetupPage = false; await f.act(async () => f.releaseSetupPage()); await f.settle();
    assert.equal(f.field('Xアカウント名').value, 'kept_draft');
    assert.notEqual(f.field('使用する自分の受信情報').value, f.deepLinkId);
    assert.equal(f.calls.filter(row => row.method !== 'GET').length, 0);
  } finally { if (f.releaseSetupPage) f.releaseSetupPage(); await f.close(); }
});
test('a shared notification creates a shared channel destination and keeps its draft after saving', { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    await openNotification(f, 'auto'); await f.fill(f.field('対象のURL・ID'), 'https://www.youtube.com/@fixture'); await continueNotificationSource(f);
    await waitFor(f, () => f.field('通知を編集できる人'), 'sharing selector');
    await f.fill(f.field('通知を編集できる人'), 'guild');
    const monitorForm = f.container.querySelector('form.monitor-registration');
    assert(monitorForm); const add = [...monitorForm.querySelectorAll('button')].find(button => button.textContent.trim() === '通知先を追加'); assert(add);
    await f.act(async () => add.click());
    const destinationForm = f.container.querySelector('form[aria-label="通知先の登録設定"]'); assert(destinationForm);
    const find = text => [...destinationForm.querySelectorAll('label')].find(label => label.textContent.trim().startsWith(text))?.querySelector('input,select');
    assert.equal(find('通知先の種類').value, 'channel'); assert.equal(find('編集できる人').value, 'guild');
    await f.fill(find('通知先の名前'), '共有の通知先');
    await waitFor(f, () => find('Webhookを作成するチャンネル')?.options.length > 1, 'channel choices');
    await f.fill(find('Webhookを作成するチャンネル'), '555555555555555555');
    await f.act(async () => destinationForm.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })));
    await waitFor(f, () => !f.container.querySelector('form[aria-label="通知先の登録設定"]'), 'destination saved');
    const call = f.calls.find(row => row.path === 'destinations' && row.method === 'POST'); assert(call);
    assert.equal(call.body.scope, 'guild'); assert.equal(call.body.kind, 'channel'); assert.equal(call.body.channelId, '555555555555555555'); assert.equal(call.guild, guildId);
    assert.equal(f.field('通知を編集できる人').value, 'guild');
    const selected = [...monitorForm.querySelectorAll('label')].find(label => label.firstChild?.textContent?.trim() === '通知先')?.querySelector('select');
    assert(selected); assert.equal(selected.value, 'shared-destination');
  } finally { await f.close(); }
});
test('a saved shared destination is not created twice when the follow-up read fails', { timeout: 90000 }, async () => {
  const f = await fixture({ failDestinationRefresh: true });
  try {
    await openNotification(f, 'auto'); await f.fill(f.field('対象のURL・ID'), 'https://www.youtube.com/@fixture'); await continueNotificationSource(f);
    await waitFor(f, () => f.field('通知を編集できる人'), 'sharing selector'); await f.fill(f.field('通知を編集できる人'), 'guild');
    const monitorForm = f.container.querySelector('form.monitor-registration');
    const add = [...monitorForm.querySelectorAll('button')].find(button => button.textContent.trim() === '通知先を追加');
    await f.act(async () => add.click());
    const form = f.container.querySelector('form[aria-label="通知先の登録設定"]');
    const find = text => [...form.querySelectorAll('label')].find(label => label.textContent.trim().startsWith(text))?.querySelector('input,select');
    await f.fill(find('通知先の名前'), '共有の通知先');
    await waitFor(f, () => find('Webhookを作成するチャンネル')?.options.length > 1, 'channel choices');
    await f.fill(find('Webhookを作成するチャンネル'), '555555555555555555');
    await f.act(async () => form.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })));
    await waitFor(f, () => f.container.textContent.includes('通知先は保存済みです'), 'saved destination warning');
    assert.equal(f.calls.filter(row => row.path === 'destinations' && row.method === 'POST').length, 1);
    assert.equal(f.field('通知を編集できる人').value, 'guild');
    assert.equal(f.calls.find(row => row.path === 'destinations' && row.method === 'POST').body.scope, 'guild');
  } finally { await f.close(); }
});

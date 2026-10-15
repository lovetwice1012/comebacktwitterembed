'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const { catalog } = require('../../src/automation/catalog');
const { newWorkflow } = require('../../src/automation/schema');
const tick = f => f.act(async () => new Promise(resolve => setTimeout(resolve, 20)));
const row = changes => ({ id: '1', kind: 'auto', name: '投稿通知', providerId: 'github', source: 'https://github.com/octocat', locale: 'ja', enabled: true, scope: 'private', revision: 1,
    lastCheckedAtMs: 1000, destinationId: 'd1', destinationStatus: 'active', workflowId: null, workflowStatus: null, ...changes });
const destination = { id: 'd1', kind: 'dm', name: '本人DM', enabled: true, scope: 'private' };

test('verified paused/unapplied rules remain visible beyond the workflow list page and open their exact assigned rule', async () => {
    for (const [status, label] of [['unapplied', 'ルール未適用'], ['paused', 'ルール停止中'], ['missing', 'ルールの確認待ち']]) {
        const f = await reactFixture('export { MonitorManager } from "./components/automation/monitor-manager";'); let opened;
        const api = async route => route === 'providers' ? { auto: [{ id: 'github' }], autoRegistration: { eligible: true } }
            : route === 'entitlements' ? { plan: { name: '無料' }, slots: { used: 1, max: 5, available: 4 }, usage: { entries: [] } }
                : { items: [row({ workflowId: 'not-in-first-page', workflowStatus: status })], nextCursor: null };
        try {
            await f.render(f.React.createElement(f.exports.MonitorManager, { api, canEdit: true, scope: 'private', destinations: [destination], rules: [], refresh: async () => {}, onOpenWorkflow: id => { opened = id; } })); await tick(f);
            const card = f.container.querySelector('article'); assert.equal(card.querySelector('.monitor-state').textContent, label); assert(!card.querySelector('.monitor-state').textContent.includes('監視中'));
            await f.click('設定を変更'); assert.equal(f.field('詳細ルール').value, 'not-in-first-page'); await f.click('キャンセル');
            await f.click('割り当てたルールを開く'); assert.equal(opened, 'not-in-first-page');
        } finally { await f.close(); }
    }
});

test('a disabled destination is shown as the reason for waiting and the destination settings are reachable', async () => {
    const f = await reactFixture('export { MonitorManager } from "./components/automation/monitor-manager";');
    const api = async route => route === 'providers' ? { auto: [], autoRegistration: { eligible: true } } : route === 'entitlements' ? { plan: { name: '無料' }, slots: { used: 1, max: 5, available: 4 }, usage: { entries: [] } } : { items: [row({ destinationStatus: 'paused' })], nextCursor: null };
    try {
        await f.render(f.React.createElement(f.exports.MonitorManager, { api, canEdit: true, scope: 'private', destinations: [{ ...destination, enabled: false }], rules: [], refresh: async () => {} })); await tick(f);
        assert.equal(f.container.querySelector('.monitor-state').textContent, '通知先停止中');
        const link = [...f.container.querySelectorAll('a')].find(node => node.textContent === '通知先を確認'); assert(link); await f.act(async () => link.click()); assert(f.container.querySelector('.notification-destinations').open);
    } finally { await f.close(); }
});

test('registration review refreshes the selected rule state and explains a paused rule before saving', async () => {
    const f = await reactFixture('export { MonitorRegistration } from "./components/automation/monitor-registration";'); let saved = 0, opened;
    try {
        function Fixture() {
            const [monitor, setMonitor] = f.React.useState({ ...row({ workflowId: 'r1' }), id: undefined });
            return f.React.createElement(f.exports.MonitorRegistration, { api: async path => path.startsWith('workflows/') ? { id: 'r1', enabled: false, activeRevision: 2 } : { providerId: 'github', source: monitor.source, intervalMinutes: 30 },
                monitor, kind: 'auto', scope: 'private', destinations: [destination], rules: [{ id: 'r1', name: '選択したルール', enabled: true, activeRevision: 1, scope: 'private' }], catalog: { auto: [{ id: 'github' }], autoRegistration: { eligible: true } }, busy: false,
                onChange: setMonitor, onSourceChange: source => setMonitor({ ...monitor, source }), onSave: async () => { saved++; }, onOpenWorkflow: id => { opened = id; }, run: async work => work(), refresh: async () => {} });
        }
        await f.render(f.React.createElement(Fixture)); await f.submit(); await f.submit();
        const review = f.container.querySelector('[aria-label="保存する通知の確認"]'); assert.match(review.textContent, /選択したルール.*ルール停止中/); assert.match(review.textContent, /ルールを再開すると通知を開始/); assert.equal(saved, 0);
        await f.click('選択したルールを開く'); assert.equal(opened, 'r1');
    } finally { await f.close(); }
});

test('ordinary DM registration review discloses the actual title and URL default', async () => {
    const f = await reactFixture('export { MonitorRegistration } from "./components/automation/monitor-registration";');
    try {
        function Fixture() {
            const [monitor, setMonitor] = f.React.useState({ ...row(), workflowId: '', id: undefined });
            return f.React.createElement(f.exports.MonitorRegistration, { api: async () => ({ providerId: 'github', source: monitor.source, intervalMinutes: 30 }), monitor, kind: 'auto', scope: 'private', destinations: [destination], rules: [], catalog: { auto: [{ id: 'github' }], autoRegistration: { eligible: true } }, busy: false,
                onChange: setMonitor, onSourceChange: source => setMonitor({ ...monitor, source }), onSave: async () => {}, run: async work => work(), refresh: async () => {} });
        }
        await f.render(f.React.createElement(Fixture)); await f.submit(); await f.submit();
        assert.match(f.container.querySelector('[aria-label="保存する通知の確認"]').textContent, /DMは投稿タイトルとURLで通知/);
    } finally { await f.close(); }
});

test('safe HTTP feedback preserves structured validation and never includes non-JSON, network or authentication internals', async () => {
    const f = await reactFixture('export { automationFetch } from "./components/automation/automation-feedback";');
    let respond; f.set('fetch', (...args) => respond(...args));
    try {
        for (const response of [new Response('<html>PRIVATE_GATEWAY</html>', { status: 502 }), new Response('invalid PRIVATE_JSON', { status: 200 })]) {
            respond = async () => response; await assert.rejects(f.exports.automationFetch('/api/automation/catalog'), cause => /再読み込み.*入力内容は保持/.test(cause.message) && !/PRIVATE|JSON|Unexpected|token/.test(cause.message));
        }
        respond = async () => { throw new TypeError('PRIVATE_HOST_TOKEN'); }; await assert.rejects(f.exports.automationFetch('/api/automation/catalog'), cause => cause.code === 'AUTOMATION_NETWORK_ERROR' && !cause.message.includes('PRIVATE'));
        respond = async () => new Response('<html>PRIVATE_LOGIN</html>', { status: 401 }); await assert.rejects(f.exports.automationFetch('/api/automation/catalog'), cause => cause.code === 'AUTH_REQUIRED' && /別のタブでログイン/.test(cause.message));
        const issues = [{ path: '$.source', message: 'プロフィールURLを入力してください。' }];
        respond = async () => Response.json({ code: 'INVALID_SOURCE', error: '対象を確認してください。', issues }, { status: 422 });
        await assert.rejects(f.exports.automationFetch('/api/automation/monitors/auto', { method: 'POST' }), cause => cause.status === 422 && cause.code === 'INVALID_SOURCE' && JSON.stringify(cause.issues) === JSON.stringify(issues));
    } finally { await f.close(); }
});

test('malformed successful collections fail safely while history arrays and write responses remain valid', async () => {
    const f = await reactFixture('export { automationFetch } from "./components/automation/automation-feedback";'); let payload;
    f.set('fetch', async () => Response.json(payload));
    try {
        for (const route of ['workflows', 'destinations?scope=private', 'dictionaries']) {
            for (payload of [null, 123, 'plain-data', [], {}, { items: null }, { items: 'wrong' }, { items: [null] }, { items: [{ id: 1 }] }, { items: [], nextCursor: 123 }]) {
                await assert.rejects(f.exports.automationFetch(`/api/automation/${route}`), error => error.code === 'AUTOMATION_INVALID_RESPONSE' && /入力内容は保持/.test(error.message));
            }
            payload = { items: [], nextCursor: null }; assert.deepEqual(await f.exports.automationFetch(`/api/automation/${route}`), payload);
        }
        payload = []; assert.deepEqual(await f.exports.automationFetch('/api/automation/workflows/fixture/history'), []);
        payload = { id: 'created' }; assert.deepEqual(await f.exports.automationFetch('/api/automation/workflows', { method: 'POST' }), payload);
        payload = { deleted: true }; assert.deepEqual(await f.exports.automationFetch('/api/automation/workflows/fixture', { method: 'DELETE' }), payload);
    } finally { await f.close(); }
});

test('the real workspace keeps malformed successful lists out of rendering and recovers on reload', async () => {
    for (const malformed of [null, 123, 'plain-data', [], { items: null }]) {
        const f = await reactFixture('export { AutomationWorkspace } from "./components/automation/automation-workspace";'); let broken = true;
        f.set('sessionStorage', f.dom.window.sessionStorage); f.set('confirm', () => true);
        f.set('fetch', async address => {
            const route = new URL(address, 'http://fixture').pathname.slice('/api/automation/'.length);
            return Response.json(route === 'catalog' ? catalog() : route === 'providers' ? { auto: [], price: [], autoRegistration: { eligible: true } }
                : route === 'entitlements' ? { plan: { name: '無料' }, slots: { used: 0, max: 5, available: 5 }, usage: { entries: [] } }
                    : route === 'workflows' && broken ? malformed : { items: [], nextCursor: null });
        });
        try {
            await f.render(f.React.createElement(f.exports.AutomationWorkspace, { viewerId: '222222222222222222' })); await tick(f);
            assert.equal(f.container.querySelectorAll('[role="alert"]').length, 1);
            assert.match(f.container.querySelector('[role="alert"]').textContent, /応答を確認できません/);
            assert.doesNotMatch(f.container.textContent, /Cannot read|reading|undefined|plain-data|TypeError/);
            broken = false; await f.click('一覧を再読み込み'); await tick(f);
            assert.equal(f.container.querySelectorAll('[role="alert"]').length, 0);
            await f.click('通知ルール'); assert.match(f.container.textContent, /通知ルールを作る/);
        } finally { await f.close(); }
    }
});

test('the real workspace presents one safe gateway error and recovers resource loading without page reload', async () => {
    const f = await reactFixture('export { AutomationWorkspace } from "./components/automation/automation-workspace";'); let failed = 502;
    f.set('sessionStorage', f.dom.window.sessionStorage); f.set('confirm', () => true);
    f.set('SVGElement', f.dom.window.SVGElement); f.set('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); f.dom.window.HTMLElement.prototype.scrollIntoView = function () {};
    f.set('fetch', async address => {
        if (failed) return new Response('<html>PRIVATE_GATEWAY_502</html>', { status: failed });
        const route = new URL(address, 'http://fixture').pathname.slice('/api/automation/'.length);
        return Response.json(route === 'catalog' ? catalog() : route === 'providers' ? { auto: [{ id: 'github' }], price: [], autoRegistration: { eligible: true } }
            : route === 'entitlements' ? { plan: { name: '無料' }, slots: { used: 0, max: 5, available: 5 }, usage: { entries: [] } } : { items: [], nextCursor: null });
    });
    try {
        await f.render(f.React.createElement(f.exports.AutomationWorkspace, { viewerId: '222222222222222222' })); await tick(f);
        assert.equal(f.container.querySelectorAll('[role="alert"]').length, 1); assert(!/PRIVATE|Unexpected|JSON/.test(f.container.textContent));
        failed = 0; await f.click('一覧を再読み込み'); await tick(f); assert.equal(f.container.querySelectorAll('[role="alert"]').length, 0);
        await f.click('通知を追加'); assert(f.field('対象のURL・ID')); await f.fill(f.field('対象のURL・ID'), 'https://github.com/octocat'); await f.fill(f.field('名前'), '保持する名前');
        failed = 502; await f.submit(); await tick(f);
        assert.equal(f.field('対象のURL・ID').value, 'https://github.com/octocat'); assert.equal(f.field('名前').value, '保持する名前');
        assert.match(f.container.querySelector('dialog[open]').textContent, /入力内容は保持/); assert(!/PRIVATE|Unexpected/.test(f.container.textContent));
        failed = 401; await f.submit(); await tick(f);
        const login = [...f.container.querySelectorAll('dialog[open] a')].find(link => link.textContent === '別のタブでログイン'); assert(login); assert.equal(login.target, '_blank'); assert.equal(f.field('名前').value, '保持する名前');
        failed = 0; await f.click('一覧を再読み込み'); await tick(f);
        assert.equal(f.field('対象のURL・ID').value, 'https://github.com/octocat'); assert.equal(f.field('名前').value, '保持する名前');
    } finally { await f.close(); }
});

test('an assigned rule outside the first resource page opens the actual rule editor without applying it', async () => {
    const f = await reactFixture('export { AutomationWorkspace } from "./components/automation/automation-workspace";');
    const ruleId = '2e0dbfc1-8d40-4b40-870f-632d6b40b815', definition = newWorkflow('停止中の対象ルール'), calls = [];
    f.set('sessionStorage', f.dom.window.sessionStorage); f.set('confirm', () => true); f.set('SVGElement', f.dom.window.SVGElement);
    f.set('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); f.dom.window.HTMLElement.prototype.scrollIntoView = function () {};
    f.set('fetch', async (address, options = {}) => {
        const route = new URL(address, 'http://fixture').pathname.slice('/api/automation/'.length); calls.push([route, options.method || 'GET']);
        return Response.json(route === 'catalog' ? catalog() : route === 'providers' ? { auto: [{ id: 'github' }], price: [], autoRegistration: { eligible: true } }
            : route === 'entitlements' ? { plan: { name: '無料' }, slots: { used: 1, max: 5, available: 4 }, usage: { entries: [] } }
                : route === `workflows/${ruleId}` ? { id: ruleId, name: definition.name, draft: definition, bindings: { destinations: {}, dictionaries: {} }, scope: 'private', enabled: false, activeRevision: 1, revision: 2 }
                    : route.startsWith('monitors/auto') ? { items: [row({ workflowId: ruleId, workflowStatus: 'paused', destinationId: null })], nextCursor: null }
                        : route === 'validate' ? { valid: true, issues: [], text: JSON.stringify(definition) } : { items: [], nextCursor: null });
    });
    try {
        await f.render(f.React.createElement(f.exports.AutomationWorkspace, { viewerId: '222222222222222222' })); await tick(f);
        await f.click('割り当てたルールを開く'); await tick(f);
        assert.equal(f.container.querySelector('[aria-label="ルール名"]').value, definition.name);
        assert.match(f.container.querySelector('[aria-label="ルールの状態"]').textContent, /停止中/);
        assert.equal(calls.some(([route]) => route.endsWith('/activate') || route.endsWith('/attach')), false);
    } finally { await f.close(); }
});

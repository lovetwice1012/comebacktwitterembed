'use strict';
// Actual product React with local API fixtures. No browser layout, live provider or delivery proof.
const test = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const { catalog, template } = require('../../src/automation/catalog');
const { validateWorkflow } = require('../../src/automation/schema');
const { parseWorkflow, stringifyDraft } = require('../../src/automation/format');
const tick = (f, ms = 30) => f.act(async () => new Promise(resolve => setTimeout(resolve, ms)));
const click = (f, node) => { assert(node, 'real control exists'); assert(!node.matches(':disabled'), 'real control enabled'); return f.act(async () => node.click()); };
const byText = (parent, text) => [...parent.querySelectorAll('button')].find(node => node.textContent.trim() === text);
function flowEnvironment(f) {
    f.set('SVGElement', f.dom.window.SVGElement); f.set('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    f.set('sessionStorage', f.dom.window.sessionStorage); f.set('confirm', () => true);
    f.dom.window.HTMLElement.prototype.scrollIntoView = function () {};
}
const job = id => ({ id, version: 1, state: 'held', title: id, providerId: 'github', dueAtMs: 1, sentSteps: 0, trace: [], scope: 'private', preview: `preview-${id}` });
for (const obsoleteError of [false, true]) test(`N8 last selected delivery wins over obsolete ${obsoleteError ? 'failure' : 'success'} and closing invalidates requests`, async () => {
    const f = await reactFixture('export { DeliveryHistory } from "./components/automation/delivery-history";');
    try {
        let finishA, finishC;
        const writes = [];
        const api = async (route, method, body) => {
            if (method === 'PATCH') { writes.push({ route, body }); return {}; }
            if (route.startsWith('jobs?')) return { items: ['A', 'B', 'C'].map(job), nextCursor: null };
            if (route === 'jobs/A') return new Promise((resolve, reject) => { finishA = obsoleteError ? () => reject(new Error('obsolete A error')) : () => resolve(job('A')); });
            if (route === 'jobs/C') return new Promise(resolve => { finishC = resolve; });
            return job('B');
        };
        await f.render(f.React.createElement(f.exports.DeliveryHistory, { api, canEdit: true })); await f.settle();
        await click(f, f.container.querySelector('[data-job-id="A"]'));
        await click(f, f.container.querySelector('[data-job-id="B"]'));
        assert.equal(f.container.querySelector('pre').textContent, 'preview-B');
        await f.act(async () => finishA());
        assert.equal(f.container.querySelector('pre').textContent, 'preview-B'); assert(!f.container.textContent.includes('obsolete A error'));
        await f.click('配信一覧に戻る'); await click(f, f.container.querySelector('[data-job-id="C"]'));
        await f.render(f.React.createElement(f.exports.DeliveryHistory, { api, canEdit: true, active: false }));
        await f.act(async () => finishC(job('C'))); assert.equal(f.container.querySelector('pre'), null); assert.deepEqual(writes, []);
    } finally { await f.close(); }
});

async function workspaceFixture({ paginate = false, failAfterSave = false, guildId, ruleScope = "private", canEdit = true, xOnly = false, tokenRace = false, xCompanion = false } = {}) {
    const f = await reactFixture('export { AutomationWorkspace } from "./components/automation/automation-workspace";'); flowEnvironment(f);
    const bindings = { destinations: {}, dictionaries: {} }, stored = new Map(), requests = [];
    for (const id of ['A', 'B']) { const draft = { ...template('all', 'now', 'normal'), name: `Rule ${id}` }; stored.set(id, { id, name: draft.name, draft, bindings, scope: ruleScope, revision: 2, activeRevision: 1, enabled: true }); }
    let committed = false;
    const xRows = xOnly ? [{ id: 'X', name: 'Owner X monitor', revision: 7, enabled: true, state: 'active', notificationSettings: { workflowId: 'A', destinationId: 'owned-destination', subscriptionId: 'owned-receiver' } }] : [];
    if (xCompanion) xRows.push({ ...structuredClone(xRows[0]), id: 'X2', name: 'Other X monitor' });
    const targets = id => xRows.filter(row => row.notificationSettings.workflowId === id).map(row => ({ ...row, kind: 'x', scope: 'private', workflowId: id, destinationId: row.notificationSettings.destinationId }));
    f.set('fetch', async (address, options) => {
        const url = new URL(address, 'http://fixture'), route = url.pathname.slice('/api/automation/'.length), body = options.body && JSON.parse(options.body), method = options.method;
        requests.push({ route, method, body, query: url.search }); let result;
        if (route === 'catalog') result = catalog();
        else if (route === 'providers') result = { auto: [{ id: 'github' }], price: [], autoRegistration: { eligible: true } };
        else if (route === 'entitlements') result = { plan: { name: '支援者', priority: 0 }, slots: { used: 0, max: 20, available: 20 }, usage: { entries: [] } };
        else if (route === 'workflows' && method === 'GET') {
            if (committed && failAfterSave) return new Response(JSON.stringify({ error: 'list temporarily unavailable' }), { status: 503 });
            result = paginate ? { items: url.searchParams.has('afterId') ? [stored.get('B')] : [stored.get('A')], nextCursor: url.searchParams.has('afterId') ? null : 'page-two' } : { items: [...stored.values()], nextCursor: null };
        } else if (route === 'workflows' && method === 'POST') { result = { id: 'copy', name: body.definition.name, draft: body.definition, bindings: body.bindings, scope: body.scope, revision: 1, activeRevision: null, enabled: false }; stored.set(result.id, result); committed = true; }
        else if (route.startsWith('workflows/')) {
            const [, id, action] = route.split('/'); result = stored.get(id);
            if (action === 'history') result = [{ revision: 1, createdAtMs: 1 }];
            else if (action === 'activation-preview') result = { expectedRevision: result.revision, expectedTargetsToken: 'fixture-target-token', affectedTargets: targets(id) };
            else if (action === 'activate') { assert.equal(body.expectedTargetsToken, 'fixture-target-token'); if (tokenRace) return new Response(JSON.stringify({ code: 'WORKFLOW_TARGETS_CHANGED', error: 'Targets changed' }), { status: 409 }); result = { ...result, enabled: true, activeRevision: result.revision }; stored.set(id, result); }
            else if (action === 'restore') { result = { ...result, revision: 3, name: 'Restored', draft: { ...result.draft, name: 'Restored' } }; stored.set(id, result); result = { revision: 3 }; }
            else if (method === 'PATCH') { result = { ...result, draft: body.definition, name: body.definition.name, bindings: body.bindings, revision: result.revision + 1 }; stored.set(id, result); committed = true; result = { revision: result.revision }; }
        } else if (route === 'validate') {
            try { const definition = body.text === undefined ? body.definition : parseWorkflow(body.text, body.format); result = { ...validateWorkflow(definition), definition, text: stringifyDraft(definition, body.format) }; }
            catch { result = { valid: false, issues: [{ message: 'invalid source' }] }; }
        } else if (route === 'x-monitors') result = { items: structuredClone(xRows), nextCursor: null };
        else if (route === 'x-monitors/X' && method === 'PATCH') { assert.equal(body.expectedRevision, xRows[0].revision); xRows[0] = { ...xRows[0], notificationSettings: body.notificationSettings, revision: xRows[0].revision + 1 }; result = { item: structuredClone(xRows[0]) }; }
        else if (route === 'destinations' || route === 'dictionaries') result = { items: [], nextCursor: null };
        else if (route === 'monitors/auto' || route === 'monitors/price') result = { items: [], nextCursor: null };
        else assert.fail(route);
        return new Response(JSON.stringify(result), { status: 200 });
    });
    await f.render(f.React.createElement(f.exports.AutomationWorkspace, { viewerId: '222222222222222222', guildId, canEdit })); await tick(f);
    return Object.assign(f, { stored, requests, xRows });
}
async function openRule(f, name = 'Rule A') { await f.click('通知ルール'); await click(f, [...f.container.querySelectorAll('.studio-rule-card')].find(node => node.textContent.includes(name))); await tick(f, 450); }
test('N9 all workflow pages participate in search and selection', async () => {
    const f = await workspaceFixture({ paginate: true });
    try {
        await f.click('通知ルール'); assert.equal(f.container.querySelectorAll('.studio-rule-card').length, 2);
        await f.fill(f.container.querySelector('[aria-label="ルールを検索"]'), 'Rule B');
        assert.equal(f.container.querySelectorAll('.studio-rule-card').length, 1); await click(f, f.container.querySelector('.studio-rule-card')); await tick(f, 450);
        assert.equal(f.container.querySelector('[aria-label="ルール名"]').value, 'Rule B'); assert(f.requests.some(row => row.route === 'workflows' && row.query.includes('afterId=page-two')));
    } finally { await f.close(); }
});
test('T9 restoring a revision discards pending source and invalidates late file parsing for the same workflow', async () => {
    const f = await workspaceFixture();
    try {
        await openRule(f); await f.click('テキスト'); await f.fill(f.container.querySelector('[aria-label="ルールJSONまたはYAML"]'), 'nodes: [incomplete'); await tick(f, 450);
        await f.click('変更履歴'); await f.click('この版を下書きに復元'); await tick(f, 450);
        assert.equal(f.container.querySelector('[aria-label="ルール名"]').value, 'Restored');
        await f.click('テキスト'); assert(!f.container.querySelector('[aria-label="ルールJSONまたはYAML"]').value.includes('incomplete'));
        assert.equal(byText(f.container, '下書きを保存').disabled, false);
    } finally { await f.close(); }
});
for (const kind of ['部品', 'ルール']) test(`S9-1 a delayed ${kind} file cannot replace another workflow`, async () => {
    const f = await workspaceFixture();
    try {
        await openRule(f); await click(f, f.container.querySelector('[aria-label="ファイル・有効期限"]')); let finish;
        const input = f.container.querySelector(`[aria-label="${kind === '部品' ? '部品を読み込む' : 'ルールをインポート'}"]`);
        Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'delayed.json', size: 200, text: () => new Promise(resolve => { finish = resolve; }) }] });
        await f.act(async () => input.dispatchEvent(new f.dom.window.Event('change', { bubbles: true })));
        await f.click('キャンセル'); await f.click('ルール一覧へ'); await click(f, [...f.container.querySelectorAll('.studio-rule-card')].find(node => node.textContent.includes('Rule B'))); await tick(f, 450);
        const raw = kind === '部品' ? { schemaVersion: 1, kind: 'block-fragment', name: 'obsolete fragment', nodes: [{ id: 'piece', type: 'stop', config: { reason: 'obsolete' } }], edges: [] } : { ...template('all', 'now', 'normal'), name: 'obsolete file' };
        await f.act(async () => finish(JSON.stringify(raw))); await tick(f, 450);
        assert.equal(f.container.querySelector('[aria-label="ルール名"]').value, 'Rule B'); assert(!f.container.textContent.includes('obsolete'));
        await f.click('下書きを保存'); assert.equal(f.stored.get('B').draft.name, 'Rule B'); assert(!f.stored.get('B').draft.nodes.some(node => node.id === 'piece'));
    } finally { await f.close(); }
});
test('S24-2 a committed workflow save advances its local revision even when the list refresh fails', async () => {
    const f = await workspaceFixture({ failAfterSave: true });
    try {
        await openRule(f); await f.fill(f.container.querySelector('[aria-label="ルール名"]'), 'Saved rename'); await tick(f, 450); await f.click('下書きを保存');
        assert(f.container.textContent.includes('下書きは保存済みです')); assert.equal(f.stored.get('A').revision, 3);
        await f.fill(f.container.querySelector('[aria-label="ルール名"]'), 'Second rename'); await tick(f, 450); await f.click('下書きを保存');
        assert.deepEqual(f.requests.filter(row => row.method === 'PATCH').map(row => row.body.expectedRevision), [2, 3]);
    } finally { await f.close(); }
});

for (const [ruleScope, listScope] of [['private', 'guild'], ['guild', 'private']]) test(`T3 clones preserve displayed ${ruleScope} scope despite hidden ${listScope} creation preference`, async () => {
    const f = await workspaceFixture({ guildId: '111111111111111111', ruleScope });
    try {
        await f.fill(f.field('作成先'), listScope); await openRule(f);
        await f.click('ルールを複製'); await tick(f, 450);
        const create = f.requests.find(row => row.route === 'workflows' && row.method === 'POST'); assert.equal(create.body.scope, ruleScope);
        assert.equal(f.stored.get('copy').scope, ruleScope);
    } finally { await f.close(); }
});
test('T3 a viewer of a shared rule cannot create a hidden shared clone', async () => {
    const f = await workspaceFixture({ guildId: '111111111111111111', ruleScope: 'guild', canEdit: false });
    try { await openRule(f); assert.equal(byText(f.container, 'ルールを複製').disabled, true); assert.equal(f.requests.filter(row => row.method === 'POST' && row.route === 'workflows').length, 0); }
    finally { await f.close(); }
});

for (const obsoleteError of [false, true]) test(`S4-3 the last package selection and key survive delayed hash ${obsoleteError ? 'failure' : 'success'}`, async () => {
    const f = await reactFixture('export { MarketplaceManager } from "./components/automation/marketplace-manager";');
    try {
        f.dom.window.history.replaceState({}, '', '/dashboard/automation#automation-package=A&key=key-A');
        const packs = id => ({ id, title: `Package ${id}`, kind: 'dictionary', version: 1, latest_version: 1, status: 'active', packageStatus: 'active', packageVisibility: 'unlisted', visibility: 'unlisted', shareKey: `key-${id}`, bundle: { dictionaries: {}, license: 'MIT' } });
        let finishA; const writes = [];
        const api = async (route, method, body) => {
            if (route === 'starter') return null;
            if (route.startsWith('marketplace?')) return { items: [packs('B')], nextCursor: null };
            if (route === 'marketplace/A/open') return new Promise((resolve, reject) => { finishA = obsoleteError ? () => reject(new Error('obsolete hash failure')) : () => resolve(packs('A')); });
            if (route === 'marketplace/B/open') return packs('B');
            if (route === 'marketplace/B/install') { writes.push({ route, body }); return { dictionaries: {} }; }
            assert.fail(route);
        };
        await f.render(f.React.createElement(f.exports.MarketplaceManager, { api, scope: 'private', canEdit: true, rules: [], dictionaries: [], refresh: async () => {}, openRule: async () => {} })); await tick(f);
        await click(f, f.container.querySelector('[data-package-id="B"]')); assert(f.container.querySelector('h2').textContent.includes('共有ルール'));
        await f.act(async () => finishA()); assert(f.container.textContent.includes('Package B')); assert(!f.container.textContent.includes('obsolete hash failure'));
        await f.click('辞書に追加'); assert.deepEqual(writes, [{ route: 'marketplace/B/install', body: { version: 1, scope: 'private', shareKey: 'key-B' } }]);
    } finally { await f.close(); }
});

test('S7-2 separate dictionary import confirms discarding staged edits and cancellation retains both buffers', async () => {
    const f = await reactFixture('export { DictionaryManager } from "./components/automation/dictionary-manager";');
    try {
        let accept = false; const writes = [], prompts = [];
        f.set('confirm', message => { prompts.push(message); return accept; });
        const page = id => ({ id, name: `Dictionary ${id}`, scope: 'private', revision: 1, currentRevision: 1, total: 1, offset: 0, nextOffset: null, mode: 'contains', normalization: { form: 'NFKC', caseFold: true, spaces: 'preserve' }, source: '', license: '', records: [{ index: 0, entry: 'original' }] });
        const api = async (route, method, body) => {
            if (route === 'dictionary-preview') return { metadata: { name: 'Dictionary B' }, entryCount: 1, duplicateCount: 0, conflictCount: 0, sample: ['import B'] };
            if (route === 'dictionaries' && method === 'POST') { writes.push(body); return { id: 'B' }; }
            if (route.startsWith('dictionaries/')) return page(route.split('/')[1].split('?')[0]);
            assert.fail(route);
        };
        await f.render(f.React.createElement(f.exports.DictionaryManager, { api, dictionaries: [{ id: 'A', name: 'Dictionary A', revision: 1 }], scope: 'private', canEdit: true, refresh: async () => {} }));
        await click(f, f.container.querySelector('[data-dictionary-id="A"]')); await f.click('語を追加'); await f.fill(f.field('語'), 'valuable A'); await f.click('語の変更を追加');
        await f.fill(f.container.querySelector('[aria-label="取り込む語または辞書データ"]'), 'import B'); await f.click('取り込み内容を確認'); await f.click('別の辞書として保存');
        assert.equal(writes.length, 0); assert(f.container.querySelector('[aria-label="辞書の変更予定"]').textContent.includes('valuable A')); assert.equal(f.container.querySelector('[aria-label="取り込む語または辞書データ"]').value, 'import B');
        accept = true; await f.click('別の辞書として保存'); assert.equal(writes.length, 1); assert.equal(prompts.length, 2); assert.equal(f.container.querySelector('[data-dictionary-id="A"]').getAttribute('aria-pressed'), 'false');
    } finally { await f.close(); }
});

test('S22-1 switching package revision drafts requires consent and retains the previous composer on cancellation', async () => {
    const f = await reactFixture('export { MarketplaceManager } from "./components/automation/marketplace-manager";');
    try {
        let accept = false; const prompts = [];
        f.set('confirm', message => { prompts.push(message); return accept; });
        const pack = id => ({ id, title: `Package ${id}`, description: '', category: 'general', visibility: 'private', mine: true, kind: 'workflow', version: 1, latest_version: 1, status: 'draft', bundle: { license: 'MIT', dictionaries: {}, workflow: template('all', 'now', 'normal') } });
        const api = async route => route === 'starter' ? null : route.startsWith('marketplace?') ? { items: [pack('A'), pack('B')], nextCursor: null } : pack(route.split('/')[1]);
        await f.render(f.React.createElement(f.exports.MarketplaceManager, { api, scope: 'private', canEdit: true, rules: [], dictionaries: [], refresh: async () => {}, openRule: async () => {} })); await tick(f);
        await click(f, f.container.querySelector('[data-package-id="A"]')); await f.click('共有内容を改訂'); await f.fill(f.field('名前'), 'Valuable A revision');
        await f.click('共有一覧に戻る'); await click(f, f.container.querySelector('[data-package-id="B"]')); await f.click('共有内容を改訂');
        assert.equal(f.field('名前').value, 'Valuable A revision'); assert.equal(prompts.length, 1);
        accept = true; await f.click('共有内容を改訂'); assert.equal(f.field('名前').value, 'Package B'); assert.equal(prompts.length, 2);
        await f.fill(f.field('名前'), 'Retained B'); await f.click('共有内容を改訂'); assert.equal(f.field('名前').value, 'Retained B');
    } finally { await f.close(); }
});


test('S7-3 X-only consumers appear in application review in a private guild-workspace rule and the token is sent', async () => {
    const f = await workspaceFixture({ guildId: '111111111111111111', xOnly: true });
    try {
        await openRule(f); await f.click('通知に適用');
        assert(f.container.querySelector('dialog[open]').textContent.includes('Owner X monitor'));
        await f.click('1件の通知に適用');
        assert.equal(f.stored.get('A').activeRevision, 2);
        assert.equal(f.requests.find(row => row.route === 'workflows/A/activate').body.expectedTargetsToken, 'fixture-target-token');
    } finally { await f.close(); }
});
test('S7-3 an isolated X clone uses the X CAS route and preserves destination and receiver settings', async () => {
    const f = await workspaceFixture({ xOnly: true, xCompanion: true });
    try {
        await openRule(f); await f.click('通知を選ぶ'); await f.fill(f.container.querySelector('[aria-label="ルールを使う通知"]'), 'x:X');
        const select = f.container.querySelector('[aria-label="ルールを使う通知"]'); assert([...select.options].some(row => row.textContent.includes('Owner X monitor')));
        await f.click('ルールを複製して、この通知だけに適用');
        const patch = f.requests.find(row => row.route === 'x-monitors/X' && row.method === 'PATCH');
        assert.deepEqual(patch.body, { expectedRevision: 7, notificationSettings: { workflowId: 'copy', destinationId: 'owned-destination', subscriptionId: 'owned-receiver' } });
        assert.equal(f.xRows[0].revision, 8); assert.equal(f.xRows[1].notificationSettings.workflowId, 'A'); assert.equal(f.stored.get('A').activeRevision, 1);
    } finally { await f.close(); }
});
test('S20-1 an atomic target-token conflict keeps application pending and exposes no false success', async () => {
    const f = await workspaceFixture({ xOnly: true, tokenRace: true });
    try {
        await openRule(f); await f.click('通知に適用'); await f.click('1件の通知に適用');
        assert.equal(f.stored.get('A').activeRevision, 1); assert(f.container.querySelector('dialog[open]'));
        assert(!f.container.textContent.includes('1件の通知に適用しました。'));
    } finally { await f.close(); }
});


test('N6 pre-job rule history shows durable waits and preserves user exclusion reasons without exposing system codes', async () => {
    const f = await reactFixture('export { DeliveryHistory } from "./components/automation/delivery-history";');
    try {
        const api = async route => route === 'excluded' ? { items: [
            { id: 'wait', state: 'waiting', event: { title: 'Waiting event' }, trace: [{ nodeId: 'delay', outcome: 'waiting', reason: 'FLOW_WAITING', wakeAtMs: 1000 }] },
            { id: 'exclude', state: 'excluded', event: { title: 'Excluded event' }, trace: [{ nodeId: 'stop', outcome: 'excluded', reason: '利用者が指定した対象外の理由' }] },
            { id: 'expired', state: 'expired', event: { title: 'Expired event' }, trace: [{ nodeId: 'schedule', outcome: 'expired', reason: 'DEADLINE_EXCEEDED' }] },
        ] } : { items: [job('normal')], nextCursor: null };
        await f.render(f.React.createElement(f.exports.DeliveryHistory, { api, canEdit: true })); await f.settle(); await f.click('除外理由を確認');
        assert(f.container.textContent.includes('ルールの処理履歴')); assert(f.container.textContent.includes('指定時刻まで待機中')); assert(f.container.textContent.includes('利用者が指定した対象外の理由')); assert(f.container.textContent.includes('配信期限を過ぎました。')); assert(!f.container.textContent.includes('FLOW_WAITING')); assert(!f.container.textContent.includes('DEADLINE_EXCEEDED'));
        assert(f.container.querySelector('[data-job-id="normal"]')); assert(f.container.querySelector('time'));
    } finally { await f.close(); }
});

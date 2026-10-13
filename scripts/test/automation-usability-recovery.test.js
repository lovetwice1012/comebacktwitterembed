'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const { catalog, template } = require('../../src/automation/catalog');
const { validateWorkflow } = require('../../src/automation/schema');
const { stringifyDraft, parseWorkflow } = require('../../src/automation/format');
const tick = (f, ms = 25) => f.act(async () => new Promise(resolve => setTimeout(resolve, ms)));
const click = (f, node) => f.act(async () => node.click());
const button = (f, text) => [...f.container.querySelectorAll('button')].find(node => node.textContent.trim() === text);

test('dictionary edits survive paging and search; review supports individual undo and saves both pages together', async () => {
    const f = await reactFixture('export { DictionaryManager } from "./components/automation/dictionary-manager";');
    try {
        f.set('confirm', () => { throw new Error('Paging must not discard or prompt to discard edits'); });
        const writes = []; let revision = 1;
        const api = async (route, method, body) => {
            if (route.endsWith('/patch')) {
                writes.push(structuredClone(body));
                if (body.preview) return { conflictCount: 0, duplicateCount: 0, conflicts: [], diff: {} };
                revision++; return { revision };
            }
            const pageTwo = route.includes('offset=100');
            return { name: '辞書', mode: 'contains', normalization: { form: 'NFKC', caseFold: true, spaces: 'preserve' }, source: '', license: '', scope: 'private',
                revision, currentRevision: revision, total: 200, offset: pageTwo ? 100 : 0, nextOffset: pageTwo ? null : 100,
                records: [{ index: pageTwo ? 100 : 0, entry: pageTwo ? 'orange' : 'apple' }] };
        };
        await f.render(f.React.createElement(f.exports.DictionaryManager, { api, dictionaries: [{ id: 'd1', name: '辞書', revision: 1 }], scope: 'private', canEdit: true, refresh: async () => {} }));
        await click(f, f.container.querySelector('[data-dictionary-id="d1"]'));
        const metadataPanel = [...f.container.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === '辞書名・正規化・出典');
        await f.fill(metadataPanel.querySelector('input'), '変更予定の辞書名');
        await f.click('編集'); await f.fill(f.field('語'), 'apple revised'); await f.click('語の変更を追加');
        await f.click('次の100語'); await f.click('編集'); await f.fill(f.field('語'), 'orange revised'); await f.click('語の変更を追加');
        await f.fill(f.container.querySelector('[aria-label="辞書の語を検索"]'), 'fruit'); await f.click('検索');
        const review = f.container.querySelector('[aria-label="辞書の変更予定"]');
        assert(review.textContent.includes('apple revised')); assert(review.textContent.includes('orange revised'));
        assert(review.textContent.includes('変更予定の辞書名'));
        await f.click('この設定の変更を取り消す'); assert.equal(metadataPanel.querySelector('input').value, '辞書');
        await f.click('語を追加'); await f.fill(f.field('語'), 'discard only this'); await f.click('語の変更を追加');
        const last = [...f.container.querySelectorAll('[aria-label="辞書の変更予定"] li')].at(-1);
        await click(f, last.querySelector('button'));
        assert(!f.container.textContent.includes('discard only this'));
        await f.click('差分・競合を確認'); await f.click('新しい版として保存');
        assert.deepEqual(writes.at(-1).patch.operations.map(row => [row.index, row.entry.term]), [[0, 'apple revised'], [100, 'orange revised']]);
        assert.equal(writes.at(-1).expectedRevision, 1); assert.equal(revision, 2);
    } finally { await f.close(); }
});

test('channel failures retry in place and loading blocks progression without losing source or price conditions', async () => {
    const f = await reactFixture('export { MonitorRegistration } from "./components/automation/monitor-registration";');
    try {
        let attempts = 0, finish, saved = 0;
        const api = async route => {
            if (route.endsWith('/preview')) return { providerId: 'steam', source: 'https://store.steampowered.com/app/730', intervalMinutes: 360 };
            if (route === 'channels') { attempts++; if (attempts === 1) throw new Error('temporary channel failure'); return new Promise(resolve => { finish = resolve; }); }
            assert.fail(route);
        };
        function Fixture() {
            const [monitor, setMonitor] = f.React.useState({ source: 'https://store.steampowered.com/app/730', providerId: 'steam', name: '保持する名前', locale: 'ja', destinationId: '', mode: 'threshold', maxPriceAmount: '980', minDiscountPercent: '', workflowId: '' });
            return f.React.createElement(f.exports.MonitorRegistration, { api, monitor, kind: 'price', scope: 'guild', guildId: 'guild', destinations: [], rules: [], catalog: { price: [{ id: 'steam' }] }, busy: false,
                onChange: setMonitor, onSourceChange: source => setMonitor({ ...monitor, source }), onSave: async () => { saved++; }, run: async work => work(), refresh: async () => {} });
        }
        await f.render(f.React.createElement(Fixture)); await f.submit(); await f.settle();
        assert(f.container.textContent.includes('temporary channel failure')); assert.equal(button(f, '通知内容を確認').disabled, true);
        await f.click('チャンネルを再読み込み'); assert.equal(button(f, '通知内容を確認').disabled, true);
        await f.act(async () => finish({ items: [{ id: 'ch', name: '通知', canCreateWebhook: true }] }));
        assert.equal(f.field('指定価格以下').value, '980'); assert.equal(saved, 0);
        await f.fill(f.field('チャンネル'), 'ch'); await f.submit();
        assert(f.container.textContent.includes('保持する名前')); assert.equal(attempts, 2); assert.equal(saved, 0);
    } finally { await f.close(); }
});

test('notification and webhook dialog drafts resume after closing; webhook secrets stay out of browser storage', async () => {
    const f = await reactFixture('export { MonitorManager } from "./components/automation/monitor-manager";');
    try {
        const api = async route => route === 'providers' ? { auto: [{ id: 'github' }], price: [], autoRegistration: { eligible: true } } : route.endsWith('/preview') ? { providerId: 'github', source: 'https://github.com/octocat', intervalMinutes: 360 } : { items: [], nextCursor: null };
        await f.render(f.React.createElement(f.exports.MonitorManager, { api, guildId: 'guild', canEdit: true, scope: 'private', destinations: [], rules: [], refresh: async () => {} })); await tick(f);
        await f.click('通知を追加'); await f.fill(f.field('対象のURL・ID'), 'https://github.com/octocat'); await f.fill(f.field('名前'), '途中の通知'); await f.submit();
        await f.click('キャンセル'); assert.equal(f.container.querySelector('dialog[open]'), null);
        await f.click('通知の入力を再開'); assert(f.container.querySelector('dialog[open]').textContent.includes('通知先の種類'));
        await f.click('キャンセル'); await f.click('通知先を追加');
        const dialog = f.container.querySelector('dialog[open]');
        const labels = [...dialog.querySelectorAll('label')];
        await f.fill(labels.find(node => node.textContent.startsWith('通知先の種類')).querySelector('select'), 'webhook');
        const secret = 'https://discord.com/api/webhooks/123/fixture-private-secret';
        await f.fill(dialog.querySelector('input[type="password"]'), secret);
        await click(f, [...dialog.querySelectorAll('button')].find(node => node.textContent === 'キャンセル'));
        await f.click('通知先の入力を再開'); assert.equal(f.container.querySelector('dialog[open] input[type="password"]').value, secret);
        assert.equal(f.dom.window.localStorage.length, 0); assert.equal(f.dom.window.sessionStorage.length, 0);
    } finally { await f.close(); }
});

test('history refresh cannot overwrite newer filters and detail Back restores the originating card focus', async () => {
    const f = await reactFixture('export { DeliveryHistory } from "./components/automation/delivery-history";');
    try {
        let refresh, allReads = 0;
        const row = { id: 'failure', state: 'failed', title: '最新の失敗', providerId: 'github', dueAtMs: 1, sentSteps: 0, trace: [], scope: 'private', preview: 'sample' };
        const api = async route => {
            if (route === 'jobs/failure') return row;
            if (route === 'jobs?state=failed') return { items: [row], nextCursor: null };
            if (route === 'jobs?state=') { if (++allReads === 2) return new Promise(resolve => { refresh = resolve; }); return { items: [], nextCursor: null }; }
            assert.fail(route);
        };
        await f.render(f.React.createElement(f.exports.DeliveryHistory, { api, canEdit: true })); await f.settle();
        await f.click('更新'); await f.fill(f.container.querySelector('select'), 'failed'); await f.settle();
        await f.act(async () => refresh({ items: [{ ...row, title: '古い更新' }], nextCursor: null }));
        assert(f.container.textContent.includes('最新の失敗')); assert(!f.container.textContent.includes('古い更新'));
        await click(f, f.container.querySelector('[data-job-id="failure"]'));
        assert.equal(f.dom.window.document.activeElement.textContent, '配信の詳細');
        await f.click('配信一覧に戻る'); await tick(f);
        assert.equal(f.dom.window.document.activeElement.dataset.jobId, 'failure');
    } finally { await f.close(); }
});

test('sharing search wins against obsolete initial reads and list/detail navigation preserves search and focus', async () => {
    const f = await reactFixture('export { MarketplaceManager } from "./components/automation/marketplace-manager";');
    try {
        let initial;
        const pack = { id: 'new', title: '一致するルール', version: 1, latest_version: 1, status: 'active', owner_user_id: 'owner', installs: 0, mine: false,
            feedback: {}, bundle: { dictionaries: {}, license: 'MIT' }, canInstall: false };
        const api = async route => {
            if (route === 'starter') return null;
            if (route.startsWith('marketplace?search=&')) return new Promise(resolve => { initial = resolve; });
            if (route.startsWith('marketplace?search=needle')) return { items: [pack], nextCursor: null };
            if (route === 'marketplace/new/open') return pack;
            assert.fail(route);
        };
        await f.render(f.React.createElement(f.exports.MarketplaceManager, { api, scope: 'private', canEdit: true, rules: [], dictionaries: [], refresh: async () => {}, openRule: async () => {} })); await tick(f);
        await f.fill(f.container.querySelector('[aria-label="共有ルールを検索"]'), 'needle'); await f.click('検索');
        await f.act(async () => initial({ items: [{ ...pack, title: '古い一覧' }], nextCursor: null }));
        assert(!f.container.textContent.includes('古い一覧'));
        await click(f, f.container.querySelector('[data-package-id="new"]'));
        assert.equal(f.dom.window.document.activeElement.textContent, pack.title);
        await f.click('共有一覧に戻る'); await tick(f);
        assert.equal(f.container.querySelector('[aria-label="共有ルールを検索"]').value, 'needle');
        assert.equal(f.dom.window.document.activeElement.dataset.packageId, 'new');
    } finally { await f.close(); }
});

async function workspace({ attached = true, cloneActivationFails = false, postActivationReadFails = false } = {}) {
    const f = await reactFixture('export { AutomationWorkspace } from "./components/automation/automation-workspace";');
    f.set('SVGElement', f.dom.window.SVGElement); f.set('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); f.set('sessionStorage', f.dom.window.sessionStorage); f.set('confirm', () => true);
    const definition = template('all', 'now', 'expanded'), bindings = { destinations: {}, dictionaries: {} }, stored = new Map();
    stored.set('original', { id: 'original', name: definition.name, draft: definition, bindings, scope: 'private', revision: 4, activeRevision: 3, enabled: true });
    const rows = ['first', 'second'].map(id => ({ id, kind: 'auto', name: `${id}の通知`, scope: 'private', enabled: true, workflowId: attached ? 'original' : null, destinationType: 'dm' }));
    const writes = [], reads = [];
    f.set('fetch', async (address, options) => {
        const url = new URL(address, 'http://fixture'), route = url.pathname.slice('/api/automation/'.length), body = options.body && JSON.parse(options.body);
        reads.push(route + url.search);
        let result;
        if (route === 'catalog') result = catalog();
        else if (route === 'providers') result = { auto: [{ id: 'github' }], price: [], autoRegistration: { eligible: true } };
        else if (route === 'destinations' || route === 'dictionaries') result = { items: [] };
        else if (route === 'starter') result = null;
        else if (route.startsWith('marketplace')) result = { items: [], nextCursor: null };
        else if (route === 'monitors/auto') result = { items: [rows[url.searchParams.has('afterId') ? 1 : 0]], nextCursor: url.searchParams.has('afterId') ? null : 'second-page' };
        else if (route === 'monitors/price') result = { items: [], nextCursor: null };
        else if (route === 'validate') { const rule = body.text === undefined ? body.definition : parseWorkflow(body.text, body.format); result = { ...validateWorkflow(rule), definition: rule, text: stringifyDraft(rule, body.format) }; }
        else if (route === 'workflows' && options.method === 'GET') result = { items: [...stored.values()] };
        else if (route === 'workflows' && options.method === 'POST') { result = { id: 'clone', name: body.definition.name, draft: body.definition, bindings: body.bindings, scope: body.scope, revision: 1, activeRevision: null, enabled: false }; stored.set('clone', result); writes.push({ route, body }); }
        else if (route.startsWith('workflows/')) {
            const [, id, action] = route.split('/'); result = stored.get(id);
            if (!action && id === 'original' && postActivationReadFails && result.activeRevision === result.revision) { postActivationReadFails = false; return new Response(JSON.stringify({ error: 'fixture reload failure' }), { status: 503 }); }
            if (action === 'activate') {
                writes.push({ route, body });
                if (id === 'clone' && cloneActivationFails) { cloneActivationFails = false; return new Response(JSON.stringify({ error: 'fixture clone activation failure' }), { status: 409 }); }
                result = { ...result, enabled: true, activeRevision: result.revision }; stored.set(id, result);
            }
            if (action === 'attach') { writes.push({ route, body }); rows.find(row => row.id === body.targetId).workflowId = id; result = { ok: true }; }
        } else assert.fail(route);
        return new Response(JSON.stringify(result), { status: 200 });
    });
    await f.render(f.React.createElement(f.exports.AutomationWorkspace, { viewerId: '222222222222222222', canEdit: true })); await tick(f);
    return Object.assign(f, { rows, stored, writes, reads });
}

test('workspace resource tabs retain dictionary import and sharing forms in memory', async () => {
    const f = await workspace();
    try {
        await f.click('辞書'); await f.settle(); await f.fill(f.container.querySelector('[aria-label="取り込む語または辞書データ"]'), 'uncommitted words');
        await f.click('共有ルール'); await f.settle(); await f.fill(f.field('名前'), '未公開の名前');
        await f.click('通知一覧'); await f.click('辞書');
        assert.equal(f.container.querySelector('[aria-label="取り込む語または辞書データ"]').value, 'uncommitted words');
        await f.click('共有ルール'); assert.equal(f.field('名前').value, '未公開の名前'); assert.deepEqual(f.writes, []);
    } finally { await f.close(); }
});

test('apply previews every attachment across pagination; a single-target clone leaves the original executing version alone', async () => {
    const f = await workspace();
    try {
        await f.click('通知ルール'); await click(f, f.container.querySelector('.studio-rule-card')); await tick(f, 460);
        await f.click('通知に適用'); await f.settle();
        const dialog = f.container.querySelector('dialog[open]'); assert(dialog.textContent.includes('firstの通知')); assert(dialog.textContent.includes('secondの通知'));
        assert(f.reads.some(route => route.includes('afterId=second-page'))); assert.deepEqual(f.writes, []);
        await f.click('1件だけ変更する通知を選ぶ'); await f.fill(f.container.querySelector('[aria-label="ルールを使う通知"]'), 'auto:second');
        await f.click('ルールを複製して、この通知だけに適用'); await tick(f, 460);
        assert.equal(f.stored.get('original').activeRevision, 3);
        assert.equal(f.rows[0].workflowId, 'original'); assert.equal(f.rows[1].workflowId, 'clone');
        assert.deepEqual(f.writes.map(row => row.route), ['workflows', 'workflows/clone/activate', 'workflows/clone/attach']);
    } finally { await f.close(); }
});

test('apply without attachments opens target selection and performs no misleading standalone activation', async () => {
    const f = await workspace({ attached: false });
    try {
        await f.click('通知ルール'); await click(f, f.container.querySelector('.studio-rule-card')); await tick(f, 460);
        await f.click('通知に適用'); await f.settle();
        assert(f.container.querySelector('dialog[open] [aria-label="ルールを使う通知"]'));
        assert.deepEqual(f.writes, []);
    } finally { await f.close(); }
});

test('a failed clone activation resumes the saved copy and never creates or modifies a second copy', async () => {
    const f = await workspace({ cloneActivationFails: true });
    try {
        await f.click('通知ルール'); await click(f, f.container.querySelector('.studio-rule-card')); await tick(f, 460);
        await f.click('通知を選ぶ'); await f.fill(f.container.querySelector('[aria-label="ルールを使う通知"]'), 'auto:second');
        await f.click('ルールを複製して、この通知だけに適用'); await tick(f, 460);
        assert(f.container.textContent.includes('fixture clone activation failure')); assert.equal(f.stored.get('original').activeRevision, 3);
        await f.click('保存して通知に適用'); await tick(f, 460);
        assert.deepEqual(f.writes.map(row => row.route), ['workflows', 'workflows/clone/activate', 'workflows/clone/activate', 'workflows/clone/attach']);
        assert.equal(f.rows[0].workflowId, 'original'); assert.equal(f.rows[1].workflowId, 'clone');
    } finally { await f.close(); }
});

test('all-target application remains visibly committed when its subsequent display reload fails', async () => {
    const f = await workspace({ postActivationReadFails: true });
    try {
        await f.click('通知ルール'); await click(f, f.container.querySelector('.studio-rule-card')); await tick(f, 460);
        await f.click('通知に適用'); await f.click('2件の通知に適用'); await f.settle();
        assert.equal(f.stored.get('original').activeRevision, 4);
        assert(f.container.textContent.includes('2件の通知に適用しました。'));
        assert(f.container.textContent.includes('通知に適用済みです。画面を再読み込みしてください。'));
        assert(!f.container.textContent.includes('fixture reload failure'));
        assert.equal(f.container.querySelector('dialog[open]'), null);
        assert.deepEqual(f.writes.map(row => row.route), ['workflows/original/activate']);
    } finally { await f.close(); }
});

test('returning to the retained notification list reloads applied and cloned workflow assignments across pages', async () => {
    const f = await workspace({ attached: false });
    try {
        await f.click('続きを読み込む'); await f.settle();
        assert.equal(f.container.querySelectorAll('.monitor-card').length, 2);
        await f.click('通知ルール'); await click(f, f.container.querySelector('.studio-rule-card')); await tick(f, 460);
        for (const target of ['first', 'second']) {
            await f.click('通知を選ぶ'); await f.fill(f.container.querySelector('[aria-label="ルールを使う通知"]'), `auto:${target}`);
            await f.click('保存して通知に適用'); await tick(f, 460);
        }
        await f.fill(f.container.querySelector('[aria-label="ルール名"]'), '複製する編集'); await tick(f, 460);
        await f.click('通知を選ぶ'); await f.fill(f.container.querySelector('[aria-label="ルールを使う通知"]'), 'auto:second');
        await f.click('ルールを複製して、この通知だけに適用'); await tick(f, 460);
        assert.equal(f.rows[0].workflowId, 'original'); assert.equal(f.rows[1].workflowId, 'clone');
        await f.click('通知一覧'); await tick(f); await f.click('続きを読み込む'); await f.settle();
        const cards = [...f.container.querySelectorAll('.monitor-card')];
        assert.equal(cards.length, 2);
        assert(cards[0].querySelector('details').textContent.includes(f.stored.get('original').name));
        assert(cards[1].querySelector('details').textContent.includes(f.stored.get('clone').name));
        assert(!cards.some(card => card.querySelector('details').textContent.includes('通常の通知')));
    } finally { await f.close(); }
});

test('reactivating notifications ignores hidden stale reads and keeps destination input and filters', async () => {
    const f = await reactFixture('export { MonitorManager } from "./components/automation/monitor-manager";');
    try {
        let reads = 0, stale;
        const api = async route => {
            if (route === 'providers') return { auto: [], price: [], autoRegistration: { eligible: true } };
            if (++reads === 2) return new Promise(resolve => { stale = resolve; });
            return { items: [{ id: 'row', name: '最新の割り当て', scope: 'private', enabled: true, workflowId: 'new-rule' }], nextCursor: null };
        };
        const props = { api, guildId: 'guild', scope: 'private', canEdit: true, destinations: [], rules: [{ id: 'new-rule', name: '更新済みルール' }], refresh: async () => {} };
        await f.render(f.React.createElement(f.exports.MonitorManager, { ...props, active: true })); await tick(f);
        await f.click('通知先を追加'); await f.fill(f.field('通知先の名前'), '閉じても保持する通知先'); await f.click('キャンセル');
        await f.fill(f.field('通知を検索'), 'assignment'); await tick(f, 280);
        await f.render(f.React.createElement(f.exports.MonitorManager, { ...props, active: false }));
        await f.render(f.React.createElement(f.exports.MonitorManager, { ...props, active: true })); await tick(f, 280);
        await f.act(async () => stale({ items: [{ id: 'old', name: '古い隠れた一覧', enabled: true }], nextCursor: null }));
        assert(!f.container.textContent.includes('古い隠れた一覧')); assert(f.container.textContent.includes('更新済みルール'));
        assert.equal(f.field('通知を検索').value, 'assignment');
        await f.click('通知先の入力を再開'); assert.equal(f.field('通知先の名前').value, '閉じても保持する通知先');
    } finally { await f.close(); }
});

test('reactivating history refreshes open job details without losing time input; a removed opener has a stable Back focus', async () => {
    const f = await reactFixture('export { DeliveryHistory } from "./components/automation/delivery-history";');
    try {
        f.set('confirm', () => true);
        let row = { id: 'later-page', state: 'pending', title: '変更前', version: 1, providerId: 'github', scope: 'private', dueAtMs: 1, sentSteps: 0, preview: 'sample', trace: [] };
        let reads = 0;
        const api = async (route, method, body) => {
            if (route === 'jobs/later-page' && method === 'PATCH') { assert.equal(body.expectedVersion, 2); row = { ...row, state: 'cancelled', version: 3 }; return {}; }
            if (route === 'jobs/later-page') return structuredClone(row);
            reads++; return { items: row.state === 'pending' ? [structuredClone(row)] : [], nextCursor: null };
        };
        const props = { api, canEdit: true };
        await f.render(f.React.createElement(f.exports.DeliveryHistory, { ...props, active: true })); await f.settle();
        await f.fill(f.container.querySelector('select'), 'pending'); await f.settle();
        await click(f, f.container.querySelector('[data-job-id="later-page"]'));
        await f.fill(f.container.querySelector('input[type="datetime-local"]'), '2026-10-15T10:30');
        await f.render(f.React.createElement(f.exports.DeliveryHistory, { ...props, active: false }));
        const hiddenReads = reads; row = { ...row, title: '再表示で更新', version: 2 };
        await f.settle(); assert.equal(reads, hiddenReads);
        await f.render(f.React.createElement(f.exports.DeliveryHistory, { ...props, active: true })); await f.settle();
        assert(reads > hiddenReads); assert.equal(f.container.querySelector('input[type="datetime-local"]').value, '2026-10-15T10:30');
        await f.click('配信を取り消す'); await f.click('配信一覧に戻る'); await tick(f);
        assert.equal(f.container.querySelector('[data-job-id="later-page"]'), null);
        assert.equal(f.dom.window.document.activeElement.textContent, '配信予定・履歴');
    } finally { await f.close(); }
});

test('reactivating sharing refreshes package status and details while preserving publication/report drafts and Back focus', async () => {
    const f = await reactFixture('export { MarketplaceManager } from "./components/automation/marketplace-manager";');
    try {
        let withdrawn = false, reads = 0;
        const pack = { id: 'publication', title: '共有のルール', version: 1, latest_version: 1, status: 'active', owner_user_id: 'owner', installs: 0, mine: false, feedback: {}, bundle: { dictionaries: {}, license: 'MIT' }, canInstall: false };
        const api = async route => {
            if (route === 'starter') return null;
            if (route === 'marketplace/publication/open') return { ...pack, status: withdrawn ? 'withdrawn' : 'active' };
            reads++; return { items: withdrawn ? [] : [pack], nextCursor: null };
        };
        const props = { api, scope: 'private', canEdit: true, rules: [], dictionaries: [], refresh: async () => {}, openRule: async () => {} };
        await f.render(f.React.createElement(f.exports.MarketplaceManager, { ...props, active: true })); await tick(f);
        await click(f, f.container.querySelector('[data-package-id="publication"]'));
        await f.fill(f.field('名前'), '未公開の入力'); await f.fill(f.container.querySelector('[aria-label="通報理由"]'), '未送信の通報');
        await f.render(f.React.createElement(f.exports.MarketplaceManager, { ...props, active: false }));
        withdrawn = true; const hiddenReads = reads; await tick(f); assert.equal(reads, hiddenReads);
        await f.render(f.React.createElement(f.exports.MarketplaceManager, { ...props, active: true })); await tick(f);
        assert(f.container.textContent.includes('公開停止')); assert(reads > hiddenReads);
        assert.equal(f.field('名前').value, '未公開の入力'); assert.equal(f.container.querySelector('[aria-label="通報理由"]').value, '未送信の通報');
        await f.click('共有一覧に戻る'); await tick(f);
        assert.equal(f.container.querySelector('[data-package-id="publication"]'), null);
        assert.equal(f.dom.window.document.activeElement.textContent, '共有ルール・辞書');
    } finally { await f.close(); }
});

test('dictionary paging pins its displayed revision; confirmed same-version reopen discards edits explicitly', async () => {
    const f = await reactFixture('export { DictionaryManager } from "./components/automation/dictionary-manager";');
    try {
        let allowDiscard = false, head = 1; const requests = [];
        f.set('confirm', () => allowDiscard);
        const api = async route => {
            requests.push(route);
            if (route.endsWith('/versions')) return { items: [{ revision: 1, entryCount: 200, createdAtMs: 1 }], nextRevision: null };
            const url = new URL(route, 'http://fixture'), revision = Number(url.searchParams.get('revision') || head), offset = Number(url.searchParams.get('offset') || 0);
            return { name: '辞書', mode: 'contains', normalization: { form: 'NFKC', caseFold: true, spaces: 'preserve' }, source: '', license: '', scope: 'private', revision, currentRevision: head, total: 200, offset, nextOffset: offset ? null : 100, records: [{ index: offset, entry: offset ? 'orange' : 'apple' }] };
        };
        await f.render(f.React.createElement(f.exports.DictionaryManager, { api, dictionaries: [{ id: 'd1', name: '辞書', revision: 1 }], scope: 'private', canEdit: true, refresh: async () => {} }));
        await click(f, f.container.querySelector('[data-dictionary-id="d1"]'));
        await f.click('編集'); await f.fill(f.field('語'), '保持する修正'); await f.click('語の変更を追加');
        head = 2; await f.click('次の100語');
        assert(requests.at(-1).includes('revision=1')); assert(f.container.querySelector('[aria-label="辞書の変更予定"]').textContent.includes('保持する修正'));
        await f.fill(f.container.querySelector('[aria-label="辞書の語を検索"]'), 'query'); await f.click('検索');
        assert(requests.at(-1).includes('revision=1')); assert(f.container.querySelector('[aria-label="辞書の変更予定"]'));
        const metadataPanel = [...f.container.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === '辞書名・正規化・出典');
        await f.fill(metadataPanel.querySelector('input'), '未保存の辞書名');
        await f.click('語を追加'); await f.fill(f.field('語'), 'まだ確定していない語');
        await f.click('版の履歴'); await f.click('この版を開く'); assert(f.container.querySelector('[aria-label="辞書の変更予定"]'));
        allowDiscard = true; await f.click('この版を開く');
        assert(requests.at(-1).includes('revision=1')); assert.equal(f.container.querySelector('[aria-label="辞書の変更予定"]'), null);
        assert(f.container.textContent.includes('過去の版は閲覧専用'));
        const leaving = new f.dom.window.Event('beforeunload', { cancelable: true }); f.dom.window.dispatchEvent(leaving);
        assert.equal(leaving.defaultPrevented, false, 'confirmed reopening clears staged words, unfinished editor and metadata together');
    } finally { await f.close(); }
});

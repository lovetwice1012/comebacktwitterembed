'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const load = require('./helpers/load-dashboard.cjs');
const nativePresentation = require('../../admin-agent/web/view-data');
const { describeResult, readAdminLocation, buildInvestigationQuery } = load('lib/admin-workspace.ts');
const { investigationSummary } = load('components/admin/investigation-view.tsx');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const settle = async (f, ms = 0) => f.act(async () => { await new Promise(resolve => ms ? setTimeout(resolve, ms) : setImmediate(resolve)); });
const click = async (f, element) => { assert(element); await f.act(async () => element.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true }))); };
const button = (f, label) => [...f.container.querySelectorAll('button')].find(node => node.textContent.trim() === label);

test('root result definitions and legacy delivery evidence give identical U/C labels across both admin UIs', () => {
    for (const code of ['U', 'C']) {
        const root = { definitionVersion: 'root-request-v1', recordKind: 'runs' };
        const legacy = { ...root, payload: { kind: 'request.completed', instrumentation_version: 1 } };
        assert.deepEqual(describeResult(code, root), nativePresentation.result(code, root));
        assert.deepEqual(describeResult(code, legacy), nativePresentation.result(code, legacy));
        assert.equal(describeResult(code, root).label, code === 'U' ? '取得対象の制約' : '明示的取消');
        assert.equal(describeResult(code, legacy).label, code === 'U' ? '送信結果不明' : '取得対象の制約');
        assert.equal(describeResult(code, legacy).contract, '送信判定（旧定義）');
        assert.match(describeResult(code).label, /定義未確認/);
    }
    const record = { id: 'legacy-run', outcome: 'U', definitionVersion: 'root-request-v1', completion: { kind: 'request.completed', instrumentation_version: 1, outcome: 'U' } };
    assert.equal(investigationSummary(record, 'runs').result, '送信結果不明');
    assert.equal(nativePresentation.event({ payload: record.completion }).outcome, '送信結果不明');
    assert.equal(describeResult('C', { outcomeDefinitionVersion: 'root-request-v1', payload: { instrumentation_version: 1 } }).label, '明示的取消', 'an explicit outcome contract takes precedence over legacy instrumentation');
});

test('management action status survives URL restore and does not contaminate root/event queries', () => {
    const location = readAdminLocation('/admin?section=investigation&tab=search&source=actions&actionStatus=running');
    assert.equal(buildInvestigationQuery(location).get('status'), 'running');
    assert.equal(buildInvestigationQuery(location, 'runs').has('status'), false);
    assert.equal(buildInvestigationQuery(location, 'events').has('status'), false);
    assert.equal(readAdminLocation('/admin?actionStatus=invalid').actionStatus, '');
});

async function receiptFixture({ saved, viewerId, storageFailure = false, fetcher, onRefresh = async () => {} } = {}) {
    const f = await reactFixture('export { useRecoveryReceipt } from "./components/admin/emergency-recovery-panel";');
    f.set('sessionStorage', storageFailure ? { getItem: key => f.dom.window.sessionStorage.getItem(key), setItem() { throw new Error('fixture storage quota'); }, removeItem: key => f.dom.window.sessionStorage.removeItem(key) } : f.dom.window.sessionStorage);
    if (saved) f.dom.window.sessionStorage.setItem(`cbte-admin-recovery-receipt-v1${viewerId ? `:${viewerId}` : ''}`, saved);
    const requests = [];
    f.set('fetch', async (url, options = {}) => { requests.push({ url: String(url), method: options.method || 'GET', body: options.body && JSON.parse(options.body) }); return fetcher(String(url), options); });
    let receipt, changeViewer;
    function Fixture() {
        const [owner, setOwner] = f.React.useState(viewerId); changeViewer = setOwner;
        receipt = f.exports.useRecoveryReceipt(onRefresh, owner);
        return f.React.createElement('div', null,
            f.React.createElement('button', { disabled: receipt.busy || !!receipt.request, onClick: () => receipt.submit('recovery.manual_switch', { targetNode: 'oci', expectedEpoch: 7, reason: 'fixture request only' }) }, '切り替え'),
            f.React.createElement('button', { disabled: receipt.busy || !receipt.request, onClick: () => receipt.check() }, '結果を確認'),
            f.React.createElement('p', { role: 'status' }, receipt.action?.status || ''),
            f.React.createElement('p', { role: 'alert' }, receipt.error));
    }
    await f.render(f.React.createElement(Fixture)); await f.settle();
    return Object.assign(f, { requests, receipt: () => receipt, changeViewer: owner => f.act(async () => changeViewer(owner)) });
}

test('receipt storage failure prevents dispatch instead of creating an untrackable recovery action', async () => {
    const f = await receiptFixture({ storageFailure: true, fetcher: async () => { throw new Error('no recovery request may be dispatched'); } });
    try {
        await f.click('切り替え'); await f.settle();
        assert.equal(f.requests.length, 0); assert.equal(f.receipt().request, null);
        assert.match(f.container.textContent, /受付キーを保存できません/);
        assert.match(f.container.textContent, /操作は送信していません/);
        assert.equal(button(f, '切り替え').disabled, false);
    } finally { await f.close(); }
});

test('recovery receipts stay in their actor namespace and late replies cannot appear after switching actors', async () => {
    let acknowledge;
    const f = await receiptFixture({ viewerId: 'admin-a', fetcher: async () => new Promise(resolve => { acknowledge = resolve; }) });
    try {
        await f.click('切り替え');
        const saved = globalThis.sessionStorage.getItem('cbte-admin-recovery-receipt-v1:admin-a'); assert(saved);
        assert.equal(JSON.parse(saved).ownerId, 'admin-a');
        await f.changeViewer('admin-b'); await f.settle();
        assert.equal(f.receipt().request, null); assert.equal(f.receipt().action, null);
        await f.act(async () => acknowledge(json({ id: 'admin-a-receipt', status: 'running' }))); await f.settle();
        assert.equal(f.receipt().action, null); assert.equal(f.receipt().request, null);
        assert.equal(globalThis.sessionStorage.getItem('cbte-admin-recovery-receipt-v1:admin-a'), saved, 'the other actor can still recover their receipt');
        assert.equal(globalThis.sessionStorage.getItem('cbte-admin-recovery-receipt-v1:admin-b'), null);
        assert.equal(f.requests.length, 1);
    } finally { await f.close(); }
});

test('a lost emergency POST acknowledgement saves its original input/key and all later reconciliation is GET-only across reload', async () => {
    let saved, postCount = 0;
    const first = await receiptFixture({ fetcher: async (_url, options) => {
        assert.equal(options.method, 'POST'); postCount++;
        saved = globalThis.sessionStorage.getItem('cbte-admin-recovery-receipt-v1');
        assert.equal(JSON.parse(saved).idempotencyKey, JSON.parse(options.body).idempotencyKey, 'the key is saved before dispatch');
        throw new TypeError('fixture lost acknowledgement');
    } });
    try {
        await first.click('切り替え'); await first.settle();
        assert(first.receipt().request); assert.equal(button(first, '切り替え').disabled, true);
        assert.match(first.container.textContent, /失敗したとは判断できません/);
        assert.equal(postCount, 1);
    } finally { await first.close(); }
    let reads = 0, refreshes = 0;
    const restored = await receiptFixture({ saved, onRefresh: async () => { refreshes++; }, fetcher: async (url, options) => {
        assert.equal(options.method || 'GET', 'GET'); reads++;
        if (reads === 1) { assert.match(url, /actions\/by-key\//); return json({ id: 'recovery-receipt-1', type: 'recovery.manual_switch', status: 'running' }); }
        assert.equal(url, '/api/admin/agent/actions/recovery-receipt-1');
        return json({ id: 'recovery-receipt-1', type: 'recovery.manual_switch', status: 'succeeded', result: { manualSwitch: { state: 'scheduled' } } });
    } });
    try {
        assert.deepEqual(restored.receipt().request, JSON.parse(saved));
        await restored.click('結果を確認'); await restored.settle();
        assert.equal(restored.receipt().request.actionId, 'recovery-receipt-1');
        assert.equal(button(restored, '切り替え').disabled, true);
        await restored.click('結果を確認'); await restored.settle();
        assert.equal(restored.receipt().request, null); assert.equal(restored.receipt().action.status, 'succeeded');
        assert.equal(globalThis.sessionStorage.getItem('cbte-admin-recovery-receipt-v1'), null);
        assert.equal(refreshes, 1); assert.equal(postCount, 1);
        assert(restored.requests.every(request => request.method === 'GET'));
    } finally { await restored.close(); }
});

test('missing or unknown recovery receipts remain unresolved and a confirmed receipt survives a failed status refresh', async () => {
    const saved = JSON.stringify({ type: 'recovery.manual_switch', input: { expectedEpoch: 7 }, idempotencyKey: 'fixture-unconfirmed' });
    for (const reply of [json({ error: { code: 'RECEIPT_NOT_OBSERVED' } }, 404), json({ id: 'unknown-action', status: 'unknown' })]) {
        const f = await receiptFixture({ saved, fetcher: async () => reply });
        try {
            await f.click('結果を確認'); await f.settle();
            assert(f.receipt().request); assert.equal(button(f, '切り替え').disabled, true);
            assert.equal(f.requests.length, 1); assert.equal(f.requests[0].method, 'GET');
        } finally { await f.close(); }
    }
    const f = await receiptFixture({ saved, onRefresh: async () => { throw new Error('fixture status read failed'); }, fetcher: async () => json({ id: 'confirmed', status: 'succeeded' }) });
    try {
        await f.click('結果を確認'); await f.settle();
        assert.equal(f.receipt().request, null); assert.equal(f.receipt().action.status, 'succeeded');
        assert.match(f.container.textContent, /受付は確認済み/);
        assert.doesNotMatch(f.container.textContent, /失敗したとは判断できません/);
    } finally { await f.close(); }
});

test('mobile investigation details focus a dialog and closing restores the originating row and scroll without changing query scope', async () => {
    const f = await reactFixture('export { InvestigationDetails } from "./components/admin/investigation-view";');
    const scrolls = [];
    f.dom.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    f.dom.window.scrollTo = (x, y) => scrolls.push([x, y]);
    Object.defineProperty(f.dom.window, 'scrollY', { value: 430, configurable: true });
    f.dom.reconfigure({ url: 'http://127.0.0.1/admin?source=runs&guildId=111&outcome=E' });
    const original = f.dom.window.location.search;
    function Fixture() {
        const [open, setOpen] = f.React.useState(false);
        return f.React.createElement('div', null,
            f.React.createElement('button', { onClick: () => setOpen(true), id: 'origin-row' }, '詳細を開く'),
            open && f.React.createElement(f.exports.InvestigationDetails, { value: { id: 'r1', outcome: 'E', input: { url: 'https://fixture.invalid/', guildId: '111' } }, source: 'runs', recordId: 'r1', onClose: () => setOpen(false) }));
    }
    try {
        await f.render(f.React.createElement(Fixture));
        const origin = button(f, '詳細を開く'); origin.focus();
        await f.click('詳細を開く'); await f.settle();
        const dialog = f.container.querySelector('dialog'); assert(dialog?.open);
        assert.equal(f.dom.window.document.activeElement, dialog.querySelector('h2'));
        await f.click('一覧に戻る'); await settle(f, 30);
        assert.equal(f.container.querySelector('dialog'), null);
        assert.equal(f.dom.window.document.activeElement, origin);
        assert.deepEqual(scrolls.at(-1), [0, 430]);
        assert.equal(f.dom.window.location.search, original);
    } finally { await f.close(); }
});

test('changing inspection URL or source scope locks saved-response actions until an explicit snapshot choice; replay keeps the original identity', async () => {
    const f = await reactFixture('export { ManagementConsole } from "./components/admin/management-console"; export { updateAdminLocation } from "./lib/admin-workspace";');
    f.dom.reconfigure({ url: 'http://127.0.0.1/admin?section=investigation&tab=inspect&guildId=111&channelId=222' });
    f.set('sessionStorage', f.dom.window.sessionStorage);
    const posts = [];
    f.set('fetch', async (url, options = {}) => {
        if (String(url) === '/api/admin/catalog') return json({ providers: [] });
        if (String(url).endsWith('/health')) return json({ ok: true, time: '2026-10-13T00:00:00Z' });
        if (String(url).endsWith('/catalog')) return json({ actions: [] });
        if (options.method === 'POST') {
            const request = JSON.parse(options.body); posts.push(request);
            return json({ id: `fixture-${posts.length}`, type: request.type, input: request.input, status: 'succeeded', createdAt: '2026-10-13T00:00:00Z', result: { url: request.input.url, context: { guildId: request.input.guildId, channelId: request.input.channelId }, settings: {}, httpAttempts: [], steps: [{ payload: { content: 'saved fixture output' } }], outcome: 'preview_generated' } });
        }
        throw new Error(`Unexpected fixture request ${url}`);
    });
    try {
        await f.render(f.React.createElement(f.exports.ManagementConsole)); await f.settle();
        await f.fill(f.field('検証するURL'), 'https://fixture.invalid/A');
        await f.click('実際に取得して展開'); await f.settle();
        assert.equal(button(f, '保存応答を再解析').disabled, false);
        await f.fill(f.field('検証するURL'), 'https://fixture.invalid/B');
        assert.equal(button(f, '保存応答を再解析').disabled, true);
        assert.equal(button(f, 'この出力を指定先へ送る').disabled, true);
        assert.match(f.container.querySelector('[aria-label="保存済み出力の対象"]').textContent, /https:\/\/fixture.invalid\/A/);
        assert.match(f.container.textContent, /入力中のURL・対象と異なる/);
        await f.click('この保存済み出力を使う');
        await f.click('保存応答を再解析'); await f.settle();
        assert.equal(posts.at(-1).type, 'url.reparse'); assert.equal(posts.at(-1).input.url, 'https://fixture.invalid/A');
        assert.equal(posts.at(-1).input.guildId, '111'); assert.equal(posts.at(-1).input.channelId, '222');
        await f.act(async () => f.exports.updateAdminLocation({ guildId: '333' })); await f.settle();
        assert.equal(button(f, 'この出力を指定先へ送る').disabled, true, 'a changed source scope requires a new explicit snapshot choice');
        await f.click('この保存済み出力を使う');
        await f.click('この出力を指定先へ送る'); await f.settle();
        assert.match(f.container.textContent, /保存済み出力/);
        assert(posts.every(request => request.type !== 'message.send'), 'fixture never dispatches a send while reviewing the snapshot');
    } finally { await f.close(); }
});

test('mobile overview details keep the loading overview mounted and restore the explicit record button even when the browser had body focus', async () => {
    const f = await reactFixture('export { ManagementConsole } from "./components/admin/management-console";');
    f.dom.reconfigure({ url: 'http://127.0.0.1/admin?section=home&guildId=111' });
    f.dom.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    f.dom.window.scrollTo = () => {};
    f.set('sessionStorage', f.dom.window.sessionStorage);
    let resolveRuns, runLists = 0;
    const record = { id: 'run-1', outcome: 'E', input: { guildId: '111', url: 'https://fixture.invalid/record' } };
    f.set('fetch', async url => {
        const path = String(url);
        if (path === '/api/admin/catalog') return json({ providers: [] });
        if (path.endsWith('/health')) return json({ ok: true });
        if (path.endsWith('/catalog')) return json({ actions: [] });
        if (path.endsWith('/shards')) return json({ items: [] });
        if (path.includes('runs?problematic')) { runLists++; return new Promise(resolve => { resolveRuns = () => resolve(json({ items: [record] })); }); }
        if (path.endsWith('/runs/run-1')) return json(record);
        if (path.includes('/incidents?') || path.includes('/actions?')) return json({ items: [] });
        throw new Error(`unexpected fixture request ${path}`);
    });
    try {
        await f.render(f.React.createElement(f.exports.ManagementConsole)); await f.settle();
        assert.match(f.container.textContent, /取得中/); assert(resolveRuns);
        await f.act(async () => resolveRuns()); await f.settle();
        const opener = f.container.querySelector('[data-record-layout="compact"] button[data-record-detail="run-1"]'); assert(opener);
        assert.equal(f.dom.window.document.activeElement, f.dom.window.document.body);
        const original = f.dom.window.location.search;
        await click(f, opener); await f.settle();
        assert.equal(new URL(f.dom.window.location.href).searchParams.get('section'), 'home');
        assert.equal(f.dom.window.document.activeElement, f.container.querySelector('dialog h2'));
        await f.click('一覧に戻る'); await settle(f, 30);
        assert.equal(f.dom.window.document.activeElement, opener);
        assert.equal(runLists, 1, 'selected-only navigation does not reload or replace the source list');
        assert.equal(f.dom.window.location.search, original);
    } finally { await f.close(); }
});

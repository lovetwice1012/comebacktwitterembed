'use strict';
// S24-2: actual product React; local server fixtures separate commit from later reads.
const test = require('node:test'), assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const { template } = require('../../src/automation/catalog');
const tick = (f, ms = 25) => f.act(async () => new Promise(resolve => setTimeout(resolve, ms)));
const button = (f, label, within = f.container) => [...within.querySelectorAll('button')].find(node => node.textContent.trim() === label);
const click = (f, node) => { assert(node, 'real control exists'); assert(!node.matches(':disabled'), 'real control enabled'); return f.act(async () => node.click()); };
async function details(f, label) { const summary = [...f.container.querySelectorAll('summary')].find(node => node.textContent.startsWith(label)); assert(summary); if (!summary.parentElement.open) await f.act(async () => summary.click()); return summary.parentElement; }
const fail = () => { throw new Error('synthetic read failure'); };
const profile = { plan: { name: '支援者', priority: 1 }, slots: { used: 1, max: 20, available: 19 }, usage: { entries: [] } };

for (const operation of ['monitor-delete', 'destination-delete']) test(`S24-2 ${operation} stays deleted after the follow-up read fails`, async () => {
    const f = await reactFixture('export { MonitorManager } from "./components/automation/monitor-manager";');
    try {
        f.set('confirm', () => true); let removed = false, writes = 0;
        const monitor = { id: '31', revision: 1, kind: 'auto', name: 'Owned monitor', scope: 'private', providerId: 'github', source: 'https://github.com/synthetic', enabled: true, destinationId: 'destination', destinationType: 'dm' };
        const destination = { id: 'destination', revision: 1, name: 'Owned destination', kind: 'dm', scope: 'private', enabled: true };
        const api = async (route, method) => {
            if (method === 'DELETE') { writes++; removed = true; return { deleted: true }; }
            if (route === 'providers') return { auto: [{ id: 'github' }], price: [], autoRegistration: { eligible: true } };
            if (route === 'entitlements') return profile;
            if (route.startsWith('monitors/auto?')) { if (removed && operation === 'monitor-delete') return fail(); return { items: [monitor], nextCursor: null }; }
            return { items: [] };
        };
        await f.render(f.React.createElement(f.exports.MonitorManager, { api, scope: 'private', canEdit: true, destinations: [destination], rules: [], refresh: async () => fail() })); await tick(f);
        const parent = operation === 'monitor-delete' ? f.container.querySelector('.monitor-card') : await details(f, '通知先を管理');
        await click(f, button(f, '削除', parent)); assert.equal(writes, 1); assert(removed); assert(f.container.textContent.includes('削除済み'));
        assert.equal(button(f, '削除', operation === 'monitor-delete' ? f.container.querySelector('.monitor-list') : parent), undefined);
        assert.equal(writes, 1);
    } finally { await f.close(); }
});

for (const action of ['cancel', 'retry', 'reschedule']) test(`S24-2 history ${action} consumes the old CAS until canonical detail reload`, async () => {
    const f = await reactFixture('export { DeliveryHistory } from "./components/automation/delivery-history";');
    try {
        f.set('confirm', () => true); let unread = false;
        let row = { id: 'job', version: 'version-1', state: action === 'retry' ? 'failed' : 'pending', title: 'Owned delivery', dueAtMs: Date.now() + 60000, providerId: 'github', sentSteps: 0, trace: [], scope: 'private', preview: 'saved preview', event: {} };
        const writes = [];
        const api = async (route, method, body) => {
            if (method === 'PATCH') { writes.push(structuredClone(body)); assert.equal(body.expectedVersion, row.version); row = { ...row, version: `version-${writes.length + 1}`, state: body.action === 'cancel' ? 'cancelled' : 'pending', dueAtMs: body.dueAtMs || row.dueAtMs }; unread = true; return { state: row.state, dueAtMs: row.dueAtMs }; }
            if (route === 'jobs/job') { if (unread) return fail(); return structuredClone(row); }
            return { items: [structuredClone(row)], nextCursor: null };
        };
        await f.render(f.React.createElement(f.exports.DeliveryHistory, { api, canEdit: true })); await f.settle(); await click(f, f.container.querySelector('[data-job-id="job"]'));
        if (action === 'reschedule') await f.fill(f.container.querySelector('input[type=datetime-local]'), '2027-01-01T10:00');
        await f.click(action === 'cancel' ? '配信を取り消す' : action === 'retry' ? '送信を再試行' : '配信を予約し直す');
        assert.equal(writes.length, 1); assert(f.container.textContent.includes('変更は保存済み'));
        const obsolete = button(f, '配信を取り消す'); if (obsolete) { assert(obsolete.matches(':disabled')); await f.act(async () => obsolete.click()); }
        assert.equal(writes.length, 1);
        unread = false; await f.click('配信の詳細を更新');
        if (action !== 'cancel') { await f.click('配信を取り消す'); assert.equal(writes[1].expectedVersion, 'version-2'); } else assert.equal(button(f, '配信を取り消す'), undefined);
    } finally { await f.close(); }
});

async function dictionaryFixture(operation, readFailure = 'detail', missingIdentity = false) {
    const f = await reactFixture('export { DictionaryManager } from "./components/automation/dictionary-manager";');
    f.set('confirm', () => true); let unread = false, revision = 2, entries = ['original']; const writes = [];
    const page = id => ({ id, name: `Dictionary ${id}`, scope: 'private', revision, currentRevision: revision, total: entries.length, offset: 0, nextOffset: null, mode: 'contains', normalization: { form: 'NFKC', caseFold: true, spaces: 'preserve' }, source: '', license: '', records: entries.map((entry, index) => ({ index, entry })) });
    const api = async (route, method, body) => {
        if (route.endsWith('/versions')) return { items: [{ revision: 1, entryCount: 1, createdAtMs: 1 }], nextRevision: null };
        if (route === 'dictionary-preview') return { metadata: { name: 'Imported dictionary' }, entryCount: 1, duplicateCount: 0, conflictCount: 0, sample: ['imported'] };
        if (method === 'POST' && route.endsWith('/patch') && body.preview) return { conflictCount: 0, duplicateCount: 0, conflicts: [], diff: {} };
        if (method === 'POST' && (route.endsWith('/patch') || route.endsWith('/restore') || route === 'dictionaries') || method === 'PATCH') {
            writes.push({ route, body: structuredClone(body) }); if (route !== 'dictionaries') assert.equal(body.expectedRevision, revision);
            revision++; entries = operation === 'patch' ? [...entries, 'committed term'] : ['committed contents']; unread = true;
            return missingIdentity ? {} : { id: operation === 'create' ? 'B' : 'A', revision };
        }
        if (route.startsWith('dictionaries/')) { if (unread && readFailure === 'detail') return fail(); return page(route.split('/')[1].split('?')[0]); }
        assert.fail(route);
    };
    await f.render(f.React.createElement(f.exports.DictionaryManager, { api, dictionaries: [{ id: 'A', name: 'Dictionary A', revision: 2, scope: 'private' }], scope: 'private', canEdit: true, refresh: async () => { if (unread && readFailure === 'parent') return fail(); } }));
    await click(f, f.container.querySelector('[data-dictionary-id="A"]'));
    return Object.assign(f, { writes, recover: () => { unread = false; }, revision: () => revision });
}
for (const operation of ['patch', 'replace', 'restore', 'create']) for (const readFailure of ['detail', 'parent']) test(`S24-2 dictionary ${operation} survives committed ${readFailure} read failure without repeating writes`, async () => {
    const f = await dictionaryFixture(operation, readFailure);
    try {
        if (operation === 'patch') { await f.click('語を追加'); await f.fill(f.field('語'), 'new term'); await f.click('語の変更を追加'); await f.click('差分・競合を確認'); await f.click('新しい版として保存'); }
        else if (operation === 'restore') { await f.click('版の履歴'); await f.click('この内容を復元'); }
        else { await details(f, '辞書を取り込む'); await f.fill(f.container.querySelector('[aria-label="取り込む語または辞書データ"]'), 'imported'); await f.click('取り込み内容を確認'); await f.click(operation === 'replace' ? '選択中の辞書に保存' : '別の辞書として保存'); }
        assert.equal(f.writes.length, 1); assert.equal(f.revision(), 3); assert(f.container.textContent.includes('保存済み'));
        if (readFailure === 'detail') { assert(f.container.querySelector('[aria-label="保存済みの辞書の再取得"]')); const old = button(f, 'この内容を復元') || button(f, '新しい版として保存') || button(f, '別の辞書として保存'); if (old) assert(old.matches(':disabled')); }
        f.recover(); if (button(f, '保存済みの辞書を読み込む')) await f.click('保存済みの辞書を読み込む');
        assert.equal(f.writes.length, 1);
        if (operation !== 'create') { await f.click('語を追加'); await f.fill(f.field('語'), 'next term'); await f.click('語の変更を追加'); await f.click('差分・競合を確認'); await f.click('新しい版として保存'); assert.equal(f.writes[1].body.expectedRevision, 3); }
    } finally { await f.close(); }
});

test('S24-2 dictionary creation without a returned ID requires a list reload and never replays the POST', async () => {
    const f = await dictionaryFixture('create', 'parent', true);
    try {
        await details(f, '辞書を取り込む'); await f.fill(f.container.querySelector('[aria-label="取り込む語または辞書データ"]'), 'imported'); await f.click('取り込み内容を確認'); await f.click('別の辞書として保存');
        assert.equal(f.writes.length, 1); assert(button(f, '別の辞書として保存').matches(':disabled')); f.recover(); await f.click('保存済みの辞書を読み込む'); assert.equal(f.writes.length, 1); assert.equal(f.container.querySelector('[aria-label="取り込む語または辞書データ"]').value, '');
    } finally { await f.close(); }
});

const pack = (id = 'package', changes = {}) => ({ id, title: 'Saved package', description: '', kind: 'workflow', category: 'general', version: 1, latest_version: 1, status: 'active', packageStatus: 'active', visibility: 'public', packageVisibility: 'public', owner_user_id: 'owner', mine: true, feedback: {}, bundle: { schemaVersion: 1, kind: 'workflow', license: 'MIT', workflow: template('all', 'now', 'normal'), dictionaries: {} }, ...changes });
async function marketplaceFixture(operation) {
    const f = await reactFixture('export { MarketplaceManager } from "./components/automation/marketplace-manager";');
    let unread = false, installedVersion = 1, created = 0, packageStatus = 'active', moderationRevision = 1, resolved = false; const writes = [], opened = [];
    const api = async (route, method = 'GET', body) => {
        if (route === 'starter') return null;
        if (route.startsWith('marketplace?')) { if (unread && ['withdraw', 'create-missing-id'].includes(operation)) return fail(); return { items: [pack('package', { status: packageStatus, packageStatus })], nextCursor: null, canModerate: ['reports', 'moderation'].includes(operation) }; }
        if (route === 'workflows/source/export') return pack().bundle;
        if (route.endsWith('/open')) { if (unread && ['create', 'feedback', 'fork'].includes(operation)) return fail(); return pack(route.split('/')[1], { feedback: { favorite: { enabled: writes.some(row => row.route.endsWith('/feedback')) } } }); }
        if (route === 'review' && method === 'GET') { if (unread) return fail(); return { reports: resolved ? [] : [{ id: 'report', subject_id: 'package', value: { reason: 'Owned report' } }] }; }
        if (route === 'moderation' && method === 'GET') { if (unread) return fail(); return { useStarter: true, dictionaryId: null, dictionaryRevision: null, revision: moderationRevision }; }
        if (route.startsWith('installations?')) return { items: [{ workflowId: 'installed', packageId: 'package', name: 'Installed workflow', version: installedVersion, availableVersion: 3, scope: 'private' }], nextCursor: null };
        if (route.endsWith('/update-preview')) return { token: `preview-${installedVersion}`, fromVersion: installedVersion, toVersion: 3, localChanges: false, dictionaryDiffs: [] };
        if (method !== 'GET') { writes.push({ route, body: structuredClone(body) }); unread = true;
            if (route === 'marketplace') { created++; return operation === 'create-missing-id' ? {} : { id: 'created', version: 1, status: 'draft' }; }
            if (route.endsWith('/update')) { installedVersion = 3; return { version: 3, workflowId: 'installed', activated: false }; }
            if (route.endsWith('/install') || route.endsWith('/editing-import')) return { workflow: { id: 'installed' } };
            if (route.endsWith('/feedback')) return { ok: true };
            if (route.endsWith('/fork')) return { id: 'forked' };
            if (route.endsWith('/status')) { packageStatus = body.status; return { status: body.status }; }
            if (route === 'reports/report') { resolved = true; return { resolved: true }; }
            if (route === 'moderation') { assert.equal(body.expectedRevision, moderationRevision); moderationRevision++; return { revision: moderationRevision }; }
            assert.fail(route);
        }
        assert.fail(route);
    };
    await f.render(f.React.createElement(f.exports.MarketplaceManager, { api, scope: 'private', canEdit: true, rules: [{ id: 'source', name: 'Source workflow' }], dictionaries: [], refresh: async () => { if (unread) return fail(); }, openRule: async id => { opened.push(id); } })); await tick(f);
    return Object.assign(f, { writes, opened, recover: () => { unread = false; }, created: () => created });
}
for (const operation of ['create', 'install', 'update', 'feedback', 'import']) test(`S24-2 marketplace ${operation} retains its committed identity or consumes its token before read failure`, async () => {
    const f = await marketplaceFixture(operation);
    try {
        if (operation === 'create') { await details(f, '自分のルール・辞書を共有'); await f.fill(f.field('対象'), 'source'); await f.fill(f.field('名前'), 'New package'); await f.click('下書きを保存'); }
        else if (operation === 'update') { await details(f, '導入したルール・辞書'); await f.click('一覧を読み込む'); await f.click('更新する版を選ぶ'); await f.click('更新差分を確認'); await f.click('下書きを更新'); }
        else { await click(f, f.container.querySelector('[data-package-id="package"]')); await f.click(operation === 'install' ? '下書きに追加' : operation === 'feedback' ? 'お気に入りに追加' : '編集用に取り込む'); }
        assert.equal(f.writes.length, 1); assert(f.container.querySelector('[aria-label="保存後の表示の再取得"]'));
        const obsolete = button(f, operation === 'create' ? '下書きを保存' : operation === 'update' ? '下書きを更新' : operation === 'install' ? '下書きに追加' : operation === 'feedback' ? 'お気に入りを解除' : '編集用に取り込む'); if (obsolete) assert(obsolete.matches(':disabled'));
        if (operation === 'update') { assert.equal(button(f, '下書きを更新'), undefined); assert(f.container.textContent.includes('導入した版 3')); }
        f.recover(); await f.click('保存後の表示を更新'); assert.equal(f.writes.length, 1);
        if (operation === 'create') { assert.equal(f.created(), 1); assert(f.container.textContent.includes('Saved package')); }
        if (operation === 'install' || operation === 'import') assert.deepEqual(f.opened, ['installed']);
        if (operation === 'import') assert.deepEqual(f.writes[0], { route: 'marketplace/package/editing-import', body: { version: 1, scope: 'private' } });
    } finally { await f.close(); }
});


test('S24-2 marketplace create without a returned identity blocks repeat creation until its list is read', async () => {
    const f = await marketplaceFixture('create-missing-id');
    try {
        await details(f, '自分のルール・辞書を共有'); await f.fill(f.field('対象'), 'source'); await f.fill(f.field('名前'), 'New package'); await f.click('下書きを保存');
        assert.equal(f.created(), 1); assert(button(f, '下書きを保存').matches(':disabled')); assert(f.container.querySelector('[aria-label="保存後の表示の再取得"]'));
        f.recover(); await f.click('保存後の表示を更新'); assert.equal(f.created(), 1); assert.equal(f.field('名前').value, '');
    } finally { await f.close(); }
});
test('S24-2 a committed package fork resumes its returned identity after a failed detail read', async () => {
    const f = await marketplaceFixture('fork');
    try {
        await click(f, f.container.querySelector('[data-package-id="package"]')); await f.click('自分用にコピー'); assert.equal(f.writes.length, 1);
        assert(button(f, '自分用にコピー').matches(':disabled')); f.recover(); await f.click('保存後の表示を更新'); assert.equal(f.writes.length, 1);
    } finally { await f.close(); }
});
test('S24-2 withdrawing a package removes the obsolete status action before a failed list refresh', async () => {
    const f = await marketplaceFixture('withdraw');
    try {
        f.set('confirm', () => true); await click(f, f.container.querySelector('[data-package-id="package"]')); await f.click('公開を停止');
        assert.equal(f.writes.length, 1); assert.equal(button(f, '公開を停止'), undefined); assert(f.container.textContent.includes('公開を停止しました。'));
    } finally { await f.close(); }
});
test('S24-2 resolving a report consumes its row before the review list read fails', async () => {
    const f = await marketplaceFixture('reports');
    try {
        await details(f, '通報・共通辞書'); await f.click('通報を確認'); await f.click('対応済みにする');
        assert.equal(f.writes.length, 1); assert.equal(button(f, '対応済みにする'), undefined); f.recover(); await f.click('保存後の表示を更新'); assert.equal(f.writes.length, 1);
    } finally { await f.close(); }
});
test('S24-2 moderation changes require canonical revision refresh before another save', async () => {
    const f = await marketplaceFixture('moderation');
    try {
        await details(f, '通報・共通辞書'); await f.click('共通辞書の設定'); await f.click('辞書設定を保存');
        assert.equal(f.writes.length, 1); assert(button(f, '辞書設定を保存').matches(':disabled'));
        f.recover(); await f.click('保存後の表示を更新'); await f.click('辞書設定を保存'); assert.equal(f.writes[1].body.expectedRevision, 2);
    } finally { await f.close(); }
});


test('S24-2 a delayed history commit cannot replace a newer filter or reopen its closed detail', async () => {
    const f = await reactFixture('export { DeliveryHistory } from "./components/automation/delivery-history";');
    try {
        f.set('confirm', () => true); let finish;
        const rows = [{ id: 'A', version: 'A1', state: 'pending', title: 'A pending', dueAtMs: 1, providerId: 'github', sentSteps: 0, trace: [], scope: 'private', preview: 'A' }, { id: 'B', version: 'B1', state: 'failed', title: 'B failed', dueAtMs: 1, providerId: 'github', sentSteps: 0, trace: [], scope: 'private', preview: 'B' }];
        const api = async (route, method) => {
            if (method === 'PATCH') return new Promise(resolve => { finish = () => resolve({ state: 'cancelled', dueAtMs: 1 }); });
            if (route === 'jobs/A') return rows[0];
            return { items: route.includes('state=failed') ? [rows[1]] : [rows[0]], nextCursor: null };
        };
        await f.render(f.React.createElement(f.exports.DeliveryHistory, { api, canEdit: true })); await f.settle(); await click(f, f.container.querySelector('[data-job-id="A"]')); await f.click('配信を取り消す');
        await f.click('配信一覧に戻る'); await f.fill(f.container.querySelector('[aria-label="配信状態で絞り込み"]'), 'failed'); await f.settle();
        await f.act(async () => finish()); await f.settle(); assert(f.container.querySelector('[data-job-id="B"]')); assert.equal(f.container.querySelector('[data-job-id="A"]'), null); assert.equal(f.container.querySelector('pre'), null);
    } finally { await f.close(); }
});


test('S24-2 a committed install returning to an inactive view keeps recovery pending without background reads or duplicate creation', async () => {
    const f = await reactFixture('export { MarketplaceManager } from "./components/automation/marketplace-manager";');
    try {
        let finish, refreshes = 0, writes = 0;
        const api = async (route, method) => {
            if (route === 'starter') return null;
            if (route.startsWith('marketplace?')) return { items: [pack()], nextCursor: null };
            if (route.endsWith('/open')) return pack();
            if (route.endsWith('/install')) { writes++; return new Promise(resolve => { finish = () => resolve({ workflow: { id: 'committed-install' } }); }); }
            assert.fail(route);
        };
        const props = { api, scope: 'private', canEdit: true, rules: [], dictionaries: [], refresh: async () => { refreshes++; }, openRule: async () => {} };
        await f.render(f.React.createElement(f.exports.MarketplaceManager, props)); await tick(f); await click(f, f.container.querySelector('[data-package-id="package"]')); await f.click('下書きに追加');
        await f.render(f.React.createElement(f.exports.MarketplaceManager, { ...props, active: false })); await f.act(async () => finish()); assert.equal(refreshes, 0);
        await f.render(f.React.createElement(f.exports.MarketplaceManager, { ...props, active: true })); await tick(f); assert(button(f, '下書きに追加').matches(':disabled'));
        await f.click('保存後の表示を更新'); assert.equal(writes, 1); assert.equal(refreshes, 1);
    } finally { await f.close(); }
});

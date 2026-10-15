'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

const tick = f => f.act(async () => new Promise(resolve => setTimeout(resolve, 20)));
const field = (f, name) => [...f.container.querySelectorAll('form.monitor-registration label')].find(label => label.firstChild?.textContent.trim() === name)?.querySelector('input,select');
const row = (kind = 'auto', changes = {}) => ({ id: kind === 'auto' ? '101' : '202', kind, scope: 'private', name: kind === 'auto' ? '投稿通知' : '価格通知', revision: 1,
    providerId: kind === 'auto' ? 'github' : 'steam', source: kind === 'auto' ? 'https://github.com/octocat' : 'https://store.steampowered.com/app/730',
    locale: 'ja', enabled: true, destinationId: 'dm-one', workflowId: '', intervalMinutes: 30, mode: 'change', maxPriceAmount: null, minDiscountPercent: null, ...changes });
async function fixture({ initial = row(), respond } = {}) {
    const f = await reactFixture('export { MonitorManager } from "./components/automation/monitor-manager"; export { AutomationDialog } from "./components/automation/automation-dialog";');
    f.calls = []; f.current = initial;
    f.set('confirm', () => true);
    const api = async (route, method = 'GET', body) => {
        f.calls.push({ route, method, body });
        const custom = respond && await respond(route, method, body, f); if (custom !== undefined) return custom;
        if (route === 'providers') return { auto: [{ id: 'github' }, { id: 'twitch' }], price: [{ id: 'steam' }, { id: 'amazon' }], autoRegistration: { eligible: true } };
        if (route === 'entitlements') return { plan: { name: '無料', priority: 0, dayLimit: 24, minuteLimit: 5 }, slots: { used: 1, max: 5, available: 4 }, usage: { entries: [] } };
        if (route.startsWith('monitors/') && method === 'GET') return { items: route.startsWith(`monitors/${f.current.kind}?`) ? [{ ...f.current }] : [], nextCursor: null };
        if (route.endsWith('/preview')) return { providerId: body.providerId, source: body.source.trim(), intervalMinutes: 30 };
        if (/^monitors\/(auto|price)$/.test(route) && method === 'POST') {
            f.current = row(route.split('/')[1], { ...body, id: '303', revision: 1, workflowId: '' });
            return { id: '303', revision: 1 };
        }
        if (route.startsWith('monitors/') && method === 'PATCH') {
            assert.equal(body.expectedRevision, f.current.revision);
            f.current = { ...f.current, ...body, workflowId: f.current.workflowId, revision: f.current.revision + 1 };
            return { id: f.current.id, revision: f.current.revision };
        }
        if (route.startsWith('workflows/') && route.endsWith('/attach')) {
            if (body.expectedRevision !== f.current.revision || body.expectedWorkflowId !== (f.current.workflowId || null)) throw Object.assign(new Error('PRIVATE_ASSIGNMENT_CONFLICT'), { code: 'REVISION_CONFLICT', status: 409 });
            const selected = route.split('/')[1]; if (selected !== f.current.workflowId) f.current.revision++;
            f.current.workflowId = selected; return { attached: true, revision: f.current.revision };
        }
        if (route.startsWith('monitors/') && method === 'POST' && body.action === 'detach') {
            if (body.expectedRevision !== f.current.revision || body.expectedWorkflowId !== (f.current.workflowId || null)) throw Object.assign(new Error('PRIVATE_ASSIGNMENT_CONFLICT'), { code: 'REVISION_CONFLICT', status: 409 });
            if (f.current.workflowId) f.current.revision++;
            f.current.workflowId = ''; return { detached: true, revision: f.current.revision };
        }
        if (route === 'channels') return { items: [{ id: 'owned-channel', name: '通知先', canCreateWebhook: true }] };
        throw new Error(`Unexpected fixture request ${route}`);
    };
    await f.render(f.React.createElement(f.exports.MonitorManager, { api, scope: 'private', guildId: '111111111111111111', canEdit: true,
        destinations: [{ id: 'dm-one', name: '個人DM', kind: 'dm', enabled: true, scope: 'private' }, { id: 'channel-two', name: '投稿チャンネル', kind: 'webhook', enabled: true, scope: 'private' }],
        rules: [{ id: 'rule-a', name: '現在のルール', scope: 'private', enabled: true }, { id: 'rule-b', name: '別のルール', scope: 'private', enabled: true }], refresh: async () => {} }));
    await tick(f);
    if (initial.kind === 'price') { await f.click('価格通知'); await tick(f); }
    f.writes = () => f.calls.filter(call => call.method !== 'GET' && !call.route.endsWith('/preview'));
    f.open = () => f.click('設定を変更');
    f.form = () => f.container.querySelector('form.monitor-registration');
    return f;
}

for (const kind of ['auto', 'price']) test(`${kind} label-only editing saves once with metadata-only CAS and no workflow or preview operations`, async () => {
    const f = await fixture({ initial: row(kind, { workflowId: 'rule-a' }) });
    try {
        await f.open(); assert.equal(f.form().querySelector('.monitor-steps'), null);
        assert(field(f, kind === 'auto' ? '対象のURL・ID' : '商品URL')); assert(field(f, '通知先')); assert(field(f, '詳細ルール'));
        await f.fill(field(f, '名前（省略可）'), '表示名だけの変更'); await f.click('変更を保存');
        assert.deepEqual(f.writes().map(call => [call.route, call.method, call.body]), [[`monitors/${kind}/${f.current.id}`, 'PATCH', { name: '表示名だけの変更', expectedRevision: 1 }]]);
        assert.equal(f.calls.filter(call => call.route.endsWith('/preview')).length, 0);
        assert.equal(f.container.querySelector('dialog[open]'), null); assert.equal(f.current.workflowId, 'rule-a');
    } finally { await f.close(); }
});

test('destination changes show one review, retain all inputs on Back, and do not reattach an unchanged rule', async () => {
    const f = await fixture({ initial: row('auto', { workflowId: 'rule-a' }) });
    try {
        await f.open(); await f.fill(field(f, '通知先'), 'channel-two'); await f.fill(field(f, '名前（省略可）'), '保持する表示名');
        await f.click('変更内容を確認'); assert.equal(f.writes().length, 0);
        const review = f.container.querySelector('[aria-label="保存する通知の確認"]'); assert(review); assert.match(review.textContent, /投稿チャンネル.*チャンネルを見られる人/);
        assert.match(review.textContent, /変更前の未送信通知を取り消します/);
        await f.click('戻る'); assert.equal(field(f, '通知先').value, 'channel-two'); assert.equal(field(f, '名前（省略可）').value, '保持する表示名');
        await f.click('変更内容を確認'); await f.click('この内容で変更');
        assert.equal(f.writes().length, 1); assert.equal(f.writes()[0].body.destinationId, 'channel-two'); assert.equal(f.current.workflowId, 'rule-a');
        assert.equal(f.calls.filter(call => call.route.endsWith('/preview')).length, 0);
    } finally { await f.close(); }
});

test('price source condition and destination edits share the same form and are saved only after their review', async () => {
    const f = await fixture({ initial: row('price') });
    try {
        await f.open(); await f.fill(field(f, '商品URL'), 'https://store.steampowered.com/app/570');
        await f.fill(field(f, '通知する条件'), 'threshold'); await f.fill(field(f, '指定価格以下（商品表示通貨）'), '1200');
        await f.fill(field(f, '割引率以上（%）'), '25'); await f.fill(field(f, '通知先'), 'channel-two');
        await f.click('変更内容を確認'); assert.equal(f.writes().length, 0);
        assert.match(f.container.querySelector('[aria-label="保存する通知の確認"]').textContent, /570.*1200以下.*25%/);
        await f.click('この内容で変更'); assert.equal(f.writes().length, 1);
        assert.equal(f.writes()[0].body.source, 'https://store.steampowered.com/app/570'); assert.equal(f.writes()[0].body.maxPriceAmount, '1200');
        assert.equal(f.writes()[0].body.minDiscountPercent, '25'); assert.equal(f.writes()[0].body.destinationId, 'channel-two');
    } finally { await f.close(); }
});

test('workflow-only changes require review but do not write the unchanged target; repeated saves do not attach twice', async () => {
    const f = await fixture();
    try {
        await f.open(); await f.fill(field(f, '詳細ルール'), 'rule-b'); await f.click('変更内容を確認');
        assert.equal(f.writes().length, 0); await f.click('この内容で変更');
        assert.deepEqual(f.writes().map(call => [call.route, call.method]), [['workflows/rule-b/attach', 'POST']]);
        assert.deepEqual(f.writes()[0].body, { targetKind: 'auto', targetId: '101', expectedRevision: 1, expectedWorkflowId: null });
        assert.equal(f.current.workflowId, 'rule-b'); assert.equal(f.current.revision, 2);
    } finally { await f.close(); }
});

test('a failed rule attachment keeps the saved target and retries only the failed attachment', async () => {
    let attempts = 0;
    const f = await fixture({ respond: (route) => { if (route === 'workflows/rule-b/attach' && ++attempts === 1) throw new Error('fixture attachment failure'); } });
    try {
        await f.open(); await f.fill(field(f, '通知先'), 'channel-two'); await f.fill(field(f, '詳細ルール'), 'rule-b');
        await f.click('変更内容を確認'); await f.click('この内容で変更');
        assert.match(f.container.querySelector('dialog[open]').textContent, /通知は保存済みです/); assert.equal(f.current.revision, 2);
        await f.click('この内容で変更');
        assert.deepEqual(f.writes().map(call => call.route), ['monitors/auto/101', 'workflows/rule-b/attach', 'workflows/rule-b/attach']);
        assert.equal(f.current.destinationId, 'channel-two'); assert.equal(f.current.workflowId, 'rule-b'); assert.equal(f.current.revision, 3);
        assert.deepEqual(f.writes().at(-1).body, { targetKind: 'auto', targetId: '101', expectedRevision: 2, expectedWorkflowId: null });
    } finally { await f.close(); }
});

test('creating with a failed optional rule keeps the new monitor ID and retries its guarded attachment without duplicate creation', async () => {
    let attempts = 0;
    const f = await fixture({ respond: route => { if (route === 'workflows/rule-b/attach' && ++attempts === 1) throw new Error('fixture attachment failure'); } });
    try {
        await f.click('通知を追加'); await f.fill(field(f, '対象のURL・ID'), 'https://github.com/new-user');
        await f.fill(field(f, '名前（省略可）'), '新しい通知'); await f.click('対象を確認');
        await f.fill(field(f, '詳細ルール'), 'rule-b'); await f.click('通知内容を確認'); await f.click('通知を登録');
        assert.equal(f.current.id, '303'); assert.match(f.container.querySelector('dialog[open]').textContent, /通知は保存済みです/);
        assert.equal(field(f, '対象のURL・ID').value, 'https://github.com/new-user');
        await f.click('変更内容を確認'); await f.click('この内容で変更');
        assert.deepEqual(f.writes().map(call => call.route), ['monitors/auto', 'workflows/rule-b/attach', 'workflows/rule-b/attach']);
        assert.equal(f.writes().at(-1).body.targetId, '303'); assert.equal(f.writes().at(-1).body.expectedRevision, 1);
        assert.equal(f.current.workflowId, 'rule-b'); assert.equal(f.current.revision, 2);
    } finally { await f.close(); }
});

test('a new-registration duplicate response keeps the editable draft instead of requiring a nonexistent target revision', async () => {
    let rejectDuplicate = true;
    const f = await fixture({ respond: (route, method) => {
        if (route === 'monitors/auto' && method === 'POST' && rejectDuplicate) { rejectDuplicate = false; throw Object.assign(new Error('同じ対象の通知が登録済みです。'), { code: 'MONITOR_EXISTS', status: 409 }); }
    } });
    try {
        await f.click('通知を追加'); await f.fill(field(f, '対象のURL・ID'), 'https://github.com/new-user'); await f.click('対象を確認');
        await f.click('通知内容を確認'); await f.click('通知を登録');
        assert.equal(f.container.querySelector('[aria-label="通知設定の再確認"]'), null);
        assert.match(f.container.querySelector('dialog[open]').textContent, /登録済みです/);
        await f.click('戻る'); await f.click('戻る'); assert.equal(field(f, '対象のURL・ID').value, 'https://github.com/new-user');
        await f.fill(field(f, '対象のURL・ID'), 'https://github.com/other-user'); await f.click('対象を確認'); await f.click('通知内容を確認'); await f.click('通知を登録');
        assert.equal(f.current.source, 'https://github.com/other-user'); assert.equal(f.container.querySelector('dialog[open]'), null);
    } finally { await f.close(); }
});

test('a concurrent workflow assignment blocks guarded retries until explicit reload and review of the retained choice', async () => {
    let conflict = true;
    const f = await fixture({ respond: (route, _method, _body, state) => {
        if (route === 'workflows/rule-b/attach' && conflict) { conflict = false; state.current = { ...state.current, revision: 2, workflowId: 'rule-c' }; throw Object.assign(new Error('PRIVATE_WORKFLOW_CHANGED'), { code: 'REVISION_CONFLICT', status: 409 }); }
    } });
    try {
        await f.open(); await f.fill(field(f, '詳細ルール'), 'rule-b'); await f.click('変更内容を確認'); await f.click('この内容で変更');
        assert(f.container.querySelector('[aria-label="通知設定の再確認"]')); assert(!f.container.textContent.includes('PRIVATE_WORKFLOW_CHANGED'));
        await f.click('この内容で変更'); assert.equal(f.writes().length, 1); assert.equal(f.current.workflowId, 'rule-c');
        await f.click('最新設定を取得して入力を引き継ぐ'); assert.equal(field(f, '詳細ルール').value, 'rule-b');
        await f.click('変更内容を確認'); assert.equal(f.writes().length, 1); await f.click('この内容で変更');
        assert.deepEqual(f.writes().at(-1).body, { targetKind: 'auto', targetId: '101', expectedRevision: 2, expectedWorkflowId: 'rule-c' });
        assert.equal(f.current.workflowId, 'rule-b'); assert.equal(f.current.revision, 3);
    } finally { await f.close(); }
});

test('detach guards both target revision and the previously selected workflow even for legacy same-revision changes', async () => {
    let conflict = true;
    const f = await fixture({ initial: row('auto', { workflowId: 'rule-a' }), respond: (_route, method, body, state) => {
        if (method === 'POST' && body.action === 'detach' && conflict) { conflict = false; state.current.workflowId = 'rule-c'; throw Object.assign(new Error('PRIVATE_ASSIGNMENT_CHANGED'), { status: 409 }); }
    } });
    try {
        await f.open(); await f.fill(field(f, '詳細ルール'), ''); await f.click('変更内容を確認'); await f.click('この内容で変更');
        assert.deepEqual(f.writes()[0].body, { action: 'detach', expectedRevision: 1, expectedWorkflowId: 'rule-a' });
        assert(f.container.querySelector('[aria-label="通知設定の再確認"]')); await f.click('この内容で変更'); assert.equal(f.writes().length, 1);
        await f.click('最新設定を取得して入力を引き継ぐ'); await f.click('変更内容を確認'); await f.click('この内容で変更');
        assert.deepEqual(f.writes().at(-1).body, { action: 'detach', expectedRevision: 1, expectedWorkflowId: 'rule-c' });
        assert.equal(f.current.workflowId, ''); assert.equal(f.current.revision, 2);
    } finally { await f.close(); }
});

test('a successful guarded assignment retains its returned revision if subsequent display refresh fails', async () => {
    let failRefresh = true;
    const f = await fixture({ respond: (route, method, _body, state) => {
        if (route.startsWith('monitors/') && method === 'GET' && state.current.workflowId === 'rule-b' && failRefresh) { failRefresh = false; throw new Error('一覧を取得できませんでした。'); }
    } });
    try {
        await f.open(); await f.fill(field(f, '詳細ルール'), 'rule-b'); await f.click('変更内容を確認'); await f.click('この内容で変更');
        assert.equal(f.current.revision, 2); assert.equal(f.container.querySelector('dialog[open]'), null); assert(f.container.textContent.includes('通知は保存済みです'));
        await f.open(); await f.fill(field(f, '名前（省略可）'), '保存後の名前変更'); await f.click('変更を保存');
        assert.deepEqual(f.writes().at(-1).body, { name: '保存後の名前変更', expectedRevision: 2 });
        assert.equal(f.writes().filter(call => call.route.endsWith('/attach')).length, 1); assert.equal(f.current.workflowId, 'rule-b');
    } finally { await f.close(); }
});

test('stale edits preserve their inputs and explicitly rebase changed fields while retaining other current server settings', async () => {
    let stale = true;
    const f = await fixture({ respond: (_route, method, _body, state) => {
        if (method === 'PATCH' && stale) { stale = false; state.current = { ...state.current, revision: 2, destinationId: 'channel-two', workflowId: 'rule-a', locale: 'en-US' }; throw Object.assign(new Error('別の操作で更新されています。'), { code: 'REVISION_CONFLICT', status: 409 }); }
    } });
    try {
        await f.open(); await f.fill(field(f, '名前（省略可）'), '自分が変えた名前'); await f.click('変更を保存');
        assert.equal(field(f, '名前（省略可）').value, '自分が変えた名前'); assert(f.container.querySelector('[aria-label="通知設定の再確認"]'));
        await f.click('変更を保存'); assert.equal(f.writes().length, 1);
        await f.click('最新設定を取得して入力を引き継ぐ');
        assert.equal(field(f, '名前（省略可）').value, '自分が変えた名前'); assert.equal(field(f, '通知先').value, 'channel-two'); assert.equal(field(f, '詳細ルール').value, 'rule-a');
        assert.equal(field(f, '通知の言語').value, 'en-US'); await f.click('変更を保存');
        assert.deepEqual(f.writes().at(-1).body, { name: '自分が変えた名前', expectedRevision: 2 });
        assert.equal(f.current.destinationId, 'channel-two'); assert.equal(f.current.workflowId, 'rule-a'); assert.equal(f.current.locale, 'en-US');
    } finally { await f.close(); }
});

test('closing and switching notification tabs retains an edit without saving or reopening it on the wrong kind', async () => {
    const f = await fixture();
    try {
        await f.open(); await f.fill(field(f, '名前（省略可）'), '編集中の名前'); await f.fill(field(f, '通知先'), 'channel-two'); await f.click('キャンセル');
        await f.click('価格通知'); await tick(f); await f.click('通知の入力を再開');
        assert.equal(field(f, '名前（省略可）').value, '編集中の名前'); assert.equal(field(f, '通知先').value, 'channel-two');
        assert.equal(f.container.querySelector('[role="tab"][aria-selected="true"]').textContent, '新着通知'); assert.equal(f.writes().length, 0);
        assert.equal(f.dom.window.localStorage.length, 0); assert.equal(f.dom.window.sessionStorage.length, 0);
    } finally { await f.close(); }
});

test('the unified timing editor serializes its atomic save and keeps other unsaved changes for review with the new revision', async () => {
    let release;
    const f = await fixture({ initial: row('auto', { canAllocateCadence: true, slotCost: 1, baseIntervalMinutes: 30, cadenceUpdatedAtMs: null }),
        respond: (route, method, body, state) => {
            if (route === 'monitors/auto/101' && method === 'POST' && body.action === 'cadence') return new Promise(resolve => { release = () => {
                state.current = { ...state.current, revision: 2, slotCost: body.slotCost, intervalMinutes: 10, cadenceUpdatedAtMs: 55 };
                resolve({ slotCost: body.slotCost, intervalMs: 600000 });
            }; });
        } });
    try {
        assert.equal(f.container.querySelector('[aria-label="通知タイミングの設定"]'), null);
        await f.open(); await f.fill(field(f, '名前（省略可）'), '枠配分中も保持する名前'); await f.fill(field(f, '通知先'), 'channel-two');
        const timing = f.container.querySelector('[aria-label="通知タイミングの設定"]'); assert(timing); assert(timing.closest('dialog[open]'));
        await f.click('確認間隔・使用枠'); await f.fill(f.field('この通知で使う枠数'), '3'); await f.click('枠配分の変更を確認'); await f.click('この枠配分で保存');
        assert(f.form().closest('fieldset').disabled); assert(f.container.querySelector('dialog[open] header button').disabled);
        await f.submit(); assert.equal(f.writes().length, 1);
        await f.act(async () => release());
        assert.equal(field(f, '名前（省略可）').value, '枠配分中も保持する名前'); assert.equal(field(f, '通知先').value, 'channel-two');
        await f.click('変更内容を確認'); await f.click('この内容で変更');
        const saved = f.writes().at(-1); assert.equal(saved.method, 'PATCH'); assert.equal(saved.body.expectedRevision, 2);
        assert.equal(saved.body.name, '枠配分中も保持する名前'); assert.equal(saved.body.destinationId, 'channel-two'); assert.equal(f.current.slotCost, 3);
    } finally { if (release) release(); await f.close(); }
});

test('dialogs trap focus in the topmost dialog and prevent lower dialog cancellation until its nested destination closes', async () => {
    const f = await reactFixture('export { AutomationDialog } from "./components/automation/automation-dialog";');
    let outer = 0, inner = 0;
    try {
        const render = nested => f.React.createElement(f.React.Fragment, null,
            f.React.createElement(f.exports.AutomationDialog, { title: '通知設定', onCancel: () => outer++ }, f.React.createElement('input', { 'aria-label': '対象' })),
            nested && f.React.createElement(f.exports.AutomationDialog, { title: '通知先', onCancel: () => inner++ }, f.React.createElement('input', { 'aria-label': '通知先名' }), f.React.createElement('button', null, '保存')));
        await f.render(render(true)); let dialogs = [...f.container.querySelectorAll('dialog[open]')];
        await f.act(async () => dialogs[0].querySelector('header button').click()); assert.equal(outer, 0);
        const save = [...dialogs[1].querySelectorAll('button')].at(-1); save.focus();
        await f.act(async () => save.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
        assert.equal(f.dom.window.document.activeElement, dialogs[1].querySelector('header button'));
        await f.act(async () => dialogs[0].dispatchEvent(new f.dom.window.Event('cancel', { cancelable: true }))); assert.equal(outer, 0);
        await f.act(async () => dialogs[1].dispatchEvent(new f.dom.window.Event('cancel', { cancelable: true }))); assert.equal(inner, 1);
        await f.render(render(false)); dialogs = [...f.container.querySelectorAll('dialog[open]')];
        assert.equal(f.dom.window.document.body.style.overflow, 'hidden');
        await f.act(async () => dialogs[0].dispatchEvent(new f.dom.window.Event('cancel', { cancelable: true }))); assert.equal(outer, 1);
    } finally { await f.close(); }
});


test('S24-2 a committed resume updates the displayed state and retry revision before a failed list refresh', async () => {
    let failRefresh = true;
    const f = await fixture({ initial: row('auto', { enabled: false }), respond: (route, method, _body, state) => {
        if (route.startsWith('monitors/') && method === 'GET' && state.current.enabled && failRefresh) { failRefresh = false; throw new Error('temporary list failure'); }
    } });
    try {
        await f.click('再開'); assert.equal(f.current.enabled, true); assert(f.container.textContent.includes('通知の変更は保存済みです')); assert([...f.container.querySelectorAll('button')].some(node => node.textContent === '停止'));
        await f.click('停止'); assert.equal(f.current.enabled, false); assert.deepEqual(f.writes().map(call => call.body.expectedRevision), [1, 2]);
    } finally { await f.close(); }
});


for (const mode of ['dm', 'channel']) test(`N2 a retained ${mode} confirmation cannot leak into another monitor and same-monitor resume keeps it`, async () => {
    const rows = [row('auto', { id: 'A', name: 'Monitor A', destinationId: 'dm-one' }), row('auto', { id: 'B', name: 'Monitor B', destinationId: 'channel-two', source: 'https://github.com/torvalds' })];
    const f = await fixture({ respond: (route, method, _body, state) => {
        if (route.startsWith('monitors/auto?') && method === 'GET') return { items: rows, nextCursor: null };
        if (route === 'destinations' && method === 'POST') assert.fail('No destination should be implicitly created for monitor B');
        if (route === 'monitors/auto/B' && method === 'PATCH') { state.current = { ...rows[1], revision: 2 }; return { id: 'B', revision: 2 }; }
    } });
    try {
        const openCard = async index => f.act(async () => [...f.container.querySelectorAll('.monitor-card')][index].querySelector('.monitor-card-actions button').click());
        await openCard(0); await f.fill(field(f, '通知先の種類'), mode);
        if (mode === 'channel') { await tick(f); await f.fill(field(f, 'チャンネル'), 'owned-channel'); }
        await f.click('変更内容を確認'); assert(f.container.querySelector('[aria-label="保存する通知の確認"]').textContent.includes('Monitor A'));
        await f.click('キャンセル'); await f.click('通知の入力を再開'); assert(f.container.querySelector('[aria-label="保存する通知の確認"]'));
        await f.click('キャンセル'); await openCard(1); assert.equal(f.container.querySelector('[aria-label="保存する通知の確認"]'), null);
        assert.equal(field(f, '対象のURL・ID').value, rows[1].source); assert.equal(field(f, '通知先の種類').value, 'existing'); assert.equal(field(f, '通知先').value, 'channel-two');
        await f.fill(field(f, '名前（省略可）'), 'B rename'); await f.click('変更を保存');
        assert.deepEqual(f.writes().at(-1).body, { name: 'B rename', expectedRevision: 1 });
    } finally { await f.close(); }
});

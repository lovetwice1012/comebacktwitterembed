'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const { scopeFor, assertAccess, createService } = require('../../src/automation/service');
const { assertMonitorAccess } = require('../../src/automation/monitors');
const owner = '222222222222222222', other = '333333333333333333', guild = '111111111111111111';
const personal = { id: 'private-destination', name: '個人DM', enabled: true, kind: 'dm', scope: 'private' };
const shared = { id: 'shared-destination', name: '共有チャンネル', enabled: true, kind: 'webhook', scope: 'guild' };
const rules = [{ id: 'personal-rule', name: '個人ルール', scope: 'private' }, { id: 'shared-rule', name: '共有ルール', scope: 'guild' }];
const draft = changes => ({ kind: 'auto', name: '', source: 'https://github.com/example', providerId: 'github', locale: 'ja', enabled: true, scope: 'private', destinationId: personal.id, workflowId: 'personal-rule', ...changes });
async function fixture({ canShare = true, guildId = guild, initial = draft(), responses = {}, destinations = [personal, shared] } = {}) {
    const f = await reactFixture('export { MonitorRegistration } from "./components/automation/monitor-registration";');
    f.saved = []; f.calls = []; f.error = ''; f.xRequests = []; f.xTransfers = [];
    const api = async (path, method = 'GET', body) => {
        f.calls.push({ path, method, body });
        if (responses[path]) return responses[path];
        if (path.endsWith('/preview')) return { providerId: 'github', source: 'https://github.com/example', intervalMinutes: 30 };
        if (path === 'channels') return { items: [{ id: '987654321012345678', name: '通知先', canCreateWebhook: true }] };
        if (path.startsWith('workflows/')) return { id: path.slice('workflows/'.length), enabled: true, activeRevision: 1 };
        throw new Error('Unexpected fixture API');
    };
    function App() {
        const [value, setValue] = f.React.useState(initial), [busy, setBusy] = f.React.useState(false); f.value = value; f.setBusy = setBusy;
        return f.React.createElement(f.exports.MonitorRegistration, { api, monitor: value, kind: 'auto', scope: 'private', guildId, canShare,
            destinations, rules, catalog: { autoRegistration: { eligible: true }, auto: [{ id: 'github' }] }, busy,
            onChange: setValue, onSourceChange: source => setValue(v => ({ ...v, source })), onSave: async item => { f.saved.push(item); if (f.failSave) throw new Error('synthetic monitor failure'); },
            run: async work => { try { await work(); } catch (error) { f.error = error.message; } }, refresh: async () => {}, onXRegistration: (handle, transfer) => { f.xRequests.push(handle); f.xTransfers.push(transfer); } });
    }
    await f.render(f.React.createElement(App)); await f.settle();
    f.submit = async () => { await f.act(async () => f.container.querySelector('form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }))); await f.settle(); };
    return f;
}

test('new notifications stay private until an authorized user explicitly selects shared editing', async () => {
    const f = await fixture();
    try {
        assert.equal(f.value.scope, 'private'); await f.submit();
        const scope = f.field('通知を編集できる人'); assert(scope); assert.equal(scope.value, 'private');
        await f.fill(scope, 'guild');
        assert.equal(f.value.scope, 'guild'); assert.equal(f.value.destinationId, ''); assert.equal(f.value.workflowId, '');
        assert.match(f.container.textContent, /選べる通知先やルールが変わりました/);
        assert(![...f.field('通知先').options].some(option => option.value === 'new:dm'));
        const destination = [...f.container.querySelectorAll('label')].find(label => label.firstChild?.textContent.trim() === '通知先')?.querySelector('select'); assert(destination);
        assert(![...destination.options].some(option => option.value === personal.id));
        await f.fill(destination, shared.id); await f.submit();
        const review = f.container.querySelector('[aria-label="保存する通知の確認"]'); assert(review);
        assert.match(review.textContent, /編集できる人サーバーの編集権限を持つ人/);
        await f.submit(); assert.equal(f.saved.length, 1, f.error || 'save not called'); assert.equal(f.saved[0].scope, 'guild'); assert.equal(f.saved[0].destinationId, shared.id);
    } finally { await f.close(); }
});

test('registration clearly identifies each next action and moves focus without stealing it on unrelated work', async () => {
    const f = await fixture({ initial: draft({ workflowId: '' }) });
    try {
        assert.match(f.container.textContent, /通知する対象/);
        assert([...f.container.querySelectorAll('button')].some(button => button.textContent.trim() === '通知先を選ぶ'));
        await f.submit();
        const heading = f.container.querySelector('[data-registration-step="destination"]'); assert(heading);
        assert.equal(heading.textContent, '通知先と通知内容'); assert.equal(f.dom.window.document.activeElement, heading);
        const scope = f.field('通知を編集できる人'); scope.focus();
        await f.act(async () => f.setBusy(true)); await f.act(async () => f.setBusy(false));
        assert.equal(f.dom.window.document.activeElement, scope);
        assert([...f.container.querySelectorAll('button')].some(button => button.textContent.trim() === '通知内容を確認'));
        await f.submit(); const review = f.container.querySelector('[aria-label="保存する通知の確認"]'); assert(review);
        assert.equal(f.dom.window.document.activeElement, review);
        assert([...f.container.querySelectorAll('button')].some(button => button.textContent.trim() === '通知を登録'));
        assert.match(review.textContent, /初回確認より前の投稿は通知しません/);
        assert.equal((review.textContent.match(/通常の通知/g) || []).length, 1);
    } finally { await f.close(); }
});

test('an X profile goes directly to X setup instead of suggesting a destination step', async () => {
    const f = await fixture({ initial: draft({ source: 'https://x.com/example_user', workflowId: '' }) });
    try {
        assert([...f.container.querySelectorAll('button')].some(button => button.textContent.trim() === 'Xの設定へ'));
        await f.submit(); assert.deepEqual(f.xRequests, ['example_user']);
        assert.equal(f.calls.filter(call => call.path.endsWith('/preview')).length, 0);
    } finally { await f.close(); }
});

test('switching an explicit shared draft to X requires consent and never transfers a shared destination or rule', async () => {
    const f = await fixture();
    try {
        await f.submit(); await f.fill(f.field('通知を編集できる人'), 'guild'); await f.fill(f.field('通知先'), shared.id);
        await f.fill(f.field('詳細ルール'), 'shared-rule');
        assert.equal(f.value.scope, 'guild'); assert.equal(f.value.destinationId, shared.id); assert.equal(f.value.workflowId, 'shared-rule');
        await f.click('戻る'); await f.fill(f.field('対象のURL・ID'), 'https://x.com/example_user');
        const before = f.calls.length; let asked = 0;
        f.set('confirm', () => { asked++; return false; }); await f.submit();
        assert.equal(asked, 1); assert.deepEqual(f.xRequests, []); assert.equal(f.value.source, 'https://x.com/example_user');
        assert.equal(f.value.scope, 'guild'); assert.equal(f.value.destinationId, shared.id); assert.equal(f.value.workflowId, 'shared-rule');
        assert.equal(f.saved.length, 0); assert.equal(f.calls.length, before);
        f.set('confirm', () => { asked++; return true; }); await f.submit();
        assert.equal(asked, 2); assert.deepEqual(f.xRequests, ['example_user']);
        assert.deepEqual(f.xTransfers, [{ name: '', destinationId: undefined, workflowId: undefined }]);
        assert.equal(f.saved.length, 0); assert.equal(f.calls.length, before);
    } finally { await f.close(); }
});

test('a personal X transition keeps compatible personal destination and rule without asking for a scope change', async () => {
    const f = await fixture({ initial: draft({ source: 'https://x.com/example_user' }) });
    try {
        let asked = 0; f.set('confirm', () => { asked++; return false; }); await f.submit();
        assert.equal(asked, 0); assert.deepEqual(f.xRequests, ['example_user']);
        assert.deepEqual(f.xTransfers, [{ name: '', destinationId: personal.id, workflowId: 'personal-rule' }]);
        assert.equal(f.value.destinationId, personal.id); assert.equal(f.saved.length, 0);
    } finally { await f.close(); }
    const stale = await fixture({ initial: draft({ scope: 'guild', source: 'https://x.com/example_user', destinationId: personal.id, workflowId: '' }) });
    try {
        stale.set('confirm', () => true); await stale.submit();
        assert.deepEqual(stale.xTransfers, [{ name: '', destinationId: personal.id, workflowId: undefined }]);
    } finally { await stale.close(); }
});

test('a personal draft with a shared destination asks before switching to X and keeps a personal rule', async () => {
    const f = await fixture({ initial: draft({ source: 'https://x.com/example_user', destinationId: shared.id }) });
    try {
        f.set('confirm', () => false); await f.submit(); assert.deepEqual(f.xRequests, []);
        assert.equal(f.value.destinationId, shared.id); assert.equal(f.value.workflowId, 'personal-rule');
        f.set('confirm', () => true); await f.submit();
        assert.deepEqual(f.xTransfers, [{ name: '', destinationId: undefined, workflowId: 'personal-rule' }]);
        assert.equal(f.calls.length, 0); assert.equal(f.saved.length, 0);
    } finally { await f.close(); }
});

test('a not-yet-created channel choice is not silently lost when switching to X', async () => {
    const f = await fixture({ initial: draft({ destinationId: '', workflowId: '' }) });
    try {
        await f.submit(); await f.fill(f.field('通知先'), 'new:channel'); await f.settle();
        const channel = f.field('チャンネル'); assert(channel); await f.fill(channel, '987654321012345678');
        await f.click('戻る'); await f.fill(f.field('対象のURL・ID'), 'https://x.com/example_user');
        let asked = 0; f.set('confirm', () => { asked++; return false; }); await f.submit();
        assert.equal(asked, 1); assert.deepEqual(f.xRequests, []); assert.equal(f.value.source, 'https://x.com/example_user');
        await f.fill(f.field('対象のURL・ID'), 'https://github.com/example'); await f.submit(); await f.settle();
        assert.equal(f.field('チャンネル').value, '987654321012345678');
        await f.click('戻る'); await f.fill(f.field('対象のURL・ID'), 'https://x.com/example_user');
        assert.equal(f.calls.filter(call => call.path === 'destinations').length, 0);
        f.set('confirm', () => true); await f.submit();
        assert.equal(asked, 1);
        assert.deepEqual(f.xTransfers, [{ name: '', destinationId: undefined, workflowId: undefined }]);
        assert.equal(f.calls.filter(call => call.path === 'destinations').length, 0);
    } finally { await f.close(); }
});

test('a source-preview failure leaves the source and current step available for retry', async () => {
    const fail = Promise.reject(new Error('対象の確認に失敗しました')); fail.catch(() => {});
    const f = await fixture({ responses: { 'monitors/auto/preview': fail } });
    try {
        await f.submit(); assert.match(f.error, /対象の確認に失敗/);
        assert.equal(f.value.source, 'https://github.com/example');
        assert(!f.container.querySelector('[data-registration-step="destination"]'));
        assert([...f.container.querySelectorAll('button')].some(button => button.textContent.trim() === '通知先を選ぶ'));
    } finally { await f.close(); }
});

test('private is preserved by default and shared choices are unavailable without edit permission', async () => {
    const f = await fixture({ canShare: false });
    try {
        await f.submit(); assert.equal(Boolean(f.field('通知を編集できる人')), false);
        await f.submit(); await f.submit(); assert.equal(f.saved.length, 1); assert.equal(f.saved[0].scope, 'private');
    } finally { await f.close(); }
    const missingGuild = await fixture({ guildId: null, canShare: true });
    try { await missingGuild.submit(); assert.equal(Boolean(missingGuild.field('通知を編集できる人')), false); }
    finally { await missingGuild.close(); }
});

test('editing an existing notification does not offer changing its visibility', async () => {
    const f = await fixture({ initial: draft({ id: '12', revision: 1, name: '既存通知', scope: 'guild', destinationId: shared.id, workflowId: '' }) });
    try { assert.equal(Boolean(f.field('通知を編集できる人')), false); assert.equal(f.value.scope, 'guild'); }
    finally { await f.close(); }
});

test('a stale shared draft cannot proceed after edit permission is lost', async () => {
    const f = await fixture({ canShare: false, initial: draft({ scope: 'guild', destinationId: shared.id, workflowId: '' }) });
    try {
        await f.submit(); assert.equal(Boolean(f.field('通知を編集できる人')), false);
        await f.submit(); assert.match(f.error, /共有設定にはサーバーの編集権限が必要/);
        assert.equal(f.saved.length, 0); assert.equal(f.value.scope, 'guild');
    } finally { await f.close(); }
});

test('one destination control reuses an existing personal DM without creating another', async () => {
    const f = await fixture({ initial: draft({ destinationId: '', workflowId: '' }), destinations: [personal] });
    try {
        await f.submit(); const target = f.field('通知先'); assert(target);
        assert.equal(Boolean(f.field('通知先の種類')), false);
        assert.equal(target.value, personal.id);
        assert.equal([...target.options].find(option => option.value === personal.id).textContent, '個人DM');
        assert.equal([...target.options].filter(option => option.value === 'new:dm').length, 0);
        await f.submit(); assert.equal(f.calls.filter(call => call.path === 'destinations').length, 0);
        await f.submit(); assert.equal(f.saved.length, 1); assert.equal(f.saved[0].destinationId, personal.id);
        assert.equal(f.calls.filter(call => call.path === 'destinations').length, 0);
    } finally { await f.close(); }
});

test('new DM is created only after review and is not recreated after monitor save fails', async () => {
    const f = await fixture({ guildId: null, destinations: [], initial: draft({ destinationId: '', workflowId: '' }), responses: { destinations: { id: 'new-dm' } } });
    try {
        f.failSave = true; await f.submit(); assert.equal(f.field('通知先').value, 'new:dm');
        await f.submit(); assert(f.container.querySelector('[aria-label="保存する通知の確認"]'));
        assert.equal(f.calls.filter(call => call.path === 'destinations').length, 0);
        await f.submit(); assert.match(f.error, /synthetic monitor failure/); assert.equal(f.value.destinationId, 'new-dm');
        assert.equal(f.calls.filter(call => call.path === 'destinations').length, 1);
        f.failSave = false; await f.submit(); assert.equal(f.calls.filter(call => call.path === 'destinations').length, 1);
        assert.equal(f.saved.at(-1).destinationId, 'new-dm');
    } finally { await f.close(); }
});

test('switching to shared editing without a shared destination asks for a channel', async () => {
    const f = await fixture({ destinations: [personal] });
    try {
        await f.submit(); await f.fill(f.field('通知を編集できる人'), 'guild'); await f.settle();
        assert.equal(f.value.destinationId, ''); assert.equal(f.field('通知先').value, 'new:channel');
        assert(f.field('チャンネル')); assert.equal(f.calls.filter(call => call.method !== 'GET' && !call.path.endsWith('/preview')).length, 0);
    } finally { await f.close(); }
});

test('server permission checks still reject unauthorized shared edits and shared DMs', async () => {
    const editor = { userId: owner, guildId: guild, canView: true, canEdit: true };
    assert.equal(scopeFor(editor, 'guild').scope, 'guild');
    assert.throws(() => scopeFor({ ...editor, canEdit: false }, 'guild'), { code: 'FORBIDDEN' });
    const privateRow = { owner_user_id: owner, guild_id: guild, scope: 'private' };
    assert.throws(() => assertAccess({ ...editor, userId: other }, privateRow, false), { code: 'NOT_FOUND' });
    assert.throws(() => assertMonitorAccess({ ...editor, canEdit: false }, { user_id: owner, guild_id: guild, destination_type: 'webhook', scope: 'guild' }, true), { code: 'FORBIDDEN' });
    const service = createService({ withDatabaseTransaction: async () => { throw new Error('unexpected write'); } }, { rateLimiter: { consumeOperation: async () => {} } });
    await assert.rejects(service.saveDestination(editor, { name: 'DM', scope: 'guild', kind: 'dm' }), { code: 'PRIVATE_DM' });
});

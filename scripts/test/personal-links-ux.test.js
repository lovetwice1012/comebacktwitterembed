'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const entry = 'export { PersonalLinksWorkspace } from "./components/personal-links/personal-links-workspace";';
const owner = '222222222222222222', other = '333333333333333333';
const props = (viewerId = owner, locale = 'ja') => ({ viewerId, locale, displayName: 'Fixture' });
const readOnlyApi = async () => new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200 });

test('personal drafts restore after remount, retain every tab, survive locale changes and never cross owners', async () => {
    const f = await reactFixture(entry);
    try {
        f.set('fetch', readOnlyApi);
        const component = p => f.React.createElement(f.exports.PersonalLinksWorkspace, p);
        await f.render(component(props())); await f.settle();
        await f.fill(f.field('URL'), 'https://example.test/read'); await f.fill(f.field('メモ'), '入力途中のメモ');
        await f.click('見返す通知'); await f.fill(f.field('URL'), 'https://example.test/remind'); await f.fill(f.field('通知する日時'), '2026-10-23T18:30');
        await f.render(null); await f.render(component(props())); await f.settle();
        assert.equal(f.field('URL').value, 'https://example.test/remind'); assert.equal(f.field('通知する日時').value, '2026-10-23T18:30');
        await f.click('あとで見る'); assert.equal(f.field('URL').value, 'https://example.test/read'); assert.equal(f.field('メモ').value, '入力途中のメモ');
        await f.render(component(props(owner, 'en'))); assert.equal(f.field('Note').value, '入力途中のメモ');
        await f.render(component(props(other))); await f.settle(); assert.equal(f.field('URL').value, ''); assert.equal(f.field('メモ').value, '');
        await f.render(component(props())); await f.settle(); assert.equal(f.field('メモ').value, '入力途中のメモ');
    } finally { await f.close(); }
});

test('an uncertain reminder submission retains the same idempotency key after remount and clears only the saved draft on success', async () => {
    const f = await reactFixture(entry);
    try {
        const writes = []; let succeed = false;
        f.set('fetch', async (_url, options) => {
            if (options.method === 'GET') return readOnlyApi();
            writes.push(JSON.parse(options.body));
            return new Response(JSON.stringify(succeed ? {} : { error: '一時的に保存できませんでした。' }), { status: succeed ? 200 : 503 });
        });
        const component = () => f.React.createElement(f.exports.PersonalLinksWorkspace, props());
        await f.render(component()); await f.settle(); await f.fill(f.field('URL'), 'https://example.test/keep'); await f.fill(f.field('メモ'), '別タブに保持');
        await f.click('見返す通知'); await f.fill(f.field('URL'), 'https://example.test/reminder'); await f.fill(f.field('通知する日時'), '2026-10-23T18:30');
        await f.submit(); assert.equal(writes.length, 1); assert.match(writes[0].requestId, /^[0-9a-f-]{36}$/i);
        await f.render(null); await f.render(component()); await f.settle(); assert.equal(f.field('URL').value, 'https://example.test/reminder');
        succeed = true; await f.submit(); assert.equal(writes.length, 2); assert.equal(writes[1].requestId, writes[0].requestId);
        assert.equal(f.field('URL').value, ''); await f.click('あとで見る'); assert.equal(f.field('メモ').value, '別タブに保持');
    } finally { await f.close(); }
});

test('personal list is the mobile default and closing a form keeps its draft until explicit discard', async () => {
    const f = await reactFixture(entry);
    try {
        f.set('fetch', readOnlyApi); f.dom.window.confirm = () => false;
        await f.render(f.React.createElement(f.exports.PersonalLinksWorkspace, props())); await f.settle();
        const form = () => f.container.querySelector('form[aria-label="リンク・通知を登録"]');
        assert(form().classList.contains('hidden'));
        await f.click('リンクを追加'); assert(!form().classList.contains('hidden'));
        await f.fill(f.field('URL'), 'https://example.test/draft'); await f.fill(f.field('メモ'), '保存前');
        await f.click('一覧に戻る'); assert(form().classList.contains('hidden')); assert.equal(f.field('メモ').value, '保存前');
        await f.click('編集を続ける'); await f.click('入力を破棄'); assert.equal(f.field('メモ').value, '保存前');
        f.dom.window.confirm = () => true; await f.click('入力を破棄'); assert.equal(f.field('メモ').value, '');
        await f.act(async () => new Promise(resolve => setTimeout(resolve, 30)));
        assert.equal(f.dom.window.document.activeElement.textContent.trim(), 'リンクを追加');
        assert.equal(f.dom.window.sessionStorage.getItem(`cbte:personal:drafts:${owner}`), null);
    } finally { await f.close(); }
});

test('unavailable draft storage leaves input usable and the beforeunload guard protects dirty input', async () => {
    const f = await reactFixture(entry);
    try {
        f.set('fetch', readOnlyApi);
        for (const method of ['getItem', 'setItem', 'removeItem']) f.dom.window.Storage.prototype[method] = () => { throw new Error('fixture storage denied'); };
        await f.render(f.React.createElement(f.exports.PersonalLinksWorkspace, props())); await f.settle();
        assert(f.container.textContent.includes('下書きを保持できません')); assert(!f.container.textContent.includes('fixture storage denied'));
        await f.fill(f.field('URL'), 'https://example.test/dirty'); const event = new f.dom.window.Event('beforeunload', { cancelable: true });
        f.dom.window.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
        const tabs = [...f.container.querySelectorAll('[role="tab"]')]; tabs[0].focus();
        await f.act(async () => tabs[0].dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
        assert.equal(f.dom.window.document.activeElement.textContent.trim(), '見返す通知'); assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
        assert(f.container.querySelector('[role="tabpanel"]').getAttribute('aria-labelledby').endsWith('reminder'));
    } finally { await f.close(); }
});

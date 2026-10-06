'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { JSDOM } = require('jsdom');
const load = require('./helpers/load-dashboard.cjs');

test('admin interval form loads, saves five minutes, rejects short input and resets to defaults', async () => {
    const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://local.test/' });
    const previous = new Map();
    const set = (key, value) => { previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent']) set(key, dom.window[key]);
    set('IS_REACT_ACT_ENVIRONMENT', true);
    let stored = null; const writes = [];
    set('fetch', async (url, options = {}) => {
        const userId = options.method === 'PATCH' ? JSON.parse(options.body).userId : new URL(url, 'https://local.test').searchParams.get('userId');
        if (options.method === 'PATCH') { const body = JSON.parse(options.body); stored = body.intervalMinutes; writes.push(body); }
        return new Response(JSON.stringify({ userId, intervalMinutes: stored, providers: [{ providerId: 'youtube', defaultMinutes: 30, intervalMinutes: stored ?? 30 }] }));
    });
    const local = Module.createRequire(path.resolve(__dirname, '../../dashboard/package.json'));
    const React = local('react'), { createRoot } = local('react-dom/client');
    const { AutoWatchIntervalForm } = load('components/admin/auto-watch-interval-form.tsx');
    const container = dom.window.document.getElementById('root'), root = createRoot(container);
    const change = async (input, value) => React.act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    const button = label => [...container.querySelectorAll('button')].find(b => b.textContent === label);
    const click = async label => { assert(!button(label).disabled); await React.act(async () => button(label).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))); };
    try {
        await React.act(async () => root.render(React.createElement(AutoWatchIntervalForm)));
        await change(container.querySelector('input'), '796972193287503913'); await click('読み込む');
        assert.match(container.textContent, /現在の設定: 通常値/);
        await change(container.querySelector('input[type="number"]'), '4'); assert(button('保存').disabled);
        await change(container.querySelector('input[type="number"]'), '5'); await click('保存');
        assert.equal(stored, 5); assert.match(container.textContent, /現在の設定: 5分/);
        await click('通常値へ戻す'); assert.equal(stored, null);
        assert.deepEqual(writes.map(x => x.intervalMinutes), [5, null]);
        assert(writes.every(x => x.userId === '796972193287503913'));
        await change(container.querySelector('input'), '222222222222222222'); assert.equal(container.querySelector('input[type="number"]'), null);
    } finally {
        await React.act(async () => root.unmount()); dom.window.close();
        for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    }
});

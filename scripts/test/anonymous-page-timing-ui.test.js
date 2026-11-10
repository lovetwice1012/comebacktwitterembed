'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

async function fixture(enabled) {
    const f = await reactFixture('export { useAnonymousPageTiming } from "./components/automation/anonymous-page-timing";');
    if (enabled) f.dom.window.sessionStorage.setItem('cbte.pageTiming', '1');
    let time = 0, next = 0, visible = 'visible';
    const callbacks = new Map();
    Object.defineProperty(f.dom.window.performance, 'now', { configurable: true, value: () => time });
    Object.defineProperty(f.dom.window.document, 'visibilityState', { configurable: true, get: () => visible });
    f.dom.window.requestAnimationFrame = callback => { const id = ++next; callbacks.set(id, callback); return id; };
    f.dom.window.cancelAnimationFrame = id => { callbacks.delete(id); };
    f.clock = value => { time = value; };
    f.visibility = value => { visible = value; f.dom.window.document.dispatchEvent(new f.dom.window.Event('visibilitychange')); };
    f.frame = async () => f.act(async () => { const ready = [...callbacks.values()]; callbacks.clear(); for (const callback of ready) callback(time); });
    const View = ({ active, loading, failed }) => { f.exports.useAnonymousPageTiming('notifications', active, loading, failed); return f.React.createElement('div', null, loading ? 'loading' : 'shown'); };
    f.renderView = async props => f.render(f.React.createElement(View, props));
    return f;
}

test('diagnostics are opt-in and make no network or persistent sample writes', async () => {
    const f = await fixture(false);
    try {
        await f.renderView({ active: true, loading: true, failed: false }); f.clock(150); await f.renderView({ active: true, loading: false, failed: false });
        await f.frame(); await f.frame();
        assert.equal(f.dom.window.__cbtePageTimings, undefined);
        assert.equal(f.dom.window.sessionStorage.length, 0);
        assert.equal(f.container.textContent, 'shown');
    } finally { await f.close(); }
});

test('only completed visible renders record rounded duration and success or error', async () => {
    const f = await fixture(true);
    try {
        await f.renderView({ active: true, loading: true, failed: false }); f.clock(123);
        await f.renderView({ active: true, loading: false, failed: false }); await f.frame(); f.clock(137); await f.frame();
        assert.deepEqual(f.dom.window.__cbtePageTimings.snapshot(), [{ page: 'notifications', outcome: 'ready', durationMs: 140 }]);
        await f.renderView({ active: false, loading: true, failed: false }); f.clock(200);
        await f.renderView({ active: true, loading: true, failed: false }); f.clock(250);
        await f.renderView({ active: true, loading: false, failed: true }); await f.frame(); await f.frame();
        assert.deepEqual(f.dom.window.__cbtePageTimings.snapshot()[1], { page: 'notifications', outcome: 'error', durationMs: 50 });
        assert.equal(f.dom.window.sessionStorage.length, 1);
    } finally { await f.close(); }
});

test('turning off diagnostics before the final frame records no sample', async () => {
    const f = await fixture(true);
    try {
        await f.renderView({ active: true, loading: true, failed: false });
        await f.renderView({ active: true, loading: false, failed: false }); await f.frame();
        f.dom.window.sessionStorage.removeItem('cbte.pageTiming'); await f.frame();
        assert.equal(f.dom.window.__cbtePageTimings, undefined);
    } finally { await f.close(); }
});

test('hidden and disposed views are not recorded and the sample buffer is bounded', async () => {
    const f = await fixture(true);
    try {
        await f.renderView({ active: true, loading: true, failed: false }); f.visibility('hidden'); f.clock(30);
        await f.renderView({ active: true, loading: false, failed: false }); await f.frame(); await f.frame();
        assert.equal(f.dom.window.__cbtePageTimings, undefined);
        f.visibility('visible'); await f.renderView({ active: false, loading: true, failed: false });
        await f.renderView({ active: true, loading: true, failed: false }); f.clock(100);
        await f.renderView({ active: true, loading: false, failed: false }); await f.frame(); await f.frame();
        const buffer = f.dom.window.__cbtePageTimings;
        for (let n = 0; n < 100; n++) buffer.add({ page: 'plans', outcome: 'ready', durationMs: n * 10, userId: 'sensitive' });
        buffer.add({ page: 'private-url', outcome: 'ready', durationMs: 1 });
        const samples = buffer.snapshot(); assert.equal(samples.length, 64); assert(samples.every(item => Object.keys(item).sort().join(',') === 'durationMs,outcome,page'));
        assert(samples.every(item => item.page === 'plans')); buffer.clear(); assert.deepEqual(buffer.snapshot(), []);
    } finally { await f.close(); }
});

test('real plan and delivery views record their own ready and error outcomes without storing API data', async () => {
    for (const [component, page, fail] of [['SubscriptionManager', 'plans', false], ['DeliveryHistory', 'delivery_history', true]]) {
        const exports = component === 'SubscriptionManager' ? 'export { SubscriptionManager } from "./components/automation/subscription-manager";' : 'export { DeliveryHistory } from "./components/automation/delivery-history";';
        const f = await reactFixture(exports); const frames = new Map(); let sequence = 0;
        try {
            f.dom.window.sessionStorage.setItem('cbte.pageTiming', '1');
            f.dom.window.requestAnimationFrame = cb => { const id = ++sequence; frames.set(id, cb); return id; };
            f.dom.window.cancelAnimationFrame = id => frames.delete(id);
            const api = async route => { if (fail) throw new Error('private-user-id-and-message');
                if (route === 'options') return { configured: true, environment: 'sandbox', plans: [] };
                return { configured: true, environment: 'sandbox', subscription: null, pending: null }; };
            await f.render(f.React.createElement(f.exports[component], { api, active: true })); await f.settle();
            for (let i = 0; i < 2; i++) await f.act(async () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); });
            const samples = f.dom.window.__cbtePageTimings.snapshot();
            assert.equal(samples.length, 1); assert.equal(samples[0].page, page); assert.equal(samples[0].outcome, fail ? 'error' : 'ready');
            assert.doesNotMatch(JSON.stringify(samples), /private-user-id-and-message|https?:|\?/);
        } finally { await f.close(); }
    }
});

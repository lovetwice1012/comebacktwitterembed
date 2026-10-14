'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const state = changes => ({ requestedMode: 'batch', effectiveMode: 'batch', realtimeAllowed: false, planId: 'basic', planLabel: 'ベーシック',
    intervalMinutes: 60, configured: true, reasonCode: null, rollout: { mode: 'supporters', eligible: true }, ...changes });
async function fixture({ value = state(), respond, active = true, compact = false } = {}) {
    const f = await reactFixture('export { XProcessingSettings } from "./components/automation/x-processing-settings";');
    f.value = value; f.calls = [];
    f.api = async (route, method = 'GET', body) => {
        f.calls.push({ route, method, body }); assert.equal(route, 'x-processing-settings');
        const result = respond && await respond(route, method, body, f);
        if (result !== undefined) return result;
        if (method === 'GET') return f.value;
        assert.equal(method, 'PUT');
        f.value = { ...f.value, requestedMode: body.mode, effectiveMode: body.mode, configured: true };
        return f.value;
    };
    f.renderSettings = async (nextActive = active) => f.render(f.React.createElement(f.exports.XProcessingSettings, { api: f.api, active: nextActive, compact }));
    await f.renderSettings(); await f.settle();
    f.select = async mode => f.act(async () => f.container.querySelector(`input[value="${mode}"]`).click());
    f.radio = mode => f.container.querySelector(`input[value="${mode}"]`);
    f.saveButton = () => [...f.container.querySelectorAll('button')].find(node => node.textContent === '通知のタイミングを保存');
    return f;
}
const writes = f => f.calls.filter(call => call.method !== 'GET');

test('batch remains the default and a plan without explicit realtime eligibility cannot select it', async () => {
    const f = await fixture({ value: state({ planLabel: 'ベーシック＋', realtimeAllowed: false }) });
    try {
        assert.equal(f.radio('batch').checked, true); assert.equal(f.radio('realtime').disabled, true);
        assert.match(f.container.textContent, /60分ごと/); assert.match(f.container.textContent, /管理者が対象に設定したプラン/);
        await f.select('realtime'); assert.equal(f.radio('batch').checked, true); assert.equal(writes(f).length, 0);
        assert.equal(f.saveButton().disabled, true);
    } finally { await f.close(); }
});

test('eligible realtime is explicitly saved with CAS even when the batch interval is unset', async () => {
    const f = await fixture({ value: state({ realtimeAllowed: true, intervalMinutes: null, configured: false, reasonCode: 'X_MONITOR_NOT_CONFIGURED' }) });
    try {
        assert.equal(f.radio('realtime').disabled, false); await f.select('realtime');
        assert.equal(writes(f).length, 0); assert.equal(f.saveButton().disabled, false);
        assert.match(f.container.textContent, /現在の通知方法：プランの間隔/);
        await f.click('通知のタイミングを保存');
        assert.deepEqual(writes(f), [{ route: 'x-processing-settings', method: 'PUT', body: { mode: 'realtime', expectedMode: 'batch' } }]);
        assert.match(f.container.textContent, /現在の通知方法：リアルタイム/); assert.match(f.container.textContent, /通知のタイミングを保存しました/);
        assert.equal(f.saveButton().disabled, true);
    } finally { await f.close(); }
});

test('revoked realtime preference is shown separately from effective batch and owner can explicitly return to batch', async () => {
    const f = await fixture({ value: state({ requestedMode: 'realtime', effectiveMode: 'batch', realtimeAllowed: false, reasonCode: 'X_REALTIME_PLAN_REQUIRED' }) });
    try {
        assert.equal(f.radio('realtime').checked, true); assert.equal(f.radio('realtime').disabled, true);
        assert.match(f.container.textContent, /リアルタイムの選択は保存されています/); assert.match(f.container.textContent, /現在の通知方法：プランの間隔/);
        assert.equal(writes(f).length, 0); await f.select('batch'); await f.click('通知のタイミングを保存');
        assert.deepEqual(writes(f)[0].body, { mode: 'batch', expectedMode: 'realtime' });
    } finally { await f.close(); }
});

test('CAS conflict preserves selection and requires a successful reload before the next save', async () => {
    let conflict = true;
    const f = await fixture({ value: state({ realtimeAllowed: true }), respond: (_route, method) => {
        if (method === 'PUT' && conflict) { conflict = false; throw { code: 'X_PROCESSING_CONFLICT', status: 409, message: 'PRIVATE-CAS' }; }
    } });
    try {
        await f.select('realtime'); await f.click('通知のタイミングを保存');
        assert.equal(f.radio('realtime').checked, true); assert.equal(f.saveButton().disabled, true);
        assert.match(f.container.textContent, /別の画面で通知のタイミングが更新/); assert.equal(f.container.textContent.includes('PRIVATE-CAS'), false);
        await f.click('最新の設定を確認'); assert.equal(f.radio('realtime').checked, true); assert.equal(f.saveButton().disabled, false);
        await f.click('通知のタイミングを保存'); assert.equal(writes(f).length, 2);
    } finally { await f.close(); }
});

test('plan revocation between selection and save returns safe feedback without losing the requested choice', async () => {
    const f = await fixture({ value: state({ realtimeAllowed: true }), respond: (_route, method, _body, current) => {
        if (method === 'PUT') { current.value = state({ realtimeAllowed: false }); throw { code: 'X_REALTIME_PLAN_REQUIRED', status: 403, message: 'PRIVATE-PLAN' }; }
    } });
    try {
        await f.select('realtime'); await f.click('通知のタイミングを保存');
        assert.equal(f.radio('realtime').checked, true); assert.equal(f.container.textContent.includes('PRIVATE-PLAN'), false);
        await f.click('最新の設定を確認'); assert.equal(f.radio('realtime').disabled, true); assert.equal(f.saveButton().disabled, true);
    } finally { await f.close(); }
});

test('missing API or malformed realtime flags affect only timing settings and offer a bounded manual retry', async () => {
    for (const value of [{}, state({ realtimeAllowed: 'true' }), state({ effectiveMode: 'realtime', realtimeAllowed: false })]) {
        const f = await fixture({ value });
        try { assert.match(f.container.textContent, /監視の登録・編集は引き続き利用できます/); assert.equal(f.container.querySelector('form'), null); assert.equal(writes(f).length, 0); }
        finally { await f.close(); }
    }
    const f = await fixture({ respond: () => { throw new Error('PRIVATE-API'); } });
    try { assert.equal(f.calls.length, 1); assert.equal(f.container.textContent.includes('PRIVATE-API'), false); await f.click('最新の設定を確認'); assert.equal(f.calls.length, 2); }
    finally { await f.close(); }
});

test('inactive settings do zero IO and rollout withdrawal still permits explicitly selecting batch for cleanup', async () => {
    const f = await fixture({ active: false, value: state({ requestedMode: 'realtime', effectiveMode: 'realtime', realtimeAllowed: true, rollout: { mode: 'supporters', eligible: false } }) });
    try {
        assert.equal(f.calls.length, 0); await f.renderSettings(true); await f.settle();
        assert.match(f.container.textContent, /支援者向けの受付対象になると利用できます/);
        assert.equal(f.radio('realtime').disabled, true); await f.select('batch'); await f.click('通知のタイミングを保存');
        assert.deepEqual(writes(f)[0].body, { mode: 'batch', expectedMode: 'realtime' });
        await f.renderSettings(false); const count = f.calls.length; await f.click('最新の設定を確認'); assert.equal(f.calls.length, count);
    } finally { await f.close(); }
});

test('returning during an in-flight save refreshes its committed CAS state and never issues an automatic second write', async () => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const f = await fixture({ value: state({ realtimeAllowed: true }), respond: async (_route, method, _body, current) => {
        if (method === 'PUT') { await pending; current.value = state({ requestedMode: 'realtime', effectiveMode: 'realtime', realtimeAllowed: true }); return current.value; }
    } });
    try {
        await f.select('realtime'); await f.click('通知のタイミングを保存');
        await f.renderSettings(false); await f.renderSettings(true);
        await f.act(async () => finish()); await f.settle();
        assert.equal(writes(f).length, 1); assert.equal(f.calls.filter(call => call.method === 'GET').length, 2);
        assert.match(f.container.textContent, /現在の通知方法：リアルタイム/); assert.equal(f.saveButton().disabled, true);
    } finally { await f.close(); }
});

test('compact timing shows the effective mode and directs changes to connection settings without another editing form', async () => {
    for (const [value, expected] of [[state(), /60分ごとにまとめて通知/], [state({ configured: false, intervalMinutes: null }), /間隔の設定待ち/], [state({ requestedMode: 'realtime', effectiveMode: 'realtime', realtimeAllowed: true }), /リアルタイム/]]) {
        const f = await fixture({ compact: true, value });
        try { assert.match(f.container.textContent, expected); assert.equal(f.container.querySelector('form'), null); assert.equal(f.container.querySelector('input'), null); assert(f.container.querySelector('a[href="/dashboard/automation/x#x-processing"]')); assert.equal(writes(f).length, 0); }
        finally { await f.close(); }
    }
});

test('compact timing keeps a revoked realtime preference separate from its current plan interval', async () => {
    const f = await fixture({ compact: true, value: state({ requestedMode: 'realtime', effectiveMode: 'batch', realtimeAllowed: false, reasonCode: 'X_REALTIME_PLAN_REQUIRED' }) });
    try { assert.match(f.container.textContent, /60分ごとにまとめて通知/); assert.match(f.container.textContent, /リアルタイムの希望は保存済み.*現在は契約プランの間隔を適用/); assert.equal(writes(f).length, 0); }
    finally { await f.close(); }
});

test('compact timing labels a retained value while refreshing and after a failed read instead of presenting it as current', async () => {
    let reads = 0, finish;
    const f = await fixture({ compact: true, respond: async (_route, method) => {
        if (method === 'GET' && ++reads === 2) return new Promise(resolve => { finish = resolve; });
        if (method === 'GET' && reads === 3) throw new Error('PRIVATE_NEW_INTERVAL');
    } });
    try {
        await f.renderSettings(false); await f.renderSettings(true); assert.match(f.container.textContent, /最新の設定を確認中.*前回確認/); assert.match(f.container.textContent, /前回確認時：60分ごと/);
        await f.act(async () => finish(state({ intervalMinutes: 5 }))); assert.match(f.container.textContent, /5分ごとにまとめて通知/); assert.doesNotMatch(f.container.textContent, /前回確認時/);
        await f.renderSettings(false); await f.renderSettings(true); assert.match(f.container.querySelector('[role="alert"]').textContent, /最新の設定を確認できません.*前回確認した内容/);
        assert.match(f.container.textContent, /前回確認時：5分ごと/); assert(!f.container.textContent.includes('PRIVATE_NEW_INTERVAL')); assert.equal(writes(f).length, 0);
    } finally { await f.close(); }
});

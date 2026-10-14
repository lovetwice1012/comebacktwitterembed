'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const processing = changes => ({ requestedMode: 'batch', explicitMode: 'batch', modeSource: 'monitor', effectiveMode: 'batch', realtimeSource: null,
    realtimeEligibilitySource: 'slots', slotCost: 1, effectiveSlotCost: 1, realtimeSlotCost: 5, canEnableRealtime: true, additionalSlotsNeeded: 4,
    configured: true, intervalMinutes: 5, reasonCode: null, ...changes });
const monitor = changes => ({ id: 'timing-monitor', accountId: null, accountHandle: 'sample_author', name: '作者の投稿', enabled: true, state: 'ready', poolKind: 'free',
    subscriptionState: 'bound', revision: 3, notificationSettings: { destinationId: 'owner-dm' }, quality: { planId: 'free', priority: 0, minuteLimit: 5, dayLimit: 24, intervalMinutes: 5 }, processing: processing(), ...changes });
async function fixture({ row = monitor(), respond, active = true, reload } = {}) {
    const f = await reactFixture('export { XMonitorTimingEditor } from "./components/automation/x-monitor-timing-editor"; export { parseXMonitor,parseXMonitorProcessing } from "./components/automation/x-monitor-view";');
    f.calls = []; f.saved = []; f.busyStates = []; f.row = row; f.reloads = 0; f.nextRow = null;
    const api = async (route, method, body) => {
        f.calls.push({ route, method, body }); const override = respond && await respond(route, method, body, f); if (override !== undefined) return override;
        const mode = body.processingMode, cost = mode === 'batch' ? 1 : body.expectedRealtimeSlotCost;
        const saved = { ...f.row, revision: f.row.revision + 1, processing: processing({ requestedMode: mode, explicitMode: mode, effectiveMode: mode, slotCost: cost,
            effectiveSlotCost: cost, realtimeSlotCost: f.row.processing.realtimeSlotCost, realtimeSource: mode === 'realtime' ? f.row.processing.realtimeEligibilitySource || 'slots' : null }) };
        f.row = saved; return saved;
    };
    let replace;
    function Parent({ shown }) {
        const [row, setRow] = f.React.useState(f.row), [busy, setBusy] = f.React.useState(false); replace = setRow;
        return f.React.createElement(f.exports.XMonitorTimingEditor, { row, api, active: shown, disabled: busy,
            onBusy: value => { f.busyStates.push(value); setBusy(value); }, onSaved: async saved => { f.saved.push(saved); f.row = saved; setRow(saved); },
            onReload: async () => { f.reloads++; if (reload) return reload(f); if (f.nextRow) { f.row = f.nextRow; setRow(f.nextRow); } return true; } });
    }
    f.renderTiming = shown => f.render(f.React.createElement(Parent, { shown }));
    f.replace = async row => { f.row = row; await f.act(async () => replace(row)); };
    f.open = () => f.click('通知方法を変更');
    f.choose = async mode => f.act(async () => f.container.querySelector(`input[value="${mode}"]`).click());
    f.review = () => f.click('通知方法の変更を確認');
    f.save = cost => f.click(`${cost}枠を使って即時通知`);
    await f.renderTiming(active); await f.settle(); return f;
}

test('per-monitor realtime quotes five personal slots and sends only an explicit top-level mode with revision and expected cost', async () => {
    const f = await fixture();
    try {
        assert.match(f.container.textContent, /5分ごと.*使用1枠/); await f.open(); await f.choose('realtime');
        assert.match(f.container.textContent, /合計5枠/); assert.match(f.container.textContent, /追加の4枠を確保/); assert.equal(f.calls.length, 0);
        await f.review(); const review = f.container.querySelector('[aria-label="X監視の通知方法変更確認"]'); assert.match(review.textContent, /現在の使用枠1枠.*変更後の使用枠5枠/); assert.equal(f.calls.length, 0);
        await f.save(5); assert.deepEqual(f.calls, [{ route: 'x-monitors/timing-monitor', method: 'PATCH', body: { expectedRevision: 3, processingMode: 'realtime', expectedRealtimeSlotCost: 5 } }]);
        assert.match(f.container.textContent, /リアルタイム.*使用5枠/); assert.equal(f.saved.length, 1); assert.deepEqual(f.saved[0].notificationSettings, monitor().notificationSettings);
    } finally { await f.close(); }
});

test('server-qualified supporter and plan benefits show a one-slot price without inferring it from a plan name or pool', async () => {
    for (const source of ['supporter', 'plan']) {
        const f = await fixture({ row: monitor({ processing: processing({ realtimeSlotCost: 1, realtimeEligibilitySource: source, additionalSlotsNeeded: 0 }) }) });
        try { await f.open(); await f.choose('realtime'); assert.match(f.container.textContent, /合計1枠/); assert.match(f.container.textContent, source === 'supporter' ? /支援者特典/ : /プラン特典/); assert.doesNotMatch(f.container.textContent, /追加の4枠を確保/); await f.review(); await f.save(1); assert.equal(f.calls[0].body.expectedRealtimeSlotCost, 1); }
        finally { await f.close(); }
    }
});

test('an eligible-sounding plan does not bypass server denied realtime or create a one-slot quote', async () => {
    const f = await fixture({ row: monitor({ poolKind: 'supporter', quality: { ...monitor().quality, planId: 'basic_plus' }, processing: processing({ canEnableRealtime: false, realtimeEligibilitySource: null, reasonCode: 'X_REALTIME_SLOT_LIMIT' }) }) });
    try { await f.open(); assert.equal(f.container.querySelector('input[value="realtime"]').disabled, true); assert.match(f.container.textContent, /合計5枠/); await f.choose('realtime'); assert.equal(f.calls.length, 0); }
    finally { await f.close(); }
});

test('a reviewed one-slot quote changing to five slots disables confirmation until the owner explicitly reviews the new price', async () => {
    const f = await fixture({ row: monitor({ processing: processing({ realtimeSlotCost: 1, realtimeEligibilitySource: 'plan', additionalSlotsNeeded: 0 }) }) });
    try {
        await f.open(); await f.choose('realtime'); await f.review(); await f.replace(monitor({ processing: processing() }));
        assert.match(f.container.querySelector('[role="alert"]').textContent, /必要な枠数が変わりました/); assert.equal([...f.container.querySelectorAll('button')].find(item => item.textContent === '5枠を使って即時通知').disabled, true); await f.save(5); assert.equal(f.calls.length, 0);
        await f.click('選び直す'); await f.review(); await f.save(5); assert.equal(f.calls[0].body.expectedRealtimeSlotCost, 5);
    } finally { await f.close(); }
});

test('server quote conflicts preserve selection and require a successful reload before another explicit save', async () => {
    let reject = true;
    const f = await fixture({ respond: () => { if (reject) { reject = false; throw { status: 409, code: 'X_REALTIME_COST_CONFLICT', message: 'PRIVATE_QUOTE' }; } } });
    try {
        await f.open(); await f.choose('realtime'); await f.review(); await f.save(5); assert.match(f.container.textContent, /必要な枠数が変わりました/); assert.equal(f.container.querySelector('input[value="realtime"]').checked, true); assert(!f.container.textContent.includes('PRIVATE_QUOTE'));
        assert.equal([...f.container.querySelectorAll('button')].find(item => item.textContent === '通知方法の変更を確認').disabled, true);
        f.nextRow = monitor({ revision: 4 }); await f.click('最新の通知方法を確認'); await f.review(); await f.save(5); assert.equal(f.calls[1].body.expectedRevision, 4);
    } finally { await f.close(); }
});

test('a legacy inherited realtime preference does not reserve four slots until the owner confirms a five-slot save', async () => {
    const f = await fixture({ row: monitor({ processing: processing({ requestedMode: 'realtime', explicitMode: null, modeSource: 'owner', effectiveMode: 'batch', reasonCode: 'X_REALTIME_ALLOCATION_REQUIRED' }) }) });
    try { assert.match(f.container.textContent, /共通設定の希望はリアルタイム.*現在は5分ごと/); assert.match(f.container.textContent, /使用1枠/); await f.open(); assert.equal(f.container.querySelector('input[value="realtime"]').checked, true); assert.equal(f.calls.length, 0); await f.review(); assert.equal(f.calls.length, 0); await f.save(5); assert.equal(f.calls[0].body.expectedRealtimeSlotCost, 5); }
    finally { await f.close(); }
});

test('returning from funded realtime to interval delivery explicitly requests batch and preserves the monitor identity', async () => {
    const f = await fixture({ row: monitor({ processing: processing({ requestedMode: 'realtime', explicitMode: 'realtime', effectiveMode: 'realtime', realtimeSource: 'slots', slotCost: 5, effectiveSlotCost: 5 }) }) });
    try { await f.open(); await f.choose('batch'); await f.review(); assert.match(f.container.textContent, /現在の使用枠5枠.*変更後の使用枠1枠/); await f.click('プランの間隔で通知に変更'); assert.deepEqual(f.calls[0].body, { expectedRevision: 3, processingMode: 'batch' }); assert.equal(f.saved[0].id, monitor().id); assert.equal(f.saved[0].processing.slotCost, 1); }
    finally { await f.close(); }
});

test('acquiring a one-slot benefit keeps five reserved slots until an explicit same-mode reapply', async () => {
    const f = await fixture({ row: monitor({ processing: processing({ requestedMode: 'realtime', explicitMode: 'realtime', effectiveMode: 'realtime', realtimeSource: 'plan', realtimeEligibilitySource: 'plan', slotCost: 5, effectiveSlotCost: 1, realtimeSlotCost: 1, additionalSlotsNeeded: 0 }) }) });
    try { assert.match(f.container.textContent, /使用5枠/); assert.equal(f.calls.length, 0); await f.open(); await f.review(); await f.save(1); assert.deepEqual(f.calls[0].body, { expectedRevision: 3, processingMode: 'realtime', expectedRealtimeSlotCost: 1 }); assert.equal(f.saved[0].processing.slotCost, 1); }
    finally { await f.close(); }
});

test('older or malformed optional processing metadata keeps timing read-only without guessing a cost', async () => {
    const f = await fixture({ row: monitor({ processing: undefined }) });
    try { assert.match(f.container.textContent, /通知方法の確認待ち/); assert.equal(f.container.querySelector('form'), null); assert.doesNotMatch(f.container.textContent, /使用1枠|合計5枠/); await f.click('最新の通知方法を確認'); assert.equal(f.reloads, 1); assert.equal(f.calls.length, 0);
        for (const changes of [{ slotCost: 0 }, { slotCost: 2 }, { slotCost: '1' }, { realtimeSlotCost: null }, { realtimeSlotCost: '5' }, { effectiveMode: 'unknown' }, { canEnableRealtime: 'true' }, { modeSource: 'owner' }, { intervalMinutes: -1 }, { additionalSlotsNeeded: 5 }]) assert.throws(() => f.exports.parseXMonitorProcessing(processing(changes)));
        const parsed = f.exports.parseXMonitor(monitor({ processing: { slotCost: 1 } })); assert.equal(parsed.processing, undefined); assert.equal(parsed.id, monitor().id);
    } finally { await f.close(); }
});

test('rapid save clicks issue one request and a response after the view is left cannot announce success or overwrite parent data', async () => {
    let finish;
    const f = await fixture({ respond: () => new Promise(resolve => { finish = resolve; }) });
    try { await f.open(); await f.choose('realtime'); await f.review(); const save = [...f.container.querySelectorAll('button')].find(item => item.textContent === '5枠を使って即時通知'); await f.act(async () => { save.click(); save.click(); }); assert.equal(f.calls.length, 1); await f.renderTiming(false);
        await f.act(async () => finish(monitor({ revision: 4, processing: processing({ requestedMode: 'realtime', explicitMode: 'realtime', effectiveMode: 'realtime', realtimeSource: 'slots', slotCost: 5, effectiveSlotCost: 5 }) })));
        assert.equal(f.saved.length, 0); assert.doesNotMatch(f.container.textContent, /通知方法を保存しました/); assert.equal(f.busyStates.at(-1), false);
    } finally { if (finish) finish(monitor()); await f.close(); }
});

test('an old reload finishing after inactive/reactive transitions cannot release the price conflict gate', async () => {
    let finish, reloads = 0;
    const f = await fixture({ respond: () => { throw { status: 409, code: 'X_REALTIME_COST_CONFLICT' }; }, reload: () => ++reloads === 1 ? new Promise(resolve => { finish = resolve; }) : true });
    try {
        await f.open(); await f.choose('realtime'); await f.review(); await f.save(5); await f.click('最新の通知方法を確認');
        await f.renderTiming(false); await f.renderTiming(true); await f.act(async () => finish(true));
        assert.equal([...f.container.querySelectorAll('button')].find(item => item.textContent === '通知方法の変更を確認').disabled, true);
        assert.equal(f.calls.length, 1); await f.click('最新の通知方法を確認'); assert.equal([...f.container.querySelectorAll('button')].find(item => item.textContent === '通知方法の変更を確認').disabled, false);
    } finally { if (finish) finish(true); await f.close(); }
});

test('an undefined parent read result does not count as a verified price refresh', async () => {
    const f = await fixture({ respond: () => { throw { status: 409, code: 'X_REALTIME_COST_CONFLICT' }; }, reload: () => undefined });
    try { await f.open(); await f.choose('realtime'); await f.review(); await f.save(5); await f.click('最新の通知方法を確認'); assert.match(f.container.textContent, /通知方法を確認できませんでした/); assert.equal([...f.container.querySelectorAll('button')].find(item => item.textContent === '通知方法の変更を確認').disabled, true); assert.equal(f.calls.length, 1); }
    finally { await f.close(); }
});

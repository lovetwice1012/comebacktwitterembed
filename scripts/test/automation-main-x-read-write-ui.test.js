'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

const RECEIVER = 'cc2cb493-a60d-41d6-936f-2ed33d7ea2c7';
const quality = { planId: 'free', priority: 0, minuteLimit: 5, dayLimit: 24, intervalMinutes: 60 };
const quota = {
    featureEnabled: true,
    currentPlan: { ...quality, label: '無料', tier: 'free', baseSlotLimit: 5 },
    personal: { totalLimit: 5, registeredCount: 1, used: 1, available: 4, supporterExtraSlots: 0 },
    x: { used: 1, available: 4, specialLimit: 0, specialUsed: 0, reasonCode: null, reason: null },
    pools: { free: { limit: 50, used: 1, available: 49 }, supporter: { limit: 100, used: 0, available: 100 } },
};
const receiver = () => ({ id: RECEIVER, state: 'stored', revision: 1, createdAtMs: 1000, updatedAtMs: 1000, browserVersion: '160.0a1', receiverState: 'awaiting', boundMonitorCount: 0 });
const setup = subscriptions => ({ available: true, receiverEnabled: false, rollout: { mode: 'public', eligible: true, reasonCode: null, reason: null },
    download: { url: '/api/automation/x-setup/download', version: '0.1.0', sha256: 'a'.repeat(64) }, subscriptions, maxFileBytes: 32768, nextCursor: null });
const monitor = changes => ({ id: '1', accountId: '18446744073709551615', accountHandle: 'fixture_user', name: '保存前', enabled: true,
    state: 'ready', poolKind: 'free', notificationSettings: {}, workflowStatus: null, destinationStatus: null, subscriptionState: 'unconfigured', revision: 1, quality, ...changes });

for (const operation of ['edit', 'create', 'stop', 'resume']) for (const timing of ['immediate', 'late']) test(`MAIN-FRESH-3 ${timing} receiver read preserves canonical X ${operation} response`, async () => {
    const fixture = await reactFixture('export { XMonitorManager } from "./components/automation/x-monitor-manager";');
    let serverMonitor = monitor({ enabled: operation !== 'resume' }), setupRows = [receiver()], releasePatch;
    const writes = []; let listReads = 0, releaseStale;
    const api = async (route, method = 'GET', body) => {
        if (method !== 'GET') writes.push({ route, method, body });
        if (route === 'x-monitor-quota') return quota;
        if (route === 'x-monitors' && method === 'GET') {
            const snapshot = { items: operation === 'create' && serverMonitor.revision === 1 ? [] : [structuredClone(serverMonitor)], quota };
            if (++listReads === 2 && timing === 'late') return new Promise(resolve => { releaseStale = () => resolve(snapshot); });
            return snapshot;
        }
        if (route === 'x-setup') return setup(setupRows.map(value => structuredClone(value)));
        if (route === 'x-processing-settings') return { requestedMode: 'batch', effectiveMode: 'batch', realtimeAllowed: false, planId: 'free', planLabel: '無料', intervalMinutes: 60, configured: true, reasonCode: null, rollout: setup([]).rollout };
        if (route === 'x-monitors/1' && method === 'PATCH' || route === 'x-monitors' && method === 'POST') {
            if (method === 'PATCH' && body.expectedRevision !== serverMonitor.revision) throw Object.assign(new Error('stale monitor'), { code: 'X_MONITOR_REVISION_CONFLICT', status: 409 });
            return new Promise(resolve => { releasePatch = () => { serverMonitor = monitor({ ...body, revision: 2 }); resolve(structuredClone(serverMonitor)); }; });
        }
        if (route === `x-setup/subscriptions/${RECEIVER}` && method === 'DELETE') { setupRows = []; return { deleted: true }; }
        throw new Error(`unexpected ${method} ${route}`);
    };
    try {
        await fixture.render(fixture.React.createElement(fixture.exports.XMonitorManager, { api, active: true, destinations: [], rules: [] }));
        await fixture.click('Xアカウントの監視を管理'); await fixture.settle();
        await fixture.click('X通知の受信設定を始める'); await fixture.settle();
        if (operation === 'create') {
            await fixture.click('X監視を追加'); await fixture.fill(fixture.field('Xアカウント名'), 'new_target');
            await fixture.fill(fixture.field('監視の表示名'), '保存済みの新名称');
            const ack = fixture.container.querySelector('.nx-firefox-ack input'); await fixture.act(async () => ack.click());
            await fixture.act(async () => fixture.container.querySelector('form[aria-label="X監視の登録設定"]').dispatchEvent(new fixture.dom.window.Event('submit', { bubbles: true, cancelable: true })));
            await fixture.click('このX監視設定で保存');
        } else if (operation === 'edit') {
            const card = fixture.container.querySelector('article[aria-label="保存前のX監視"]');
            const edit = [...card.querySelectorAll('button')].find(button => button.textContent.trim() === '通知設定');
            await fixture.act(async () => edit.click());
            await fixture.fill(fixture.field('監視の表示名'), '保存済みの新名称');
            await fixture.act(async () => fixture.container.querySelector('form[aria-label="X監視の登録設定"]').dispatchEvent(new fixture.dom.window.Event('submit', { bubbles: true, cancelable: true })));
        } else await fixture.click(operation === 'stop' ? 'X監視を停止' : 'X監視を再開');
        assert.equal(typeof releasePatch, 'function');
        await fixture.click('受信情報を削除'); await fixture.click('この受信情報を削除'); await fixture.settle();
        await fixture.act(async () => releasePatch()); await fixture.settle();
        if (timing === 'late') { assert.equal(typeof releaseStale, 'function'); await fixture.act(async () => releaseStale()); await fixture.settle(); }
        assert.equal(serverMonitor.revision, 2);
        assert.equal(fixture.container.querySelector('form[aria-label="X監視の登録設定"]'), null, 'committed editor is closed');
        assert.match(fixture.container.textContent, operation === 'stop' ? /X監視を停止しました/ : operation === 'resume' ? /X監視を再開しました/ : /X監視の設定を保存しました/);
        assert.equal(writes.filter(write => write.route === 'x-monitors/1' || write.route === 'x-monitors').length, 1);
        if (operation === 'edit') {
            await fixture.click('通知設定'); await fixture.fill(fixture.field('監視の表示名'), '次の保存');
            await fixture.act(async () => fixture.container.querySelector('form[aria-label="X監視の登録設定"]').dispatchEvent(new fixture.dom.window.Event('submit', { bubbles: true, cancelable: true })));
            assert.equal(writes.at(-1).body.expectedRevision, 2);
        }
    } finally {
        if (releaseStale) releaseStale(); if (releasePatch) releasePatch();
        await fixture.close();
    }
});

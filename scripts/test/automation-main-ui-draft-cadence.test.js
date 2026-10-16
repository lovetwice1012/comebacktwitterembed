'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const settle = fixture => fixture.act(async () => new Promise(resolve => setTimeout(resolve, 35)));
const field = (fixture, label) => [...fixture.container.querySelectorAll('form.monitor-registration label')]
    .find(node => node.firstChild?.textContent.trim() === label)?.querySelector('input,select');

function row(kind, id) {
    return {
        id: String(id), kind, scope: 'private', revision: 1, enabled: true,
        name: kind === 'auto' ? 'Auto retained draft' : 'Price target',
        providerId: kind === 'auto' ? 'github' : 'steam',
        source: kind === 'auto' ? 'https://github.com/example/project' : 'https://store.steampowered.com/app/620',
        locale: 'ja', destinationId: 'dm', workflowId: '', intervalMinutes: 30,
        mode: 'change', maxPriceAmount: null, minDiscountPercent: null,
    };
}

async function scenario({ autoId = '42', priceId = '42', operation = 'delete-price' }) {
    const fixture = await reactFixture('export { MonitorManager } from "./components/automation/monitor-manager";');
    const requests = [];
    const records = { auto: [row('auto', autoId)], price: [row('price', priceId)] };
    fixture.set('confirm', () => true);
    const api = async (route, method = 'GET', body) => {
        requests.push({ route, method, body: body == null ? null : structuredClone(body) });
        if (route === 'providers') return { auto: [{ id: 'github' }], price: [{ id: 'steam' }], autoRegistration: { eligible: true } };
        if (route === 'entitlements') return { plan: { name: 'supporter', priority: 1, minuteLimit: 10, dayLimit: 100 }, slots: { used: 2, max: 10, available: 8 }, usage: { entries: [] } };
        const list = /^monitors\/(auto|price)\?/.exec(route);
        if (list && method === 'GET') return { items: records[list[1]].map(value => ({ ...value })), nextCursor: null };
        const target = /^monitors\/(auto|price)\/([^/]+)$/.exec(route);
        if (target && method === 'DELETE') {
            if (operation === 'failed-delete') throw Object.assign(new Error('fixture delete rejected'), { status: 503 });
            records[target[1]] = records[target[1]].filter(value => value.id !== target[2]);
            return { deleted: true };
        }
        if (target && method === 'PATCH') {
            records[target[1]] = records[target[1]].map(value => value.id === target[2] ? { ...value, enabled: body.enabled, revision: 2 } : value);
            return { revision: 2 };
        }
        throw new Error(`Unexpected request: ${method} ${route}`);
    };
    try {
        await fixture.render(fixture.React.createElement(fixture.exports.MonitorManager, {
            api, scope: 'private', canEdit: true, rules: [], active: true,
            destinations: [{ id: 'dm', name: 'Owner DM', kind: 'dm', enabled: true, scope: 'private' }],
            refresh: async () => {},
        }));
        await settle(fixture);
        await fixture.click('設定を変更');
        await fixture.fill(field(fixture, '名前（省略可）'), 'UNSAVED-AUTO-DRAFT');
        await fixture.click('キャンセル');
        assert.match(fixture.container.textContent, /通知の入力を保持しています/);

        if (operation === 'delete-auto') {
            await fixture.click('削除');
        } else {
            await fixture.click('価格通知'); await settle(fixture);
            if (operation === 'toggle-price') await fixture.click('停止');
            else await fixture.click('削除');
        }
        await settle(fixture);

        const retained = fixture.container.textContent.includes('通知の入力を保持しています');
        let resumedName = null;
        if (retained) {
            await fixture.click('通知の入力を再開');
            resumedName = field(fixture, '名前（省略可）')?.value ?? null;
        }
        return {
            autoId: String(autoId), priceId: String(priceId), operation, retained, resumedName,
            mutations: requests.filter(request => request.method !== 'GET'),
        };
    } finally {
        await fixture.close();
    }
}


for (const operation of ['delete-price', 'failed-delete', 'toggle-price', 'delete-auto']) test(`MAIN-UI-1 typed monitor draft survives ${operation}`, async () => {
    const result = await scenario({ operation });
    assert.equal(result.retained, operation !== 'delete-auto');
    if (result.retained) assert.equal(result.resumedName, 'UNSAVED-AUTO-DRAFT');
    assert.equal(result.mutations.length, 1);
    assert.equal(result.mutations[0].route, `monitors/${operation === 'delete-auto' ? 'auto' : 'price'}/42`);
});
const tick = fixture => fixture.act(async () => new Promise(resolve => setTimeout(resolve, 25)));

function monitor(id, overrides = {}) {
    return {
        id: String(id), kind: 'auto', scope: 'private', name: `通知 ${id}`, revision: 1,
        providerId: 'github', source: `https://github.com/example/repo-${id}`, locale: 'ja', enabled: true,
        destinationId: 'dm-one', workflowId: '', intervalMinutes: 30, baseIntervalMinutes: 30,
        slotCost: 1, effectiveSlotCost: 1, cadenceUpdatedAtMs: null, canAllocateCadence: true,
        ...overrides,
    };
}

test('MAIN-UI-2 page-two cadence save adopts fresh baseline and supports another CAS save', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => monitor(index + 1));
    let last = monitor(101), cadenceWrites = 0;
    const reads = [];
    const fixture = await reactFixture('export { MonitorManager } from "./components/automation/monitor-manager";');
    try {
        const api = async (route, method = 'GET', body) => {
            if (route === 'providers') return { auto: [{ id: 'github' }], price: [], autoRegistration: { eligible: true } };
            if (route === 'entitlements') return { plan: { name: '無料', priority: 0, dayLimit: 24, minuteLimit: 5 }, slots: { used: 1, max: 10, available: 9 }, usage: { entries: [] } };
            if (route.startsWith('monitors/auto?') && method === 'GET') {
                reads.push(route);
                return route.includes('afterId=100') ? { items: [last], nextCursor: null } : { items: firstPage, nextCursor: '100' };
            }
            if (route === 'monitors/auto/101' && method === 'POST' && body.action === 'cadence') {
                cadenceWrites++;
                assert.equal(body.expectedRevision, last.revision);
                assert.equal(body.expectedUpdatedAtMs, last.cadenceUpdatedAtMs);
                last = monitor(101, { revision: last.revision + 1, slotCost: body.slotCost, effectiveSlotCost: body.slotCost, cadenceUpdatedAtMs: cadenceWrites * 2000, intervalMinutes: 30 / body.slotCost });
                return { id: '101', slotCost: body.slotCost, effectiveSlotCost: body.slotCost, intervalMs: 1800000 / body.slotCost, updatedAtMs: last.cadenceUpdatedAtMs };
            }
            throw new Error(`unexpected request ${method} ${route}`);
        };
        await fixture.render(fixture.React.createElement(fixture.exports.MonitorManager, {
            api, scope: 'private', canEdit: true,
            destinations: [{ id: 'dm-one', name: '個人DM', kind: 'dm', enabled: true, scope: 'private' }],
            rules: [], refresh: async () => {},
        }));
        await tick(fixture);
        await fixture.click('続きを読み込む');
        await tick(fixture);
        const card = [...fixture.container.querySelectorAll('article.monitor-card')].find(node => node.textContent.includes('通知 101'));
        assert(card, 'page-two monitor must be visible');
        const edit = [...card.querySelectorAll('button')].find(node => node.textContent.trim() === '設定を変更');
        await fixture.act(async () => edit.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true })));
        await fixture.click('確認間隔・使用枠');
        const slotInput = fixture.field('この通知で使う枠数');
        await fixture.fill(slotInput, '2');
        await fixture.click('枠配分の変更を確認');
        await fixture.click('この枠配分で保存');
        await tick(fixture);
        assert.equal(cadenceWrites, 1, 'the cadence write committed');
        assert.match(fixture.container.textContent, /枠配分を保存しました。サービスの設定間隔は15分です/);
        assert.equal(reads.filter(route => !route.includes('afterId=100')).length >= 2, true, 'reload restarts at the first page');
        assert.equal(reads.filter(route => route.includes('afterId=100')).length, 2, 'post-write reload follows the cursor');
        assert.equal(fixture.field('この通知で使う枠数').value, '2');
        assert.match(fixture.container.textContent, /現在の設定間隔 15分/);
        await fixture.click('通知・利用枠を再取得');
        await tick(fixture);
        assert.match(fixture.container.textContent, /最新の通知を取得しました/);
        assert.equal(fixture.container.querySelectorAll('article.monitor-card').length, 101, 'targeted refresh retains all loaded pages');
        await fixture.fill(fixture.field('この通知で使う枠数'), '3');
        await fixture.click('枠配分の変更を確認'); await fixture.click('この枠配分で保存');
        assert.equal(cadenceWrites, 2); assert.equal(last.revision, 3); assert.equal(last.slotCost, 3);
        assert.match(fixture.container.textContent, /現在の設定間隔 10分/);
    } finally {
        await fixture.close();
    }
});

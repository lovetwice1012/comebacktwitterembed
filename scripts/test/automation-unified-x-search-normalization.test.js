'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const { xFixtureResponse } = require('./helpers/notification-registration-fixture.cjs');

test('unified X search matches composed and decomposed Japanese voiced characters in both directions', async () => {
    const f = await reactFixture('export { MonitorManager } from "./components/automation/monitor-manager";');
    const quality = { planId: 'free', priority: 0, minuteLimit: 5, dayLimit: 24, intervalMinutes: 60 };
    const monitor = (id, name, handle) => ({ id, name, accountId: id, accountHandle: handle, enabled: true, state: 'ready', poolKind: 'free',
        notificationSettings: {}, workflowStatus: null, destinationStatus: null, subscriptionState: 'unconfigured', revision: 1, quality });
    const api = async route => {
        if (route === 'providers') return { auto: [], price: [], autoRegistration: { eligible: true } };
        if (route === 'entitlements') return { plan: { name: '無料', priority: 0, dayLimit: 24, minuteLimit: 5 }, slots: { used: 2, max: 5, available: 3 }, usage: { entries: [] } };
        if (route.startsWith('monitors/')) return { items: [], nextCursor: null };
        if (route === 'x-monitors') return { ...xFixtureResponse(route), items: [monitor('1', 'カ\u3099チ通知', 'first'), monitor('2', 'ガイド通知', 'second')] };
        const result = xFixtureResponse(route); if (result !== undefined) return result;
        if (route.startsWith('jobs')) return { items: [], nextCursor: null };
        throw new Error('Unexpected fixture route');
    };
    try {
        await f.render(f.React.createElement(f.exports.MonitorManager, { api, scope: 'private', canEdit: true, active: true,
            destinations: [], rules: [], refresh: async () => {} }));
        await f.act(async () => new Promise(resolve => setTimeout(resolve, 30)));
        const search = f.field('通知を検索');
        await f.fill(search, 'ガ');
        await f.act(async () => new Promise(resolve => setTimeout(resolve, 300)));
        let cards = f.container.querySelector('.monitor-list[aria-label="登録した通知"]').textContent;
        assert.match(cards, /カ\u3099チ通知/); assert.match(cards, /ガイド通知/);
        await f.fill(search, 'カ\u3099イト\u3099');
        await f.act(async () => new Promise(resolve => setTimeout(resolve, 300)));
        cards = f.container.querySelector('.monitor-list[aria-label="登録した通知"]').textContent;
        assert.match(cards, /ガイド通知/); assert.doesNotMatch(cards, /カ\u3099チ通知/);
    } finally { await f.close(); }
});

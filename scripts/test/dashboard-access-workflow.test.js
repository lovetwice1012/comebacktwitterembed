'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

const entry = 'export { AccessManagement } from "./components/dashboard/access-management";';
const directory = (name = 'Alice') => ({ enabled: true, grants: [], members: [{ id: '123456789012345678', username: name, nickname: null, avatarUrl: null }], roles: [{ id: '223456789012345678', name: 'Editors', managed: false, color: null, position: 1 }, { id: '323456789012345678', name: 'Readers', managed: false, color: null, position: 0 }], directoryError: null });
const visibleCard = f => [...f.container.querySelectorAll('div[hidden],div.rounded-lg')].find(card => card.querySelector('h3') && !card.hidden && card.querySelector('button'));
const clickVisible = async (f, text) => f.act(async () => [...visibleCard(f).querySelectorAll('button')].find(button => button.textContent.trim() === text).click());

test('access grants serialize writes, lock selection during delivery, and show the exact target receipt', async () => {
    const f = await reactFixture(entry);
    try {
        const writes = []; let resolveWrite;
        f.set('fetch', async (url, options = {}) => {
            if (options.method !== 'POST') return new Response(JSON.stringify(directory()));
            writes.push(JSON.parse(options.body));
            return new Promise(resolve => { resolveWrite = resolve; });
        });
        await f.render(f.React.createElement(f.exports.AccessManagement, { guildId: '111111', locale: 'ja' })); await f.settle();
        await f.act(async () => f.container.querySelector('input[aria-label="Alice を選択"]').click());
        await clickVisible(f, '編集を許可');
        assert.equal(writes.length, 1);
        assert([...f.container.querySelectorAll('[role="group"] button')].every(button => button.disabled));
        assert([...f.container.querySelectorAll('input[type="checkbox"]')].every(input => input.disabled));
        await clickVisible(f, '閲覧を許可');
        assert.equal(writes.length, 1);
        await f.act(async () => resolveWrite(new Response(JSON.stringify({ enabled: true, grants: [{ guildId: '111111', targetType: 'user', targetId: '123456789012345678', accessLevel: 'edit', grantedByUserId: 'owner' }] })))); await f.settle();
        assert.deepEqual(writes, [{ targetType: 'user', targetIds: ['123456789012345678'], accessLevel: 'edit' }]);
        assert.equal(f.container.querySelector('input[aria-label="Alice を選択"]').checked, false);
        const receipt = f.container.querySelector('[role="status"]');
        assert(receipt.textContent.includes('編集を許可')); assert(receipt.textContent.includes('Alice'));
    } finally { await f.close(); }
});

test('late directory and save responses cannot replace another server or revive its selection', async () => {
    const f = await reactFixture(entry);
    try {
        let resolveOld;
        f.set('fetch', async (url, options = {}) => {
            if (options.method === 'POST') return new Promise(resolve => { resolveOld = resolve; });
            return new Response(JSON.stringify(directory(url.includes('/111111/') ? 'Alice' : 'Bob')));
        });
        await f.render(f.React.createElement(f.exports.AccessManagement, { guildId: '111111', locale: 'ja' })); await f.settle();
        await f.act(async () => f.container.querySelector('input[aria-label="Alice を選択"]').click());
        await clickVisible(f, '編集を許可');
        await f.render(f.React.createElement(f.exports.AccessManagement, { guildId: '222222', locale: 'en' })); await f.settle();
        assert(f.container.textContent.includes('Dashboard access'));
        assert(f.container.querySelector('input[aria-label="Select Bob"]'));
        await f.act(async () => resolveOld(new Response(JSON.stringify({ enabled: true, grants: [{ guildId: '111111', targetType: 'user', targetId: '123456789012345678', accessLevel: 'edit', grantedByUserId: 'owner' }] })))); await f.settle();
        assert(!f.container.textContent.includes('Alice'));
        assert(!f.container.querySelector('[role="status"]'));
        assert.equal(f.container.querySelector('input[aria-label="Select Bob"]').checked, false);
    } finally { await f.close(); }
});

test('role search retains selected targets and network failure retains an actionable, safe retry', async () => {
    const f = await reactFixture(entry);
    try {
        let attempts = 0; const writes = [];
        f.set('fetch', async (url, options = {}) => {
            if (options.method !== 'POST') return new Response(JSON.stringify(directory()));
            writes.push(JSON.parse(options.body));
            if (++attempts === 1) throw new Error('socket secrets must not reach the UI');
            return new Response(JSON.stringify({ enabled: true, grants: [] }));
        });
        await f.render(f.React.createElement(f.exports.AccessManagement, { guildId: '111111', locale: 'ja' })); await f.settle();
        await f.click('ロール');
        await f.act(async () => f.container.querySelector('input[aria-label="Editors（223456789012345678）を選択"]').click());
        await f.fill(f.container.querySelector('input[aria-label="ロール名・IDを検索"]'), 'readers');
        assert.equal(f.container.querySelector('input[aria-label="Editors（223456789012345678）を選択"]'), null);
        assert(visibleCard(f).textContent.includes('Editors'));
        await clickVisible(f, '閲覧を許可'); await f.settle();
        assert(f.container.querySelector('[role="alert"]').textContent.includes('再試行'));
        assert(!f.container.textContent.includes('socket secrets'));
        await clickVisible(f, '閲覧を許可'); await f.settle();
        assert.deepEqual(writes, Array.from({ length: 2 }, () => ({ targetType: 'role', targetIds: ['223456789012345678'], accessLevel: 'view' })));
        assert(f.container.querySelector('[role="status"]').textContent.includes('Editors'));
    } finally { await f.close(); }
});

test('an older member lookup cannot overwrite a later cleared search', async () => {
    const f = await reactFixture(entry);
    try {
        let resolveLookup;
        f.set('fetch', async url => url.includes('query=423456789012345678') ? new Promise(resolve => { resolveLookup = resolve; }) : new Response(JSON.stringify(directory('Alice'))));
        await f.render(f.React.createElement(f.exports.AccessManagement, { guildId: '111111', locale: 'ja' })); await f.settle();
        const search = f.container.querySelector('input[aria-label="Discord ユーザーID"]');
        await f.fill(search, '423456789012345678'); await f.submit();
        assert(resolveLookup);
        await f.fill(search, ''); await f.settle();
        assert(f.container.querySelector('input[aria-label="Alice を選択"]'));
        await f.act(async () => resolveLookup(new Response(JSON.stringify(directory('Outdated lookup'))))); await f.settle();
        assert(f.container.querySelector('input[aria-label="Alice を選択"]'));
        assert(!f.container.textContent.includes('Outdated lookup'));
    } finally { await f.close(); }
});

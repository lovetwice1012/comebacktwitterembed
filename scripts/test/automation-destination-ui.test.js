'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const G1 = '111111111111111111', G2 = '222222222222222222';
const C1 = '333333333333333333', C2 = '444444444444444444';
const button = (f, text) => [...f.container.querySelectorAll('button')].find(item => item.textContent.trim() === text);
const destinationForm = f => f.container.querySelector('form[aria-label="通知先の登録設定"]');
const submitDestination = f => f.act(async () => destinationForm(f).dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })));
const channel = (id = C1, name = '通知') => ({ id, name, canCreateWebhook: true });
const plan = { featureEnabled: true, currentPlan: { planId: 'basic', label: 'ベーシック', tier: 'paid', priority: 2, minuteLimit: 7, dayLimit: 48, intervalMinutes: 5, baseSlotLimit: 5 },
    personal: { totalLimit: 8, registeredCount: 1, used: 1, available: 7, supporterExtraSlots: 3 }, x: { used: 1, available: 7, specialLimit: 3, specialUsed: 0, reasonCode: null },
    pools: { free: { limit: 50, used: 1, available: 49 }, supporter: { limit: 100, used: 0, available: 100 } } };
async function fixture({ guildId, scope = 'private', destinations = [], guildResponse, respond, refreshFails = false, targetedRefresh = false, firstPageLimit = 100 } = {}) {
    const f = await reactFixture('export { MonitorManager } from "./components/automation/monitor-manager"; export { XMonitorManager } from "./components/automation/x-monitor-manager";');
    f.calls = []; f.fetches = []; f.destinations = destinations; f.guildResponse = guildResponse;
    f.set('fetch', async (url, options) => {
        f.fetches.push({ url, options });
        if (f.guildResponse) return f.guildResponse(url, options);
        return new Response(JSON.stringify([{ guildId: G1, name: 'サーバー1' }, { guildId: G2, name: 'サーバー2' }]), { status: 200 });
    });
    const api = async (route, method = 'GET', body) => {
        f.calls.push({ route, method, body });
        const override = respond && await respond(route, method, body, f);
        if (override !== undefined) return override;
        if (route === 'providers') return { auto: [], price: [], autoRegistration: { eligible: true } };
        if (route === 'entitlements') return { plan: { name: '無料', dayLimit: 24, minuteLimit: 5 }, slots: { used: 1, max: 5, available: 4 }, usage: { entries: [] } };
        if (route.endsWith('/preview')) return { providerId: 'github', source: body.source, intervalMinutes: 60 };
        if (route.startsWith('monitors/')) return { items: [], nextCursor: null };
        if (route.startsWith('channels')) return { items: [channel(), { ...channel(C2, '権限を確認'), canCreateWebhook: false }] };
        if (route.startsWith('destinations') && method === 'POST') { const row = { id: 'new-destination', name: body.name, scope: body.scope, kind: body.kind === 'dm' ? 'dm' : 'webhook', enabled: true }; f.destinations.push(row); return { id: row.id }; }
        if (route.startsWith('destinations') && method === 'PATCH') return { id: 'existing' };
        if (route.startsWith('destinations/') && method === 'GET') return f.destinations.find(item => item.id === route.slice('destinations/'.length));
        if (route === 'x-monitor-quota') return plan;
        if (route === 'x-monitors') return { items: [] };
        if (route === 'x-setup') return { available: true, receiverEnabled: true, rollout: { mode: 'public', eligible: true, reasonCode: null, reason: null }, download: { url: '/api/automation/x-setup/download', version: '0.1.0-preview.4', sha256: 'a'.repeat(64) }, subscriptions: [], maxFileBytes: 32768, nextCursor: null };
        if (route === 'x-processing-settings') return { requestedMode: 'batch', effectiveMode: 'batch', realtimeAllowed: false, planId: 'basic', planLabel: 'ベーシック', intervalMinutes: 5, configured: true, reasonCode: null, rollout: { mode: 'public', eligible: true, reasonCode: null, reason: null } };
        throw new Error(`Unexpected fixture route ${route}`);
    };
    function Parent() {
        const [items, setItems] = f.React.useState(f.destinations.slice(0, firstPageLimit));
        return f.React.createElement(f.exports.MonitorManager, { api, guildId, scope, active: true, canEdit: true, destinations: items, rules: [], refresh: async () => { if (refreshFails) throw new Error('fixture refresh failure'); setItems(f.destinations.slice(0, firstPageLimit)); }, ...(targetedRefresh ? { refreshDestination: async id => {
            const saved = await api(`destinations/${id}`); setItems(current => [...current.filter(item => item.id !== saved.id), saved]);
        } } : {}) });
    }
    f.api = api;
    await f.render(f.React.createElement(Parent)); await f.settle();
    f.writes = () => f.calls.filter(item => item.method !== 'GET');
    return f;
}
async function openChannel(f) {
    await f.click('通知先を追加'); await f.fill(f.field('通知先の名前'), 'X投稿の通知先'); await f.fill(f.field('通知先の種類'), 'channel'); await f.settle();
}

test('personal notification destinations show DM, Bot-created channel webhook, and existing webhook choices', async () => {
    const f = await fixture();
    try {
        await f.click('通知先を追加');
        assert.deepEqual([...f.field('通知先の種類').options].map(item => item.textContent), ['自分のDM', 'チャンネルを選択してBotがWebhookを作成', '既存Webhook URL']);
        assert.equal(f.fetches.length, 0); assert.equal(f.writes().length, 0);
        await f.fill(f.field('通知先の名前'), '自分のDM'); await submitDestination(f);
        assert.equal(f.writes()[0].route, 'destinations'); assert.equal(f.writes()[0].body.kind, 'dm'); assert.equal(f.writes()[0].body.scope, 'private'); assert.equal(f.fetches.length, 0);
    } finally { await f.close(); }
});

test('personal channel selection creates a private destination only on explicit save and refreshes open X draft choices', async () => {
    const f = await fixture();
    try {
        await f.click('Xアカウントの監視を管理'); await f.settle(); await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), '@retained_x'); await f.fill(f.field('監視の表示名'), '保持する下書き');
        await f.click('X監視の通知先を追加'); await f.fill(f.field('通知先の名前'), 'X投稿の通知先'); await f.fill(f.field('通知先の種類'), 'channel'); await f.settle();
        assert.equal(f.fetches[0].url, '/api/guilds?purpose=notification-destinations'); assert.equal(f.fetches[0].options.cache, 'no-store');
        await f.fill(f.field('通知先のサーバー'), G1); await f.settle();
        assert(f.calls.some(item => item.route === `channels?guildId=${G1}`));
        assert(f.field('Webhookを作成するチャンネル').querySelector(`option[value="${C2}"]`).disabled);
        await f.fill(f.field('Webhookを作成するチャンネル'), C1);
        assert.equal(f.writes().length, 0); assert.match(destinationForm(f).textContent, /保存すると、Botが選択したチャンネルに通知用Webhookを作成/);
        assert.equal(f.field('編集できる人').disabled, true); await submitDestination(f);
        assert.equal(f.writes().length, 1); assert.equal(f.writes()[0].route, `destinations?guildId=${G1}`); assert.equal(f.writes()[0].body.kind, 'channel'); assert.equal(f.writes()[0].body.scope, 'private'); assert.equal(f.writes()[0].body.channelId, C1);
        assert.equal(f.field('Xアカウント名').value, 'retained_x'); assert.equal(f.field('監視の表示名').value, '保持する下書き');
        const choices = f.container.querySelector('form[aria-label="X監視の登録設定"] select'); assert(choices.querySelector('option[value="new-destination"]')); assert.equal(choices.value, 'new-destination');
    } finally { await f.close(); }
});

test('server changes clear channel selection and late previous-server choices cannot replace the current list', async () => {
    let finishOld;
    const f = await fixture({ respond: async route => route === `channels?guildId=${G1}` ? new Promise(resolve => { finishOld = resolve; }) : route === `channels?guildId=${G2}` ? { items: [channel(C2, '現在の通知')] } : undefined });
    try {
        await openChannel(f); await f.fill(f.field('通知先のサーバー'), G1); assert.equal(button(f, '通知先を保存').disabled, true);
        await f.fill(f.field('通知先のサーバー'), G2); await f.settle(); await f.fill(f.field('Webhookを作成するチャンネル'), C2);
        await f.act(async () => finishOld({ items: [channel(C1, '古いチャンネル')] }));
        assert.equal(f.field('Webhookを作成するチャンネル').value, C2); assert(!destinationForm(f).textContent.includes('古いチャンネル'));
        await f.fill(f.field('通知先のサーバー'), G1); assert.equal(f.field('Webhookを作成するチャンネル').value, ''); assert.equal(button(f, '通知先を保存').disabled, true);
        assert.equal(f.writes().length, 0);
    } finally { await f.close(); }
});

test('guild and channel failures retry in place while retaining destination inputs', async () => {
    let guildAttempt = 0, channelAttempt = 0;
    const f = await fixture({ guildResponse: async () => { guildAttempt++; return new Response(JSON.stringify([{ guildId: G1, name: '再取得サーバー' }]), { status: guildAttempt === 1 ? 503 : 200 }); },
        respond: async route => { if (route === `channels?guildId=${G1}` && ++channelAttempt === 1) throw new Error('private details'); } });
    try {
        await openChannel(f); assert.match(destinationForm(f).textContent, /サーバー一覧を取得できませんでした/); assert.equal(button(f, '通知先を保存').disabled, true);
        await f.click('サーバーを再読み込み'); await f.settle(); await f.fill(f.field('通知先のサーバー'), G1); await f.settle();
        assert.match(destinationForm(f).textContent, /チャンネル一覧を取得できませんでした/); assert(!destinationForm(f).textContent.includes('private details')); assert.equal(button(f, '通知先を保存').disabled, true);
        await f.click('チャンネルを再読み込み'); await f.settle(); assert.equal(f.field('通知先の名前').value, 'X投稿の通知先');
        await f.fill(f.field('Webhookを作成するチャンネル'), C1); assert.equal(button(f, '通知先を保存').disabled, false); assert.equal(f.writes().length, 0);
    } finally { await f.close(); }
});

test('empty guild choices explain how to add a server and do not send a destination write', async () => {
    const f = await fixture({ guildResponse: async () => new Response('[]', { status: 200 }) });
    try { await openChannel(f); assert.match(destinationForm(f).textContent, /通知したいサーバーにBotを追加/); assert.equal(button(f, '通知先を保存').disabled, true); await submitDestination(f); assert.equal(f.writes().length, 0); }
    finally { await f.close(); }
});

test('personal existing webhook saves against the selected server, preserves secrets only in memory, and resumes its draft', async () => {
    const f = await fixture();
    try {
        await f.click('通知先を追加'); await f.fill(f.field('通知先の名前'), '既存の通知先'); await f.fill(f.field('通知先の種類'), 'webhook'); await f.settle(); await f.fill(f.field('通知先のサーバー'), G2);
        const secret = `https://discord.com/api/webhooks/${C1}/fixture-secret-webhook-token`;
        assert.equal(f.field('DiscordのWebhook URL').type, 'password'); await f.fill(f.field('DiscordのWebhook URL'), secret);
        await f.click('キャンセル'); await f.click('通知先の入力を再開'); assert.equal(f.field('DiscordのWebhook URL').value, secret);
        assert.equal(f.dom.window.localStorage.length, 0); assert.equal(f.dom.window.sessionStorage.length, 0); assert.equal(f.writes().length, 0);
        await submitDestination(f); assert.equal(f.writes()[0].route, `destinations?guildId=${G2}`); assert.equal(f.writes()[0].body.webhookUrl, secret); assert.equal(f.writes()[0].body.scope, 'private');
    } finally { await f.close(); }
});

test('editing an existing private webhook uses its original guild context and keeps destination identity locked', async () => {
    const f = await fixture({ destinations: [{ id: 'existing', name: '保存済みチャンネル', kind: 'webhook', guildId: G2, channelId: C2, scope: 'private', enabled: true, createdByBot: true, revision: 4 }] });
    try {
        await f.click('名前・状態を編集'); await f.fill(f.field('通知先の名前'), '変更後の名前');
        assert(f.field('通知先の種類').disabled); assert(f.field('編集できる人').disabled); assert.equal(f.field('通知先のサーバー'), undefined); assert.equal(f.field('DiscordのWebhook URL'), undefined); assert.equal(f.fetches.length, 0);
        await submitDestination(f); const call = f.writes()[0]; assert.equal(call.route, `destinations/existing?guildId=${G2}`); assert.equal(call.method, 'PATCH'); assert.equal(call.body.expectedRevision, 4); assert.equal(call.body.channelId, C2); assert.equal(call.body.guildId, G2); assert.equal(call.body.kind, 'webhook'); assert.equal(call.body.webhookUrl, '');
    } finally { await f.close(); }
});

test('server-shared creation retains the current server API and shared scope without fetching guild choices', async () => {
    const f = await fixture({ guildId: G1, scope: 'guild' });
    try {
        await openChannel(f); assert.equal(f.field('通知先のサーバー'), undefined); assert.equal(f.fetches.length, 0); assert(f.calls.some(item => item.route === 'channels'));
        assert.equal(f.field('編集できる人').value, 'guild'); await f.fill(f.field('Webhookを作成するチャンネル'), C1); await submitDestination(f);
        assert.equal(f.writes()[0].route, 'destinations'); assert.equal(f.writes()[0].body.scope, 'guild'); assert.equal(f.writes()[0].body.guildId, G1);
    } finally { await f.close(); }
});

test('a post-save list refresh failure reports the saved destination without allowing duplicate retry creation', async () => {
    const f = await fixture({ refreshFails: true });
    try { await f.click('通知先を追加'); await f.fill(f.field('通知先の名前'), '保存成功'); await submitDestination(f); assert.equal(f.writes().length, 1); assert.equal(destinationForm(f), null); assert.match(f.container.textContent, /通知先は保存済みです/); }
    finally { await f.close(); }
});

test('rapid explicit saves issue one destination write and keep inputs while the write is pending', async () => {
    let finish;
    const f = await fixture({ respond: async (route, method) => route === 'destinations' && method === 'POST' ? new Promise(resolve => { finish = resolve; }) : undefined });
    try {
        await f.click('通知先を追加'); await f.fill(f.field('通知先の名前'), '一度だけ保存');
        await f.act(async () => {
            const form = destinationForm(f);
            form.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
            form.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
        });
        assert.equal(f.writes().length, 1); assert.equal(f.field('通知先の名前').value, '一度だけ保存'); assert(button(f, '通知先を保存').disabled);
        await f.act(async () => finish({ id: 'saved-once' })); assert.equal(destinationForm(f), null); assert.equal(f.writes().length, 1);
    } finally { await f.close(); }
});

test('a failed save retains channel and server for an explicit retry without creating automatically', async () => {
    let attempts = 0;
    const f = await fixture({ respond: async (route, method) => { if (route === `destinations?guildId=${G1}` && method === 'POST' && ++attempts === 1) throw new Error('通知先を保存できませんでした。もう一度お試しください。'); } });
    try {
        await openChannel(f); await f.fill(f.field('通知先のサーバー'), G1); await f.settle(); await f.fill(f.field('Webhookを作成するチャンネル'), C1); await submitDestination(f);
        assert.equal(f.writes().length, 1); assert.equal(f.field('通知先のサーバー').value, G1); assert.equal(f.field('Webhookを作成するチャンネル').value, C1); assert.match(destinationForm(f).closest('dialog').textContent, /通知先を保存できませんでした/);
        await f.settle(); assert.equal(f.writes().length, 1); await submitDestination(f); assert.equal(f.writes().length, 2); assert.equal(destinationForm(f), null);
    } finally { await f.close(); }
});

const originalDestination = { id: 'original-destination', name: '元のDM', scope: 'private', kind: 'dm', enabled: true };
async function retainNormalDraft(f) {
    await f.click('通知を追加'); await f.fill(f.field('対象のURL・ID'), 'https://github.com/octocat'); await f.fill(f.field('名前'), '通常通知の下書き'); await f.submit(); await f.click('キャンセル');
}
const normalDestinations = f => f.container.querySelector('form.monitor-registration').querySelectorAll('select');

test('adding from an X draft selects its new destination while a retained ordinary draft keeps its original destination', async () => {
    const f = await fixture({ destinations: [originalDestination], respond: async route => route === 'providers' ? { auto: [{ id: 'github' }], price: [], autoRegistration: { eligible: true } } : undefined });
    try {
        await retainNormalDraft(f); await f.click('Xアカウントの監視を管理'); await f.settle(); await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), 'preserved_x');
        await f.click('X監視の通知先を追加'); await f.fill(f.field('通知先の名前'), 'X専用DM'); await submitDestination(f);
        assert.equal(f.container.querySelector('form[aria-label="X監視の登録設定"] select').value, 'new-destination'); assert.equal(f.field('Xアカウント名').value, 'preserved_x');
        await f.click('通知の入力を再開'); assert.equal(normalDestinations(f)[0].value, 'existing'); assert.equal(normalDestinations(f)[1].value, 'original-destination'); assert.match(f.container.querySelector('form.monitor-registration').textContent, /github.com\/octocat/);
    } finally { await f.close(); }
});

test('ordinary destination creation still selects its destination in the requesting ordinary draft', async () => {
    const f = await fixture({ destinations: [originalDestination], respond: async route => route === 'providers' ? { auto: [{ id: 'github' }], price: [], autoRegistration: { eligible: true } } : undefined });
    try {
        await retainNormalDraft(f); await f.click('通知先を追加'); await f.fill(f.field('通知先の名前'), '通常通知の新しいDM'); await submitDestination(f); await f.click('通知の入力を再開');
        assert.equal(normalDestinations(f)[1].value, 'new-destination');
    } finally { await f.close(); }
});

test('cancelling destination creation detaches the old X draft callback when its form is resumed separately', async () => {
    const f = await fixture();
    try {
        await f.click('Xアカウントの監視を管理'); await f.settle(); await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), 'old_request');
        await f.click('X監視の通知先を追加'); await f.fill(f.field('通知先の名前'), 'キャンセルした宛先'); await f.click('キャンセル');
        await f.fill(f.field('Xアカウント名'), 'new_request'); await f.click('通知先の入力を再開'); await submitDestination(f);
        assert.equal(f.field('Xアカウント名').value, 'new_request'); assert.equal(f.container.querySelector('form[aria-label="X監視の登録設定"] select').value, ''); assert.equal(f.writes().length, 1);
    } finally { await f.close(); }
});

test('stale and unmounted X destination callbacks cannot change another draft; a current callback selects its destination', async () => {
    const f = await fixture(); const callbacks = [];
    try {
        await f.render(f.React.createElement(f.exports.XMonitorManager, { api: f.api, destinations: [originalDestination], onAddDestination: callback => callbacks.push(callback) }));
        await f.click('Xアカウントの監視を管理'); await f.settle(); await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), 'first_draft'); await f.click('X監視の通知先を追加');
        await f.fill(f.field('Xアカウント名'), 'changed_draft'); await f.act(async () => callbacks[0]('original-destination')); assert.equal(f.container.querySelector('form[aria-label="X監視の登録設定"] select').value, '');
        await f.click('X監視の通知先を追加'); await f.act(async () => callbacks[1]('original-destination')); assert.equal(f.container.querySelector('form[aria-label="X監視の登録設定"] select').value, 'original-destination');
        await f.render(f.React.createElement('p', null, '別の画面')); await f.act(async () => callbacks[1]('unexpected')); assert.equal(f.container.textContent, '別の画面');
    } finally { await f.close(); }
});

test('a created destination beyond the first hundred candidates is individually refreshed and selected by the X draft', async () => {
    const destinations = Array.from({ length: 100 }, (_, index) => ({ ...originalDestination, id: `older-${index}`, name: `既存${index}` }));
    const f = await fixture({ destinations, targetedRefresh: true });
    try {
        await f.click('Xアカウントの監視を管理'); await f.settle(); await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), 'many_choices');
        await f.click('X監視の通知先を追加'); await f.fill(f.field('通知先の名前'), '101件目の通知先'); await submitDestination(f);
        assert(f.calls.some(item => item.route === 'destinations/new-destination' && item.method === 'GET')); const choices = f.container.querySelector('form[aria-label="X監視の登録設定"] select');
        assert.equal(choices.options.length, 102); assert.equal(choices.value, 'new-destination'); assert.equal(f.field('Xアカウント名').value, 'many_choices');
    } finally { await f.close(); }
});

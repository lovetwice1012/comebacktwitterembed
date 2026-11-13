'use strict';

// Open the real shared type chooser. Scope the second click to the dialog,
// since the same names are also used by the list's filter buttons.
async function openNotification(f, kind) {
    const labels = { auto: '新着通知', price: '価格通知', x: 'X通知' };
    if (!labels[kind]) throw new Error('Unknown notification kind');
    await f.click('通知を追加');
    const chooser = f.container.querySelector('dialog[open][aria-label="通知の種類を選択"]')
        || [...f.container.querySelectorAll('dialog[open]')].find(node => node.textContent.includes('通知の種類を選択'));
    if (!chooser) throw new Error('Notification type chooser is not open');
    const button = [...chooser.querySelectorAll('button')].find(node => node.querySelector('strong')?.textContent.trim() === labels[kind] || node.textContent.trim() === labels[kind]);
    if (!button) throw new Error(`Missing notification type: ${labels[kind]}`);
    await f.act(async () => button.click());
    await f.settle();
}
async function openXDestinationDraft(f, handle) {
    await openNotification(f, 'x');
    await f.click('あとで接続する');
    await f.fill(f.field('Xアカウント名'), handle);
    const form = f.container.querySelector('form[aria-label="X監視の登録設定"]');
    if (!form) throw new Error('X notification form is missing');
    const checkbox = form.querySelector('.nx-firefox-ack input');
    if (!checkbox || checkbox.disabled) throw new Error('Browser notification acknowledgement is unavailable');
    if (!checkbox.checked) await f.act(async () => checkbox.click());
    const next = [...form.querySelectorAll('button')].find(button => button.textContent.trim() === '次へ' && !button.closest('[hidden]'));
    if (!next || next.disabled) throw new Error('X notification destination step is unavailable');
    await f.act(async () => next.click());
}
function xFixtureResponse(path) {
    const rollout = { mode: 'supporters', eligible: true, reasonCode: null, reason: null };
    const quality = { planId: 'free', label: '無料', tier: 'free', baseSlotLimit: 5, priority: 0, minuteLimit: 5, dayLimit: 24, intervalMinutes: 60 };
    const quota = { featureEnabled: true, currentPlan: quality,
        personal: { totalLimit: 5, registeredCount: 0, used: 0, available: 5, supporterExtraSlots: 0 },
        x: { used: 0, available: 5, specialLimit: 0, specialUsed: 0, reasonCode: null, reason: null },
        pools: { free: { limit: 50, used: 0, available: 50 }, supporter: { limit: 100, used: 0, available: 100 } } };
    if (path === 'x-monitor-quota') return quota;
    if (path === 'x-monitors') return { items: [], quota };
    if (path === 'x-setup') return { available: true, receiverEnabled: true, chromeEnabled: true, braveEnabled: true, rollout,
        download: { url: '/api/automation/x-setup/download', version: '0.1.0-preview.5', sha256: 'a'.repeat(64) }, subscriptions: [], maxFileBytes: 32768, nextCursor: null };
    if (path === 'x-processing-settings') return { requestedMode: 'batch', effectiveMode: 'batch', realtimeAllowed: false, planId: 'free', planLabel: '無料', intervalMinutes: 60, configured: true, reasonCode: null, rollout };
    return undefined;
}
function xDestinationSelect(f) {
    const form = f.container.querySelector('form[aria-label="X監視の登録設定"]');
    const label = form && [...form.querySelectorAll('label')].find(node => node.firstChild?.textContent?.trim() === '通知先');
    const select = label?.querySelector('select');
    if (!select) throw new Error('X notification destination selector is missing');
    return select;
}
async function continueNotificationSource(f) {
    const form = f.container.querySelector('form.monitor-registration');
    const button = form && [...f.container.querySelectorAll('button[type="submit"]')].find(node => node.getAttribute('form') === form.id);
    if (!button || !['通知先を選ぶ', 'Xの設定へ'].includes(button.textContent.trim())) throw new Error('Notification source action is missing');
    await f.act(async () => button.click());
    await f.settle();
}
module.exports = { openNotification, openXDestinationDraft, xFixtureResponse, xDestinationSelect, continueNotificationSource };

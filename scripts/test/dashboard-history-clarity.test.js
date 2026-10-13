'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/load-dashboard.cjs');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const { presentAuditEntry, redactAuditValue } = load('features/audit/audit-history-model.ts');
const spec = (key, kind, label, extra = {}) => ({ key, kind, label: { ja: label, en: `EN ${key}` }, description: '', ...extra });
const enabled = spec('enabled', 'boolean', 'リンクを展開');
const media = spec('media_display_mode', 'choice', '画像・動画の表示方法', { choices: [{ value: 'embed', label: { ja: '本文と一緒に表示', en: 'Show with message' } }, { value: 'link_only', label: { ja: 'リンクだけ表示', en: 'Links only' } }] });
const targets = spec('disable', 'targets', '展開しない対象');
const catalog = [{ providerId: 'twitter', label: 'X / Twitter', enabledByDefault: true, settings: [enabled, media, targets] }];
const record = { auditLogId: 'audit-1', providerId: 'twitter', guildId: '111', actorUserId: '222', actorUsernameSnapshot: '管理者A', createdAt: '2026-10-13T03:00:00.000Z' };

test('scalar audit changes use catalog labels, enum presentation, and accurate inheritance semantics', () => {
    const entry = presentAuditEntry({ ...record, action: 'setting.update', settingKey: 'media_display_mode', before: 'embed', after: 'link_only' }, catalog, 'ja');
    assert.equal(entry.actionLabel, '設定を変更'); assert.equal(entry.providerLabel, 'X / Twitter');
    assert.deepEqual(entry.changes, [{ key: 'media_display_mode', label: '画像・動画の表示方法', before: '本文と一緒に表示', after: 'リンクだけ表示' }]);
    assert.match(entry.time, /12:00/);
    const inherited = presentAuditEntry({ ...record, action: 'setting.update', settingKey: 'enabled', before: false, after: null }, catalog, 'ja');
    assert.equal(inherited.changes[0].after, '初期値を使用');
    const bot = presentAuditEntry({ ...record, action: 'setting.set', settingKey: 'enabled', before: false, after: true }, catalog, 'en');
    assert.equal(bot.actionLabel, 'Setting changed'); assert.equal(bot.changes[0].label, 'Expand links'); assert.equal(bot.changes[0].after, 'On');
});

test('admin map audits show named/changed settings while reset uses the captured historical default', () => {
    const entry = presentAuditEntry({ ...record, action: 'settings.change', settingKey: 'enabled,media_display_mode', before: { enabled: true, media_display_mode: 'embed', unchanged: 1 }, after: { enabled: false, media_display_mode: 'link_only', unchanged: 1 } }, catalog, 'ja');
    assert.deepEqual(entry.changes.map(change => change.key), ['enabled', 'media_display_mode']);
    assert.equal(entry.changes[0].after, '無効');
    const truncated = presentAuditEntry({ ...record, action: 'settings.change', settingKey: 'enabled,media_displ', before: { enabled: true, media_display_mode: 'embed' }, after: { enabled: false, media_display_mode: 'link_only' } }, catalog, 'ja');
    assert.deepEqual(truncated.changes.map(change => change.key), ['enabled', 'media_display_mode'], 'a truncated key list must not invent a setting change');
    const reset = presentAuditEntry({ ...record, action: 'provider.reset', before: [{ key: 'media_display_mode', kind: 'choice', spec: media, value: 'embed', defaultValue: 'link_only', customized: true }, { key: 'enabled', kind: 'boolean', spec: enabled, value: true, defaultValue: true, customized: false, changedFromDefault: false }], after: null }, catalog, 'ja');
    assert.equal(reset.changes.length, 1); assert.equal(reset.changes[0].after, 'リンクだけ表示');
    assert.equal(reset.details.before.length, 2, 'the optional record retains the complete snapshot');
});

test('server copy is displayed as a copy summary without inventing before/after setting values', () => {
    const copied = presentAuditEntry({ ...record, action: 'guild.sync', providerId: null, before: { sourceGuildId: '333', targetGuildId: '111' }, after: { sourceGuildId: '333', targetGuildId: '111', providerCount: 12, copied: 40, skippedTargets: 3 } }, catalog, 'ja');
    assert.equal(copied.actionLabel, '別サーバーから設定をコピー'); assert.deepEqual(copied.changes, []);
    assert.deepEqual(copied.facts.map(fact => fact.value), ['333', '12', '40', '3']);
    assert.match(copied.facts[3].label, /チャンネル・ロール/);
});

test('credentials are removed before browser serialization while non-secret audit fields remain available', () => {
    const unsafe = { ...record, action: 'future.action', requestId: 'request-123', before: { access_token: 'fixture-token', nested: { password: 'fixture-password', private_key: 'fixture-key' } }, after: { url: 'https://user:pass@example.invalid/file?X-Amz-Signature=fixture-signature&tag=public', webhook: 'https://discord.com/api/webhooks/123/fixture-webhook' } };
    const entry = presentAuditEntry(unsafe, catalog, 'ja');
    const serialized = JSON.stringify(entry);
    assert.doesNotMatch(serialized, /fixture-token|fixture-password|fixture-key|fixture-signature|fixture-webhook|user:pass/);
    assert.equal(entry.details.requestId, 'request-123'); assert.equal(entry.details.action, 'future.action');
    assert.match(serialized, /tag=public/);
    assert.deepEqual(redactAuditValue({ safe: ['one', 'two'], credential: 'hidden' }), { safe: ['one', 'two'], credential: '••••' });
});

test('history filters search human labels, group equivalent audit contracts, and lazy details retain complete records', async () => {
    const f = await reactFixture('export { AuditHistory } from "./features/audit/audit-history";');
    const entries = [presentAuditEntry({ ...record, action: 'setting.update', settingKey: 'media_display_mode', before: 'embed', after: 'link_only' }, catalog, 'ja'), presentAuditEntry({ ...record, auditLogId: 'audit-2', action: 'setting.set', settingKey: 'enabled', before: true, after: false }, catalog, 'ja')];
    try {
        await f.render(f.React.createElement(f.exports.AuditHistory, { entries, guildId: '111', locale: 'ja' }));
        assert.equal(f.container.querySelectorAll('li').length, 2); assert.equal(f.container.querySelectorAll('pre').length, 0);
        const actionField = f.field('操作で絞り込む'); assert.equal(actionField.options.length, 2, 'update/set actions share one human filter label');
        await f.fill(actionField, '設定を変更'); assert.equal(f.container.querySelectorAll('li').length, 2);
        await f.fill(f.field('変更履歴を検索'), '画像・動画'); assert.equal(f.container.querySelectorAll('li').length, 1);
        assert.match(f.container.textContent, /変更前.*本文と一緒に表示.*変更後.*リンクだけ表示/);
        const detail = f.container.querySelector('details');
        await f.act(async () => { detail.open = true; detail.dispatchEvent(new f.dom.window.Event('toggle', { bubbles: true })); });
        assert.match(f.container.querySelector('pre').textContent, /audit-1/); assert.match(f.container.querySelector('pre').textContent, /setting.update/);
        await f.fill(f.field('変更履歴を検索'), 'missing'); assert.match(f.container.textContent, /一致する変更履歴なし/);
        await f.click('検索条件をクリア'); assert.equal(f.container.querySelectorAll('li').length, 2);
    } finally { await f.close(); }
});

test('history requires Manage Server and gives a precise navigable denial before reading stored logs', async () => {
    let reads = 0;
    const AccessDenied = props => props;
    const { AuditLogsPage } = load('features/audit/audit-logs-page.tsx', {
        '@/lib/ui-rollout': { usesNewDashboardUI: async () => true },
        '@/lib/server-locale': { getDashboardLocale: async () => 'ja' }, '@/lib/server-session': { requireDashboardSession: async () => ({ user: { id: '796972193287503913', isAdmin: true } }) },
        '@/lib/discord': { getGuildAccess: async () => ({ name: 'Guild', canEdit: true, canManageGuild: false }) },
        '@/lib/audit-log': { listAuditLogs: async () => { reads++; return []; } }, '@/lib/settings-catalog': { getCatalog: () => catalog },
        '@/components/dashboard/access-denied': { AccessDenied }, '@/components/dashboard/dashboard-shell': { DashboardShell: props => props },
    });
    const result = await AuditLogsPage({ guildId: '111' });
    assert.equal(result.type, AccessDenied); assert.equal(result.props.guildId, '111'); assert.match(result.props.required, /サーバーの管理/); assert.equal(reads, 0);
});

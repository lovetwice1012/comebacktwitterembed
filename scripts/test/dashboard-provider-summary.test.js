'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/load-dashboard.cjs');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

const providers = [{ id: 'twitter', enabledByDefault: true }, { id: 'youtube', enabledByDefault: false }, { id: 'pixiv', enabledByDefault: false }];
function summaryLoader(rows, calls = [], registry = providers) {
    return load('lib/guild-provider-summary.ts', {
        '@/lib/settings-catalog': { getBotProviders: () => registry },
        '@/lib/prisma': { prisma: { $queryRawUnsafe: async (sql, ...params) => { calls.push({ sql, params }); if (rows instanceof Error) throw rows; return rows; } } },
    });
}

test('one bounded scalar query counts registry defaults and per-guild overrides instead of unloaded zeros', async () => {
    const calls = [];
    const api = summaryLoader([
        { guild_id: 'A', provider_id: 'twitter', enabled: null },
        { guild_id: 'A', provider_id: 'youtube', enabled: 1 },
        { guild_id: 'A', provider_id: 'pixiv', enabled: false },
        { guild_id: 'B', provider_id: 'twitter', enabled: 0 },
        { guild_id: 'B', provider_id: 'youtube', enabled: null },
        { guild_id: 'B', provider_id: 'pixiv', enabled: BigInt(1) },
        { guild_id: 'A', provider_id: 'removed-provider', enabled: 1 },
        { guild_id: 'not-authorized', provider_id: 'twitter', enabled: false },
    ], calls);
    const result = await api.getVisibleGuildProviderSummaries(['A', 'B', 'C', 'A']);
    assert.deepEqual(result.get('A'), { enabled: 2, disabled: 1, total: 3 });
    assert.deepEqual(result.get('B'), { enabled: 1, disabled: 2, total: 3 });
    assert.deepEqual(result.get('C'), { enabled: 1, disabled: 2, total: 3 });
    assert.equal(result.has('not-authorized'), false);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /^SELECT guild_id, provider_id, enabled FROM/);
    assert(!calls[0].sql.includes('SELECT *'));
    assert.deepEqual(calls[0].params, ['A', 'B', 'C', 'twitter', 'youtube', 'pixiv']);
});

test('explicit truth values match settings storage, null inherits, and all-disabled remains a real 0/3', async () => {
    for (const value of [true, 1, BigInt(1)]) {
        const result = await summaryLoader([{ guild_id: 'A', provider_id: 'youtube', enabled: value }]).getVisibleGuildProviderSummaries(['A']);
        assert.equal(result.get('A').enabled, 2);
    }
    for (const value of [false, 0, BigInt(0), '1']) {
        const result = await summaryLoader([{ guild_id: 'A', provider_id: 'twitter', enabled: value }]).getVisibleGuildProviderSummaries(['A']);
        assert.deepEqual(result.get('A'), { enabled: 0, disabled: 3, total: 3 });
    }
});

test('empty visibility never queries; large visibility chunks bound queries and bind every ID', async () => {
    const calls = [], api = summaryLoader([], calls);
    assert.equal((await api.getVisibleGuildProviderSummaries([])).size, 0);
    assert.equal(calls.length, 0);
    const ids = Array.from({ length: 251 }, (_, i) => `guild-${i}`);
    const result = await api.getVisibleGuildProviderSummaries(ids);
    assert.equal(result.size, 251); assert.equal(calls.length, 2);
    assert.equal(calls[0].params.length, 250 + providers.length);
    assert.equal(calls[1].params.length, 1 + providers.length);
    const literal = "guild' OR 1=1 --";
    await api.getVisibleGuildProviderSummaries([literal]);
    assert(!calls[2].sql.includes(literal)); assert.equal(calls[2].params[0], literal);
});

test('failed summary reads reject rather than returning defaults that look confirmed', async () => {
    await assert.rejects(summaryLoader(new Error('fixture DB unavailable')).getVisibleGuildProviderSummaries(['A']), /fixture DB unavailable/);
});

test('new directory never prints an unloaded 0/0 and offers a refresh while retaining real zero-active counts', async () => {
    let refreshes = 0;
    const f = await reactFixture('export { GuildList } from "./components/dashboard/guild-list";', { moduleOverrides: { 'next/navigation': { useRouter: () => ({ refresh() { refreshes++; } }) } } });
    try {
        const guild = { guildId: '111111', name: 'Summary test', iconUrl: null, canEdit: true, canManageGuild: true, permissions: { administrator: true, manageGuild: true, manageChannels: true } };
        for (const providerSummary of [null, { enabled: 0, disabled: 0, total: 0 }]) {
            await f.render(f.React.createElement(f.exports.GuildList, { locale: 'ja', guilds: [{ ...guild, providerSummary }] }));
            assert(!f.container.textContent.includes('0 / 0'));
            assert(f.container.textContent.includes('件数を取得できませんでした'));
            await f.click('件数を再取得');
        }
        assert.equal(refreshes, 2);
        await f.render(f.React.createElement(f.exports.GuildList, { locale: 'ja', guilds: [{ ...guild, providerSummary: { enabled: 0, disabled: 3, total: 3 } }] }));
        assert(f.container.textContent.includes('展開中 0 / 3サービス'));
        assert(!f.container.textContent.includes('件数を取得できませんでした'));
        assert(![...f.container.querySelectorAll('button')].some(button => button.textContent === '件数を再取得'));
    } finally { await f.close(); }
});

test('preview list reads summaries only for authorized returned guilds and leaves the legacy path untouched', async () => {
    const owner = '796972193287503913', other = '933314562487386122', summaryCalls = [], visibleCalls = [];
    let current = { user: { id: owner, isAdmin: true } };
    const marker = name => Object.assign(props => props, { displayName: name });
    const summary = { enabled: 1, disabled: 2, total: 3 };
    const mocks = {
        '@/lib/ui-rollout': { usesNewDashboardUI: session => session.user.id === owner },
        '@/lib/server-session': { requireDashboardSession: async () => current },
        '@/lib/server-locale': { getDashboardLocale: async () => 'ja' },
        '@/lib/discord': { listVisibleGuilds: async (_session, options) => { visibleCalls.push(options); return [{ guildId: 'authorized', name: 'Allowed', canEdit: true, canManageGuild: true }]; } },
        '@/lib/guild-provider-summary': { getVisibleGuildProviderSummaries: async ids => { summaryCalls.push(ids); return new Map([['authorized', summary]]); } },
        '@/components/dashboard/guild-list': { GuildList: marker('GuildList') },
        '@/components/dashboard/dashboard-shell': { DashboardShell: marker('Shell') },
        '@/legacy/pages/dashboard': { __esModule: true, default: marker('LegacyPage') },
    };
    const page = load('app/dashboard/page.tsx', mocks).default;
    const result = await page({ searchParams: Promise.resolve({ mode: 'user' }) });
    const list = result.props.children.props.children.find(child => child.type?.displayName === 'GuildList');
    assert.deepEqual(list.props.guilds[0].providerSummary, summary);
    assert.deepEqual(visibleCalls, [{ loadProviderSummary: false }]);
    assert.deepEqual(summaryCalls, [['authorized']]);
    current = { user: { id: other, isAdmin: true } };
    const legacy = await page({ searchParams: Promise.resolve({ mode: 'user' }) });
    assert.equal(legacy.type.displayName, 'LegacyPage');
    assert.equal(summaryCalls.length, 1); assert.equal(visibleCalls.length, 1);
});

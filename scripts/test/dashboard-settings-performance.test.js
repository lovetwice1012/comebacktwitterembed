'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadDashboard = require('./helpers/load-dashboard.cjs');

function fixture() {
    const calls = [];
    const rows = {
        guild_provider_settings: [
            { provider_id: 'twitter', guild_id: 'g1', enabled: 0, default_language: 'en-US', quote_repost_max_depth: 3 },
            { provider_id: 'pixiv', guild_id: 'g1', enabled: null, pixiv_images_per_step: 2 },
            { provider_id: 'github', guild_id: 'g1', enabled: 1n },
            { provider_id: 'twitter', guild_id: 'g2', enabled: 1 },
        ],
        guild_provider_banned_words: [{ provider_id: 'twitter', guild_id: 'g1', word: 'blocked' }],
        guild_provider_button_visibility: [{ provider_id: 'twitter', guild_id: 'g1', button_key: 'delete', hidden: 1 }],
        guild_provider_disable_targets: [{ provider_id: 'github', guild_id: 'g1', target_type: 'role', target_id: 'role-1' }],
        guild_provider_sensitive_content_allowed_targets: [{ provider_id: 'pixiv', guild_id: 'g1', target_type: 'channel', target_id: 'channel-1' }],
    };
    async function query(sql, ...params) {
        if (Array.isArray(sql)) sql = sql.join('?');
        calls.push(sql);
        const table = sql.match(/FROM\s+(\w+)/i)?.[1];
        const guildFirst = /WHERE guild_id/.test(sql);
        const guild = params[guildFirst ? 0 : 1];
        const providers = guildFirst ? params.slice(1) : [params[0]];
        return (rows[table] || []).filter(row => row.guild_id === guild && (!providers.length || providers.includes(row.provider_id)));
    }
    const settings = loadDashboard('lib/settings-db.ts', {
        '@/lib/prisma': { prisma: { $queryRaw: query, $queryRawUnsafe: query } },
        '@/lib/audit-log': { recordAuditLog() {} },
    });
    return { settings, calls };
}

test('batched provider pages preserve every setting, default, warning and target with fewer queries', async t => {
    const { settings, calls } = fixture();
    const providers = settings.catalogForGuild();
    const expected = [];
    for (const provider of providers) {
        const values = await settings.getProviderSettingsState(provider.providerId, 'g1');
        expected.push(...values.map(setting => ({ providerId: provider.providerId, setting })));
    }
    const individualQueries = calls.length;
    calls.length = 0;
    const actual = await settings.getCrossProviderSettings('g1');
    assert.deepEqual(actual.map(({ providerId, setting }) => ({ providerId, setting })), expected);
    assert.ok(calls.length <= 11, `${calls.length} batch queries`);
    assert.ok(individualQueries > calls.length * 5, `${individualQueries} -> ${calls.length}`);
    t.diagnostic(`${providers.length} providers: ${individualQueries} individual queries -> ${calls.length} batched queries`);
    calls.length = 0;
    const overview = await settings.getProvidersOverview('g1');
    const expectedEnabled = overview.filter(provider => provider.enabled).length;
    calls.length = 0;
    assert.deepEqual(await settings.getProviderSummary('g1'), {
        enabled: expectedEnabled, disabled: providers.length - expectedEnabled, total: providers.length,
    });
    assert.equal(calls.length, 1);
    const otherGuild = await settings.getCrossProviderSettings('g2');
    assert.equal(otherGuild.find(row => row.providerId === 'twitter' && row.setting.key === 'enabled').setting.value, true);
});

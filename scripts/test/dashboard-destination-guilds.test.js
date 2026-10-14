'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/load-dashboard.cjs');
const A = '111111111111111111', B = '222222222222222222', C = '333333333333333333';

test('personal destination guilds include only current account memberships with the Bot, without requiring Dashboard management access', async () => {
    const original = global.fetch, calls = [];
    try {
        global.fetch = async (url, options) => {
            calls.push({ url: String(url), authorization: options.headers.Authorization });
            assert.equal(String(url), 'https://discord.com/api/v10/users/@me/guilds');
            const guilds = options.headers.Authorization === 'Bearer owner-fixture'
                ? [{ id: A, name: 'Channel member', permissions: '0' }, { id: B, name: 'Bot absent', permissions: '8' }]
                : [{ id: C, name: 'Other account', permissions: '0' }];
            return { ok: true, json: async () => guilds };
        };
        const discord = load('lib/discord.ts', {
            '@/lib/env': { getBotToken: () => 'never-used-token', getDashboardFlag: () => false, getDashboardNumber: (_key, _env, fallback) => fallback },
            '@/lib/prisma': { prisma: { $queryRaw: async () => [{ guild_id: A }, { guild_id: C }] } },
            '@/lib/delegated-access': {
                isDiscordSnowflake: value => /^\d{16,22}$/.test(value), delegatedAccessEnabledForGuild: () => false,
                delegatedAccessLevelForTargets: () => null, listDelegatedAccess: async () => [],
            },
            '@/lib/permissions': { parsePermissions: () => ({}), canViewSettings: () => false, canEditSettings: () => false, canManageGuildSettings: () => false },
        });
        const session = token => ({ accessToken: token, user: { id: A } });
        assert.deepEqual(await discord.listNotificationDestinationGuilds(session('owner-fixture')), [{ guildId: A, name: 'Channel member' }]);
        assert.deepEqual(await discord.listVisibleGuilds(session('owner-fixture'), { loadProviderSummary: false }), []);
        assert.deepEqual(await discord.listNotificationDestinationGuilds(session('other-fixture')), [{ guildId: C, name: 'Other account' }]);
        assert(calls.every(call => !call.url.includes('/members') && !call.url.includes('/webhooks')));
    } finally { global.fetch = original; }
});

test('guild directory destination purpose stays authenticated and private, preserves the ordinary directory, and hides upstream errors', async () => {
    let session = { user: { id: A }, accessToken: 'fixture-no-real-oauth' }, fail = false;
    const calls = [];
    const route = load('app/api/guilds/route.ts', {
        '@/lib/api': {
            requireSession: async () => { if (!session) throw Object.assign(new Error('ログインが必要です。'), { status: 401 }); return session; },
            json: (data, status = 200) => new Response(JSON.stringify(data), { status }),
            errorResponse: error => new Response(JSON.stringify({ error: error.message }), { status: error.status || 500 }),
        },
        '@/lib/server-locale': { getDashboardLocaleFromRequest: () => 'ja' },
        '@/lib/discord': {
            listVisibleGuilds: async given => { assert.equal(given, session); calls.push('ordinary'); return [{ guildId: B, canEdit: true }]; },
            listNotificationDestinationGuilds: async given => { assert.equal(given, session); calls.push('destinations'); if (fail) throw new Error('private-upstream-token-and-body'); return [{ guildId: A, name: 'Allowed' }]; },
        },
    });
    const request = query => route.GET(new Request(`https://fixture.invalid/api/guilds${query}`));
    let response = await request(''); assert.equal(response.status, 200); assert.deepEqual(await response.json(), [{ guildId: B, canEdit: true }]);
    response = await request('?purpose=notification-destinations&userId=forged');
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.deepEqual(await response.json(), [{ guildId: A, name: 'Allowed' }]);
    fail = true; response = await request('?purpose=notification-destinations'); assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store'); assert(!(await response.text()).includes('private-upstream'));
    session = null; response = await request('?purpose=notification-destinations'); assert.equal(response.status, 401);
    assert.deepEqual(calls, ['ordinary', 'destinations', 'destinations']);
});

'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/load-dashboard.cjs');

const originalFetch = global.fetch;
const originalFlag = process.env.DASHBOARD_DELEGATED_ACCESS_ENABLED;
process.env.DASHBOARD_DELEGATED_ACCESS_ENABLED = 'true';

afterEach(() => {
    global.fetch = originalFetch;
    if (originalFlag === undefined) delete process.env.DASHBOARD_DELEGATED_ACCESS_ENABLED;
    else process.env.DASHBOARD_DELEGATED_ACCESS_ENABLED = originalFlag;
});

function response(body, ok = true, status = 200) {
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function loadDiscord() {
    return load('lib/discord.ts', {
        '@/lib/env': {
            getBotToken: () => 'bot-token',
            getDashboardFlag: (_key, envName) => envName === 'DASHBOARD_DELEGATED_ACCESS_ENABLED',
            getDashboardNumber: (_key, _envName, fallback) => fallback,
        },
        '@/lib/delegated-access': {
            delegatedAccessEnabled: () => true,
            delegatedAccessEnabledForGuild: () => true,
            delegatedAccessLevelForTargets: () => null,
            isDiscordSnowflake: value => /^\d{16,24}$/.test(value),
            listDelegatedAccess: async () => [],
        },
        '@/lib/prisma': { prisma: {} },
        '@/lib/permissions': {
            canEditSettings: () => false,
            canManageGuildSettings: () => false,
            canViewSettings: () => false,
            parsePermissions: () => ({}),
        },
    });
}

test('dashboard access directory fetches an explicitly identified member and never calls members/search', async () => {
    const calls = [];
    global.fetch = async url => {
        calls.push(String(url));
        if (String(url).endsWith('/members/123456789012345678')) {
            return response({ user: { id: '123456789012345678', username: 'target', avatar: null }, nick: '対象', avatar: null, roles: [] });
        }
        if (String(url).endsWith('/roles')) return response([{ id: '234567890123456789', name: 'staff', color: 0, managed: false, position: 1 }]);
        throw new Error(`unexpected URL: ${url}`);
    };

    const result = await loadDiscord().fetchGuildAccessDirectory('345678901234567890', '123456789012345678');
    assert.deepEqual(result.members.map(member => member.id), ['123456789012345678']);
    assert.equal(result.roles[0].name, 'staff');
    assert.equal(calls.some(url => url.includes('/members/search')), false);
    assert.equal(calls.some(url => url.endsWith('/members/123456789012345678')), true);
});

test('dashboard access directory rejects name-like searches without making a member search request', async () => {
    const calls = [];
    global.fetch = async url => {
        calls.push(String(url));
        if (String(url).endsWith('/roles')) return response([]);
        throw new Error(`unexpected URL: ${url}`);
    };

    const result = await loadDiscord().fetchGuildAccessDirectory('345678901234567890', 'target-name');
    assert.deepEqual(result.members, []);
    assert.match(result.directoryError, /ユーザーID/);
    assert.equal(calls.some(url => url.includes('/members')), false);
});

test('dashboard access directory reloads existing user grants by ID', async () => {
    const calls = [];
    global.fetch = async url => {
        calls.push(String(url));
        if (String(url).endsWith('/members/123456789012345678')) {
            return response({ user: { id: '123456789012345678', username: 'existing', avatar: null }, nick: null, roles: [] });
        }
        if (String(url).endsWith('/roles')) return response([]);
        throw new Error(`unexpected URL: ${url}`);
    };

    const result = await loadDiscord().fetchGuildAccessDirectory(
        '345678901234567890',
        '',
        ['123456789012345678'],
    );
    assert.deepEqual(result.members.map(member => member.username), ['existing']);
    assert.equal(calls.some(url => url.includes('/members/search')), false);
});

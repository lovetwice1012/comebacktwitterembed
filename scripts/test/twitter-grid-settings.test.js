'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const settings = require('../../src/providers/_provider_settings');
const { getProviderSettingSpecs } = require('../../src/providers/_setting_specs');
const loadDashboard = require('./helpers/load-dashboard.cjs');

test('X image layout defaults and choices are isolated per server and provider', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
        const twitter = { id: 'twitter', enabledByDefault: true };
        const specs = getProviderSettingSpecs(twitter);
        assert.equal(specs.find(spec => spec.key === 'twitter_grid_cell_size').label.ja, '画像サイズの目安');
        assert.match(specs.find(spec => spec.key === 'twitter_grid_fit').choices.find(choice => choice.value === 'contain').label.ja, /自動調整/);
        const expected = {
            twitter_grid_default_layout: 'grid', twitter_grid_columns: 2, twitter_grid_gap: 4,
            twitter_grid_background: '#000000', twitter_grid_fit: 'contain', twitter_grid_cell_size: 512,
            twitter_grid_quality: 85, twitter_grid_default_visibility: 'private', twitter_grid_replace_permission: 'restricted',
        };
        for (const [key, value] of Object.entries(expected)) {
            const spec = specs.find(item => item.key === key);
            assert.equal(spec.kind, 'choice', key);
            assert.ok(spec.choices.some(choice => String(choice.value) === String(value)), key);
            assert.equal(await settings.getSetting(twitter, key, 'grid-server-a'), value, key);
            assert.equal(settings.PROVIDER_SETTING_COLUMNS[key].column, key);
        }
        assert.equal(getProviderSettingSpecs({ id: 'pixiv' }).some(spec => spec.key.startsWith('twitter_grid_')), false);
        await settings.setSetting(twitter, 'twitter_grid_replace_permission', 'grid-server-a', 'everyone');
        await settings.setSetting(twitter, 'twitter_grid_columns', 'grid-server-a', 5);
        const first = await settings.getProviderSettings(twitter, 'grid-server-a');
        const second = await settings.getProviderSettings(twitter, 'grid-server-b');
        assert.equal(first.twitter_grid_replace_permission, 'everyone');
        assert.equal(first.twitter_grid_columns, 5);
        assert.equal(second.twitter_grid_replace_permission, 'restricted');
        assert.equal(second.twitter_grid_columns, 2);
        const migration = fs.readFileSync(path.join(__dirname, '../../migrations/20261113_add_twitter_image_grid_settings.sql'), 'utf8');
        for (const key of Object.keys(expected)) assert.match(migration, new RegExp(`\\b${key}\\b`));
    } finally {
        if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
    }
});

test('server settings reject unknown grid values and require server management to allow public replacement by everyone', () => {
    const { validateProviderChanges } = loadDashboard('lib/settings-validation.ts');
    const everyone = validateProviderChanges('twitter', { changes: { twitter_grid_replace_permission: 'everyone', twitter_grid_columns: '4' } }, 'ja');
    assert.equal(everyone.dangerous, true);
    assert.equal(everyone.changes.twitter_grid_columns, 4);
    assert.equal(validateProviderChanges('twitter', { changes: { twitter_grid_replace_permission: 'restricted' } }, 'ja').dangerous, false);
    assert.throws(() => validateProviderChanges('twitter', { changes: { twitter_grid_replace_permission: 'anyone-else' } }, 'ja'));
    assert.throws(() => validateProviderChanges('twitter', { changes: { twitter_grid_columns: 200 } }, 'ja'));
    const custom = validateProviderChanges('twitter', { changes: { twitter_grid_columns: '7', twitter_grid_gap: '13', twitter_grid_cell_size: '777', twitter_grid_quality: '91', twitter_grid_background: '#12aBcD' } }, 'ja');
    assert.deepEqual(custom.changes, { twitter_grid_columns: 7, twitter_grid_gap: 13, twitter_grid_cell_size: 777, twitter_grid_quality: 91, twitter_grid_background: '#12abcd' });
    assert.throws(() => validateProviderChanges('twitter', { changes: { twitter_grid_background: 'red' } }, 'ja'));
    assert.throws(() => validateProviderChanges('pixiv', { changes: { twitter_grid_replace_permission: 'everyone' } }, 'ja'));
    assert.equal(validateProviderChanges('twitter', { changes: { button_invisible: { tg: true } } }, 'ja').changes.button_invisible.tg, true);
    assert.equal(validateProviderChanges('pixiv', { changes: { button_invisible: { tg: true } } }, 'ja').changes.button_invisible.tg, undefined);
});

test('the settings API blocks non-managers from allowing everyone to replace a post', async () => {
    let canManageGuild = false, saves = 0;
    const route = loadDashboard('app/api/guilds/[guildId]/providers/[providerId]/settings/route.ts', {
        '@/lib/api': {
            requireGuildPermission: async () => ({ session: { user: { id: '123456789012345678', username: 'fixture' } }, access: { canManageGuild, permissions: '0' } }),
            json: (body, status = 200) => ({ body, status }),
            errorResponse: error => { throw error; }, requestMeta: () => ({}),
        },
        '@/lib/server-locale': { getDashboardLocaleFromRequest: () => 'ja' },
        '@/lib/settings-db': { saveProviderSettings: async () => { saves++; return { saved: true }; } },
    });
    const request = { json: async () => ({ changes: { twitter_grid_replace_permission: 'everyone' } }) };
    const context = { params: Promise.resolve({ guildId: '123456789012345678', providerId: 'twitter' }) };
    const denied = await route.PATCH(request, context);
    assert.equal(denied.status, 403); assert.equal(saves, 0);
    canManageGuild = true;
    const accepted = await route.PATCH(request, context);
    assert.equal(accepted.status, 200); assert.equal(saves, 1);
});

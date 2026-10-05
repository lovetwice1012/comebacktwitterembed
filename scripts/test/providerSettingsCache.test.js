'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
    SETTINGS_PATH, TARGET_TABLES, compileSettings, createFixtureDatabase,
} = require('../benchmark_main_settings');

const source = fs.readFileSync(SETTINGS_PATH, 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const provider = { id: 'twitter', enabledByDefault: true };

function fixture(mode = 'populated') {
    const database = createFixtureDatabase(mode);
    let now = 1000000;
    class ClockDate extends Date { static now() { return now; } }
    const settings = compileSettings(source, database.queryDatabase, { Date: ClockDate });
    settings._internal.providerSettingsCache.now = () => now;
    return { database, settings, advance: ms => { now += ms; } };
}

function assertTargets(value, providerId, guildId, empty = false) {
    for (const key of Object.keys(TARGET_TABLES)) {
        const prefix = `${providerId}/${guildId}/${key}`;
        assert.deepEqual(value[key], {
            user: empty ? [] : [`${prefix}/user`],
            channel: empty ? [] : [`${prefix}/channel`],
            role: empty ? [] : [`${prefix}/role`],
        }, key);
    }
}

test('production cold load preserves all eight target categories and normalized scalar/button values', async () => {
    const { database, settings } = fixture();
    const value = await settings._internal.loadProviderSettings(provider, 'guild-a');
    assert.equal(database.queries.length, 4);
    assertTargets(value, 'twitter', 'guild-a');
    assert.equal(value.enabled, true);
    assert.equal(value.defaultLanguage, 'en');
    assert.equal(value.passive_mode, false);
    assert.equal(value.quote_repost_max_depth, 3);
    assert.deepEqual(value.quote_repost_depth_by_account, { alice: 2, bob: 0 });
    assert.deepEqual(value.hidden_output_items, ['media', 'title']);
    assert.deepEqual(value.bannedWords, ['alpha', 'beta']);
    assert.deepEqual(value.button_invisible, {
        showMediaAsAttachments: false, showAttachmentsAsEmbedsImage: false,
        translate: true, delete: false, all: false, savetweet: true,
        personal: false, personal_save: false, personal_remind: false, personal_restock: false, gallery: false,
    });

    const union = database.queries.find(({ sql }) => sql.includes('UNION ALL'));
    assert.ok(union);
    const branches = union.sql.split(/\s+UNION ALL\s+/i);
    assert.equal(branches.length, 8);
    const seen = new Set();
    branches.forEach((sql, index) => {
        const [key, providerId, guildId] = union.params.slice(index * 3, index * 3 + 3);
        assert.equal(providerId, 'twitter');
        assert.equal(guildId, 'guild-a');
        assert.match(sql, /SELECT \? AS setting_key, target_type, target_id/i);
        assert.ok(sql.includes(`FROM ${TARGET_TABLES[key]} WHERE provider_id = ? AND guild_id = ?`));
        seen.add(key);
    });
    assert.deepEqual([...seen].sort(), Object.keys(TARGET_TABLES).sort());
    assert.equal(union.params.length, 24);
    for (const query of database.queries.filter(query => query !== union)) {
        assert.deepEqual(query.params, ['twitter', 'guild-a']);
    }
});

test('empty production rows retain defaults and independent empty target arrays', async () => {
    const { database, settings } = fixture('empty');
    for (const input of [provider, { id: 'pixiv', enabledByDefault: false }]) {
        const value = await settings._internal.loadProviderSettings(input, 'empty');
        assertTargets(value, input.id, 'empty', true);
        assert.equal(value.enabled, input.enabledByDefault);
        assert.equal(value.defaultLanguage, 'ja');
        assert.deepEqual(value.bannedWords, []);
        assert.ok(Object.values(value.button_invisible).every(hidden => hidden === false));
        assert.deepEqual(value.hidden_output_items, []);
        assert.deepEqual(value.quote_repost_depth_by_account, input.id === 'twitter' ? {} : undefined);
        value.disable.role.push('changed');
        assert.deepEqual(value.button_disabled.role, []);
        assert.deepEqual(value.sensitive_content_allowed_targets.role, []);
    }
    assert.equal(database.queries.length, 8);
});

test('concurrent production reads share one cold load and isolate provider/guild cache keys', async () => {
    const { database, settings } = fixture();
    database.beforeQuery = tick;
    const scopes = [['twitter', 'guild-a'], ['twitter', 'guild-b'], ['pixiv', 'guild-a']];
    const results = await Promise.all(scopes.map(([id, guildId]) => Promise.all(
        Array.from({ length: 100 }, () => settings.getProviderSettings({ id }, guildId)),
    )));
    assert.equal(database.queries.length, 1 + 4 * scopes.length);
    assert.equal(database.queries.filter(({ sql }) => sql.includes('MAX(revision)')).length, 1);
    results.forEach((values, index) => {
        assert.ok(values.every(value => value === values[0]));
        assertTargets(values[0], ...scopes[index]);
    });
    const count = database.queries.length;
    assert.equal(await settings.getProviderSettings(provider, 'guild-a'), results[0][0]);
    assert.equal(database.queries.length, count);
});

test('local production setting mutation invalidates only its scope and retains audited transaction', async () => {
    const { database, settings } = fixture();
    const original = await settings.getProviderSettings(provider, 'guild-a');
    const other = await settings.getProviderSettings(provider, 'guild-b');
    await settings.setSetting(provider, 'enabled', 'guild-a', false);
    const count = database.queries.length;
    const refreshed = await Promise.all(Array.from({ length: 100 }, () => settings.getProviderSettings(provider, 'guild-a')));
    assert.ok(refreshed.every(value => value === refreshed[0] && value.enabled === false));
    assert.notEqual(refreshed[0], original);
    assertTargets(refreshed[0], 'twitter', 'guild-a');
    assert.equal(database.queries.length - count, 4);
    assert.equal(await settings.getProviderSettings(provider, 'guild-b'), other);
    assert.ok(database.queries.some(({ sql }) => sql.includes('FOR UPDATE')));
    assert.equal(database.auditRows.length, 1);
    assert.deepEqual(database.auditRows[0].slice(0, 3), ['guild-a', 'twitter', 'enabled']);
    assert.equal(database.auditRows[0][5], 'true');
    assert.equal(database.auditRows[0][6], 'false');
    assert.deepEqual(database.invalidations, [{ revision: 1, provider_id: 'twitter', guild_id: 'guild-a' }]);
});

test('remote invalidation and TTL expiry reload production rows while other scopes stay cached', async () => {
    const { database, settings, advance } = fixture();
    const original = await settings.getProviderSettings(provider, 'guild-a');
    const other = await settings.getProviderSettings(provider, 'guild-b');
    database.scope('twitter', 'guild-a').scalar.enabled = 0;
    database.invalidations.push({ revision: 1, provider_id: 'twitter', guild_id: 'guild-a' });
    advance(251);
    const count = database.queries.length;
    const refreshed = await settings.getProviderSettings(provider, 'guild-a');
    assert.equal(refreshed.enabled, false);
    assert.notEqual(refreshed, original);
    assert.equal(await settings.getProviderSettings(provider, 'guild-b'), other);
    assert.equal(database.queries.length - count, 5);
    database.scope('twitter', 'guild-a').scalar.enabled = 1;
    advance(30000);
    assert.equal((await settings.getProviderSettings(provider, 'guild-a')).enabled, true);
});

for (const failedRead of ['scalar', 'targets', 'words', 'visibility']) {
    test(`failed production ${failedRead} read rejects all shared callers and permits a fresh retry`, async () => {
        const { database, settings } = fixture();
        const error = new Error(`synthetic ${failedRead} query failure`);
        const matches = {
            scalar: sql => sql.includes('SELECT *'),
            targets: sql => sql.includes('UNION ALL'),
            words: sql => sql.includes('SELECT word'),
            visibility: sql => sql.includes('SELECT button_key'),
        };
        database.beforeQuery = async sql => {
            await tick();
            if (matches[failedRead](sql)) throw error;
        };
        const results = await Promise.allSettled(Array.from({ length: 100 }, () => settings.getProviderSettings(provider, 'guild-a')));
        assert.ok(results.every(result => result.status === 'rejected' && result.reason === error));
        assert.equal(database.queries.length, 5);
        assert.equal(settings._internal.providerSettingsCache.size, 0);
        await tick(); // Let other reads from the rejected Promise.all settle.
        database.beforeQuery = tick;
        const retry = await Promise.all(Array.from({ length: 100 }, () => settings.getProviderSettings(provider, 'guild-a')));
        assert.ok(retry.every(value => value === retry[0]));
        assertTargets(retry[0], 'twitter', 'guild-a');
        assert.equal(database.queries.length, 9);
    });
}

test('failed production invalidation poll rejects callers before loading settings and retries next poll', async () => {
    const { database, settings, advance } = fixture();
    const error = new Error('synthetic checkpoint failure');
    database.beforeQuery = async sql => {
        await tick();
        if (sql.includes('MAX(revision)')) throw error;
    };
    const results = await Promise.allSettled(Array.from({ length: 100 }, () => settings.getProviderSettings(provider, 'guild-a')));
    assert.ok(results.every(result => result.status === 'rejected' && result.reason === error));
    assert.equal(database.queries.length, 1);
    assert.equal(settings._internal.providerSettingsCache.size, 0);
    database.beforeQuery = tick;
    advance(251);
    assertTargets(await settings.getProviderSettings(provider, 'guild-a'), 'twitter', 'guild-a');
    assert.equal(database.queries.length, 6);
});

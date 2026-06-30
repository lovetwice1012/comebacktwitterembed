'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    SETTINGS_DEFAULT_FILE,
    SETTINGS_MIGRATIONS,
    PROVIDER_SETTING_COLUMNS: migrationProviderSettingColumns,
} = require('../../src/settings');
const {
    PROVIDER_SETTING_COLUMNS: liveProviderSettingColumns,
} = require('../../src/providers/_provider_settings');

test('settings migration provider setting columns do not drift from live provider settings', () => {
    assert.deepEqual(
        Object.keys(migrationProviderSettingColumns).sort(),
        Object.keys(liveProviderSettingColumns).sort(),
        'src/settings.js provider setting keys must stay aligned with src/providers/_provider_settings.js'
    );

    for (const [key, liveSpec] of Object.entries(liveProviderSettingColumns)) {
        assert.deepEqual(
            migrationProviderSettingColumns[key],
            liveSpec,
            `src/settings.js provider setting definition drifted for ${key}`
        );
    }
});

test('settings migrations include TikTok video fallback mode', () => {
    assert.deepEqual(SETTINGS_DEFAULT_FILE.tiktok_video_fallback_mode, {});
    assert.deepEqual(SETTINGS_MIGRATIONS.tiktok_video_fallback_mode, {});
    assert.equal(migrationProviderSettingColumns.tiktok_video_fallback_mode.column, 'tiktok_video_fallback_mode');
    assert.equal(migrationProviderSettingColumns.tiktok_video_fallback_mode.type, 'string');
});

test('settings defaults and file migrations cover provider setting buckets', () => {
    for (const key of Object.keys(liveProviderSettingColumns).filter(key => key !== 'enabled')) {
        assert.deepEqual(SETTINGS_DEFAULT_FILE[key], {}, `SETTINGS_DEFAULT_FILE missing ${key}`);
        assert.deepEqual(SETTINGS_MIGRATIONS[key], {}, `SETTINGS_MIGRATIONS missing ${key}`);
    }
});

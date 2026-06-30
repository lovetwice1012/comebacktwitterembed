'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { TABLES, SCHEMA_STATEMENTS, MIGRATIONS_DIR, _internal } = require('../../src/db_schema');
const { PROVIDER_SETTING_COLUMNS } = require('../../src/providers/_provider_settings');

test('database schema declares migration tracking', () => {
    assert.equal(TABLES.schemaMigrations, 'schema_migrations');
    assert.ok(SCHEMA_STATEMENTS.some(statement => statement.includes(TABLES.schemaMigrations)));
});

test('youtube description length migration is present', () => {
    const file = path.join(MIGRATIONS_DIR, '20260630_add_youtube_description_max_length.sql');
    const sql = fs.readFileSync(file, 'utf8');

    assert.ok(_internal.listMigrationFiles().includes('20260630_add_youtube_description_max_length.sql'));
    assert.ok(sql.includes('ALTER TABLE guild_provider_settings'));
    assert.ok(sql.includes('youtube_description_max_length'));
    assert.ok(sql.includes('youtube_video_list_limit'));
    assert.equal(PROVIDER_SETTING_COLUMNS.youtube_description_max_length.column, 'youtube_description_max_length');
    assert.equal(PROVIDER_SETTING_COLUMNS.youtube_description_max_length.type, 'int');
    assert.equal(PROVIDER_SETTING_COLUMNS.youtube_video_list_limit.column, 'youtube_video_list_limit');
    assert.equal(PROVIDER_SETTING_COLUMNS.youtube_video_list_limit.type, 'int');
});

test('tiktok hq migration is present', () => {
    const file = path.join(MIGRATIONS_DIR, '20260630_add_zz_tiktok_hq.sql');
    const sql = fs.readFileSync(file, 'utf8');

    assert.ok(_internal.listMigrationFiles().includes('20260630_add_zz_tiktok_hq.sql'));
    assert.ok(sql.includes('ALTER TABLE guild_provider_settings'));
    assert.ok(sql.includes('tiktok_hq'));
    assert.ok(sql.includes('AFTER youtube_video_list_limit'));
    assert.equal(PROVIDER_SETTING_COLUMNS.tiktok_hq.column, 'tiktok_hq');
    assert.equal(PROVIDER_SETTING_COLUMNS.tiktok_hq.type, 'bool');
});

test('provider output settings migration is present', () => {
    const file = path.join(MIGRATIONS_DIR, '20260630_add_zzz_provider_output_settings.sql');
    const sql = fs.readFileSync(file, 'utf8');
    const expected = {
        twitter_text_mode: 'string',
        twitter_stats_layout: 'string',
        twitter_quote_mode: 'string',
        twitter_quote_layout: 'string',
        pixiv_caption_max_length: 'int',
        pixiv_tag_limit: 'string',
        instagram_caption_max_length: 'int',
        instagram_media_limit: 'int',
        github_card_style: 'string',
        hidden_output_items: 'jsonArray',
    };

    assert.ok(_internal.listMigrationFiles().includes('20260630_add_zzz_provider_output_settings.sql'));
    assert.ok(sql.includes('ALTER TABLE guild_provider_settings'));
    for (const [key, type] of Object.entries(expected)) {
        assert.ok(sql.includes(PROVIDER_SETTING_COLUMNS[key].column), `${key} missing from migration`);
        assert.equal(PROVIDER_SETTING_COLUMNS[key].type, type);
    }
});

test('common provider output controls migration is present', () => {
    const file = path.join(MIGRATIONS_DIR, '20260630_add_zzzz_common_provider_output_controls.sql');
    const sql = fs.readFileSync(file, 'utf8');
    const expected = {
        display_density: 'string',
        media_display_mode: 'string',
        failure_display_policy: 'string',
        tiktok_description_max_length: 'int',
        tiktok_image_limit: 'int',
        tiktok_video_fallback_mode: 'string',
        niconico_description_max_length: 'int',
        spotify_description_max_length: 'int',
        twitch_description_max_length: 'int',
        steam_description_max_length: 'int',
        steam_image_source: 'string',
        amazon_description_max_length: 'int',
        booth_description_max_length: 'int',
        booth_image_limit: 'int',
        booth_adult_display_mode: 'string',
    };

    assert.ok(_internal.listMigrationFiles().includes('20260630_add_zzzz_common_provider_output_controls.sql'));
    assert.ok(sql.includes('ALTER TABLE guild_provider_settings'));
    for (const [key, type] of Object.entries(expected)) {
        assert.ok(sql.includes(PROVIDER_SETTING_COLUMNS[key].column), `${key} missing from migration`);
        assert.equal(PROVIDER_SETTING_COLUMNS[key].type, type);
    }
});

test('providers route metadata fetch failures through common failure display policy', () => {
    const providerIds = [
        'twitter',
        'youtube',
        'pixiv',
        'instagram',
        'tiktok',
        'niconico',
        'spotify',
        'twitch',
        'steam',
        'github',
        'amazon',
        'booth',
    ];

    for (const providerId of providerIds) {
        const file = path.join(__dirname, '..', '..', 'src', 'providers', providerId, 'index.js');
        const source = fs.readFileSync(file, 'utf8');
        assert.match(
            source,
            new RegExp(`buildFailureResponse\\(['"]${providerId}['"]`),
            `${providerId} should use buildFailureResponse for metadata fetch failures`
        );
    }
});

test('database schema can split simple SQL migration files', () => {
    assert.deepEqual(
        _internal.splitSqlStatements('-- comment\nSELECT 1;\nSELECT 2;'),
        ['SELECT 1', 'SELECT 2']
    );
});

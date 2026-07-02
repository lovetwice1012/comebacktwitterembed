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

test('provider hourly aggregate migration is present', () => {
    const file = path.join(MIGRATIONS_DIR, '20260702_add_bot_provider_hourly_aggregates.sql');
    const sql = fs.readFileSync(file, 'utf8');

    assert.ok(_internal.listMigrationFiles().includes('20260702_add_bot_provider_hourly_aggregates.sql'));
    assert.equal(TABLES.botProviderHourlyAggregates, 'bot_provider_hourly_aggregates');
    assert.equal(TABLES.botProviderHourlyUniqueKeys, 'bot_provider_hourly_unique_keys');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS bot_provider_hourly_aggregates'));
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS bot_provider_hourly_unique_keys'));
    assert.ok(sql.includes('schema_version'));
    assert.ok(sql.includes('enrichment_duration_sum_ms'));
});

test('provider facet observation metadata migration is present', () => {
    const file = path.join(MIGRATIONS_DIR, '20260702_add_provider_content_facet_observation_metadata.sql');
    const sql = fs.readFileSync(file, 'utf8');

    assert.ok(_internal.listMigrationFiles().includes('20260702_add_provider_content_facet_observation_metadata.sql'));
    for (const column of ['metric_stage', 'metric_source', 'collected_at_ms', 'schema_version', 'collection_success', 'collection_timeout_ms']) {
        assert.ok(sql.includes(column), `${column} missing from migration`);
        assert.ok(SCHEMA_STATEMENTS.some(statement => statement.includes(column)), `${column} missing from schema`);
    }
    assert.ok(sql.includes('idx_content_facets_stage_schema_time'));
    assert.ok(sql.includes('idx_content_facets_source_time'));
    assert.deepEqual(
        _internal.parseAddIndexStatement('ALTER TABLE bot_provider_content_facets ADD INDEX idx_content_facets_source_time (metric_source, occurred_at_ms)'),
        { table: 'bot_provider_content_facets', index: 'idx_content_facets_source_time' }
    );
});

test('amazon extract targets migration is present', () => {
    const file = path.join(MIGRATIONS_DIR, '20260701_add_amazon_extract_targets.sql');
    const sql = fs.readFileSync(file, 'utf8');

    assert.ok(_internal.listMigrationFiles().includes('20260701_add_amazon_extract_targets.sql'));
    assert.ok(sql.includes('ALTER TABLE guild_provider_settings'));
    assert.ok(sql.includes('amazon_extract_targets'));
    assert.equal(PROVIDER_SETTING_COLUMNS.amazon_extract_targets.column, 'amazon_extract_targets');
    assert.equal(PROVIDER_SETTING_COLUMNS.amazon_extract_targets.type, 'jsonArray');
});

test('twitter account quote depth migration is present', () => {
    const file = path.join(MIGRATIONS_DIR, '20260702_add_twitter_quote_depth_by_account.sql');
    const sql = fs.readFileSync(file, 'utf8');

    assert.ok(_internal.listMigrationFiles().includes('20260702_add_twitter_quote_depth_by_account.sql'));
    assert.ok(sql.includes('ALTER TABLE guild_provider_settings'));
    assert.ok(sql.includes('quote_repost_depth_by_account'));
    assert.equal(PROVIDER_SETTING_COLUMNS.quote_repost_depth_by_account.column, 'quote_repost_depth_by_account');
    assert.equal(PROVIDER_SETTING_COLUMNS.quote_repost_depth_by_account.type, 'jsonObject');
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

test('database schema can detect add-column migrations before execution', async () => {
    assert.deepEqual(
        _internal.parseAddColumnStatement('ALTER TABLE guild_provider_settings ADD COLUMN tiktok_hq TINYINT(1) NULL AFTER youtube_video_list_limit'),
        { table: 'guild_provider_settings', column: 'tiktok_hq' }
    );
    assert.equal(_internal.parseAddColumnStatement('CREATE TABLE example (id INT)'), null);

    const queries = [];
    const skip = await _internal.shouldSkipMigrationStatement(async (sql, params) => {
        queries.push({ sql, params });
        return [{ Field: params[0] }];
    }, 'ALTER TABLE guild_provider_settings ADD COLUMN tiktok_hq TINYINT(1) NULL');

    assert.equal(skip, true);
    assert.deepEqual(queries, [{
        sql: 'SHOW COLUMNS FROM guild_provider_settings LIKE ?',
        params: ['tiktok_hq'],
    }]);
});

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
    assert.equal(PROVIDER_SETTING_COLUMNS.youtube_description_max_length.column, 'youtube_description_max_length');
    assert.equal(PROVIDER_SETTING_COLUMNS.youtube_description_max_length.type, 'int');
});

test('database schema can split simple SQL migration files', () => {
    assert.deepEqual(
        _internal.splitSqlStatements('-- comment\nSELECT 1;\nSELECT 2;'),
        ['SELECT 1', 'SELECT 2']
    );
});

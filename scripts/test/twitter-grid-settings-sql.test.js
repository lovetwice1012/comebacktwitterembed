'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase, applyTestMigration } = require('../lib/automation-test-db');
const schema = require('../../src/db_schema');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (port !== 33621 || process.env.NODE_ENV !== 'test') throw new Error('Use the isolated SQL fixture on port 33621');

test('grid settings migration resumes after a DDL failure and preserves existing server settings', { timeout: 120000 }, async () => {
    const db = await createTestDatabase(port);
    try {
        for (const name of ['providers', 'guilds', 'guild_provider_settings']) {
            const sql = schema.SCHEMA_STATEMENTS.find(value => new RegExp(`^CREATE TABLE IF NOT EXISTS ${name}\\s*\\(`).test(value));
            assert.ok(sql, name); await db.queryDatabase(sql);
        }
        const columns = ['twitter_grid_default_layout','twitter_grid_columns','twitter_grid_gap','twitter_grid_background',
            'twitter_grid_fit','twitter_grid_cell_size','twitter_grid_quality','twitter_grid_default_visibility','twitter_grid_replace_permission'];
        for (const column of columns) await db.queryDatabase(`ALTER TABLE guild_provider_settings DROP COLUMN ${column}`);
        await db.queryDatabase("INSERT INTO providers (provider_id) VALUES ('twitter')");
        await db.queryDatabase("INSERT INTO guilds (guild_id) VALUES ('123456789012345678')");
        await db.queryDatabase("INSERT INTO guild_provider_settings (provider_id,guild_id,enabled,twitter_text_mode) VALUES ('twitter','123456789012345678',1,'normal')");
        const migration = '20261113_add_twitter_image_grid_settings.sql';
        const tracking = schema.SCHEMA_STATEMENTS.find(value => /^CREATE TABLE IF NOT EXISTS schema_migrations\s*\(/.test(value));
        await db.queryDatabase(tracking);
        await assert.rejects(schema._internal.applyMigrationFile(async (sql, params, options) => {
            if (/ADD COLUMN twitter_grid_fit\b/.test(sql)) throw Object.assign(new Error('synthetic DB fault'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
            return db.queryDatabase(sql, params, options);
        }, migration), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM schema_migrations'))[0].n), 0);
        await applyTestMigration(db, migration);
        await applyTestMigration(db, migration);
        const row = (await db.queryDatabase("SELECT * FROM guild_provider_settings WHERE provider_id='twitter'"))[0];
        assert.equal(Number(row.enabled), 1); assert.equal(row.twitter_text_mode, 'normal');
        for (const column of columns) assert.equal(row[column], null, column);
        await db.queryDatabase("UPDATE guild_provider_settings SET twitter_grid_columns=?,twitter_grid_replace_permission=? WHERE provider_id='twitter'", [4, 'everyone']);
        const saved = (await db.queryDatabase("SELECT twitter_grid_columns,twitter_grid_replace_permission FROM guild_provider_settings WHERE provider_id='twitter'"))[0];
        assert.equal(Number(saved.twitter_grid_columns), 4); assert.equal(saved.twitter_grid_replace_permission, 'everyone');
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM schema_migrations'))[0].n), 1);
    } finally { await db.close(); }
});

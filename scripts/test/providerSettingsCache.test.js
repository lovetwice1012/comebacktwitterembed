'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('production settings reads share cold DB queries and reload after a local setting change', async () => {
    const providerPath = require.resolve('../../src/providers/_provider_settings');
    const dbPath = require.resolve('../../src/db');
    const schemaPath = require.resolve('../../src/db_schema');
    const schema = require(schemaPath);
    const originals = new Map([providerPath, dbPath, schemaPath].map(path => [path, require.cache[path]]));
    const originalEnv = process.env.NODE_ENV;
    let enabled = true;
    const queries = [];
    process.env.NODE_ENV = 'production';
    require.cache[schemaPath] = { id: schemaPath, filename: schemaPath, loaded: true, exports: {
        ...schema, ensureDatabaseSchema: async () => {},
    } };
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
        queryDatabase: async (sql, params) => {
            queries.push(sql);
            await new Promise(resolve => setImmediate(resolve));
            if (sql.includes('SELECT MAX(revision)')) return [{ revision: 0 }];
            if (sql.includes(`SELECT * FROM ${schema.TABLES.guildProviderSettings}`)) return [{ enabled: enabled ? 1 : 0 }];
            if (sql.includes('SELECT enabled AS value')) return [{ value: enabled ? 1 : 0 }];
            if (sql.includes(`INSERT INTO ${schema.TABLES.guildProviderSettings}`)) enabled = Boolean(params[2]);
            return [];
        },
        withDatabaseTransaction: async work => work(require.cache[dbPath].exports.queryDatabase),
    } };
    delete require.cache[providerPath];
    try {
        const settings = require(providerPath);
        const provider = { id: 'twitter', enabledByDefault: true };
        const read = () => settings.getProviderSettings(provider, 'guild');
        const result = await Promise.all(Array.from({ length: 100 }, read));
        assert.ok(result.every(value => value.enabled === true));
        // 11 settings-table reads plus one shared invalidation checkpoint.
        assert.equal(queries.filter(sql => sql.startsWith('SELECT')).length, 12);
        await settings.setSetting(provider, 'enabled', 'guild', false);
        assert.equal((await read()).enabled, false);
        // The mutation also locks the setting row and reads before/after for
        // its transactionally committed audit record.
        assert.equal(queries.filter(sql => sql.startsWith('SELECT')).length, 26);
        assert.ok(queries.some(sql => sql.includes('FOR UPDATE')));
        assert.ok(queries.some(sql => sql.includes(`INSERT INTO ${schema.TABLES.dashboardAuditLogs}`)));
    } finally {
        if (originalEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalEnv;
        for (const [path, original] of originals) {
            if (original) require.cache[path] = original;
            else delete require.cache[path];
        }
    }
});

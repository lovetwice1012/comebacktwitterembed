'use strict';

const mysql = require('mysql');
const { randomBytes } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
async function createTestDatabase(port) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 3306) throw new Error('Set an explicit non-production AUTOMATION_TEST_DB_PORT');
    const schema = `cbte_automation_test_${randomBytes(10).toString('hex')}`;
    const pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: process.env.AUTOMATION_TEST_DB_PASSWORD || '', connectionLimit: 8, supportBigNumbers: true, bigNumberStrings: true });
    const context = new AsyncLocalStorage();
    const acquire = () => new Promise((resolve, reject) => pool.getConnection((error, c) => error ? reject(error) : resolve(c)));
    const queryOn = c => (sql, params = []) => new Promise((resolve, reject) => c.query(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
    const admin = await acquire(), adminQuery = queryOn(admin);
    await adminQuery(`CREATE DATABASE ${mysql.escapeId(schema)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    let closed = false;
    const db = {
        schema,
        queryDatabase: async (sql, params = []) => {
            if (context.getStore()) return context.getStore()(sql, params);
            const c = await acquire();
            try { await queryOn(c)(`USE ${mysql.escapeId(schema)}`); return await queryOn(c)(sql, params); } finally { c.release(); }
        },
        withDatabaseTransaction: async work => {
            if (context.getStore()) return work(context.getStore());
            const c = await acquire(), query = queryOn(c);
            try { await query(`USE ${mysql.escapeId(schema)}`); await query('START TRANSACTION'); const result = await context.run(query, () => work(query)); await query('COMMIT'); return result; }
            catch (error) { await query('ROLLBACK'); throw error; } finally { c.release(); }
        },
        close: async () => {
            if (closed) return; closed = true;
            if (!/^cbte_automation_test_[0-9a-f]{20}$/.test(schema)) throw new Error('Unsafe fixture schema');
            await adminQuery(`DROP DATABASE ${mysql.escapeId(schema)}`); admin.release();
            await new Promise((resolve, reject) => pool.end(error => error ? reject(error) : resolve()));
        },
    };
    try {
        const needed = /CREATE TABLE IF NOT EXISTS (?:users|webhook_endpoints|auto_watch_sources|auto_watch_targets|auto_watch_items|auto_watch_deliveries|price_watch_sources|price_watch_targets|price_watch_deliveries)\s*\(/;
        for (const sql of require('../../src/db_schema').SCHEMA_STATEMENTS.filter(sql => needed.test(sql))) await db.queryDatabase(sql);
        for (const sql of require('../../src/automation/schema.sql').SCHEMA) await db.queryDatabase(sql);
    } catch (error) { await db.close(); throw error; }
    return db;
}
module.exports = { createTestDatabase };

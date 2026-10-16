'use strict';

const mysql = require('mysql');
const { randomBytes } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
async function createTestDatabase(port) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 3306) throw new Error('Set an explicit non-production AUTOMATION_TEST_DB_PORT');
    const schema = `cbte_automation_test_${randomBytes(10).toString('hex')}`;
    const pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: process.env.AUTOMATION_TEST_DB_PASSWORD || '', connectionLimit: 8, supportBigNumbers: true, bigNumberStrings: true });
    const context = new AsyncLocalStorage();
    const acquire = async () => {
        for (let attempt = 1; ; attempt++) {
            let suppliedConnection = false;
            try {
                return await new Promise((resolve, reject) => pool.getConnection((error, connection) => {
                    suppliedConnection = connection != null;
                    if (error) reject(error); else resolve(connection);
                }));
            } catch (error) {
                // Only a proven TCP connect failure before pool admission is
                // safe to repeat. Never replay a handshake, SQL or transaction.
                const connectOnly = error && typeof error === 'object' && !suppliedConnection
                    && error.code === 'ETIMEDOUT' && error.syscall === 'connect'
                    && error.address === '127.0.0.1' && error.port === port
                    && !('sql' in error) && !('sqlState' in error);
                if (!connectOnly || attempt >= 3) throw error;
                process.stderr.write(JSON.stringify({ code: 'AUTOMATION_TEST_DB_CONNECT_RETRY', attempt: attempt + 1, port }) + '\n');
                await new Promise(resolve => setTimeout(resolve, attempt * 50));
            }
        }
    };
    const queryOn = c => (sql, params = []) => new Promise((resolve, reject) => c.query(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
    let admin;
    try { admin = await acquire(); }
    catch (error) {
        try { await new Promise(resolve => pool.end(resolve)); } catch { /* Preserve the exact original admission error. */ }
        throw error;
    }
    const adminQuery = queryOn(admin);
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
async function grantTestDonor(db, userId) {
    if (!/^cbte_automation_test_[0-9a-f]{20}$/.test(db.schema || '')) throw new Error('Donor fixtures require a disposable test schema');
    await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms,is_donor) VALUES (?,0,1) ON DUPLICATE KEY UPDATE is_donor=1', [userId]);
}
module.exports = { createTestDatabase, grantTestDonor };

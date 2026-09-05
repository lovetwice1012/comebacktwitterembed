'use strict';
// Capture SELECTs with a no-I/O client, then EXPLAIN them against real schema.
// Never execute or persist the synthetic report produced during capture.
const crypto = require('node:crypto');
const loadDashboard = require('./test/helpers/load-dashboard.cjs');
const { connect, option } = require('./lib/counter-database');

async function main() {
    const database = option('--database');
    if (!database) throw new Error('--database is required');
    const captured = new Map();
    async function capture(sql, ...params) {
        if (Array.isArray(sql)) sql = sql.join('?');
        if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error('Capture supports SELECT only');
        const key = crypto.createHash('sha256').update(sql + JSON.stringify(params)).digest('hex').slice(0, 12);
        captured.set(key, { key, sql, params: params.map(value => value instanceof Date ? value.toISOString().slice(0, 19).replace('T', ' ') : value) });
        return [];
    }
    const admin = loadDashboard('lib/admin-data.ts', {
        '@/lib/prisma': { prisma: { $queryRaw: capture, $queryRawUnsafe: capture, $executeRawUnsafe: () => { throw new Error('Capture cannot write'); } } },
        '@/lib/discord': { fetchBotGuildIds: async () => new Set() },
    }, ['getAdvancedAnalytics']);
    await admin.__test.getAdvancedAnalytics();
    const db = await connect(database, 10000);
    try {
        for (const { key, sql, params } of captured.values()) {
            try {
                const rows = await db.query('EXPLAIN FORMAT=JSON ' + sql, params);
                const encoded = Object.values(rows[0])[0];
                const plan = typeof encoded === 'string' ? JSON.parse(encoded) : encoded;
                const tables = [];
                function visit(value) {
                    if (!value || typeof value !== 'object') return;
                    if (value.table_name) tables.push({ table: value.table_name, access: value.access_type, index: value.key, rows: value.rows_examined_per_scan, parts: value.used_key_parts });
                    for (const child of Object.values(value)) visit(child);
                }
                visit(plan);
                console.log(JSON.stringify({ key, sql: sql.replace(/\s+/g, ' ').slice(0, 240), tables }));
            } catch (error) { console.log(JSON.stringify({ key, error: error.message })); }
        }
    } finally { await db.close(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });

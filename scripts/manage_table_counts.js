'use strict';
const { connect, option } = require('./lib/counter-database');
const counts = require('../src/tableCounts');

async function main() {
    const action = process.argv[2];
    if (!['install', 'seed', 'verify', 'status'].includes(action)) throw new Error('Usage: manage_table_counts.js install|seed|verify|status --database NAME [--defaults-file PATH] [--table NAME]');
    const database = option('--database');
    if (!database || !/^[\w]+$/.test(database)) throw new Error('An explicit database name is required.');
    const timeout = Number(option('--timeout-ms', '900000'));
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 1800000) throw new Error('Invalid statement timeout');
    const db = await connect(database, timeout);
    try {
        if (action === 'install') {
            await counts.install(db.query);
            console.log(JSON.stringify({ action, database, tables: counts.TABLES.length }));
            return;
        }
        if (action === 'status') {
            console.log(JSON.stringify(await db.query(`SELECT b.table_name, b.ready, b.counter_version,
                b.baseline_count + COALESCE(SUM(d.delta), 0) AS row_count, b.seeded_at, b.verified_at
                FROM ${counts.BASELINES} b LEFT JOIN ${counts.DELTAS} d ON d.table_name=b.table_name
                GROUP BY b.table_name, b.ready, b.counter_version, b.baseline_count, b.seeded_at, b.verified_at`), null, 2));
            return;
        }
        const table = option('--table');
        const targets = table ? [counts.targetFor(table)] : counts.TABLES;
        for (const target of targets) {
            const start = Date.now();
            console.log(JSON.stringify({ action, table: target.table, state: 'started' }));
            const result = action === 'seed'
                ? await counts.seed(db.query, target.table, { reseed: process.argv.includes('--reseed') })
                : await counts.verify(db.query, target.table);
            console.log(JSON.stringify({ action, ...result, elapsedMs: Date.now() - start }));
        }
    } finally { await db.close(); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };

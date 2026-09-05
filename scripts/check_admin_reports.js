'use strict';
// Trusted server-side verification of the same report builders used by the
// dashboard. This creates no web endpoint or authentication bypass.
const loadDashboard = require('./test/helpers/load-dashboard.cjs');

async function main() {
    const kind = process.argv[2];
    const functions = { overview: 'refreshAdminOverviewCache', advanced: 'refreshAdminAdvancedAnalyticsCache' };
    if (!functions[kind]) throw new Error('Usage: check_admin_reports.js overview|advanced');
    const admin = loadDashboard('lib/admin-data.ts', {}, [functions[kind], 'sharedPrisma']);
    const start = Date.now();
    try {
        const report = await admin.__test[functions[kind]]();
        // Let the snapshot persistence launched by the production refresh finish.
        // $disconnect waits for in-flight queries on this dedicated CLI client.
        await admin.__test.sharedPrisma.$disconnect();
        console.log(JSON.stringify({
            kind, success: true, elapsedMs: Date.now() - start,
            tables: report.tables?.map(table => ({ table: table.table, count: table.count, available: table.available })),
            sections: Object.keys(report),
        }, null, 2));
    } finally { await admin.__test.sharedPrisma.$disconnect(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });

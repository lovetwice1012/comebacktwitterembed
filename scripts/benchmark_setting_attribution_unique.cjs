'use strict';
// Read-only MySQL comparison with a fixed window and one repeatable-read snapshot.
// Run only against the intended report runtime; credentials never enter output.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
if (process.argv.includes('--export')) {
    const root = path.resolve(__dirname, '..');
    const load = require('./test/helpers/load-dashboard.cjs');
    const source = fs.readFileSync(path.join(root, 'dashboard/lib/admin-data.ts'), 'utf8');
    const scope = source.match(/function settingAttributionAuditScopeSql\(\) \{\s*return `([\s\S]*?)`;/)?.[1];
    if (!scope) throw new Error('Audit query source not found');
    const sql = load('lib/setting-attribution-query.ts').settingAttributionUniqueQuery(scope);
    process.stdout.write(Buffer.from(JSON.stringify({ script: fs.readFileSync(__filename, 'utf8'), sql })).toString('base64'));
} else {
    async function main() {
        const runtime = process.env.CBTE_REPORT_RUNTIME || '/opt/cbte-admin/worker-runtime';
        for (const line of fs.readFileSync('/etc/cbte-admin/reports.env', 'utf8').split('\n')) {
            const i = line.indexOf('='); if (i < 1) continue;
            let value = line.slice(i + 1); try { value = JSON.parse(value); } catch {}
            process.env[line.slice(0, i)] = String(value);
        }
        const load = require(path.join(runtime, 'scripts/test/helpers/load-dashboard.cjs'));
        const { prisma } = load('lib/prisma.ts');
        const { withSelectTimeout, reportResourceHints } = load('lib/report-execution.ts');
        const originalRecord = JSON.parse(fs.readFileSync('/var/lib/cbte-admin-shared/report-queries/6f64807f-8371-4130-b160-3a0a0e3e9831.json', 'utf8'));
        const candidate = JSON.parse(fs.readFileSync(path.join(__dirname, 'query.json'), 'utf8')).sql;
        const sql = { original: withSelectTimeout(originalRecord.sql, 300000, reportResourceHints), candidate: withSelectTimeout(candidate, 300000, reportResourceHints) };
        const parameters = [new Date('2026-08-23T07:49:30.000Z'), 7 * 24 * 3600000];
        const normalize = rows => JSON.stringify(rows.map(row => JSON.stringify(Object.fromEntries(Object.entries(row).sort()), (_, value) => typeof value === 'bigint' ? value.toString() : value)).sort());
        const report = { measuredAt: new Date().toISOString(), fixedParameters: parameters, mode: process.argv.includes('--explain') ? 'explain' : 'compare', plans: {}, measurements: {} };
        try {
            for (const key of Object.keys(sql)) report.plans[key] = await prisma.$queryRawUnsafe('EXPLAIN FORMAT=JSON ' + sql[key], ...parameters);
            if (report.mode === 'compare') {
                await prisma.$transaction(async tx => {
                    let baseline;
                    for (const key of ['original', 'candidate']) {
                        const start = performance.now();
                        const result = await tx.$queryRawUnsafe(sql[key], ...parameters);
                        const normalized = normalize(result);
                        report.measurements[key] = { elapsedMs: Math.round(performance.now() - start), rows: result.length, sha256: crypto.createHash('sha256').update(normalized).digest('hex') };
                        if (key === 'original') baseline = normalized;
                        else assert.equal(normalized, baseline, 'Scoped query must retain every group and exact unique count');
                        console.log(JSON.stringify({ query: key, ...report.measurements[key] }));
                    }
                    report.resultsEqual = true;
                }, { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 650000 });
            }
            fs.writeFileSync(path.join(__dirname, report.mode + '-result.json'), JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
            console.log(JSON.stringify({ mode: report.mode, resultsEqual: report.resultsEqual, measurements: report.measurements }));
        } finally { await prisma.$disconnect(); }
    }
    main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
}

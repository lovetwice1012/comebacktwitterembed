'use strict';
// Read-only probes of individual production report sections. Output contains
// elapsed time and row counts; report contents and SQL parameters stay private.
const loadDashboard = require('./test/helpers/load-dashboard.cjs');
const sections = {
    impact: ['getSettingChangeImpact', 7], attribution: ['getSettingAttributionSummary', 30],
    cohorts: ['getWeeklyCohortAnalytics', 7], lifetime: ['getContentLifetimeAnalytics', 30],
    reuse: ['getUrlReuseAnalytics', 30], health: ['getProviderAccountHealth', 7],
    anomalies: ['getProviderAnomalySignals', 0], seasonality: ['getAggregateSeasonalityAnalytics', 30],
    spikes: ['getAggregateEventDaySpikes', 30], correlation: ['getAggregateAudienceCorrelation', 7],
};
async function main() {
    const names = process.argv.slice(2);
    if (!names.length || names.some(name => !Object.hasOwn(sections, name))) throw new Error('Select sections: ' + Object.keys(sections).join(' '));
    const admin = loadDashboard('lib/admin-data.ts', {}, [...Object.values(sections).map(([name]) => name), 'sharedPrisma', 'runReportBuild']);
    const { runReportBuild } = admin.__test;
    try {
        for (const name of names) {
            const [fn, days] = sections[name];
            const started = Date.now();
            const result = await runReportBuild(() => admin.__test[fn](started-days*86400000));
            console.log(JSON.stringify({ section: name, elapsedMs: Date.now()-started, rows: Array.isArray(result) ? result.length : undefined, success: true }));
        }
    } finally { await admin.__test.sharedPrisma.$disconnect(); }
}
main().catch(error => { console.error(error.message); process.exitCode=1; });

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const loadDashboard = require('./helpers/load-dashboard.cjs');
const { settingImpactSummaryQuery } = loadDashboard('lib/setting-attribution-query.ts');

test('scoped audit aggregation preserves wildcard scopes, overlapping windows, null guilds and unmatched audits', () => {
    const db = new DatabaseSync(':memory:');
    const metrics = ['content_events','extract_events','extract_successes','send_events','send_successes','enrichment_jobs','enrichment_successes','analytics_duration_sum_ms','analytics_duration_count'];
    const labels = ['content','extract','extract_successes','send','send_successes','enrichment','enrichment_successes','analytics_duration_sum','analytics_duration_count'];
    const groups = ['attribution_type','setting_direction','provider_id','setting_key','action'];
    db.exec(`CREATE TABLE audits_input(audit_log_id INTEGER,guild_id TEXT,provider_id TEXT,setting_key TEXT,action TEXT,changed_at_ms INTEGER,attribution_type TEXT,setting_direction TEXT);
      CREATE TABLE bot_provider_hourly_aggregates(bucket_start_ms INTEGER,guild_id TEXT,provider_id TEXT,${metrics.map(column => column+' INTEGER').join(',')})`);
    const insertAudit = db.prepare('INSERT INTO audits_input VALUES (?,?,?,?,?,?,?,?)');
    [['g1','p1'],['g1','p1'],['g1',null],[null,'p1'],['missing','missing'],['','p1']].forEach(([guild,provider],i)=>insertAudit.run(i,guild,provider,'enabled','setting.update',100+i*2,'enabled','on'));
    const insertFact = db.prepare(`INSERT INTO bot_provider_hourly_aggregates VALUES (${Array(3+metrics.length).fill('?').join(',')})`);
    for (const time of [89,90,99,100,101,109,110,112,120]) for (const guild of ['g1','g2','']) for (const provider of ['p1','p2']) insertFact.run(time,guild,provider,...metrics.map((_,i)=>i+1));
    const sums = metrics.flatMap((column,i)=>[
        `SUM(CASE WHEN h.bucket_start_ms<a.changed_at_ms THEN h.${column} ELSE 0 END) AS ${labels[i]}_before`,
        `SUM(CASE WHEN h.bucket_start_ms>=a.changed_at_ms THEN h.${column} ELSE 0 END) AS ${labels[i]}_after`,
    ]).join(',');
    const scope = 'SELECT * FROM audits_input WHERE changed_at_ms>=?';
    const original = `SELECT ${groups.map(column=>'a.'+column).join(',')},COUNT(DISTINCT a.audit_log_id) AS changes,
      COUNT(DISTINCT a.guild_id) AS affected_guilds,${sums},MAX(h.bucket_start_ms) AS latest_bucket_ms
      FROM (${scope}) a LEFT JOIN bot_provider_hourly_aggregates h
      ON h.bucket_start_ms>=a.changed_at_ms-? AND h.bucket_start_ms<a.changed_at_ms+?
      AND (a.guild_id IS NULL OR h.guild_id=a.guild_id) AND (a.provider_id IS NULL OR h.provider_id=a.provider_id)
      GROUP BY ${groups.map(column=>'a.'+column).join(',')} ORDER BY content_after DESC,changes DESC LIMIT 120`;
    const normalize = rows => rows.map(row=>({...row})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    try { assert.deepEqual(normalize(db.prepare(settingImpactSummaryQuery(scope)).all(0,10)),normalize(db.prepare(original).all(0,10,10))); }
    finally { db.close(); }
});

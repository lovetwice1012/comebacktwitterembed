'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const loadDashboard = require('./helpers/load-dashboard.cjs');
const { settingImpactSummaryQuery } = loadDashboard('lib/setting-attribution-query.ts');

test('unique attribution preserves exact membership across overlapping audits and wildcard scopes', () => {
    const { settingAttributionUniqueQuery } = loadDashboard('lib/setting-attribution-query.ts');
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE audits_input(audit_log_id INTEGER,guild_id TEXT,provider_id TEXT,setting_key TEXT,action TEXT,changed_at_ms INTEGER,attribution_type TEXT,setting_direction TEXT);
      CREATE TABLE bot_provider_hourly_unique_keys(bucket_start_ms INTEGER,guild_id TEXT,provider_id TEXT,event_type TEXT,key_type TEXT,key_hash TEXT)`);
    const insertAudit = db.prepare('INSERT INTO audits_input VALUES (?,?,?,?,?,?,?,?)');
    [['g1','p1'],['g1','p1'],['g1',null],[null,'p1'],['missing','missing'],['','p1']].forEach(([guild, provider], i) => insertAudit.run(i, guild, provider, 'enabled', 'setting.update', 100+i, 'enabled', 'on'));
    // Touching intervals may merge; gaps and different attribution dimensions must not.
    insertAudit.run(20,'g1','p1','enabled','setting.update',111,'enabled','on');
    insertAudit.run(21,'g1','p1','enabled','setting.update',140,'enabled','on');
    insertAudit.run(22,'g1','p1','enabled','setting.update',145,'enabled','on');
    insertAudit.run(23,'g1','p1','enabled','setting.update',145,'enabled','off');
    const insert = db.prepare('INSERT INTO bot_provider_hourly_unique_keys VALUES (?,?,?,?,?,?)');
    for (const time of [99,100,101,105,109,110,111,114,115,120,121,130,139,140,149,150,154,155]) for (const guild of ['g1','g2','']) for (const provider of ['p1','p2']) for (const kind of ['author_user','guild','url','unrelated']) {
        for (const hash of ['shared', `member-${guild}-${provider}`, null]) insert.run(time,guild,provider,'provider_content',kind,hash);
        insert.run(time,guild,provider,'discord_send',kind,'other-event');
    }
    const scope = 'SELECT * FROM audits_input WHERE changed_at_ms>=?';
    const groups = ['attribution_type','setting_direction','provider_id','setting_key','action'];
    const original = `SELECT ${groups.map(k=>'a.'+k).join(',')},u.key_type,COUNT(DISTINCT u.key_hash) AS unique_count
      FROM (${scope}) a JOIN bot_provider_hourly_unique_keys u ON u.bucket_start_ms>=a.changed_at_ms AND u.bucket_start_ms<a.changed_at_ms+?
      AND u.event_type='provider_content' AND (a.guild_id IS NULL OR u.guild_id=a.guild_id) AND (a.provider_id IS NULL OR u.provider_id=a.provider_id)
      AND u.key_type IN ('author_user','guild','url') GROUP BY ${groups.map(k=>'a.'+k).join(',')},u.key_type`;
    const normalize = rows => rows.map(row => ({...row})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    try {
        const optimized = settingAttributionUniqueQuery(scope).replaceAll('STRAIGHT_JOIN','JOIN');
        assert.deepEqual(normalize(db.prepare(optimized).all(0,10)), normalize(db.prepare(original).all(0,10)));
        assert.deepEqual(db.prepare(optimized).all(999,10), []);
    } finally { db.close(); }
});

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

test('latest setting impacts select the requested audits before scoped content joins', () => {
    const { settingChangeImpactQuery } = loadDashboard('lib/setting-attribution-query.ts');
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE audit_input(audit_log_id INTEGER,guild_id TEXT,provider_id TEXT,setting_key TEXT,action TEXT,changed_at_ms INTEGER);
      CREATE TABLE bot_provider_content_events(guild_id TEXT,provider_id TEXT,occurred_at_ms INTEGER,author_user_id TEXT)`);
    const insertAudit = db.prepare('INSERT INTO audit_input VALUES (?,?,?,?,?,?)');
    for (let i=0;i<80;i++) {
        const [guild,provider] = [['g1','p1'],['g1',null],[null,'p1'],['missing','missing'],['','p1']][i%5];
        insertAudit.run(i,guild,provider,null,'change',100+i);
    }
    const insertFact = db.prepare('INSERT INTO bot_provider_content_events VALUES (?,?,?,?)');
    for (const time of [99,100,109,110,119,120,129,130,139,159,179,189]) for (const guild of ['g1','g2','']) for (const provider of ['p1','p2']) {
        insertFact.run(guild,provider,time,'u1'); insertFact.run(guild,provider,time,'u1'); insertFact.run(guild,provider,time,null);
    }
    const scope = 'SELECT * FROM audit_input WHERE changed_at_ms>=? ORDER BY changed_at_ms DESC LIMIT 60';
    const matching = '(a.guild_id IS NULL OR c.guild_id=a.guild_id) AND (a.provider_id IS NULL OR c.provider_id=a.provider_id)';
    const original = `SELECT a.*,
      (SELECT COUNT(*) FROM bot_provider_content_events c WHERE ${matching} AND c.occurred_at_ms>=a.changed_at_ms-? AND c.occurred_at_ms<a.changed_at_ms) AS content_before,
      (SELECT COUNT(*) FROM bot_provider_content_events c WHERE ${matching} AND c.occurred_at_ms>=a.changed_at_ms AND c.occurred_at_ms<a.changed_at_ms+?) AS content_after,
      (SELECT COUNT(DISTINCT c.author_user_id) FROM bot_provider_content_events c WHERE ${matching} AND c.occurred_at_ms>=a.changed_at_ms AND c.occurred_at_ms<a.changed_at_ms+?) AS users_after
      FROM (${scope}) a ORDER BY changed_at_ms DESC`;
    try {
        assert.deepEqual(db.prepare(settingChangeImpactQuery(scope)).all(0,10),db.prepare(original).all(10,10,10,0));
        assert.deepEqual(db.prepare(settingChangeImpactQuery(scope)).all(999,10),[]);
    } finally { db.close(); }
});

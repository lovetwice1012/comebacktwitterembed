'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const loadDashboard = require('./helpers/load-dashboard.cjs');
const { detailedProviderReliabilityQuery } = loadDashboard('lib/detailed-reliability-query.ts');

const timeWhere = 'a.occurred_at_ms >= ? AND a.occurred_at_ms < ?';
function original(whereSql) {
    return `SELECT a.provider_id,a.account_key,a.event_type,COUNT(*) AS events,
      SUM(a.success=1) AS successes,SUM(a.success=0) AS failures,
      COUNT(DISTINCT a.author_user_id) AS users,COUNT(DISTINCT a.guild_id) AS guilds,
      AVG(a.duration_ms) AS avg_duration_ms,MAX(a.duration_ms) AS max_duration_ms
      FROM bot_analytics_events a WHERE ${whereSql} AND a.provider_id IS NOT NULL AND a.success IS NOT NULL
      GROUP BY a.provider_id,a.account_key,a.event_type ORDER BY events DESC LIMIT ?`;
}
function fixture() {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE bot_analytics_events(occurred_at_ms INTEGER,provider_id TEXT COLLATE NOCASE,
      account_key TEXT COLLATE NOCASE,event_type TEXT COLLATE NOCASE,success INTEGER,duration_ms INTEGER,
      author_user_id TEXT COLLATE NOCASE,guild_id TEXT COLLATE NOCASE,command_name TEXT COLLATE NOCASE,
      component_id TEXT COLLATE NOCASE,count INTEGER)`);
    const statement = db.prepare('INSERT INTO bot_analytics_events VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    return {
        db,
        insert(options = {}) {
            const row = { time: 100, provider: 'p', account: 'a', event: 'provider_extract', success: 1,
                duration: 10, user: 'u', guild: 'g', command: 'embed', component: 'extract', count: 1, ...options };
            statement.run(row.time,row.provider,row.account,row.event,row.success,row.duration,row.user,row.guild,row.command,row.component,row.count);
        },
    };
}
function query(db, sql, params) { return db.prepare(sql.replaceAll('<=>', 'IS')).all(...params).map(row => ({ ...row })); }
function normalize(rows) {
    return rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
        typeof value === 'number' ? Math.round(value * 1e10) / 1e10 : typeof value === 'string' ? value.toLowerCase() : value,
    ]))).sort((left,right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
function compare(db, where, params, limit = 100) {
    assert.deepEqual(normalize(query(db, detailedProviderReliabilityQuery(where), [...params,limit])),
        normalize(query(db, original(where), [...params,limit])));
}

test('reliability grouping preserves nullable account keys, collation, zero durations and unweighted event counts', () => {
    const { db, insert } = fixture();
    try {
        insert({ account: null, user: 'User', guild: 'Guild', duration: 0, count: 999 });
        insert({ account: null, user: 'user', guild: 'guild', duration: 100, success: 0 });
        insert({ account: null, user: null, guild: null, duration: null, success: 2 });
        insert({ provider: 'P', account: 'A', event: 'PROVIDER_EXTRACT', user: 'User', guild: 'Guild' });
        insert({ provider: 'p', account: 'a', event: 'provider_extract', user: 'user', guild: 'guild', success: 0 });
        insert({ account: '', duration: null });
        insert({ account: 'unknown', duration: null });
        insert({ provider: '', duration: 0 });
        insert({ provider: null, duration: 100000 });
        insert({ success: null, duration: 100000 });
        compare(db,timeWhere,[50,500]);
        const nullAccount = query(db,detailedProviderReliabilityQuery(timeWhere),[50,500,100]).find(row => row.account_key === null);
        assert.deepEqual(nullAccount, { provider_id: 'p', account_key: null, event_type: 'provider_extract',
            events: 3, successes: 1, failures: 1, users: 1, guilds: 1, avg_duration_ms: 50, max_duration_ms: 100 });
    } finally { db.close(); }
});

test('reliability query retains all analytics filters and half-open date boundaries with unchanged binding order', () => {
    const { db, insert } = fixture();
    try {
        for (let id = 0; id < 180; id++) insert({ time: id * 10, provider: id % 2 ? 'p' : 'q',
            account: id % 3 ? 'a' : null, event: id % 4 ? 'provider_extract' : 'discord_send',
            success: id % 5 ? 1 : 0, duration: id % 7 ? id * 3 : null, user: `u${id % 4}`, guild: `g${id % 3}`,
            command: id % 3 ? 'embed' : 'manual', component: id % 4 ? 'extract' : 'send' });
        const cases = [
            [timeWhere,[300,1200]],
            [`${timeWhere} AND a.provider_id=? AND a.account_key=?`,[300,1200,'p','a']],
            [`${timeWhere} AND a.guild_id=? AND a.author_user_id=?`,[300,1200,'g1','u1']],
            [`${timeWhere} AND a.event_type=?`,[300,1200,'discord_send']],
            [`${timeWhere} AND a.command_name=? AND a.component_id=?`,[300,1200,'manual','send']],
            [`${timeWhere} AND a.provider_id=? AND a.account_key=? AND a.guild_id=? AND a.author_user_id=?
              AND a.event_type=? AND a.command_name=? AND a.component_id=?`,[300,1200,'p','a','g1','u1','provider_extract','embed','extract']],
            [timeWhere,[3000,4000]],
        ];
        for (const [where,params] of cases) compare(db,where,params);
        assert.match(detailedProviderReliabilityQuery(timeWhere),/INDEX\(a idx_analytics_time\)/);
        assert.doesNotMatch(detailedProviderReliabilityQuery(`${timeWhere} AND a.guild_id=?`),/INDEX\(a idx_analytics_time\)/);
    } finally { db.close(); }
});

test('reliability selects by event count before computing exact audiences, without ranking by audience size', () => {
    const { db, insert } = fixture();
    try {
        for (let id = 0; id < 12; id++) insert({ account: 'winner', duration: id, success: id % 2 });
        for (let id = 0; id < 10; id++) insert({ account: 'larger-audience', user: `u${id}`, guild: `g${id}` });
        compare(db,timeWhere,[50,500],1);
        const rows = query(db,detailedProviderReliabilityQuery(timeWhere),[50,500,1]);
        assert.equal(rows[0].account_key,'winner');
        assert.equal(rows[0].events,12);
        assert.equal(rows[0].users,1);
        assert.equal(rows[0].guilds,1);
        assert.equal(rows[0].avg_duration_ms,5.5);
        assert.equal(rows[0].max_duration_ms,11);
    } finally { db.close(); }
});

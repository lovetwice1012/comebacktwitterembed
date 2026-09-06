'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const loadDashboard = require('./helpers/load-dashboard.cjs');
const {
    detailedSecondaryInterestQuery,
    detailedContentLifetimeQuery,
    detailedUrlReuseQuery,
    detailedSettingImpactQuery,
} = loadDashboard('lib/detailed-secondary-queries.ts');
const { detailedInterestQuery } = loadDashboard('lib/analytics-interest-query.ts');

function sqlite(sql) { return sql.replaceAll('<=>', ' IS '); }
function normalized(rows) {
    return rows.map(row => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function contentDatabase() {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE bot_provider_content_events (
        content_event_id INTEGER PRIMARY KEY,occurred_at_ms INTEGER,
        provider_id TEXT COLLATE NOCASE,account_key TEXT COLLATE NOCASE,content_type TEXT COLLATE NOCASE,
        content_url TEXT COLLATE NOCASE,normalized_url TEXT COLLATE NOCASE,
        guild_id TEXT COLLATE NOCASE,author_user_id TEXT COLLATE NOCASE,title TEXT COLLATE NOCASE
    ); CREATE TABLE bot_provider_content_facets(content_event_id INTEGER,facet_key TEXT);`);
    return db;
}

test('detailed interest preserves filtered target multiplicities, cross-guild reach, nulls and inclusive other end', () => {
    const db = contentDatabase();
    const insert = db.prepare('INSERT INTO bot_provider_content_events VALUES (?,?,?,?,?,?,?,?,?,?)');
    let id = 0;
    for (let user = 0; user < 6; user++) {
        for (let guild = 0; guild < 9; guild++) {
            for (let repeat = 0; repeat < 3; repeat++) {
                insert.run(++id, 101 + repeat, 'twitter', 'a', 'post', 'url', null, `g${guild}`, `u${user}`, 'title');
                db.prepare('INSERT INTO bot_provider_content_facets VALUES (?,?)').run(id, 'keep');
            }
        }
        for (let repeat = 0; repeat < 4; repeat++) {
            insert.run(++id, 200, 'youtube', 'b', 'video', null, 'normal', null, `u${user}`, null);
        }
    }
    for (const [provider, account, type, guild, user, time] of [
        ['twitter', null, null, null, 'u0', 150], ['twitter', '', '', '', 'u0', 150],
        [null, 'a', 'post', null, 'u0', 150], ['pixiv', 'b', 'image', null, null, 150],
        ['ignored', 'b', 'image', 'g1', 'u0', 201], ['ignored', 'old', 'post', 'g1', 'u0', 99],
        ['youtube', 'B', 'VIDEO', 'g1', 'U0', 180],
    ]) insert.run(++id, time, provider, account, type, 'url', null, guild, user, null);

    const scopes = [
        ['target.occurred_at_ms>=? AND target.occurred_at_ms<?', [100, 200]],
        ['target.occurred_at_ms>=? AND target.occurred_at_ms<? AND target.provider_id=? AND target.account_key=?', [100, 200, 'twitter', 'a']],
        [`target.occurred_at_ms>=? AND target.occurred_at_ms<? AND target.guild_id=? AND EXISTS (
            SELECT 1 FROM bot_provider_content_facets f_filter WHERE f_filter.content_event_id=target.content_event_id AND f_filter.facet_key=?)`, [100, 200, 'g0', 'keep']],
    ];
    try {
        for (const [scope, params] of scopes) {
            const args = [...params, 100, 200, 10000];
            const expected = db.prepare(detailedInterestQuery(scope)).all(...args);
            const actual = db.prepare(sqlite(detailedSecondaryInterestQuery(scope))).all(...args);
            assert.deepEqual(normalized(actual), normalized(expected));
            assert.ok(actual.some(row => row.interest_provider_id === 'youtube'));
        }
        const [scope, params] = scopes[1];
        const args = [...params, 100, 200, 1];
        assert.deepEqual(normalized(db.prepare(sqlite(detailedSecondaryInterestQuery(scope))).all(...args)),
            normalized(db.prepare(detailedInterestQuery(scope)).all(...args)));
        assert.deepEqual(db.prepare(sqlite(detailedSecondaryInterestQuery('target.occurred_at_ms>=?'))).all(9999, 100, 200, 10), []);
    } finally { db.close(); }
});

function originalReach(kind, where) {
    const keys = ['provider_id', 'account_key', ...(kind === 'lifetime' ? ['content_type'] : []), 'content_url', 'normalized_url'];
    return `SELECT ${keys.map(column => `c.${column}`).join(',')},MAX(c.title) AS title,COUNT(*) AS content_events,
        COUNT(DISTINCT c.author_user_id) AS users,COUNT(DISTINCT c.guild_id) AS guilds,
        MIN(c.occurred_at_ms) AS first_seen_ms,MAX(c.occurred_at_ms) AS last_seen_ms
        FROM bot_provider_content_events c WHERE ${where} AND (c.content_url IS NOT NULL OR c.normalized_url IS NOT NULL)
        GROUP BY ${keys.map(column => `c.${column}`).join(',')}
        HAVING content_events>1 OR users>1 OR guilds>1
        ORDER BY ${kind === 'lifetime' ? '(last_seen_ms-first_seen_ms) DESC,content_events DESC' : 'guilds DESC,users DESC,content_events DESC'} LIMIT ?`;
}

test('detailed lifetime and reuse preserve their different grouping, ranking and nullable URL membership', () => {
    const db = contentDatabase();
    const insert = db.prepare('INSERT INTO bot_provider_content_events VALUES (?,?,?,?,?,?,?,?,?,?)');
    const facet = db.prepare('INSERT INTO bot_provider_content_facets VALUES (?,?)');
    for (let i = 0; i < 1200; i++) {
        insert.run(i, i, `p${i % 2}`, i % 4 ? 'a' : null, i % 3 ? 'type' : null,
            i % 3 ? `url${i % 11}` : null, i % 5 ? `normal${i % 7}` : null,
            i % 5 ? `g${i % 3}` : null, i % 5 ? `u${i % 11}` : null, `Title${i % 19}`);
        if (i % 2) facet.run(i, 'selected');
    }
    insert.run(9999, 20, 'single', null, null, 'once', null, 'g1', 'u1', null);
    insert.run(9998, 21, 'nulls', null, null, 'nulls', null, null, null, null);
    insert.run(9997, 22, 'nulls', null, null, 'nulls', null, null, null, null);
    const scopes = [
        ['c.occurred_at_ms>=? AND c.occurred_at_ms<?', [10, 1100]],
        [`c.occurred_at_ms>=? AND c.occurred_at_ms<? AND c.provider_id=? AND EXISTS (
            SELECT 1 FROM bot_provider_content_facets f_filter WHERE f_filter.content_event_id=c.content_event_id AND f_filter.facet_key=?)`, [10, 1100, 'p1', 'selected']],
        ['c.occurred_at_ms>=? AND c.occurred_at_ms<? AND c.provider_id=?', [10, 1100, 'nulls']],
        ['c.occurred_at_ms>=?', [99999]],
    ];
    try {
        for (const kind of ['lifetime', 'reuse']) for (const [where, params] of scopes) {
            const sql = kind === 'lifetime' ? detailedContentLifetimeQuery(where) : detailedUrlReuseQuery(where);
            const expected = db.prepare(originalReach(kind, where)).all(...params, 10000);
            const actual = db.prepare(sqlite(sql)).all(...params, 10000);
            assert.deepEqual(normalized(actual), normalized(expected));
        }
    } finally { db.close(); }
});

test('detailed reuse ranks exact users before event count while lifetime ranks spread before event count', () => {
    const db = contentDatabase();
    const insert = db.prepare('INSERT INTO bot_provider_content_events VALUES (?,?,?,?,?,?,?,?,?,?)');
    let id = 0;
    for (let i = 0; i < 20; i++) insert.run(++id, i, 'p', 'a', 'type', 'repeat', null, `g${i % 2}`, 'same', 'title');
    for (let i = 0; i < 3; i++) insert.run(++id, 10 + i, 'p', 'a', 'type', 'users', null, `g${i % 2}`, `u${i}`, 'title');
    for (let i = 0; i < 2; i++) insert.run(++id, i * 100, 'p', 'a', 'type', 'spread', null, 'g1', 'same', 'title');
    try {
        for (const [kind, build, winner] of [
            ['reuse', detailedUrlReuseQuery, 'users'], ['lifetime', detailedContentLifetimeQuery, 'spread'],
        ]) {
            const actual = db.prepare(sqlite(build('c.occurred_at_ms>=?'))).all(0, 1);
            assert.equal(actual.length, 1);
            assert.equal(actual[0].content_url, winner);
            assert.deepEqual(normalized(actual), normalized(db.prepare(originalReach(kind, 'c.occurred_at_ms>=?')).all(0, 1)));
        }
    } finally { db.close(); }
});

test('detailed setting impact preserves scoped audits, overlapping windows, per-audit users and all parameter positions', () => {
    const db = contentDatabase();
    db.function('UNIX_TIMESTAMP', value => value / 1000);
    db.function('GREATEST', { varargs: true }, (...values) => Math.max(...values));
    db.exec(`CREATE TABLE dashboard_audit_logs(audit_log_id INTEGER PRIMARY KEY,provider_id TEXT COLLATE NOCASE,
        guild_id TEXT COLLATE NOCASE,setting_key TEXT COLLATE NOCASE,action TEXT COLLATE NOCASE,created_at INTEGER);`);
    const audit = db.prepare('INSERT INTO dashboard_audit_logs VALUES (?,?,?,?,?,?)');
    const scopes = [['p1', 'g1'], ['p1', 'g1'], [null, 'g1'], ['p1', null], ['missing', 'missing'], ['p1', ''], [null, null]];
    scopes.forEach(([provider, guild], i) => audit.run(i, provider, guild, i % 2 ? '__provider__' : null, 'change', 100 + i * 2));
    const event = db.prepare('INSERT INTO bot_provider_content_events VALUES (?,?,?,?,?,?,?,?,?,?)');
    let id = 0;
    for (const time of [89, 90, 99, 100, 101, 109, 110, 112, 120, 130]) {
        for (const guild of ['g1', 'g2', '', null]) for (const provider of ['p1', 'p2', null]) {
            for (const user of ['u1', 'u1', 'u2', null]) event.run(++id, time, provider, null, null, null, null, guild, user, null);
        }
    }
    const matching = '(a.guild_id IS NULL OR c.guild_id=a.guild_id) AND (a.provider_id IS NULL OR c.provider_id=a.provider_id)';
    function original(where) {
        return `SELECT a.provider_id,COALESCE(a.setting_key,'__provider__') AS setting_key,a.action,
            COUNT(DISTINCT a.audit_log_id) AS changes,COUNT(DISTINCT a.guild_id) AS guilds,
            SUM((SELECT COUNT(*) FROM bot_provider_content_events c WHERE ${matching}
                AND c.occurred_at_ms>=UNIX_TIMESTAMP(a.created_at)*1000-? AND c.occurred_at_ms<UNIX_TIMESTAMP(a.created_at)*1000)) AS content_before,
            SUM((SELECT COUNT(*) FROM bot_provider_content_events c WHERE ${matching}
                AND c.occurred_at_ms>=UNIX_TIMESTAMP(a.created_at)*1000 AND c.occurred_at_ms<UNIX_TIMESTAMP(a.created_at)*1000+?)) AS content_after,
            SUM((SELECT COUNT(DISTINCT c.author_user_id) FROM bot_provider_content_events c WHERE ${matching}
                AND c.occurred_at_ms>=UNIX_TIMESTAMP(a.created_at)*1000 AND c.occurred_at_ms<UNIX_TIMESTAMP(a.created_at)*1000+?)) AS users_after
            FROM dashboard_audit_logs a WHERE ${where}
            GROUP BY a.provider_id,COALESCE(a.setting_key,'__provider__'),a.action ORDER BY content_after DESC,changes DESC LIMIT ?`;
    }
    const baseWhere = 'a.created_at>=? AND a.created_at<=? AND (a.provider_id IS NOT NULL OR a.guild_id IS NOT NULL)';
    try {
        for (const windows of [[10, 10, 10], [5, 9, 15], [0, 0, 0]]) {
            for (const [where, params] of [
                [baseWhere, [90, 200]],
                [baseWhere + ' AND a.provider_id=? AND a.guild_id=?', [90, 200, 'p1', 'g1']],
                [baseWhere, [9999, 10000]],
            ]) {
                const args = [...windows, ...params, 100];
                assert.deepEqual(normalized(db.prepare(detailedSettingImpactQuery(where)).all(...args)),
                    normalized(db.prepare(original(where)).all(...args)));
            }
        }
    } finally { db.close(); }
});

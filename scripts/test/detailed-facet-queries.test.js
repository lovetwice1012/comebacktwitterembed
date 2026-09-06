'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const loadDashboard = require('./helpers/load-dashboard.cjs');
const { detailedFacetBreakdownQuery, detailedProviderMarketingSegmentsQuery } = loadDashboard('lib/detailed-facet-queries.ts');

const segmentValueSql = `CASE WHEN f.facet_value IS NOT NULL AND f.facet_value <> '' THEN f.facet_value
  WHEN f.numeric_value IS NULL THEN NULL
  WHEN f.facet_key LIKE '%.duration_seconds' THEN CASE
    WHEN f.numeric_value < 15 THEN 'duration:<15s' WHEN f.numeric_value < 60 THEN 'duration:15-59s' ELSE 'duration:1m+' END
  ELSE CASE WHEN f.numeric_value < 10 THEN 'numeric:<10' ELSE 'numeric:10+' END END`;

function originalFacet(whereSql) {
    return `SELECT f.provider_id,f.account_key,f.facet_key,f.facet_value,COUNT(*) AS events,
      COUNT(DISTINCT c.author_user_id) AS users,COUNT(DISTINCT c.guild_id) AS guilds,
      AVG(f.numeric_value) AS avg_numeric_value,MIN(f.numeric_value) AS min_numeric_value,MAX(f.numeric_value) AS max_numeric_value
      FROM bot_provider_content_facets f JOIN bot_provider_content_events c ON c.content_event_id=f.content_event_id
      WHERE ${whereSql} GROUP BY f.provider_id,f.account_key,f.facet_key,f.facet_value ORDER BY events DESC LIMIT ?`;
}

function originalMarketing(whereSql, placeholders) {
    // SQLite drops the source collation on MAX(text); MySQL preserves it.
    // Restore it in the reference so derived IDs use the schema's collation.
    return `SELECT segment.provider_id,segment.account_key,segment.metric_key,segment.facet_value,COUNT(*) AS events,
      COUNT(DISTINCT segment.author_user_id) AS users,COUNT(DISTINCT segment.guild_id) AS guilds,
      COUNT(DISTINCT segment.display_url) AS urls,AVG(segment.numeric_value) AS avg_numeric_value,NULL AS sum_numeric_value,
      MIN(segment.numeric_value) AS min_numeric_value,MAX(segment.numeric_value) AS max_numeric_value,MAX(segment.occurred_at_ms) AS latest_ms
      FROM (SELECT f.content_event_id,f.provider_id,f.account_key,f.facet_key AS metric_key,${segmentValueSql} AS facet_value,
        AVG(f.numeric_value) AS numeric_value,MAX(c.author_user_id) COLLATE NOCASE AS author_user_id,MAX(c.guild_id) COLLATE NOCASE AS guild_id,
        MAX(COALESCE(c.normalized_url,c.content_url)) AS display_url,MAX(c.occurred_at_ms) AS occurred_at_ms
        FROM bot_provider_content_facets f JOIN bot_provider_content_events c ON c.content_event_id=f.content_event_id
        WHERE ${whereSql} AND f.facet_key IN (${placeholders})
        GROUP BY f.content_event_id,f.provider_id,f.account_key,f.facet_key,${segmentValueSql}) segment
      GROUP BY segment.provider_id,segment.account_key,segment.metric_key,segment.facet_value
      ORDER BY events DESC,users DESC,guilds DESC LIMIT ?`;
}

function fixture() {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE bot_provider_content_events(content_event_id INTEGER PRIMARY KEY,occurred_at_ms INTEGER,
      provider_id TEXT COLLATE NOCASE,account_key TEXT COLLATE NOCASE,author_user_id TEXT COLLATE NOCASE,
      guild_id TEXT COLLATE NOCASE,content_type TEXT COLLATE NOCASE,normalized_url TEXT COLLATE NOCASE,content_url TEXT COLLATE NOCASE);
      CREATE TABLE bot_provider_content_facets(content_event_id INTEGER,provider_id TEXT COLLATE NOCASE,
      account_key TEXT COLLATE NOCASE,facet_key TEXT COLLATE NOCASE,facet_value TEXT COLLATE NOCASE,numeric_value REAL,occurred_at_ms INTEGER)`);
    const insertParent = db.prepare('INSERT INTO bot_provider_content_events VALUES (?,?,?,?,?,?,?,?,?)');
    const insertFacet = db.prepare('INSERT INTO bot_provider_content_facets VALUES (?,?,?,?,?,?,?)');
    return {
        db,
        parent(id, options = {}) {
            insertParent.run(id, options.time ?? 100, options.provider ?? 'p', options.account === undefined ? 'a' : options.account,
                options.user === undefined ? `u${id % 3}` : options.user, options.guild === undefined ? `g${id % 2}` : options.guild,
                options.type ?? 'video', options.url === undefined ? `https://example.test/${id % 4}` : options.url, options.fallback ?? null);
        },
        facet(id, key, value, number, options = {}) {
            insertFacet.run(id, options.provider ?? 'p', options.account === undefined ? 'a' : options.account, key, value, number, options.time ?? 999999);
        },
    };
}

function query(db, sql, params) { return db.prepare(sql.replaceAll('<=>', 'IS')).all(...params).map(row => ({ ...row })); }
function normalize(rows) {
    // GROUP BY may choose any spelling among collation-equivalent labels.
    return rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
        typeof value === 'number' ? Math.round(value * 1e10) / 1e10 : typeof value === 'string' ? value.toLowerCase() : value,
    ]))).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
function compareFixture(db, where, params, metricKeys = ['p.duration_seconds', 'p.label', 'p.value'], limit = 100) {
    assert.deepEqual(normalize(query(db, detailedFacetBreakdownQuery(where), [...params, limit])),
        normalize(query(db, originalFacet(where), [...params, limit])));
    const placeholders = metricKeys.map(() => '?').join(',');
    assert.deepEqual(normalize(query(db, detailedProviderMarketingSegmentsQuery(where, placeholders, segmentValueSql), [...params, ...metricKeys, limit, limit])),
        normalize(query(db, originalMarketing(where, placeholders), [...params, ...metricKeys, limit])));
}

test('detailed facet queries preserve repeated observations, nulls, collation groups and event-based numeric averages', () => {
    const { db, parent, facet } = fixture();
    try {
        parent(1, { user: 'User', guild: 'Guild', url: null, fallback: 'https://fallback.test' });
        parent(2, { user: 'user', guild: 'guild', url: null, fallback: 'https://fallback.test' });
        parent(3, { user: null, guild: null, url: null });
        parent(4, { account: null });
        parent(5, { account: '' });
        parent(6, { account: 'unknown' });
        parent(7, { time: 9999 });
        for (let duplicate = 0; duplicate < 9; duplicate++) facet(1, 'p.duration_seconds', null, 4);
        facet(1, 'p.duration_seconds', null, 6);
        facet(2, 'p.duration_seconds', '', 12);
        facet(2, 'p.duration_seconds', '', 17);
        facet(3, 'p.duration_seconds', null, null);
        facet(1, 'p.label', 'Shared', null);
        facet(2, 'p.label', 'shared', 0);
        facet(3, 'p.label', '', null);
        facet(4, 'p.value', null, 5, { account: null });
        facet(4, 'p.value', null, 9, { account: null });
        facet(5, 'p.value', '', 2, { account: '' });
        facet(6, 'p.value', 'unknown', 0, { account: 'unknown' });
        facet(7, 'p.label', 'outside', 700, { time: 100 });
        compareFixture(db, 'c.occurred_at_ms >= ? AND c.occurred_at_ms < ?', [50, 500]);
        const result = query(db, detailedProviderMarketingSegmentsQuery('c.occurred_at_ms >= ? AND c.occurred_at_ms < ?', '?', segmentValueSql), [50, 500, 'p.duration_seconds', 100, 100]);
        const smallDuration = result.find(row => row.facet_value === 'duration:<15s');
        assert.equal(smallDuration.events, 2);
        assert.equal(smallDuration.avg_numeric_value, 8.1, 'preserve average of per-event averages, not observation-weighted average');
        assert.equal(smallDuration.users, 1, 'distinct membership uses the database collation');
    } finally { db.close(); }
});

test('detailed facet queries preserve all content filters, facet existence filters and half-open date windows', () => {
    const { db, parent, facet } = fixture();
    try {
        for (let id = 1; id <= 60; id++) {
            const provider = id % 2 ? 'p' : 'q';
            const account = id % 4 ? 'a' : 'b';
            parent(id, { time: id * 10, provider, account, type: id % 3 ? 'video' : 'image' });
            for (let count = 0; count < 1 + (id % 5); count++) {
                facet(id, 'p.label', id % 3 ? 'segment' : null, id % 7 ? id / 7 : null, { provider, account });
                facet(id, 'p.value', null, id + count, { provider, account });
            }
            if (id % 3 === 0) facet(id, 'qualification', 'yes', null, { provider, account });
        }
        const time = 'c.occurred_at_ms >= ? AND c.occurred_at_ms < ?';
        compareFixture(db, time, [100, 500]);
        compareFixture(db, `${time} AND c.provider_id=? AND c.account_key=?`, [100, 500, 'p', 'a']);
        compareFixture(db, `${time} AND c.guild_id=? AND c.author_user_id=? AND c.content_type=?`, [100, 500, 'g1', 'u0', 'image']);
        compareFixture(db, `${time} AND EXISTS (SELECT 1 FROM bot_provider_content_facets f_filter
          WHERE f_filter.content_event_id=c.content_event_id AND f_filter.facet_key=?)`, [100, 500, 'qualification']);
        compareFixture(db, `${time} AND f.facet_key=?`, [100, 500, 'p.label']);
        compareFixture(db, time, [1000, 2000]);
    } finally { db.close(); }
});

test('marketing segment cutoff retains ties before applying distinct-user and distinct-guild ordering', () => {
    const { db, parent, facet } = fixture();
    try {
        for (let index = 0; index < 3; index++) {
            parent(index + 1, { user: 'one-user', guild: 'one-guild' });
            facet(index + 1, 'p.label', 'a-first-but-smaller-audience', 1);
            parent(index + 4, { user: `user-${index}`, guild: 'one-guild' });
            facet(index + 4, 'p.label', 'b-more-users', 2);
            parent(index + 7, { user: `user-${index}`, guild: `guild-${index}` });
            facet(index + 7, 'p.label', 'c-winner-by-guild-tiebreak', 3);
        }
        const sql = detailedProviderMarketingSegmentsQuery('c.occurred_at_ms >= ? AND c.occurred_at_ms < ?', '?', segmentValueSql);
        const result = query(db, sql, [50, 500, 'p.label', 1, 1]);
        assert.equal(result.length, 1);
        assert.equal(result[0].facet_value, 'c-winner-by-guild-tiebreak');
        assert.deepEqual(result, query(db, originalMarketing('c.occurred_at_ms >= ? AND c.occurred_at_ms < ?', '?'), [50, 500, 'p.label', 1]));
    } finally { db.close(); }
});

test('facet ranking selects groups by observation count while preserving exact distinct audiences', () => {
    const { db, parent, facet } = fixture();
    try {
        for (let id = 1; id <= 8; id++) parent(id);
        for (let duplicate = 0; duplicate < 9; duplicate++) facet(1, 'p.label', 'most-observations', duplicate);
        for (let id = 2; id <= 8; id++) facet(id, 'p.label', 'more-users', 10);
        const where = 'c.occurred_at_ms >= ? AND c.occurred_at_ms < ?';
        const rows = query(db, detailedFacetBreakdownQuery(where), [50, 500, 1]);
        assert.deepEqual(rows, query(db, originalFacet(where), [50, 500, 1]));
        assert.equal(rows[0].events, 9);
        assert.equal(rows[0].users, 1);
        assert.equal(rows[0].avg_numeric_value, 4);
    } finally { db.close(); }
});

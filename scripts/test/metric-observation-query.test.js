'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const loadDashboard = require('./helpers/load-dashboard.cjs');
const { metricObservationQuery, metricObservationRollupRange, metricObservationRollupQuery, metricObservationRollupParams, providerMetricObservationCountsQuery } = loadDashboard('lib/metric-observation-query.ts');

function sqliteQuery(sql) {
    return sql
        .replace(/<=>/g, ' IS ')
        .replace(/utf8mb4_bin/g, 'BINARY');
}

test('numeric metric observations prefilter candidate facet keys without changing latest-value semantics', () => {
    const db = new DatabaseSync(':memory:');
    db.function('regexp', (pattern, value) => value == null ? 0 : new RegExp(pattern).test(String(value)) ? 1 : 0);
    db.function('CONCAT', (...values) => values.join(''));
    db.exec(`
      CREATE TABLE bot_provider_content_events(
        content_event_id INTEGER PRIMARY KEY, occurred_at_ms INTEGER, provider_id TEXT,
        account_key TEXT, content_id TEXT, normalized_url TEXT, content_url TEXT,
        author_user_id TEXT, guild_id TEXT
      );
      CREATE TABLE bot_provider_content_facets(
        facet_id INTEGER PRIMARY KEY, content_event_id INTEGER, provider_id TEXT,
        account_key TEXT, facet_key TEXT, numeric_value REAL, collected_at_ms INTEGER
      );
    `);
    const event = db.prepare('INSERT INTO bot_provider_content_events VALUES (?,?,?,?,?,?,?,?,?)');
    event.run(1, 10, 'p', 'a', 'content-1', null, null, 'u1', 'g1');
    event.run(2, 20, 'p', 'a', 'content-2', 'url-2', null, 'u2', 'g2');
    event.run(3, 30, 'p', 'a', 'content-3', 'url-3', null, 'u3', 'g3');
    event.run(4, 40, 'p', 'a', 'content-4', null, 'url-4', 'u4', 'g4');
    const facet = db.prepare('INSERT INTO bot_provider_content_facets VALUES (?,?,?,?,?,?,?)');
    facet.run(1, 1, 'p', 'a', 'metric.likes', 3, 10);
    facet.run(2, 2, 'p', 'a', 'metric.likes', 4, 20);
    facet.run(3, 3, 'p', 'a', 'metric.likes', null, 30); // latest null suppresses this subject
    facet.run(4, 4, 'p', 'a', 'metric.label', null, 40); // text-only key is not a numeric candidate
    facet.run(5, 1, 'p', 'a', 'metric.likes', 2, 5); // older row remains in source but not latest
    const where = 'c.occurred_at_ms >= ? AND c.occurred_at_ms < ?';
    const optimized = sqliteQuery(metricObservationQuery(where, true, true));
    const legacy = optimized
        .replace(/^WITH numeric_keys AS \([\s\S]*?\),observations AS /, 'WITH observations AS ')
        .replace(/ JOIN numeric_keys nk ON nk\.provider_id\s+IS\s+f\.provider_id AND nk\.facet_key\s+IS\s+f\.facet_key/,'');
    try {
        const params = [0, 100];
        const normalize = rows => rows.map(row => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        assert.deepEqual(normalize(db.prepare(optimized).all(...params, ...params, 50)), normalize(db.prepare(legacy).all(...params, 50)));
        assert.equal(db.prepare(optimized).all(...params, ...params, 50).some(row => row.facet_key === 'metric.label'), false);
        assert.match(metricObservationQuery(where, true, true), /numeric_keys AS/);
        assert.doesNotMatch(metricObservationQuery(where, true, false), /numeric_keys AS/);
        assert.doesNotMatch(metricObservationQuery(`${where} AND f.facet_key IN (?)`, true, true, false), /numeric_keys AS/);
        assert.match(providerMetricObservationCountsQuery(`${where} AND f.facet_key IN (?)`), /GROUP BY f\.provider_id,f\.facet_key/);
    } finally { db.close(); }
});


test('hourly metric rollup keeps partial boundary hours on the raw path', () => {
    const range = metricObservationRollupRange({ startMs: 15 * 60 * 1000, endMs: 5 * 60 * 60 * 1000 + 45 * 60 * 1000 }, 1);
    assert.deepEqual(range, { fullStartMs: 60 * 60 * 1000, fullEndMs: 5 * 60 * 60 * 1000 });
    assert.deepEqual(metricObservationRollupParams([1, 2], range, true, 50), [1, 2, 1, 2, range.fullStartMs, range.fullEndMs, range.fullStartMs, range.fullEndMs, 1, 2, 50]);
    const sql = metricObservationRollupQuery('c.occurred_at_ms >= ? AND c.occurred_at_ms < ?', true, range, true, false);
    const params = metricObservationRollupParams([0, 100], range, false, 50);
    assert.match(sql, /bot_provider_metric_observation_hourly/);
    assert.equal((sql.match(/\?/g) || []).length, params.length);
    assert.equal(metricObservationRollupRange({ startMs: 0, endMs: 30 * 60 * 1000 }, 0), null);
});

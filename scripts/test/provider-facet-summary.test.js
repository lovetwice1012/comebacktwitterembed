'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const loadDashboard = require('./helpers/load-dashboard.cjs');
const { providerFacetSummaryQuery } = loadDashboard('lib/provider-facet-summary-query.ts');

test('ranked facet summaries preserve duplicates, nullable values, averages and distinct event counts', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE bot_provider_content_facets(provider_id TEXT,account_key TEXT,facet_key TEXT,facet_value TEXT,numeric_value REAL,content_event_id INTEGER,occurred_at_ms INTEGER)');
    const insert = db.prepare('INSERT INTO bot_provider_content_facets VALUES (?,?,?,?,?,?,?)');
    for (let i = 0; i < 500; i++) {
        const row = ['p' + i % 2, i % 3 ? 'account' : null, 'metric' + i % 4, i % 5 ? 'tag' : null, i % 7 ? i : null, i, 100];
        insert.run(...row);
        if (i % 3 === 0) insert.run(...row); // Multiple observations for one event.
    }
    insert.run('old', 'a', 'key', 'value', 1, 1, 1);
    const original = `SELECT provider_id,account_key,facet_key,facet_value,COUNT(*) AS count,AVG(numeric_value) AS avg_numeric_value,
        SUM(numeric_value) AS sum_numeric_value,COUNT(DISTINCT content_event_id) AS content_events
        FROM bot_provider_content_facets WHERE occurred_at_ms >= ? GROUP BY provider_id,account_key,facet_key,facet_value
        ORDER BY count DESC LIMIT 200`;
    const normalize = rows => rows.map(row => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    try {
        assert.deepEqual(normalize(db.prepare(providerFacetSummaryQuery.replaceAll('<=>', 'IS')).all(50, 50)), normalize(db.prepare(original).all(50)));
    } finally { db.close(); }
});

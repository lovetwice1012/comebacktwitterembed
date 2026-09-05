'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const loadDashboard = require('./helpers/load-dashboard.cjs');
const { facetObservationCountsQuery, facetSchemaDriftQuery } = loadDashboard('lib/facet-quality-queries.ts');

test('per-event quality aggregates preserve repeated observations, nulls, stages and content types', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE bot_provider_content_events(content_event_id INTEGER PRIMARY KEY,content_type TEXT);
      CREATE TABLE bot_provider_content_facets(provider_id TEXT,facet_key TEXT,content_event_id INTEGER,metric_stage TEXT,schema_version TEXT,metric_source TEXT,collection_success INTEGER,facet_value TEXT,numeric_value REAL,json_value TEXT,occurred_at_ms INTEGER)`);
    const parent = db.prepare('INSERT INTO bot_provider_content_events VALUES (?,?)');
    const insert = db.prepare('INSERT INTO bot_provider_content_facets VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    for (let id = 1; id <= 30; id++) {
        parent.run(id, [null, '', 'video'][id % 3]);
        const row = ['p','key',id,'initial',null,null,null,null,null,null,100];
        insert.run(...row);
        insert.run(...row);
        insert.run('p','key',id,'initial','unknown','unknown',0,'',0,null,101);
        insert.run('p','key',id,'enriched','v1','api',1,null,null,'{}',102);
    }
    const originalCounts = `SELECT f.provider_id,f.facet_key,COALESCE(c.content_type,'') AS content_type,
      COUNT(*) AS facet_rows,COUNT(DISTINCT f.content_event_id) AS observed_events,
      SUM(f.facet_value IS NULL AND f.numeric_value IS NULL AND f.json_value IS NULL) AS null_facets
      FROM bot_provider_content_facets f JOIN bot_provider_content_events c ON c.content_event_id=f.content_event_id
      WHERE f.occurred_at_ms>=? GROUP BY f.provider_id,f.facet_key,c.content_type`;
    const originalDrift = `SELECT provider_id,facet_key,COALESCE(metric_stage,'unknown') AS metric_stage,
      COALESCE(schema_version,'unknown') AS schema_version,COALESCE(metric_source,'unknown') AS metric_source,
      COUNT(*) AS observations,COUNT(DISTINCT content_event_id) AS observed_events,
      SUM(collection_success=0) AS failed_observations,MAX(occurred_at_ms) AS latest_ms
      FROM bot_provider_content_facets WHERE occurred_at_ms>=?
      GROUP BY provider_id,facet_key,metric_stage,schema_version,metric_source ORDER BY observations DESC LIMIT 500`;
    const normalize = rows => rows.map(row=>({...row})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    try {
        assert.deepEqual(normalize(db.prepare(facetObservationCountsQuery).all(50)),normalize(db.prepare(originalCounts).all(50)));
        assert.deepEqual(normalize(db.prepare(facetSchemaDriftQuery).all(50)),normalize(db.prepare(originalDrift).all(50)));
    } finally { db.close(); }
});

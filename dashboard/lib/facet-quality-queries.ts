// Per-event aggregation makes the outer event count exact without DISTINCT.
// It also avoids sorting millions of rows by wide text group keys.
export const facetObservationCountsQuery = `WITH per_event AS (
  SELECT /*+ INDEX(f idx_content_facets_time) */ f.provider_id,f.facet_key,f.content_event_id,
    COUNT(*) AS facet_rows,
    SUM(f.facet_value IS NULL AND f.numeric_value IS NULL AND f.json_value IS NULL) AS null_facets
  FROM bot_provider_content_facets f WHERE f.occurred_at_ms >= ?
  GROUP BY f.provider_id,f.facet_key,f.content_event_id
)
SELECT /*+ SET_VAR(tmp_table_size=2147483648) */ f.provider_id,f.facet_key,COALESCE(c.content_type,'') AS content_type,
  SUM(f.facet_rows) AS facet_rows,COUNT(*) AS observed_events,SUM(f.null_facets) AS null_facets
FROM per_event f JOIN bot_provider_content_events c ON c.content_event_id=f.content_event_id
GROUP BY f.provider_id,f.facet_key,c.content_type`;

export const facetSchemaDriftQuery = `WITH per_event AS (
  SELECT /*+ INDEX(f idx_content_facets_time) */ f.provider_id,f.facet_key,f.metric_stage,f.schema_version,f.metric_source,f.content_event_id,
    COUNT(*) AS observations,SUM(f.collection_success=0) AS failed_observations,MAX(f.occurred_at_ms) AS latest_ms
  FROM bot_provider_content_facets f WHERE f.occurred_at_ms >= ?
  GROUP BY f.provider_id,f.facet_key,f.metric_stage,f.schema_version,f.metric_source,f.content_event_id
)
SELECT /*+ SET_VAR(tmp_table_size=2147483648) */ provider_id,facet_key,COALESCE(metric_stage,'unknown') AS metric_stage,
  COALESCE(schema_version,'unknown') AS schema_version,COALESCE(metric_source,'unknown') AS metric_source,
  SUM(observations) AS observations,COUNT(*) AS observed_events,SUM(failed_observations) AS failed_observations,MAX(latest_ms) AS latest_ms
FROM per_event
GROUP BY provider_id,facet_key,per_event.metric_stage,per_event.schema_version,per_event.metric_source
ORDER BY observations DESC LIMIT 500`;

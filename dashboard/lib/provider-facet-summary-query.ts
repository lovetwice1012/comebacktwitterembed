// DISTINCT on every group forces a wide filesort over all source rows. Rank
// using ordinary aggregates, then count unique events only for the winners.
export const providerFacetSummaryQuery = `WITH ranked AS (
  SELECT /*+ INDEX(bot_provider_content_facets idx_content_facets_time) */
    provider_id, account_key, facet_key, facet_value,
    COUNT(*) AS count, AVG(numeric_value) AS avg_numeric_value, SUM(numeric_value) AS sum_numeric_value
  FROM bot_provider_content_facets
  WHERE occurred_at_ms >= ?
  GROUP BY provider_id, account_key, facet_key, facet_value
  ORDER BY count DESC LIMIT 200
)
SELECT ranked.*,
  (SELECT /*+ INDEX(f idx_content_facets_account_key_time) */ COUNT(DISTINCT f.content_event_id)
   FROM bot_provider_content_facets f
   WHERE f.provider_id=ranked.provider_id AND f.account_key <=> ranked.account_key
     AND f.facet_key=ranked.facet_key AND f.facet_value <=> ranked.facet_value
     AND f.occurred_at_ms >= ?) AS content_events
FROM ranked ORDER BY count DESC`;

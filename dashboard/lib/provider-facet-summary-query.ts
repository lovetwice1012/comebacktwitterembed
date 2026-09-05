// DISTINCT on every group forces a wide filesort over all source rows. Rank
// using ordinary aggregates, then count unique events only for the winners.
export const providerFacetSummaryQuery = `WITH ranked_values AS (
  SELECT /*+ INDEX(bot_provider_content_facets idx_content_facets_time) */
    provider_id, account_key, facet_key, facet_value,
    COUNT(*) AS count, AVG(numeric_value) AS avg_numeric_value, SUM(numeric_value) AS sum_numeric_value
  FROM bot_provider_content_facets
  WHERE occurred_at_ms >= ?
  GROUP BY provider_id, account_key, facet_key, facet_value
  ORDER BY count DESC LIMIT 200
), ranked AS (
  SELECT ranked_values.*,ROW_NUMBER() OVER (ORDER BY count DESC) AS group_no FROM ranked_values
), unique_counts AS (
  SELECT /*+ JOIN_ORDER(r,f) INDEX(f idx_content_facets_account_key_time) */
    r.group_no,COUNT(DISTINCT f.content_event_id) AS content_events
  FROM ranked r JOIN bot_provider_content_facets f
    ON f.provider_id=r.provider_id AND f.account_key <=> r.account_key
      AND f.facet_key=r.facet_key AND f.facet_value <=> r.facet_value
  WHERE f.occurred_at_ms >= ?
  GROUP BY r.group_no
)
SELECT r.provider_id,r.account_key,r.facet_key,r.facet_value,r.count,r.avg_numeric_value,r.sum_numeric_value,u.content_events
FROM ranked r JOIN unique_counts u ON u.group_no=r.group_no ORDER BY r.count DESC`;

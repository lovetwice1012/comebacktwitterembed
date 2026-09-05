/** Numeric values are snapshots, not independent increments. Latest is selected per subject and metric. */
export function metricObservationQuery(whereSql: string, groupAccount: boolean, numericOnly = true) {
  const keys = groupAccount ? "provider_id, account_key, facet_key" : "provider_id, facet_key";
  const join = groupAccount ? "t.provider_id <=> o.provider_id AND t.account_key <=> o.account_key AND t.facet_key <=> o.facet_key" : "t.provider_id <=> o.provider_id AND t.facet_key <=> o.facet_key";
  // Currency, rating scales and unknown units cannot be averaged merely because values are numeric.
  const comparable = "facet_key REGEXP '[.](likes|views|plays|comments|shares|retweets|reposts|replies|quotes|bookmarks|favorites|stars|forks|followers|subscribers|following|follower_count|subscriber_count|media_count|video_count|duration_seconds|duration_ms|size_bytes)$'";
  return `WITH observations AS (
    SELECT f.provider_id,f.account_key,f.facet_key,f.numeric_value,f.facet_id,
      c.author_user_id,c.guild_id,c.occurred_at_ms,c.content_event_id,
      COALESCE(f.collected_at_ms,c.occurred_at_ms) AS observed_at_ms,
      CASE WHEN f.facet_key REGEXP '[.](followers|subscribers|following|follower_count|subscriber_count)$'
        THEN CONCAT('account:',COALESCE(NULLIF(f.account_key,''),CONCAT('unknown:',c.content_event_id)))
        ELSE CONCAT('content:',COALESCE(NULLIF(c.content_id,''),NULLIF(c.normalized_url,''),NULLIF(c.content_url,''),CONCAT('unknown:',c.content_event_id))) END AS subject_key
    FROM bot_provider_content_facets f JOIN bot_provider_content_events c ON c.content_event_id=f.content_event_id
    WHERE ${whereSql} AND f.facet_key IS NOT NULL
  ), ranked AS (
    SELECT observations.*,ROW_NUMBER() OVER (PARTITION BY provider_id,subject_key COLLATE utf8mb4_bin,facet_key ORDER BY observed_at_ms DESC,content_event_id DESC,facet_id DESC) AS observation_rank
    FROM observations
  ), totals AS (
    SELECT ${keys},COUNT(*) AS content_count,COUNT(numeric_value) AS numeric_subject_count,
      CASE WHEN ${comparable} THEN AVG(numeric_value) ELSE NULL END AS avg_value,
      CASE WHEN ${comparable} THEN MIN(numeric_value) ELSE NULL END AS min_value,
      CASE WHEN ${comparable} THEN MAX(numeric_value) ELSE NULL END AS max_value,
      CASE WHEN facet_key REGEXP '[.](likes|views|plays|comments|shares|retweets|reposts|replies|quotes|bookmarks|favorites|stars|forks)$'
        THEN SUM(numeric_value) ELSE NULL END AS sum_value,
      MIN(observed_at_ms) AS oldest_observation_ms,MAX(observed_at_ms) AS latest_observation_ms,
      CASE WHEN ${comparable} THEN 'available' ELSE 'unsupported_aggregation' END AS aggregation_status,
      CASE WHEN ${comparable} THEN NULL ELSE 'currency_scale_or_unit_not_defined; inspect individual observations' END AS aggregation_note
    FROM ranked WHERE observation_rank=1 GROUP BY ${keys} ${numericOnly ? "HAVING COUNT(numeric_value)>0" : ""}
  ), observation_counts AS (
    SELECT ${keys},COUNT(*) AS events,COUNT(DISTINCT author_user_id) AS users,COUNT(DISTINCT guild_id) AS guilds
    FROM observations GROUP BY ${keys}
  ) SELECT t.*,o.events,o.users,o.guilds,'latest_subject_observation_v2' AS aggregation,
    'latest_observation_of_requests_in_selected_window' AS observation_window,
    'external_service_not_discord' AS metric_origin
    FROM totals t JOIN observation_counts o ON ${join} ORDER BY o.events DESC LIMIT ?`;
}

/** Ratio absence is not zero percent; keep the observed zero numerator. */
export function observedRatio(numerator: unknown, denominator: unknown): number | null {
  if (numerator == null || denominator == null || numerator === "" || denominator === "") return null;
  const top = Number(numerator), bottom = Number(denominator);
  return Number.isFinite(top) && Number.isFinite(bottom) && bottom > 0 ? top / bottom : null;
}

/** Recombine disjoint account groups without treating observation frequency as a metric value. */
export function aggregateNumericFacet(rows: Record<string, unknown>[], facetKey: string, valueKey = "sum_value"): number | null {
  const selected = rows.filter(row => row.facet_key === facetKey);
  if (!selected.length || selected.some(row => row.aggregation_status === "unsupported_aggregation")) return null;
  const available = selected.filter(row => row[valueKey] != null && Number.isFinite(Number(row[valueKey])));
  if (!available.length) return null;
  if (valueKey === "avg_value") {
    const counted = available.filter(row => Number(row.numeric_subject_count) > 0);
    const count = counted.reduce((sum, row) => sum + Number(row.numeric_subject_count), 0);
    return count ? counted.reduce((sum, row) => sum + Number(row.avg_value) * Number(row.numeric_subject_count), 0) / count : null;
  }
  if (valueKey === "min_value") return Math.min(...available.map(row => Number(row[valueKey])));
  if (valueKey === "max_value") return Math.max(...available.map(row => Number(row[valueKey])));
  if (["sum_value", "events", "content_count", "numeric_subject_count"].includes(valueKey)) return available.reduce((sum, row) => sum + Number(row[valueKey]), 0);
  return null;
}

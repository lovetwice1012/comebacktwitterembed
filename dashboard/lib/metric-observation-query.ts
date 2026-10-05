/** Numeric values are snapshots, not independent increments. Latest is selected per subject and metric. */
export function metricObservationQuery(whereSql: string, groupAccount: boolean, numericOnly = true, prefilterCandidates = numericOnly) {
  const keys = groupAccount ? "provider_id, account_key, facet_key" : "provider_id, facet_key";
  // Numeric reports do not need to rank facet keys that have no numeric
  // observation in the selected window. Keep every row for a candidate key so
  // a later non-numeric observation still suppresses an older numeric value,
  // while avoiding the window sort for unrelated text-only facets.
  const candidateKeys = prefilterCandidates ? `numeric_keys AS (
    SELECT /*+ JOIN_ORDER(c,f) */ DISTINCT f.provider_id,f.facet_key
    FROM bot_provider_content_facets f
    JOIN bot_provider_content_events c ON c.content_event_id=f.content_event_id
    WHERE ${whereSql} AND f.facet_key IS NOT NULL AND f.numeric_value IS NOT NULL
  ),` : "";
  const candidateJoin = prefilterCandidates ? " JOIN numeric_keys nk ON nk.provider_id <=> f.provider_id AND nk.facet_key <=> f.facet_key" : "";
  // Currency, rating scales and unknown units cannot be averaged merely because values are numeric.
  const comparable = "facet_key REGEXP '[.](likes|views|plays|comments|shares|retweets|reposts|replies|quotes|bookmarks|favorites|stars|forks|followers|subscribers|following|follower_count|subscriber_count|media_count|video_count|duration_seconds|duration_ms|size_bytes)$'";
  // Keep latest-value and observation-volume aggregates on the same ranked
  // stream. The previous shape scanned the observation CTE again for counts.
  return `WITH ${candidateKeys}observations AS (
    SELECT f.provider_id,f.account_key,f.facet_key,f.numeric_value,f.facet_id,
      c.author_user_id,c.guild_id,c.occurred_at_ms,c.content_event_id,
      COALESCE(f.collected_at_ms,c.occurred_at_ms) AS observed_at_ms,
      CASE WHEN f.facet_key REGEXP '[.](followers|subscribers|following|follower_count|subscriber_count)$'
        THEN CONCAT('account:',COALESCE(NULLIF(f.account_key,''),CONCAT('unknown:',c.content_event_id)))
        ELSE CONCAT('content:',COALESCE(NULLIF(c.content_id,''),NULLIF(c.normalized_url,''),NULLIF(c.content_url,''),CONCAT('unknown:',c.content_event_id))) END AS subject_key
    FROM bot_provider_content_facets f JOIN bot_provider_content_events c ON c.content_event_id=f.content_event_id${candidateJoin}
    WHERE ${whereSql} AND f.facet_key IS NOT NULL
  ), ranked AS (
    SELECT observations.*,ROW_NUMBER() OVER (PARTITION BY provider_id,subject_key COLLATE utf8mb4_bin,facet_key ORDER BY observed_at_ms DESC,content_event_id DESC,facet_id DESC) AS observation_rank
    FROM observations
  ) SELECT ${keys},
    COUNT(CASE WHEN observation_rank=1 THEN 1 END) AS content_count,
    COUNT(CASE WHEN observation_rank=1 THEN numeric_value END) AS numeric_subject_count,
    CASE WHEN ${comparable} THEN AVG(CASE WHEN observation_rank=1 THEN numeric_value END) ELSE NULL END AS avg_value,
    CASE WHEN ${comparable} THEN MIN(CASE WHEN observation_rank=1 THEN numeric_value END) ELSE NULL END AS min_value,
    CASE WHEN ${comparable} THEN MAX(CASE WHEN observation_rank=1 THEN numeric_value END) ELSE NULL END AS max_value,
    CASE WHEN facet_key REGEXP '[.](likes|views|plays|comments|shares|retweets|reposts|replies|quotes|bookmarks|favorites|stars|forks)$'
      THEN SUM(CASE WHEN observation_rank=1 THEN numeric_value END) ELSE NULL END AS sum_value,
    MIN(observed_at_ms) AS oldest_observation_ms,MAX(observed_at_ms) AS latest_observation_ms,
    CASE WHEN ${comparable} THEN 'available' ELSE 'unsupported_aggregation' END AS aggregation_status,
    CASE WHEN ${comparable} THEN NULL ELSE 'currency_scale_or_unit_not_defined; inspect individual observations' END AS aggregation_note,
    COUNT(*) AS events,COUNT(DISTINCT author_user_id) AS users,COUNT(DISTINCT guild_id) AS guilds,
    'latest_subject_observation_v2' AS aggregation,
    'latest_observation_of_requests_in_selected_window' AS observation_window,
    'external_service_not_discord' AS metric_origin
    FROM ranked GROUP BY ${keys} ${numericOnly ? "HAVING COUNT(CASE WHEN observation_rank=1 THEN numeric_value END)>0" : ""}
    ORDER BY events DESC LIMIT ?`;
}


export type MetricObservationRollupRange = { fullStartMs: number; fullEndMs: number };

const HOUR_MS = 60 * 60 * 1000;

export function metricObservationRollupRange(
  window: { startMs: number; endMs: number },
  coverageStartMs: number,
): MetricObservationRollupRange | null {
  if (!Number.isFinite(coverageStartMs) || coverageStartMs <= 0) return null;
  const fullStartMs = Math.max(
    Math.ceil(window.startMs / HOUR_MS) * HOUR_MS,
    Math.ceil(coverageStartMs / HOUR_MS) * HOUR_MS,
  );
  const fullEndMs = Math.floor(window.endMs / HOUR_MS) * HOUR_MS;
  return fullStartMs < fullEndMs ? { fullStartMs, fullEndMs } : null;
}

export function metricObservationRollupParams(
  baseParams: unknown[],
  range: MetricObservationRollupRange,
  prefilterCandidates: boolean,
  limit: number,
) {
  return [
    ...(prefilterCandidates ? baseParams : []),
    ...baseParams,
    range.fullStartMs,
    range.fullEndMs,
    range.fullStartMs,
    range.fullEndMs,
    ...baseParams,
    limit,
  ];
}

/**
 * Use hourly latest rows for the expensive latest-subject ranking. Boundary
 * hours stay raw; exact event/user/guild counts are fetched separately.
 */
export function metricObservationRollupQuery(
  whereSql: string,
  groupAccount: boolean,
  range: MetricObservationRollupRange,
  numericOnly = true,
  prefilterCandidates = numericOnly,
) {
  const keys = groupAccount ? "provider_id, account_key, facet_key" : "provider_id, facet_key";
  const rollupWhere = whereSql.replace(/\bc\./g, "r.").replace(/\bf\./g, "r.");
  const candidateKeys = prefilterCandidates ? `numeric_keys AS (
    SELECT /*+ JOIN_ORDER(c,f) */ DISTINCT f.provider_id,f.facet_key
    FROM bot_provider_content_facets f
    JOIN bot_provider_content_events c ON c.content_event_id=f.content_event_id
    WHERE ${whereSql} AND f.facet_key IS NOT NULL AND f.numeric_value IS NOT NULL
  ),` : "";
  const candidateJoin = prefilterCandidates
    ? " JOIN numeric_keys nk ON nk.provider_id <=> f.provider_id AND nk.facet_key <=> f.facet_key"
    : "";
  const rollupCandidateJoin = prefilterCandidates
    ? " JOIN numeric_keys nk ON nk.provider_id <=> r.provider_id AND nk.facet_key <=> r.facet_key"
    : "";
  const comparable = "facet_key REGEXP '[.](likes|views|plays|comments|shares|retweets|reposts|replies|quotes|bookmarks|favorites|stars|forks|followers|subscribers|following|follower_count|subscriber_count|media_count|video_count|duration_seconds|duration_ms|size_bytes)$'";
  return `WITH ${candidateKeys}edge_base AS (
    SELECT f.provider_id,f.account_key,f.facet_key,f.numeric_value,f.facet_id,
      c.author_user_id,c.guild_id,c.occurred_at_ms,c.content_event_id,
      COALESCE(f.collected_at_ms,c.occurred_at_ms) AS observed_at_ms,
      CASE WHEN f.facet_key REGEXP '[.](followers|subscribers|following|follower_count|subscriber_count)$'
        THEN CONCAT('account:',COALESCE(NULLIF(f.account_key,''),CONCAT('unknown:',c.content_event_id)))
        ELSE CONCAT('content:',COALESCE(NULLIF(c.content_id,''),NULLIF(c.normalized_url,''),NULLIF(c.content_url,''),CONCAT('unknown:',c.content_event_id))) END AS subject_key
    FROM bot_provider_content_facets f JOIN bot_provider_content_events c ON c.content_event_id=f.content_event_id${candidateJoin}
    WHERE ${whereSql} AND f.facet_key IS NOT NULL
      AND (c.occurred_at_ms < ? OR c.occurred_at_ms >= ?)
  ), edge_observations AS (
    SELECT edge_base.*,UNHEX(SHA2(subject_key,256)) AS subject_hash
    FROM edge_base
  ), rollup_observations AS (
    SELECT r.provider_id,r.account_key,r.facet_key,r.numeric_value,r.facet_id,
      r.author_user_id,r.guild_id,r.occurred_at_ms,r.content_event_id,r.observed_at_ms,
      r.subject_key,r.subject_hash
    FROM bot_provider_metric_observation_hourly r${rollupCandidateJoin}
    WHERE r.bucket_start_ms >= ? AND r.bucket_start_ms < ?
      AND ${rollupWhere} AND r.facet_key IS NOT NULL
  ), observations AS (
    SELECT provider_id,account_key,facet_key,numeric_value,facet_id,
      author_user_id,guild_id,occurred_at_ms,content_event_id,observed_at_ms,subject_key,subject_hash
    FROM edge_observations
    UNION ALL
    SELECT provider_id,account_key,facet_key,numeric_value,facet_id,
      author_user_id,guild_id,occurred_at_ms,content_event_id,observed_at_ms,subject_key,subject_hash
    FROM rollup_observations
  ), ranked AS (
    SELECT observations.*,ROW_NUMBER() OVER (
      PARTITION BY provider_id,subject_hash,facet_key
      ORDER BY observed_at_ms DESC,content_event_id DESC,facet_id DESC
    ) AS observation_rank
    FROM observations
  )
  SELECT ${keys},COUNT(*) AS content_count,COUNT(numeric_value) AS numeric_subject_count,
    CASE WHEN ${comparable} THEN AVG(numeric_value) ELSE NULL END AS avg_value,
    CASE WHEN ${comparable} THEN MIN(numeric_value) ELSE NULL END AS min_value,
    CASE WHEN ${comparable} THEN MAX(numeric_value) ELSE NULL END AS max_value,
    CASE WHEN facet_key REGEXP '[.](likes|views|plays|comments|shares|retweets|reposts|replies|quotes|bookmarks|favorites|stars|forks)$'
      THEN SUM(numeric_value) ELSE NULL END AS sum_value,
    CASE WHEN ${comparable} THEN 'available' ELSE 'unsupported_aggregation' END AS aggregation_status,
    CASE WHEN ${comparable} THEN NULL ELSE 'currency_scale_or_unit_not_defined; inspect individual observations' END AS aggregation_note,
    'latest_subject_observation_v3_hourly_rollup' AS aggregation,
    'latest_observation_of_requests_in_selected_window' AS observation_window,
    'external_service_not_discord' AS metric_origin
  FROM ranked WHERE observation_rank=1 GROUP BY ${keys} ${numericOnly ? "HAVING COUNT(numeric_value)>0" : ""}
  ORDER BY content_count DESC LIMIT ?`;
}

export function metricObservationCountsQuery(whereSql: string, groupAccount: boolean) {
  const keys = groupAccount
    ? "f.provider_id AS provider_id,f.account_key AS account_key,f.facet_key AS facet_key"
    : "f.provider_id AS provider_id,f.facet_key AS facet_key";
  const groups = groupAccount ? "f.provider_id,f.account_key,f.facet_key" : "f.provider_id,f.facet_key";
  return `SELECT /*+ SET_VAR(tmp_table_size=1073741824) */
      ${keys},COUNT(*) AS events,COUNT(DISTINCT c.author_user_id) AS users,
      COUNT(DISTINCT c.guild_id) AS guilds,
      MIN(COALESCE(f.collected_at_ms,c.occurred_at_ms)) AS oldest_observation_ms,
      MAX(COALESCE(f.collected_at_ms,c.occurred_at_ms)) AS latest_observation_ms
    FROM bot_provider_content_facets f
    JOIN bot_provider_content_events c ON c.content_event_id=f.content_event_id
    WHERE ${whereSql} AND f.facet_key IS NOT NULL
    GROUP BY ${groups}`;
}

// Provider schema coverage only needs the observed event/user/server counts.
// It does not consume latest numeric values; using the full latest-subject
// window for this auxiliary section needlessly sorts every observation again.
export function providerMetricObservationCountsQuery(whereSql: string) {
  return `SELECT /*+ SET_VAR(tmp_table_size=1073741824) */
      f.provider_id,f.facet_key,COUNT(*) AS events,
      COUNT(DISTINCT c.author_user_id) AS users,COUNT(DISTINCT c.guild_id) AS guilds
    FROM bot_provider_content_facets f
    JOIN bot_provider_content_events c ON c.content_event_id=f.content_event_id
    WHERE ${whereSql}
    GROUP BY f.provider_id,f.facet_key
    ORDER BY events DESC LIMIT ?`;
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

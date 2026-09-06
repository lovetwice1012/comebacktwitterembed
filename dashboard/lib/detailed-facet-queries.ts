/**
 * Materialize the filtered observations once, rank with ordinary aggregates,
 * then compute exact audience counts for only the groups that will be shown.
 * The content filter is deliberately applied to c.occurred_at_ms; a facet may
 * have been collected later than its parent event.
 */
export function detailedFacetBreakdownQuery(whereSql: string) {
  return `WITH observations AS (
    SELECT /*+ JOIN_ORDER(c,f) */ f.content_event_id,f.provider_id,f.account_key,
      f.facet_key,f.facet_value,f.numeric_value
    FROM bot_provider_content_events c
    JOIN bot_provider_content_facets f ON f.content_event_id=c.content_event_id
    WHERE ${whereSql}
  ), ranked_values AS (
    SELECT /*+ NO_MERGE(observations) */ provider_id,account_key,facet_key,facet_value,
      COUNT(*) AS events,AVG(numeric_value) AS avg_numeric_value,
      MIN(numeric_value) AS min_numeric_value,MAX(numeric_value) AS max_numeric_value
    FROM observations GROUP BY provider_id,account_key,facet_key,facet_value
    ORDER BY events DESC LIMIT ?
  ), ranked AS (
    SELECT ranked_values.*,ROW_NUMBER() OVER (ORDER BY events DESC) AS group_no
    FROM ranked_values
  ), participants AS (
    SELECT /*+ NO_MERGE(o) JOIN_ORDER(r,o) */ DISTINCT r.group_no,o.content_event_id
    FROM ranked r JOIN observations o
      ON o.provider_id <=> r.provider_id AND o.account_key <=> r.account_key
        AND o.facet_key <=> r.facet_key AND o.facet_value <=> r.facet_value
  ), audiences AS (
    SELECT p.group_no,COUNT(DISTINCT c.author_user_id) AS users,
      COUNT(DISTINCT c.guild_id) AS guilds
    FROM participants p JOIN bot_provider_content_events c ON c.content_event_id=p.content_event_id
    GROUP BY p.group_no
  )
  SELECT /*+ SET_VAR(tmp_table_size=2147483648) */ r.provider_id,r.account_key,r.facet_key,r.facet_value,
    r.events,a.users,a.guilds,r.avg_numeric_value,r.min_numeric_value,r.max_numeric_value
  FROM ranked r JOIN audiences a ON a.group_no=r.group_no ORDER BY r.events DESC`;
}

/**
 * A segment is one event/metric/bucket, even when the event has repeated metric
 * observations. Keep that existing average-of-event-averages semantics. Parent
 * IDs/URLs are loaded only after ranking, avoiding wide DISTINCT aggregates for
 * every segment. RANK retains all ties at the event-count cutoff because users
 * and guilds participate in the final ordering.
 *
 * Parameters: content filter values, metric-key values, limit, limit.
 * whereSql and segmentValueSql are trusted application SQL, never user input.
 */
export function detailedProviderMarketingSegmentsQuery(whereSql: string, metricPlaceholders: string, segmentValueSql: string) {
  return `WITH segments AS (
    SELECT /*+ JOIN_ORDER(c,f) */ f.content_event_id,f.provider_id,f.account_key,
      f.facet_key AS metric_key,${segmentValueSql} AS facet_value,AVG(f.numeric_value) AS numeric_value
    FROM bot_provider_content_events c
    JOIN bot_provider_content_facets f ON f.content_event_id=c.content_event_id
    WHERE ${whereSql} AND f.facet_key IN (${metricPlaceholders})
    GROUP BY f.content_event_id,f.provider_id,f.account_key,f.facet_key,${segmentValueSql}
  ), totals AS (
    SELECT provider_id,account_key,metric_key,facet_value,COUNT(*) AS events,
      AVG(numeric_value) AS avg_numeric_value,MIN(numeric_value) AS min_numeric_value,
      MAX(numeric_value) AS max_numeric_value
    FROM segments GROUP BY provider_id,account_key,metric_key,facet_value
  ), ranks AS (
    SELECT totals.*,RANK() OVER (ORDER BY events DESC) AS event_rank,
      ROW_NUMBER() OVER (ORDER BY events DESC) AS group_no FROM totals
  ), candidates AS (
    SELECT * FROM ranks WHERE event_rank <= ?
  ), audiences AS (
    SELECT /*+ JOIN_ORDER(r,s,c) */ r.group_no,COUNT(DISTINCT c.author_user_id) AS users,
      COUNT(DISTINCT c.guild_id) AS guilds,
      COUNT(DISTINCT COALESCE(c.normalized_url,c.content_url)) AS urls,
      MAX(c.occurred_at_ms) AS latest_ms
    FROM candidates r JOIN segments s
      ON s.provider_id <=> r.provider_id AND s.account_key <=> r.account_key
        AND s.metric_key <=> r.metric_key AND s.facet_value <=> r.facet_value
    JOIN bot_provider_content_events c ON c.content_event_id=s.content_event_id
    GROUP BY r.group_no
  )
  SELECT /*+ SET_VAR(tmp_table_size=2147483648) */ r.provider_id,r.account_key,r.metric_key,r.facet_value,
    r.events,a.users,a.guilds,a.urls,r.avg_numeric_value,NULL AS sum_numeric_value,
    r.min_numeric_value,r.max_numeric_value,a.latest_ms
  FROM candidates r JOIN audiences a ON a.group_no=r.group_no
  ORDER BY r.events DESC,a.users DESC,a.guilds DESC LIMIT ?`;
}

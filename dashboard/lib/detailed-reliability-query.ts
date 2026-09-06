/**
 * Rank reliability groups without wide DISTINCT aggregates, then calculate the
 * exact audience only for the selected groups using their numeric group IDs.
 * Materializing the filtered source once keeps every analyticsWhere predicate
 * and its bindings in one place. Null success/provider rows remain excluded.
 */
export function detailedProviderReliabilityQuery(whereSql: string) {
  // Broad time windows otherwise compete with the group-key index. Leave
  // narrower provider/guild/user/event/command/component filters to MySQL.
  const sourceHint = /^\s*a\.occurred_at_ms\s*>=\s*\?\s+AND\s+a\.occurred_at_ms\s*<\s*\?\s*$/i.test(whereSql)
    ? "/*+ INDEX(a idx_analytics_time) */ " : "";
  return `WITH observations AS (
    SELECT ${sourceHint}a.provider_id,a.account_key,a.event_type,a.success,a.duration_ms,
      a.author_user_id,a.guild_id
    FROM bot_analytics_events a
    WHERE ${whereSql} AND a.provider_id IS NOT NULL AND a.success IS NOT NULL
  ), ranked_values AS (
    SELECT /*+ NO_MERGE(observations) */ provider_id,account_key,event_type,
      COUNT(*) AS events,SUM(success=1) AS successes,SUM(success=0) AS failures,
      AVG(duration_ms) AS avg_duration_ms,MAX(duration_ms) AS max_duration_ms
    FROM observations GROUP BY provider_id,account_key,event_type
    ORDER BY events DESC LIMIT ?
  ), ranked AS (
    SELECT ranked_values.*,ROW_NUMBER() OVER (ORDER BY events DESC) AS group_no FROM ranked_values
  ), audiences AS (
    SELECT /*+ NO_MERGE(o) JOIN_ORDER(r,o) */ r.group_no,
      COUNT(DISTINCT o.author_user_id) AS users,COUNT(DISTINCT o.guild_id) AS guilds
    FROM ranked r JOIN observations o
      ON o.provider_id <=> r.provider_id AND o.account_key <=> r.account_key AND o.event_type <=> r.event_type
    GROUP BY r.group_no
  )
  SELECT /*+ SET_VAR(tmp_table_size=1073741824) */ r.provider_id,r.account_key,r.event_type,
    r.events,r.successes,r.failures,a.users,a.guilds,r.avg_duration_ms,r.max_duration_ms
  FROM ranked r JOIN audiences a ON a.group_no=r.group_no ORDER BY r.events DESC`;
}

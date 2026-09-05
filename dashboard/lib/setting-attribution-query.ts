const groupColumns = ['attribution_type', 'setting_direction', 'provider_id', 'setting_key', 'action'];
const measures = [
  ['content_events', 'content'], ['extract_events', 'extract'], ['extract_successes', 'extract_successes'],
  ['send_events', 'send'], ['send_successes', 'send_successes'], ['enrichment_jobs', 'enrichment'],
  ['enrichment_successes', 'enrichment_successes'], ['analytics_duration_sum_ms', 'analytics_duration_sum'],
  ['analytics_duration_count', 'analytics_duration_count'],
];

export function settingImpactSummaryQuery(auditScope: string) {
  const perAudit = measures.flatMap(([column, label]) => [
    `SUM(CASE WHEN h.bucket_start_ms < a.changed_at_ms THEN h.${column} ELSE 0 END) AS ${label}_before`,
    `SUM(CASE WHEN h.bucket_start_ms >= a.changed_at_ms THEN h.${column} ELSE 0 END) AS ${label}_after`,
  ]).join(',\n');
  const totals = measures.flatMap(([, label]) => [
    `SUM(m.${label}_before) AS ${label}_before`, `SUM(m.${label}_after) AS ${label}_after`,
  ]).join(',\n');
  const scopes = [
    { where: 'a.guild_id IS NOT NULL AND a.provider_id IS NOT NULL', join: 'h.guild_id=a.guild_id AND h.provider_id=a.provider_id', index: 'idx_provider_hourly_guild_time' },
    { where: 'a.guild_id IS NOT NULL AND a.provider_id IS NULL', join: 'h.guild_id=a.guild_id', index: 'idx_provider_hourly_guild_time' },
    { where: 'a.guild_id IS NULL AND a.provider_id IS NOT NULL', join: 'h.provider_id=a.provider_id', index: 'idx_provider_hourly_provider_time' },
  ];
  const branches = scopes.map(scope => `SELECT /*+ INDEX(h ${scope.index}) */
    a.audit_log_id,a.guild_id,${groupColumns.map(column => `a.${column}`).join(',')},${perAudit},
    MAX(h.bucket_start_ms) AS latest_bucket_ms
    FROM audits a CROSS JOIN impact_params p
    LEFT JOIN bot_provider_hourly_aggregates h ON ${scope.join}
      AND h.bucket_start_ms >= a.changed_at_ms-p.window_ms AND h.bucket_start_ms < a.changed_at_ms+p.window_ms
    WHERE ${scope.where}
    GROUP BY a.audit_log_id,a.guild_id,${groupColumns.map(column => `a.${column}`).join(',')},a.changed_at_ms`);
  // Branches are disjoint and retain audits with no matching facts. Reducing
  // each audit first avoids sorting billions of joined rows by wide labels.
  return `WITH audits AS (${auditScope}), impact_params AS (SELECT ? AS window_ms),
    per_audit AS (${branches.join('\nUNION ALL\n')})
    SELECT ${groupColumns.map(column => `m.${column}`).join(',')},COUNT(*) AS changes,
      COUNT(DISTINCT m.guild_id) AS affected_guilds,${totals},MAX(m.latest_bucket_ms) AS latest_bucket_ms
    FROM per_audit m GROUP BY ${groupColumns.map(column => `m.${column}`).join(',')}
    ORDER BY content_after DESC,changes DESC LIMIT 120`;
}

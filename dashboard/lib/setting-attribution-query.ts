const groupColumns = ['attribution_type', 'setting_direction', 'provider_id', 'setting_key', 'action'];
const measures = [
  ['content_events', 'content'], ['extract_events', 'extract'], ['extract_successes', 'extract_successes'],
  ['send_events', 'send'], ['send_successes', 'send_successes'], ['enrichment_jobs', 'enrichment'],
  ['enrichment_successes', 'enrichment_successes'], ['analytics_duration_sum_ms', 'analytics_duration_sum'],
  ['analytics_duration_count', 'analytics_duration_count'],
];
const scopes = [
  { where: 'a.guild_id IS NOT NULL AND a.provider_id IS NOT NULL', join: 'h.guild_id=a.guild_id AND h.provider_id=a.provider_id', source: 'guild_hours', contentIndex: 'idx_content_guild_time' },
  { where: 'a.guild_id IS NOT NULL AND a.provider_id IS NULL', join: 'h.guild_id=a.guild_id', source: 'guild_hours', contentIndex: 'idx_content_guild_time' },
  { where: 'a.guild_id IS NULL AND a.provider_id IS NOT NULL', join: 'h.provider_id=a.provider_id', source: 'provider_hours', contentIndex: 'idx_content_provider_account_time' },
];

export function settingImpactSummaryQuery(auditScope: string) {
  const perAudit = measures.flatMap(([column, label]) => [
    `SUM(CASE WHEN h.bucket_start_ms < a.changed_at_ms THEN h.${column} ELSE 0 END) AS ${label}_before`,
    `SUM(CASE WHEN h.bucket_start_ms >= a.changed_at_ms THEN h.${column} ELSE 0 END) AS ${label}_after`,
  ]).join(',\n');
  const totals = measures.flatMap(([, label]) => [
    `SUM(m.${label}_before) AS ${label}_before`, `SUM(m.${label}_after) AS ${label}_after`,
  ]).join(',\n');
  const hourlySums = measures.map(([column]) => `SUM(h.${column}) AS ${column}`).join(',');
  const branches = scopes.map(scope => `SELECT
    a.audit_log_id,a.guild_id,${groupColumns.map(column => `a.${column}`).join(',')},${perAudit},
    MAX(h.bucket_start_ms) AS latest_bucket_ms
    FROM audits a CROSS JOIN impact_params p
    LEFT JOIN ${scope.source} h ON ${scope.join}
      AND h.bucket_start_ms >= a.changed_at_ms-p.window_ms AND h.bucket_start_ms < a.changed_at_ms+p.window_ms
    WHERE ${scope.where}
    GROUP BY a.audit_log_id,a.guild_id,${groupColumns.map(column => `a.${column}`).join(',')},a.changed_at_ms`);
  // Only additive measures are reduced before joining overlapping audit windows.
  // Each audit still contributes independently, including audits with no facts.
  return `WITH audits AS (${auditScope}), impact_params AS (SELECT ? AS window_ms),
    bounds AS (SELECT MIN(changed_at_ms) AS first_ms,MAX(changed_at_ms) AS last_ms FROM audits),
    guild_scope AS (SELECT DISTINCT guild_id FROM audits WHERE guild_id IS NOT NULL),
    provider_scope AS (SELECT DISTINCT provider_id FROM audits WHERE guild_id IS NULL AND provider_id IS NOT NULL),
    guild_hours AS (
      SELECT /*+ INDEX(h idx_provider_hourly_guild_time) */ h.guild_id,h.provider_id,h.bucket_start_ms,${hourlySums}
      FROM guild_scope s JOIN bot_provider_hourly_aggregates h ON h.guild_id=s.guild_id
      CROSS JOIN bounds b CROSS JOIN impact_params p
      WHERE h.bucket_start_ms>=b.first_ms-p.window_ms AND h.bucket_start_ms<b.last_ms+p.window_ms
      GROUP BY h.guild_id,h.provider_id,h.bucket_start_ms
    ), provider_hours AS (
      SELECT /*+ INDEX(h idx_provider_hourly_provider_time) */ h.provider_id,h.bucket_start_ms,${hourlySums}
      FROM provider_scope s JOIN bot_provider_hourly_aggregates h ON h.provider_id=s.provider_id
      CROSS JOIN bounds b CROSS JOIN impact_params p
      WHERE h.bucket_start_ms>=b.first_ms-p.window_ms AND h.bucket_start_ms<b.last_ms+p.window_ms
      GROUP BY h.provider_id,h.bucket_start_ms
    ), per_audit AS (${branches.join('\nUNION ALL\n')})
    SELECT /*+ SET_VAR(tmp_table_size=1073741824) */ ${groupColumns.map(column => `m.${column}`).join(',')},COUNT(*) AS changes,
      COUNT(DISTINCT m.guild_id) AS affected_guilds,${totals},MAX(m.latest_bucket_ms) AS latest_bucket_ms
    FROM per_audit m GROUP BY ${groupColumns.map(column => `m.${column}`).join(',')}
    ORDER BY content_after DESC,changes DESC LIMIT 120`;
}

export function settingChangeImpactQuery(auditScope: string) {
  const columns = ['audit_log_id', 'guild_id', 'provider_id', 'setting_key', 'action', 'changed_at_ms'];
  const branches = scopes.map(scope => `SELECT /*+ INDEX(h ${scope.contentIndex}) */
    ${columns.map(column => `a.${column}`).join(',')},
    SUM(CASE WHEN h.occurred_at_ms<a.changed_at_ms THEN 1 ELSE 0 END) AS content_before,
    SUM(CASE WHEN h.occurred_at_ms>=a.changed_at_ms THEN 1 ELSE 0 END) AS content_after,
    COUNT(DISTINCT CASE WHEN h.occurred_at_ms>=a.changed_at_ms THEN h.author_user_id END) AS users_after
    FROM latest_audits a CROSS JOIN impact_params p
    LEFT JOIN bot_provider_content_events h ON ${scope.join}
      AND h.occurred_at_ms>=a.changed_at_ms-p.window_ms AND h.occurred_at_ms<a.changed_at_ms+p.window_ms
    WHERE ${scope.where}
    GROUP BY ${columns.map(column => `a.${column}`).join(',')}`);
  return `WITH latest_audits AS (${auditScope}),impact_params AS (SELECT ? AS window_ms)
    SELECT * FROM (${branches.join('\nUNION ALL\n')}) impacts ORDER BY changed_at_ms DESC`;
}

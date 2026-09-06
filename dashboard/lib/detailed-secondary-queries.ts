// Keep these builders separate from report assembly so their SQL can be
// compared with the original reports using the same bound parameters.
export function detailedSecondaryInterestQuery(targetWhereSql: string) {
  return `WITH target_events AS (
    SELECT target.author_user_id,target.provider_id,target.account_key,target.guild_id,COUNT(*) AS activity_count
    FROM bot_provider_content_events target
    WHERE ${targetWhereSql} AND target.author_user_id IS NOT NULL
    GROUP BY target.author_user_id,target.provider_id,target.account_key,target.guild_id
  ), target_counts AS (
    SELECT author_user_id,provider_id,account_key,SUM(activity_count) AS activity_count
    FROM target_events GROUP BY author_user_id,provider_id,account_key
  ), target_accounts AS (
    SELECT target_counts.*,DENSE_RANK() OVER (ORDER BY provider_id,account_key) AS target_id
    FROM target_counts
  ), other_counts AS (
    SELECT author_user_id,provider_id,account_key,content_type,COUNT(*) AS activity_count
    FROM bot_provider_content_events
    WHERE occurred_at_ms>=? AND occurred_at_ms<=?
      AND author_user_id IS NOT NULL AND provider_id IS NOT NULL
    GROUP BY author_user_id,provider_id,account_key,content_type
  ), other_events AS (
    SELECT other_counts.*,DENSE_RANK() OVER (ORDER BY provider_id,account_key,content_type) AS other_id
    FROM other_counts
  ), ranked_ids AS (
    SELECT target.target_id,other.other_id,
      SUM(target.activity_count*other.activity_count) AS co_events,COUNT(*) AS shared_users
    FROM target_accounts target JOIN other_events other ON other.author_user_id=target.author_user_id
    WHERE other.provider_id<>target.provider_id
      OR COALESCE(other.account_key,'')<>COALESCE(target.account_key,'')
    GROUP BY target.target_id,other.other_id ORDER BY co_events DESC LIMIT ?
  ), target_labels AS (
    SELECT target_id,MIN(provider_id) AS provider_id,MIN(account_key) AS account_key
    FROM target_accounts GROUP BY target_id
  ), other_labels AS (
    SELECT other_id,MIN(provider_id) AS provider_id,MIN(account_key) AS account_key,MIN(content_type) AS content_type
    FROM other_events GROUP BY other_id
  )
  SELECT /*+ SET_VAR(tmp_table_size=2147483648) */
    target_label.provider_id AS target_provider_id,target_label.account_key AS target_account_key,
    other_label.provider_id AS interest_provider_id,other_label.account_key AS interest_account_key,
    other_label.content_type AS interest_content_type,pairs.co_events,pairs.shared_users,
    (SELECT COUNT(DISTINCT target.guild_id) FROM target_events target
     WHERE target.provider_id<=>target_label.provider_id AND target.account_key<=>target_label.account_key
       AND EXISTS (SELECT 1 FROM other_events other
         WHERE other.author_user_id=target.author_user_id AND other.other_id=pairs.other_id)) AS shared_guilds
  FROM ranked_ids pairs
  JOIN target_labels target_label ON target_label.target_id=pairs.target_id
  JOIN other_labels other_label ON other_label.other_id=pairs.other_id
  ORDER BY co_events DESC`;
}

const urlColumns = ['provider_id', 'account_key', 'content_url', 'normalized_url'];

export function detailedContentLifetimeQuery(contentWhereSql: string) {
  const columns = [...urlColumns.slice(0, 2), 'content_type', ...urlColumns.slice(2)];
  const keys = columns.join(',');
  // More than one distinct user/guild necessarily implies more than one event.
  // Ranking therefore needs only additive measures; exact distinct counts and
  // titles are fetched for winners after LIMIT, with null-safe key joins.
  return `WITH events AS (
    SELECT ${columns.map(column => `c.${column}`).join(',')},c.occurred_at_ms,c.author_user_id,c.guild_id,c.title
    FROM bot_provider_content_events c WHERE ${contentWhereSql}
      AND (c.content_url IS NOT NULL OR c.normalized_url IS NOT NULL)
  ), top_values AS (
    SELECT ${keys},COUNT(*) AS content_events,MIN(occurred_at_ms) AS first_seen_ms,MAX(occurred_at_ms) AS last_seen_ms
    FROM events GROUP BY ${keys} HAVING content_events>1
    ORDER BY (last_seen_ms-first_seen_ms) DESC,content_events DESC LIMIT ?
  ), ranked AS (
    SELECT top_values.*,ROW_NUMBER() OVER () AS group_no FROM top_values
  ), selected_stats AS (
    SELECT r.group_no,MAX(c.title) AS title,COUNT(DISTINCT c.author_user_id) AS users,COUNT(DISTINCT c.guild_id) AS guilds
    FROM ranked r JOIN events c ON ${columns.map(column => `c.${column}<=>r.${column}`).join(' AND ')}
    GROUP BY r.group_no
  )
  SELECT /*+ SET_VAR(tmp_table_size=2147483648) */ ${columns.map(column => `r.${column}`).join(',')},
    s.title,r.content_events,s.users,s.guilds,r.first_seen_ms,r.last_seen_ms
  FROM ranked r JOIN selected_stats s ON s.group_no=r.group_no
  ORDER BY (r.last_seen_ms-r.first_seen_ms) DESC,r.content_events DESC`;
}

export function detailedUrlReuseQuery(contentWhereSql: string) {
  // Reuse ranks on guilds AND users, unlike the overview report. Both exact
  // distinct measures must be calculated before LIMIT. Numeric group IDs keep
  // long URL tuples out of those distinct aggregates without hashing keys or
  // changing their database collation/null grouping.
  return `WITH events AS (
    SELECT ${urlColumns.map(column => `c.${column}`).join(',')},c.occurred_at_ms,c.author_user_id,c.guild_id,c.title,
      DENSE_RANK() OVER (ORDER BY ${urlColumns.map(column => `c.${column}`).join(',')}) AS group_no
    FROM bot_provider_content_events c WHERE ${contentWhereSql}
      AND (c.content_url IS NOT NULL OR c.normalized_url IS NOT NULL)
  ), ranked AS (
    SELECT group_no,COUNT(*) AS content_events,COUNT(DISTINCT guild_id) AS guilds,COUNT(DISTINCT author_user_id) AS users,
      MIN(occurred_at_ms) AS first_seen_ms,MAX(occurred_at_ms) AS last_seen_ms
    FROM events GROUP BY group_no HAVING content_events>1
    ORDER BY guilds DESC,users DESC,content_events DESC LIMIT ?
  ), selected_labels AS (
    SELECT e.group_no,${urlColumns.map(column => `MIN(e.${column}) AS ${column}`).join(',')},MAX(e.title) AS title
    FROM ranked r JOIN events e ON e.group_no=r.group_no GROUP BY e.group_no
  )
  SELECT /*+ SET_VAR(tmp_table_size=2147483648) */ ${urlColumns.map(column => `s.${column}`).join(',')},
    s.title,r.content_events,r.guilds,r.users,r.first_seen_ms,r.last_seen_ms
  FROM ranked r JOIN selected_labels s ON s.group_no=r.group_no
  ORDER BY r.guilds DESC,r.users DESC,r.content_events DESC`;
}

export function detailedSettingImpactQuery(auditWhereSql: string) {
  const columns = ['audit_log_id', 'provider_id', 'setting_key', 'action', 'guild_id', 'changed_at_ms'];
  const scopes = [
    { where: 'a.guild_id IS NOT NULL AND a.provider_id IS NOT NULL', join: 'c.guild_id=a.guild_id AND c.provider_id=a.provider_id', index: 'idx_content_guild_time' },
    { where: 'a.guild_id IS NOT NULL AND a.provider_id IS NULL', join: 'c.guild_id=a.guild_id', index: 'idx_content_guild_time' },
    { where: 'a.guild_id IS NULL AND a.provider_id IS NOT NULL', join: 'c.provider_id=a.provider_id', index: 'idx_content_provider_account_time' },
  ];
  // An audit belongs to exactly one branch. Each audit retains its own window
  // and distinct user count before group totals, including overlapping audits
  // and audits with no matching content. Parameter order stays unchanged.
  const branches = scopes.map(scope => `SELECT /*+ INDEX(c ${scope.index}) */
    ${columns.map(column => `a.${column}`).join(',')},
    SUM(CASE WHEN c.occurred_at_ms<a.changed_at_ms THEN 1 ELSE 0 END) AS content_before,
    SUM(CASE WHEN c.occurred_at_ms>=a.changed_at_ms AND c.occurred_at_ms<a.changed_at_ms+p.after_ms THEN 1 ELSE 0 END) AS content_after,
    COUNT(DISTINCT CASE WHEN c.occurred_at_ms>=a.changed_at_ms AND c.occurred_at_ms<a.changed_at_ms+p.users_after_ms THEN c.author_user_id END) AS users_after
    FROM audits a CROSS JOIN impact_params p
    LEFT JOIN bot_provider_content_events c ON ${scope.join}
      AND c.occurred_at_ms>=a.changed_at_ms-p.before_ms
      AND c.occurred_at_ms<a.changed_at_ms+GREATEST(p.after_ms,p.users_after_ms)
    WHERE ${scope.where}
    GROUP BY ${columns.map(column => `a.${column}`).join(',')}
  `);
  return `WITH impact_params AS (SELECT ? AS before_ms,? AS after_ms,? AS users_after_ms),audits AS (
    SELECT a.audit_log_id,a.provider_id,COALESCE(a.setting_key,'__provider__') AS setting_key,a.action,a.guild_id,
      UNIX_TIMESTAMP(a.created_at)*1000 AS changed_at_ms
    FROM dashboard_audit_logs a WHERE ${auditWhereSql}
  ), per_audit AS (${branches.join('\nUNION ALL\n')})
  SELECT /*+ SET_VAR(tmp_table_size=1073741824) */ m.provider_id,m.setting_key,m.action,
    COUNT(*) AS changes,COUNT(DISTINCT m.guild_id) AS guilds,
    SUM(m.content_before) AS content_before,SUM(m.content_after) AS content_after,SUM(m.users_after) AS users_after
  FROM per_audit m GROUP BY m.provider_id,m.setting_key,m.action
  ORDER BY content_after DESC,changes DESC LIMIT ?`;
}

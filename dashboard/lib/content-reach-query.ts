const urlColumns = ['provider_id', 'account_key', 'content_url', 'normalized_url'];

export function contentReachQuery(kind: 'lifetime' | 'reuse') {
  const columns = kind === 'lifetime' ? [...urlColumns.slice(0, 2), 'content_type', ...urlColumns.slice(2)] : urlColumns;
  const keys = columns.join(',');
  const ranking = kind === 'lifetime'
    ? `SELECT ${keys},COUNT(*) AS content_events,MIN(occurred_at_ms) AS first_seen_ms,MAX(occurred_at_ms) AS last_seen_ms
       FROM events GROUP BY ${keys} HAVING content_events>1
       ORDER BY (last_seen_ms-first_seen_ms) DESC,content_events DESC LIMIT 100`
    : `SELECT ${keys},SUM(content_events) AS content_events,COUNT(guild_id) AS guilds,
         MIN(first_seen_ms) AS first_seen_ms,MAX(last_seen_ms) AS last_seen_ms
       FROM guild_counts GROUP BY ${keys} HAVING guilds>1
       ORDER BY guilds DESC,content_events DESC LIMIT 100`;
  const perGuild = kind === 'reuse' ? `guild_counts AS (
    SELECT ${keys},guild_id,COUNT(*) AS content_events,MIN(occurred_at_ms) AS first_seen_ms,MAX(occurred_at_ms) AS last_seen_ms
    FROM events GROUP BY ${keys},guild_id
  ),` : '';
  // Rank on additive measures first. COUNT(DISTINCT guild) > 1 implies at
  // least two events, so the lifetime eligibility test needs no DISTINCT.
  // Reuse counts one pre-grouped row per non-null guild. Exact users (and
  // lifetime guilds) are calculated only for the selected groups.
  return `WITH events AS (
    SELECT content_event_id,occurred_at_ms,${keys},guild_id,author_user_id,title
    FROM bot_provider_content_events WHERE occurred_at_ms>=?
      AND (content_url IS NOT NULL OR normalized_url IS NOT NULL)
  ),${perGuild}top_values AS (${ranking}),
  ranked AS (SELECT top_values.*,ROW_NUMBER() OVER () AS group_no FROM top_values),
  selected_stats AS (
    SELECT r.group_no,MAX(c.title) AS title,COUNT(DISTINCT c.author_user_id) AS users,
      COUNT(DISTINCT c.guild_id) AS guilds
    FROM ranked r JOIN events c ON ${columns.map(column=>`c.${column}<=>r.${column}`).join(' AND ')}
    GROUP BY r.group_no
  )
  SELECT /*+ SET_VAR(tmp_table_size=2147483648) */ ${columns.map(column=>'r.'+column).join(',')},
    s.title,r.content_events,s.users,s.guilds,r.first_seen_ms,r.last_seen_ms
  FROM ranked r JOIN selected_stats s ON s.group_no=r.group_no
  ORDER BY ${kind === 'lifetime' ? '(r.last_seen_ms-r.first_seen_ms)' : 's.guilds'} DESC,r.content_events DESC`;
}

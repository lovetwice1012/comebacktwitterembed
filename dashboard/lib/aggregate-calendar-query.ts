const measures = ['content_events','analytics_events','extract_events','extract_successes','send_events','send_successes',
  'enrichment_jobs','enrichment_successes','sensitive_events','media_count_sum','duration_seconds_sum','duration_seconds_count',
  'analytics_duration_sum_ms','analytics_duration_count','enrichment_duration_sum_ms','enrichment_duration_count'];

export function aggregateCalendarQuery(grain: 'hour' | 'weekday' | 'day', providerScoped = false) {
  const period = {hour:'hour_utc',weekday:'weekday_utc',day:'day_start_ms'}[grain];
  const expression = {hour:'FLOOR(MOD(FLOOR(bucket_start_ms / ?), 24))',weekday:'DAYOFWEEK(FROM_UNIXTIME(bucket_start_ms / 1000))',day:'FLOOR(bucket_start_ms / ?) * ?'}[grain];
  const keys = providerScoped ? ['provider_id',period] : [period];
  const sums = measures.map(column=>`SUM(${column}) AS ${column}`).join(',');
  const providerCounts = providerScoped ? '' : `,provider_members AS (SELECT DISTINCT ${period},NULLIF(provider_id,'') AS member FROM periods),
    provider_counts AS (SELECT ${period},COUNT(member) AS providers FROM provider_members GROUP BY ${period})`;
  return `WITH periods AS (
      SELECT ${expression} AS ${period},provider_id,account_key,${measures.join(',')}
      FROM bot_provider_hourly_aggregates WHERE bucket_start_ms>=? ${providerScoped ? "AND provider_id<>''" : ''}
    ),totals AS (SELECT ${keys.join(',')},${providerScoped ? '' : 'COUNT(*) AS aggregate_rows,'}${sums}
      FROM periods GROUP BY ${keys.join(',')}),
    account_members AS (SELECT DISTINCT ${keys.join(',')},NULLIF(account_key,'') AS member FROM periods),
    account_counts AS (SELECT ${keys.join(',')},COUNT(member) AS accounts FROM account_members GROUP BY ${keys.join(',')})
    ${providerCounts}
    SELECT /*+ SET_VAR(tmp_table_size=1073741824) */ t.*,a.accounts${providerScoped ? '' : ',p.providers'}
    FROM totals t JOIN account_counts a ON ${keys.map(column=>`a.${column}<=>t.${column}`).join(' AND ')}
    ${providerScoped ? '' : `JOIN provider_counts p ON p.${period}<=>t.${period}`}
    ${grain==='day' && providerScoped ? 'WHERE t.content_events>0' : ''}
    ORDER BY ${providerScoped ? 't.content_events DESC' : `t.${period} ${grain==='day' ? 'DESC' : 'ASC'}`}
    ${providerScoped ? `LIMIT ${grain==='day' ? 240 : 160}` : grain==='day' ? 'LIMIT 45' : ''}`;
}

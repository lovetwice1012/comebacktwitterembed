// Both sides contain exactly one row per user/item tuple. Integer group IDs
// preserve database collation while removing wide DISTINCT sorts from pairs.
export const aggregateAudienceCorrelationQuery = `WITH scoped AS (
  SELECT /*+ INDEX(bot_provider_hourly_unique_keys idx_provider_hourly_unique_event_key_time) */ DISTINCT provider_id,account_key,content_type,key_hash
  FROM bot_provider_hourly_unique_keys WHERE bucket_start_ms>=?
    AND event_type='provider_content' AND key_type='author_user' AND provider_id<>'' AND account_key<>''
),target_members AS (SELECT DISTINCT provider_id,account_key,key_hash FROM scoped),
  targets AS (SELECT target_members.*,DENSE_RANK() OVER (ORDER BY provider_id,account_key) AS group_id FROM target_members),
  interests AS (SELECT scoped.*,DENSE_RANK() OVER (ORDER BY provider_id,account_key,content_type) AS group_id FROM scoped),
  pairs AS (
    SELECT t.group_id AS target_id,i.group_id AS interest_id,COUNT(*) AS shared_users
    FROM targets t JOIN interests i ON i.key_hash=t.key_hash
      AND (i.provider_id<>t.provider_id OR i.account_key<>t.account_key)
    GROUP BY t.group_id,i.group_id ORDER BY shared_users DESC LIMIT 160
  ),target_labels AS (
    SELECT group_id,MIN(provider_id) AS provider_id,MIN(account_key) AS account_key FROM targets GROUP BY group_id
  ),interest_labels AS (
    SELECT group_id,MIN(provider_id) AS provider_id,MIN(account_key) AS account_key,MIN(content_type) AS content_type
    FROM interests GROUP BY group_id
  )
  SELECT /*+ SET_VAR(tmp_table_size=2147483648) */ t.provider_id AS target_provider_id,t.account_key AS target_account_key,
    i.provider_id AS interest_provider_id,i.account_key AS interest_account_key,i.content_type AS interest_content_type,p.shared_users
  FROM pairs p JOIN target_labels t ON t.group_id=p.target_id JOIN interest_labels i ON i.group_id=p.interest_id
  ORDER BY shared_users DESC`;

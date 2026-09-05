// Avoid multiplying a user's account activity by every guild before ranking.
// The winning account pairs keep the same weighted activity and user counts;
// distinct guild counts are calculated only for those winning pairs.
// Both inputs are unique per user and account tuple, so each joined pair has
// exactly one row per shared user; COUNT(*) avoids a redundant DISTINCT sort.
// DENSE_RANK preserves MySQL's collation/null grouping while the large pair
// aggregation uses compact numeric keys instead of wide character keys.
export const audienceInterestQuery = `WITH target_events AS (
  SELECT /*+ INDEX(bot_analytics_events idx_analytics_event_time) */ author_user_id, provider_id, account_key, guild_id, COUNT(*) AS activity_count
  FROM bot_analytics_events
  WHERE occurred_at_ms >= ? AND event_type='provider_extract'
    AND author_user_id IS NOT NULL AND account_key IS NOT NULL
  GROUP BY author_user_id, provider_id, account_key, guild_id
), target_account_counts AS (
  SELECT author_user_id, provider_id, account_key, SUM(activity_count) AS activity_count
  FROM target_events GROUP BY author_user_id, provider_id, account_key
), target_accounts AS (
  SELECT target_account_counts.*, DENSE_RANK() OVER (ORDER BY provider_id,account_key) AS target_id
  FROM target_account_counts
), other_counts AS (
  SELECT /*+ INDEX(bot_analytics_events idx_analytics_event_time) */ author_user_id, provider_id, account_key, endpoint_key, COUNT(*) AS activity_count
  FROM bot_analytics_events
  WHERE occurred_at_ms >= ? AND event_type='provider_extract'
    AND provider_id IS NOT NULL AND author_user_id IS NOT NULL
  GROUP BY author_user_id, provider_id, account_key, endpoint_key
), other_events AS (
  SELECT other_counts.*, DENSE_RANK() OVER (ORDER BY provider_id,account_key,endpoint_key) AS other_id
  FROM other_counts
), ranked_ids AS (
  SELECT target.target_id, other.other_id,
    SUM(target.activity_count * other.activity_count) AS co_activity,
    COUNT(*) AS shared_users
  FROM target_accounts target JOIN other_events other ON other.author_user_id=target.author_user_id
  WHERE other.provider_id <> target.provider_id
    OR COALESCE(other.account_key,'') <> COALESCE(target.account_key,'')
  GROUP BY target.target_id,other.other_id
  ORDER BY co_activity DESC LIMIT 100
), target_labels AS (
  SELECT target_id,MIN(provider_id) AS provider_id,MIN(account_key) AS account_key
  FROM target_accounts GROUP BY target_id
), other_labels AS (
  SELECT other_id,MIN(provider_id) AS provider_id,MIN(account_key) AS account_key,MIN(endpoint_key) AS endpoint_key
  FROM other_events GROUP BY other_id
)
SELECT target_label.provider_id AS target_provider_id,target_label.account_key AS target_account_key,
  other_label.provider_id AS interest_provider_id,other_label.account_key AS interest_account_key,
  other_label.endpoint_key AS interest_endpoint_key,pairs.co_activity,pairs.shared_users,
  (SELECT COUNT(DISTINCT target.guild_id) FROM target_events target
   WHERE target.provider_id <=> target_label.provider_id AND target.account_key <=> target_label.account_key
     AND EXISTS (SELECT 1 FROM other_events other WHERE other.author_user_id=target.author_user_id
       AND other.other_id=pairs.other_id)) AS shared_guilds
FROM ranked_ids pairs
JOIN target_labels target_label ON target_label.target_id=pairs.target_id
JOIN other_labels other_label ON other_label.other_id=pairs.other_id
ORDER BY co_activity DESC`;

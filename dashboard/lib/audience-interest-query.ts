// Avoid multiplying a user's account activity by every guild before ranking.
// The winning account pairs keep the same weighted activity and user counts;
// distinct guild counts are calculated only for those winning pairs.
export const audienceInterestQuery = `WITH target_events AS (
  SELECT /*+ INDEX(bot_analytics_events idx_analytics_event_time) */ author_user_id, provider_id, account_key, guild_id, COUNT(*) AS activity_count
  FROM bot_analytics_events
  WHERE occurred_at_ms >= ? AND event_type='provider_extract'
    AND author_user_id IS NOT NULL AND account_key IS NOT NULL
  GROUP BY author_user_id, provider_id, account_key, guild_id
), target_accounts AS (
  SELECT author_user_id, provider_id, account_key, SUM(activity_count) AS activity_count
  FROM target_events GROUP BY author_user_id, provider_id, account_key
), other_events AS (
  SELECT /*+ INDEX(bot_analytics_events idx_analytics_event_time) */ author_user_id, provider_id, account_key, endpoint_key, COUNT(*) AS activity_count
  FROM bot_analytics_events
  WHERE occurred_at_ms >= ? AND event_type='provider_extract'
    AND provider_id IS NOT NULL AND author_user_id IS NOT NULL
  GROUP BY author_user_id, provider_id, account_key, endpoint_key
), ranked_pairs AS (
  SELECT target.provider_id AS target_provider_id, target.account_key AS target_account_key,
    other.provider_id AS interest_provider_id, other.account_key AS interest_account_key,
    other.endpoint_key AS interest_endpoint_key,
    SUM(target.activity_count * other.activity_count) AS co_activity,
    COUNT(DISTINCT target.author_user_id) AS shared_users
  FROM target_accounts target JOIN other_events other ON other.author_user_id=target.author_user_id
  WHERE other.provider_id <> target.provider_id
    OR COALESCE(other.account_key,'') <> COALESCE(target.account_key,'')
  GROUP BY target.provider_id,target.account_key,other.provider_id,other.account_key,other.endpoint_key
  ORDER BY co_activity DESC LIMIT 100
)
SELECT pairs.*,
  (SELECT COUNT(DISTINCT target.guild_id) FROM target_events target
   WHERE target.provider_id <=> pairs.target_provider_id AND target.account_key <=> pairs.target_account_key
     AND EXISTS (SELECT 1 FROM other_events other WHERE other.author_user_id=target.author_user_id
       AND other.provider_id <=> pairs.interest_provider_id AND other.account_key <=> pairs.interest_account_key
       AND other.endpoint_key <=> pairs.interest_endpoint_key)) AS shared_guilds
FROM ranked_pairs pairs ORDER BY co_activity DESC`;

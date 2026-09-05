// Aggregate repeated posts before joining audiences. Each grouped row retains
// its multiplicity, so co_events and distinct users/guilds remain exact.
export function detailedInterestQuery(targetWhereSql: string) {
  return `WITH target_events AS (
    SELECT target.author_user_id, target.provider_id, target.account_key, target.guild_id,
           COUNT(*) AS activity_count
    FROM bot_provider_content_events target
    WHERE ${targetWhereSql} AND target.author_user_id IS NOT NULL
    GROUP BY target.author_user_id, target.provider_id, target.account_key, target.guild_id
  ), other_events AS (
    SELECT author_user_id, provider_id, account_key, content_type, COUNT(*) AS activity_count
    FROM bot_provider_content_events
    WHERE occurred_at_ms >= ? AND occurred_at_ms <= ?
      AND author_user_id IS NOT NULL AND provider_id IS NOT NULL
    GROUP BY author_user_id, provider_id, account_key, content_type
  )
  SELECT target.provider_id AS target_provider_id,
         target.account_key AS target_account_key,
         other.provider_id AS interest_provider_id,
         other.account_key AS interest_account_key,
         other.content_type AS interest_content_type,
         SUM(target.activity_count * other.activity_count) AS co_events,
         COUNT(DISTINCT target.author_user_id) AS shared_users,
         COUNT(DISTINCT target.guild_id) AS shared_guilds
  FROM target_events target
  JOIN other_events other ON other.author_user_id = target.author_user_id
  WHERE other.provider_id <> target.provider_id
     OR COALESCE(other.account_key, '') <> COALESCE(target.account_key, '')
  GROUP BY target.provider_id, target.account_key, other.provider_id, other.account_key, other.content_type
  ORDER BY co_events DESC
  LIMIT ?`;
}

CREATE TABLE IF NOT EXISTS dashboard_delegated_access_grants (
  grant_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  guild_id VARCHAR(32) NOT NULL,
  target_type ENUM('user', 'role') NOT NULL,
  target_id VARCHAR(32) NOT NULL,
  access_level ENUM('view', 'edit') NOT NULL,
  granted_by_user_id VARCHAR(32) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_dashboard_delegated_access_target (guild_id, target_type, target_id),
  INDEX idx_dashboard_delegated_access_guild (guild_id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

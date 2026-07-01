CREATE TABLE IF NOT EXISTS dashboard_audit_logs (
  audit_log_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  guild_id VARCHAR(32) NOT NULL,
  provider_id VARCHAR(64) NULL,
  setting_key VARCHAR(191) NULL,
  actor_user_id VARCHAR(32) NOT NULL,
  actor_username_snapshot VARCHAR(255) NULL,
  action VARCHAR(64) NOT NULL,
  before_json LONGTEXT NULL,
  after_json LONGTEXT NULL,
  request_id VARCHAR(64) NULL,
  ip_hash CHAR(64) NULL,
  user_agent_hash CHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_dashboard_audit_guild_time (guild_id, created_at),
  INDEX idx_dashboard_audit_actor_time (actor_user_id, created_at),
  INDEX idx_dashboard_audit_provider_time (provider_id, created_at),
  INDEX idx_dashboard_audit_setting_time (setting_key, created_at)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

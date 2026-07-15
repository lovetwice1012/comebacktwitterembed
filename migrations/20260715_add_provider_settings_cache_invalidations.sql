CREATE TABLE IF NOT EXISTS provider_settings_cache_invalidations (
    revision BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    provider_id VARCHAR(64) NOT NULL,
    guild_id VARCHAR(32) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_provider_settings_cache_invalidations_created (created_at)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

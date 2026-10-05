ALTER TABLE auto_watch_targets MODIFY COLUMN webhook_endpoint_id BIGINT UNSIGNED NULL;
ALTER TABLE auto_watch_targets ADD COLUMN guild_id VARCHAR(32) NULL AFTER source_id;
ALTER TABLE auto_watch_targets ADD COLUMN origin_channel_id VARCHAR(32) NULL AFTER guild_id;
ALTER TABLE auto_watch_targets ADD COLUMN origin_channel_nsfw TINYINT(1) NOT NULL DEFAULT 0 AFTER origin_channel_id;
ALTER TABLE auto_watch_targets ADD COLUMN source_locale VARCHAR(16) NULL AFTER origin_channel_nsfw;
ALTER TABLE auto_watch_targets ADD COLUMN destination_type VARCHAR(16) NOT NULL DEFAULT 'webhook' AFTER source_locale;
ALTER TABLE auto_watch_targets ADD COLUMN destination_key VARCHAR(191) NOT NULL DEFAULT '' AFTER destination_type;
UPDATE auto_watch_targets SET destination_key=CONCAT('webhook:', webhook_endpoint_id) WHERE destination_key='';
ALTER TABLE auto_watch_targets ADD UNIQUE KEY uniq_auto_watch_target_destination (user_id, source_id, destination_key);

CREATE TABLE IF NOT EXISTS price_watch_sources (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    provider_id VARCHAR(64) NOT NULL,
    product_key VARCHAR(191) NOT NULL,
    product_url VARCHAR(1024) NOT NULL,
    source_locale VARCHAR(16) NOT NULL,
    product_name VARCHAR(1024) NULL,
    state_json MEDIUMTEXT NULL,
    initialized_at_ms BIGINT NULL,
    poll_interval_ms BIGINT NOT NULL,
    next_check_at_ms BIGINT NOT NULL DEFAULT 0,
    last_checked_at_ms BIGINT NOT NULL DEFAULT 0,
    lease_token VARCHAR(64) NULL,
    lease_expires_at_ms BIGINT NOT NULL DEFAULT 0,
    failure_count INT UNSIGNED NOT NULL DEFAULT 0,
    last_error_code VARCHAR(96) NULL,
    last_error_at_ms BIGINT NULL,
    created_at_ms BIGINT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_price_watch_source (provider_id, product_key, source_locale),
    INDEX idx_price_watch_source_due (next_check_at_ms),
    INDEX idx_price_watch_source_lease (lease_expires_at_ms)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS price_watch_targets (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    source_id BIGINT UNSIGNED NOT NULL,
    user_id VARCHAR(32) NOT NULL,
    guild_id VARCHAR(32) NULL,
    origin_channel_id VARCHAR(32) NULL,
    destination_type VARCHAR(16) NOT NULL,
    destination_key VARCHAR(191) NOT NULL,
    webhook_endpoint_id BIGINT UNSIGNED NULL,
    watch_mode VARCHAR(16) NOT NULL,
    rule_key VARCHAR(191) NOT NULL,
    max_price_amount DECIMAL(20,4) NULL,
    min_discount_percent DECIMAL(5,2) NULL,
    condition_active TINYINT(1) NOT NULL DEFAULT 0,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_at_ms BIGINT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_price_watch_target (source_id, user_id, destination_key, watch_mode, rule_key),
    INDEX idx_price_watch_target_source_enabled (source_id, enabled),
    INDEX idx_price_watch_target_user (user_id),
    CONSTRAINT fk_price_watch_target_source FOREIGN KEY (source_id) REFERENCES price_watch_sources(id) ON DELETE CASCADE,
    CONSTRAINT fk_price_watch_target_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_price_watch_target_webhook FOREIGN KEY (webhook_endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS price_watch_deliveries (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    target_id BIGINT UNSIGNED NOT NULL,
    event_key CHAR(64) NOT NULL,
    message_text TEXT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
    next_attempt_at_ms BIGINT NOT NULL DEFAULT 0,
    lease_token VARCHAR(64) NULL,
    lease_expires_at_ms BIGINT NOT NULL DEFAULT 0,
    last_error_code VARCHAR(96) NULL,
    last_error_at_ms BIGINT NULL,
    sent_at_ms BIGINT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_price_watch_delivery (target_id, event_key),
    INDEX idx_price_watch_delivery_due (status, next_attempt_at_ms),
    INDEX idx_price_watch_delivery_lease (lease_expires_at_ms),
    CONSTRAINT fk_price_watch_delivery_target FOREIGN KEY (target_id) REFERENCES price_watch_targets(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

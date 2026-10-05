CREATE TABLE IF NOT EXISTS auto_watch_sources (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    provider_id VARCHAR(64) NOT NULL,
    source_key VARCHAR(255) NOT NULL,
    source_url VARCHAR(1024) NOT NULL,
    state_json MEDIUMTEXT NULL,
    cursor_json MEDIUMTEXT NULL,
    etag VARCHAR(512) NULL,
    last_modified VARCHAR(512) NULL,
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
    UNIQUE KEY uniq_auto_watch_source (provider_id, source_key),
    INDEX idx_auto_watch_source_due (next_check_at_ms),
    INDEX idx_auto_watch_source_provider_due (provider_id, next_check_at_ms),
    INDEX idx_auto_watch_source_lease (lease_expires_at_ms)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auto_watch_targets (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(32) NOT NULL,
    source_id BIGINT UNSIGNED NOT NULL,
    webhook_endpoint_id BIGINT UNSIGNED NOT NULL,
    premium_slot TINYINT(1) NOT NULL DEFAULT 0,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_at_ms BIGINT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_auto_watch_target (user_id, source_id, webhook_endpoint_id),
    INDEX idx_auto_watch_target_user (user_id),
    INDEX idx_auto_watch_target_source_enabled (source_id, enabled),
    INDEX idx_auto_watch_target_premium (premium_slot, enabled),
    CONSTRAINT fk_auto_watch_target_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_auto_watch_target_source FOREIGN KEY (source_id) REFERENCES auto_watch_sources(id) ON DELETE CASCADE,
    CONSTRAINT fk_auto_watch_target_webhook FOREIGN KEY (webhook_endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auto_watch_items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    source_id BIGINT UNSIGNED NOT NULL,
    content_key VARCHAR(255) NOT NULL,
    content_url TEXT NOT NULL,
    published_at_ms BIGINT NULL,
    title VARCHAR(1024) NULL,
    payload_json MEDIUMTEXT NULL,
    discovered_at_ms BIGINT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_auto_watch_item (source_id, content_key),
    INDEX idx_auto_watch_item_source_time (source_id, discovered_at_ms),
    CONSTRAINT fk_auto_watch_item_source FOREIGN KEY (source_id) REFERENCES auto_watch_sources(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auto_watch_deliveries (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    item_id BIGINT UNSIGNED NOT NULL,
    target_id BIGINT UNSIGNED NOT NULL,
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
    UNIQUE KEY uniq_auto_watch_delivery (item_id, target_id),
    INDEX idx_auto_watch_delivery_due (status, next_attempt_at_ms),
    INDEX idx_auto_watch_delivery_lease (lease_expires_at_ms),
    CONSTRAINT fk_auto_watch_delivery_item FOREIGN KEY (item_id) REFERENCES auto_watch_items(id) ON DELETE CASCADE,
    CONSTRAINT fk_auto_watch_delivery_target FOREIGN KEY (target_id) REFERENCES auto_watch_targets(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auto_watch_provider_states (
    provider_id VARCHAR(64) NOT NULL PRIMARY KEY,
    next_allowed_at_ms BIGINT NOT NULL DEFAULT 0,
    cooldown_until_ms BIGINT NOT NULL DEFAULT 0,
    last_rate_limit_limit BIGINT NULL,
    last_rate_limit_remaining BIGINT NULL,
    last_rate_limit_reset_at_ms BIGINT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auto_watch_provider_usage (
    provider_id VARCHAR(64) NOT NULL,
    window_key VARCHAR(32) NOT NULL,
    used_units BIGINT UNSIGNED NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (provider_id, window_key)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

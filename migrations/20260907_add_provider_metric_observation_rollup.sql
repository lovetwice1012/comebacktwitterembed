-- Compact latest observation rows per provider/facet/subject/hour.
-- The raw facet table remains the source of truth for exact event and distinct counts.
CREATE TABLE IF NOT EXISTS bot_provider_metric_observation_hourly (
    bucket_start_ms BIGINT NOT NULL,
    provider_id VARCHAR(64) NOT NULL,
    account_key VARCHAR(191) NULL,
    facet_key VARCHAR(191) NOT NULL,
    subject_hash BINARY(32) NOT NULL,
    subject_key TEXT NOT NULL,
    content_event_id BIGINT UNSIGNED NOT NULL,
    facet_id BIGINT UNSIGNED NOT NULL,
    occurred_at_ms BIGINT NOT NULL,
    observed_at_ms BIGINT NOT NULL,
    author_user_id VARCHAR(32) NULL,
    guild_id VARCHAR(32) NULL,
    content_type VARCHAR(64) NULL,
    numeric_value DOUBLE NULL,
    PRIMARY KEY (bucket_start_ms, provider_id, facet_key, subject_hash),
    INDEX idx_metric_rollup_window (bucket_start_ms, provider_id, facet_key),
    INDEX idx_metric_rollup_subject (provider_id, subject_hash, facet_key, observed_at_ms),
    INDEX idx_metric_rollup_event (content_event_id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Heavy admin reports must not repeatedly scan raw event history.  Completed
-- report payloads survive dashboard restarts, while these indexes keep the
-- background refreshes on the time-bounded reporting path.
CREATE TABLE IF NOT EXISTS bot_admin_report_snapshots (
    report_type VARCHAR(32) NOT NULL,
    snapshot_key CHAR(64) NOT NULL,
    generated_at_ms BIGINT NOT NULL,
    payload_json LONGTEXT NOT NULL,
    PRIMARY KEY (report_type, snapshot_key),
    INDEX idx_admin_report_snapshots_generated (generated_at_ms)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE bot_provider_content_events
    ADD INDEX idx_content_time_provider_account_guild_type (occurred_at_ms, provider_id, account_key, guild_id, content_type);

ALTER TABLE bot_provider_content_events
    ADD INDEX idx_content_time_guild_user (occurred_at_ms, guild_id, author_user_id);

ALTER TABLE bot_analytics_events
    ADD INDEX idx_analytics_time_provider_account_event_success (occurred_at_ms, provider_id, account_key, event_type, success);

ALTER TABLE bot_analytics_events
    ADD INDEX idx_analytics_time_guild_user (occurred_at_ms, guild_id, author_user_id);

ALTER TABLE bot_provider_content_facets
    ADD INDEX idx_content_facets_time_provider_account_key_value (occurred_at_ms, provider_id, account_key, facet_key, facet_value(128));

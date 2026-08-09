-- Keep the two data-heavy audience reports on selective, narrow access paths.
-- These are deliberately non-covering indexes: wide covering indexes would add
-- several gigabytes to the largest analytics tables and slow write ingestion.
ALTER TABLE bot_provider_hourly_unique_keys
    ADD INDEX idx_provider_hourly_unique_event_key_time (event_type, key_type, bucket_start_ms);

ALTER TABLE bot_analytics_events
    ADD INDEX idx_analytics_event_user_time (event_type, author_user_id, occurred_at_ms);

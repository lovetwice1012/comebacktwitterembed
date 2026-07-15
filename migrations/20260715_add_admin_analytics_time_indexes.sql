-- Default admin analytics queries filter these high-volume tables by time.
-- Existing composite indexes start with dimension columns, so unfiltered
-- dashboard reports otherwise require full table scans.
ALTER TABLE bot_metric_buckets
    ADD INDEX idx_metric_buckets_time (bucket_start_ms);

ALTER TABLE bot_provider_content_events
    ADD INDEX idx_content_time (occurred_at_ms);

ALTER TABLE bot_provider_content_facets
    ADD INDEX idx_content_facets_time (occurred_at_ms);

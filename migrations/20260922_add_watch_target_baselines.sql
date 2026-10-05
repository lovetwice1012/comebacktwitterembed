-- Preserve existing active registrations, seed new/re-enabled targets on their
-- own first successful observation even when another user shares the source.
ALTER TABLE auto_watch_targets ADD COLUMN baseline_at_ms BIGINT NULL DEFAULT 0;
UPDATE auto_watch_targets t JOIN auto_watch_sources s ON s.id=t.source_id
SET t.baseline_at_ms=IF(s.initialized_at_ms IS NULL,NULL,GREATEST(t.created_at_ms,s.initialized_at_ms))
WHERE t.baseline_at_ms=0;
ALTER TABLE auto_watch_targets MODIFY COLUMN baseline_at_ms BIGINT NULL DEFAULT NULL;
ALTER TABLE price_watch_targets ADD COLUMN baseline_at_ms BIGINT NULL DEFAULT 0;
UPDATE price_watch_targets t JOIN price_watch_sources s ON s.id=t.source_id
SET t.baseline_at_ms=IF(s.initialized_at_ms IS NULL,NULL,GREATEST(t.created_at_ms,s.initialized_at_ms))
WHERE t.baseline_at_ms=0;
ALTER TABLE price_watch_targets MODIFY COLUMN baseline_at_ms BIGINT NULL DEFAULT NULL;

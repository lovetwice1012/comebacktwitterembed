ALTER TABLE users ADD COLUMN auto_watch_interval_minutes INT NULL;
ALTER TABLE auto_watch_targets ADD COLUMN last_polled_at_ms BIGINT NULL;
ALTER TABLE auto_watch_targets ADD COLUMN next_poll_at_ms BIGINT NULL;
ALTER TABLE auto_watch_targets ADD COLUMN last_notification_window_at_ms BIGINT NULL;

CREATE TABLE IF NOT EXISTS auto_watch_user_interval_audits (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(32) NOT NULL,
    actor_user_id VARCHAR(32) NOT NULL,
    before_minutes INT NULL,
    after_minutes INT NULL,
    changed_at_ms BIGINT NOT NULL,
    INDEX idx_auto_watch_interval_audit_user (user_id, changed_at_ms)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

UPDATE auto_watch_targets t JOIN auto_watch_sources s ON s.id=t.source_id
SET t.last_polled_at_ms=NULLIF(s.last_checked_at_ms,0),
    t.next_poll_at_ms=IF(s.last_checked_at_ms>0,s.last_checked_at_ms+s.poll_interval_ms,NULL)
WHERE t.last_polled_at_ms IS NULL AND t.next_poll_at_ms IS NULL;

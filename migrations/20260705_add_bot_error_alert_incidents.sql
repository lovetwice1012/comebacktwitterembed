ALTER TABLE bot_error_alerts ADD COLUMN incident_id VARCHAR(64) NULL AFTER alert_kind;
ALTER TABLE bot_error_alerts ADD COLUMN active TINYINT(1) NOT NULL DEFAULT 0 AFTER incident_id;
ALTER TABLE bot_error_alerts ADD COLUMN detected_at_ms BIGINT NULL AFTER active;
ALTER TABLE bot_error_alerts ADD COLUMN last_seen_at_ms BIGINT NULL AFTER detected_at_ms;
ALTER TABLE bot_error_alerts ADD COLUMN resolved_at_ms BIGINT NULL AFTER last_seen_at_ms;
ALTER TABLE bot_error_alerts ADD INDEX idx_error_alerts_active (active, updated_at);

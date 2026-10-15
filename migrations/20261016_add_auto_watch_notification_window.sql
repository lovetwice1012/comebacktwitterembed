-- Preserve pending delivery cohorts across sequential claims and restarts.
-- NULL retains the previous conservative cadence behavior until a new window opens.
ALTER TABLE auto_watch_targets ADD COLUMN notification_window_json TEXT NULL;
-- Keep the first cadence admission time separate from mutable retry backoff.
ALTER TABLE auto_watch_deliveries ADD COLUMN cadence_due_at_ms BIGINT NULL;

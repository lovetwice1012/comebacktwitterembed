-- Nullable: preserve all existing plan amounts/limits and per-user intervals.
-- Existing migration runner checks column existence and handles concurrent ADD.
ALTER TABLE automation_notification_plans ADD COLUMN confirmation_interval_minutes INT UNSIGNED NULL;

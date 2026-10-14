-- Owner preference survives contract changes. Realtime eligibility is explicit
-- administrator configuration on the existing plan policy; default is off.
ALTER TABLE users ADD COLUMN x_notification_processing_mode VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'batch';
ALTER TABLE automation_push_plan_policy ADD COLUMN realtime_enabled TINYINT(1) NOT NULL DEFAULT 0;
-- Keep the mode of an interrupted window so a revoked realtime permission
-- resumes through the current batch cadence without losing inbox or cursor.
ALTER TABLE automation_x_push_receivers ADD COLUMN process_window_mode VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL;

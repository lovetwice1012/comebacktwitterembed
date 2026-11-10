-- Additive only: existing Firefox and Chrome registrations are preserved.
ALTER TABLE automation_x_push_receivers ADD COLUMN IF NOT EXISTS chrome_checkin_at_ms BIGINT NULL;
ALTER TABLE automation_x_push_receivers ADD COLUMN IF NOT EXISTS chrome_checkin_interval_seconds INT UNSIGNED NULL;
ALTER TABLE automation_x_push_receivers ADD COLUMN IF NOT EXISTS chrome_checkin_revision INT UNSIGNED NULL;

-- Existing subscriptions are Firefox and retain their existing encrypted data.
ALTER TABLE automation_x_subscriptions
    ADD COLUMN IF NOT EXISTS browser_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'firefox';

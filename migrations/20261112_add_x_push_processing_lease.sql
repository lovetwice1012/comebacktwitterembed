-- Additive preparation only. The feature remains disabled until every
-- receiver worker supports these fences and deployment compatibility is proven.
ALTER TABLE automation_x_push_receivers ADD COLUMN processing_lease_token CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL;
ALTER TABLE automation_x_push_receivers ADD COLUMN processing_worker_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL;
ALTER TABLE automation_x_push_receivers ADD COLUMN processing_lease_expires_at_ms BIGINT NULL;
ALTER TABLE automation_x_push_receivers ADD COLUMN processing_revision INT UNSIGNED NULL;
ALTER TABLE automation_x_push_receivers ADD COLUMN connection_generation BIGINT UNSIGNED NOT NULL DEFAULT 0;

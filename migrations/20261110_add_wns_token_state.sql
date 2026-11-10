-- Inactive Edge preparation: existing receivers retain their state unchanged.
ALTER TABLE automation_x_push_receivers ADD COLUMN wns_token_sealed_json TEXT NULL;
ALTER TABLE automation_x_push_receivers ADD COLUMN wns_token_revision INT UNSIGNED NULL;
ALTER TABLE automation_x_push_receivers ADD COLUMN wns_token_generation BIGINT UNSIGNED NULL;

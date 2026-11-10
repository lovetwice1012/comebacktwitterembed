-- Pending Chrome MCS receipt acknowledgments; created only during an explicit
-- Chrome rollout migration. Receipt and pending ID must commit together.
CREATE TABLE IF NOT EXISTS automation_x_mcs_pending (
    subscription_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    subscription_revision INT UNSIGNED NOT NULL,
    persistent_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    inbox_id BIGINT UNSIGNED NOT NULL,
    created_at_ms BIGINT NOT NULL,
    PRIMARY KEY (subscription_id, persistent_id),
    CONSTRAINT x_mcs_pending_subscription FOREIGN KEY (subscription_id) REFERENCES automation_x_subscriptions(id) ON DELETE CASCADE,
    CONSTRAINT x_mcs_pending_inbox FOREIGN KEY (inbox_id) REFERENCES automation_x_push_inbox(id) ON DELETE CASCADE
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

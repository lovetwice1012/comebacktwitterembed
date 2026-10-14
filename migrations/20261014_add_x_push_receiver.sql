-- Durable encrypted AutoPush receipt and fenced worker ownership.
CREATE TABLE IF NOT EXISTS automation_x_push_receivers (
        subscription_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        state VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'awaiting',
        reason_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        lease_token CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        worker_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        subscription_revision INT UNSIGNED NOT NULL,
        lease_expires_at_ms BIGINT NULL,
        retry_at_ms BIGINT NULL,
        retry_attempt INT UNSIGNED NOT NULL DEFAULT 0,
        last_connected_at_ms BIGINT NULL,
        last_process_at_ms BIGINT NULL,
        process_window_at_ms BIGINT NULL,
        process_cursor_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
        updated_at_ms BIGINT NOT NULL,
        CONSTRAINT x_push_receiver_subscription FOREIGN KEY (subscription_id) REFERENCES automation_x_subscriptions(id) ON DELETE CASCADE,
        INDEX x_push_receiver_lease (lease_expires_at_ms)
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS automation_x_push_inbox (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        subscription_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        subscription_revision INT UNSIGNED NOT NULL,
        version VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        data_ciphertext MEDIUMTEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        headers_json TEXT NOT NULL,
        ack_code SMALLINT UNSIGNED NOT NULL,
        status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        received_at_ms BIGINT NOT NULL,
        routed_at_ms BIGINT NULL,
        CONSTRAINT x_push_inbox_subscription FOREIGN KEY (subscription_id) REFERENCES automation_x_subscriptions(id) ON DELETE CASCADE,
        UNIQUE KEY x_push_inbox_version (subscription_id,version),
        INDEX x_push_inbox_recovery (subscription_id,status,id)
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS automation_monitors (
        target_kind VARCHAR(16) NOT NULL,
        target_id BIGINT UNSIGNED NOT NULL,
        name VARCHAR(120) NOT NULL,
        scope VARCHAR(16) NOT NULL,
        destination_id CHAR(36) NULL,
        revision INT UNSIGNED NOT NULL DEFAULT 1,
        PRIMARY KEY (target_kind, target_id),
        INDEX idx_automation_monitor_destination (destination_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

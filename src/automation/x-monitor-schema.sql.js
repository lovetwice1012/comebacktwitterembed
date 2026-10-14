'use strict';
// X receives events through a browser subscription rather than a polling
// provider. Keep owner/account identity separate from the connection registry,
// and reuse automation_notification_slots for the shared personal allowance.
const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS automation_x_monitors (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        owner_user_id VARCHAR(32) NOT NULL,
        account_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        account_handle VARCHAR(15) CHARACTER SET ascii COLLATE ascii_bin NULL,
        name VARCHAR(120) NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        state VARCHAR(16) NOT NULL DEFAULT 'ready',
        pool_kind VARCHAR(16) NULL,
        notification_settings_json TEXT NOT NULL,
        subscription_state VARCHAR(32) NOT NULL DEFAULT 'pending',
        revision INT UNSIGNED NOT NULL DEFAULT 1,
        created_at_ms BIGINT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        UNIQUE KEY uniq_x_monitor_owner_account (owner_user_id,account_id),
        INDEX idx_x_monitor_pool (pool_kind,state,id),
        CHECK (state IN ('ready','suspended','deleted')),
        CHECK (pool_kind IS NULL OR pool_kind IN ('free','supporter','special'))
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
];
module.exports = { SCHEMA };

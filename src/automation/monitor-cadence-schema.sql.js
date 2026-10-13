'use strict';
const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS automation_monitor_cadence (
        owner_user_id VARCHAR(32) NOT NULL, target_kind VARCHAR(16) NOT NULL, target_id BIGINT UNSIGNED NOT NULL,
        slot_cost INT UNSIGNED NOT NULL DEFAULT 1, updated_at_ms BIGINT NOT NULL,
        PRIMARY KEY (target_kind,target_id), INDEX idx_cadence_owner (owner_user_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS automation_notification_boost_slots (
        owner_user_id VARCHAR(32) NOT NULL, slot_index INT UNSIGNED NOT NULL,
        target_kind VARCHAR(16) NOT NULL, target_id BIGINT UNSIGNED NOT NULL,
        PRIMARY KEY (owner_user_id,slot_index), INDEX idx_boost_target (target_kind,target_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
];
module.exports = { SCHEMA };

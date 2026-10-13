'use strict';
const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS automation_donor_profiles (
        owner_user_id VARCHAR(32) NOT NULL PRIMARY KEY,
        display_name VARCHAR(120) NOT NULL DEFAULT '',
        admin_note TEXT NOT NULL,
        manual_payment_count INT UNSIGNED NOT NULL DEFAULT 0,
        manual_purchase_units INT UNSIGNED NOT NULL DEFAULT 0,
        updated_at_ms BIGINT NOT NULL,
        actor_user_id VARCHAR(32) NOT NULL,
        INDEX idx_donor_profile_name (display_name,owner_user_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS automation_donor_audit (
        id CHAR(36) NOT NULL PRIMARY KEY,
        owner_user_id VARCHAR(32) NOT NULL,
        actor_user_id VARCHAR(32) NOT NULL,
        reason VARCHAR(500) NOT NULL,
        before_json LONGTEXT NOT NULL,
        after_json LONGTEXT NOT NULL,
        created_at_ms BIGINT NOT NULL,
        INDEX idx_donor_audit_owner (owner_user_id,created_at_ms,id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
];
module.exports = { SCHEMA };

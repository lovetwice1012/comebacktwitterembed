'use strict';

// Permanent supporter holdings are separate from the existing rolling Square
// donation policy. Legacy counts are snapshotted, never derived from old prices.
const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS automation_push_support_owner_snapshots (
        owner_user_id VARCHAR(32) NOT NULL PRIMARY KEY,
        manual_slots BIGINT UNSIGNED NOT NULL,
        manual_supporter TINYINT(1) NOT NULL,
        snapshot_at_ms BIGINT NOT NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS automation_push_support_scope_snapshots (
        owner_user_id VARCHAR(32) NOT NULL,
        environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        merchant_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        snapshot_id CHAR(36) NOT NULL,
        extra_slots BIGINT UNSIGNED NOT NULL,
        purchase_units BIGINT UNSIGNED NOT NULL,
        payment_count BIGINT UNSIGNED NOT NULL,
        snapshot_at_ms BIGINT NOT NULL,
        PRIMARY KEY (owner_user_id,environment,merchant_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS automation_push_support_legacy_attempts (
        environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        merchant_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        attempt_id CHAR(36) NOT NULL,
        owner_user_id VARCHAR(32) NOT NULL,
        payment_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
        classified_at_ms BIGINT NOT NULL,
        PRIMARY KEY (environment,merchant_id,attempt_id),
        UNIQUE KEY uniq_push_support_legacy_payment (environment,merchant_id,payment_id),
        INDEX idx_push_support_legacy_owner (owner_user_id,environment,merchant_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS automation_push_support_grants (
        grant_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        insertion_token CHAR(36) NOT NULL,
        owner_user_id VARCHAR(32) NOT NULL,
        source_kind VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        source_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        merchant_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        attempt_id CHAR(36) NULL,
        slots BIGINT NOT NULL,
        purchased_slots BIGINT UNSIGNED NOT NULL,
        amount_yen BIGINT UNSIGNED NULL,
        confirmed_refunded_amount BIGINT UNSIGNED NOT NULL DEFAULT 0,
        financial_observed_at_ms BIGINT NULL,
        actor_user_id VARCHAR(32) NULL,
        purchased_at_ms BIGINT NOT NULL,
        created_at_ms BIGINT NOT NULL,
        details_json TEXT NOT NULL,
        UNIQUE KEY uniq_push_support_grant_source (source_kind,environment,merchant_id,source_id),
        INDEX idx_push_support_grant_owner (owner_user_id,created_at_ms,grant_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
];
module.exports = { SCHEMA };

'use strict';

const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS automation_square_donation_reconciliation (
        owner_user_id VARCHAR(32) NOT NULL,
        environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        merchant_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        lease_token CHAR(36) NULL,
        lease_until_at_ms BIGINT NULL,
        next_allowed_at_ms BIGINT NOT NULL DEFAULT 0,
        completed_cursor_at_ms BIGINT NULL,
        completed_cursor_id CHAR(36) NULL,
        PRIMARY KEY (owner_user_id,environment,merchant_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS automation_square_donation_policy (
        environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        merchant_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 0,
        currency CHAR(3) NULL,
        minimum_amount BIGINT UNSIGNED NULL,
        maximum_amount BIGINT UNSIGNED NULL,
        supporter_threshold BIGINT UNSIGNED NULL,
        validity_days INT UNSIGNED NULL,
        updated_at_ms BIGINT NOT NULL,
        actor_user_id VARCHAR(32) NOT NULL,
        PRIMARY KEY (environment,merchant_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS automation_square_donation_attempts (
        id CHAR(36) NOT NULL PRIMARY KEY,
        owner_user_id VARCHAR(32) NOT NULL,
        environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        merchant_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        location_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        application_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        amount BIGINT UNSIGNED NOT NULL,
        currency CHAR(3) NOT NULL,
        email VARCHAR(254) NOT NULL,
        name VARCHAR(120) NOT NULL,
        policy_updated_at_ms BIGINT NOT NULL,
        state VARCHAR(32) NOT NULL DEFAULT 'QUOTED',
        source_digest CHAR(64) NULL,
        payment_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
        order_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
        refunded_amount BIGINT UNSIGNED NOT NULL DEFAULT 0,
        verified TINYINT(1) NOT NULL DEFAULT 0,
        lease_token CHAR(36) NULL,
        lease_until_at_ms BIGINT NULL,
        expires_at_ms BIGINT NOT NULL,
        completed_at_ms BIGINT NULL,
        square_updated_at_ms BIGINT NULL,
        created_at_ms BIGINT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        UNIQUE KEY unique_square_donation_payment (environment,merchant_id,payment_id),
        INDEX idx_square_donation_owner (owner_user_id,environment,merchant_id,created_at_ms),
        INDEX idx_square_donation_pending (environment,merchant_id,state)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS automation_square_donation_refunds (
        environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        merchant_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        refund_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        attempt_id CHAR(36) NOT NULL,
        payment_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        amount BIGINT UNSIGNED NOT NULL,
        currency CHAR(3) NOT NULL,
        state VARCHAR(32) NOT NULL,
        observed_at_ms BIGINT NOT NULL,
        PRIMARY KEY (environment,merchant_id,refund_id),
        INDEX idx_square_donation_refund_attempt (attempt_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS automation_square_donation_supporters (
        owner_user_id VARCHAR(32) NOT NULL,
        environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        merchant_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        active TINYINT(1) NOT NULL DEFAULT 0,
        net_amount BIGINT UNSIGNED NOT NULL DEFAULT 0,
        valid_until_at_ms BIGINT NULL,
        policy_updated_at_ms BIGINT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        PRIMARY KEY (owner_user_id,environment,merchant_id),
        INDEX idx_square_donation_supporter_validity (active,valid_until_at_ms)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
];

module.exports = { SCHEMA };

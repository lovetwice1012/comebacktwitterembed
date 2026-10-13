'use strict';
const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS automation_square_catalog_ownership (
        environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        merchant_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        request_ref VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        variation_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        parent_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        request_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        state VARCHAR(16) NOT NULL DEFAULT 'OWNED',
        repair_request_json LONGTEXT NULL,
        updated_at_ms BIGINT NOT NULL,
        PRIMARY KEY (environment,merchant_id,request_ref),
        UNIQUE KEY unique_catalog_owned_variation (environment,merchant_id,variation_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS automation_square_catalog_creations (
        id CHAR(36) NOT NULL PRIMARY KEY, environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        merchant_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, plan_id VARCHAR(64) NOT NULL,
        terms_json LONGTEXT NOT NULL, request_json LONGTEXT NOT NULL, state VARCHAR(32) NOT NULL DEFAULT 'QUOTED',
        variation_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL, lease_token CHAR(36) NULL,lease_until_at_ms BIGINT NULL,
        expires_at_ms BIGINT NOT NULL,created_at_ms BIGINT NOT NULL,updated_at_ms BIGINT NOT NULL,
        UNIQUE KEY unique_square_catalog_plan (environment,merchant_id,plan_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS automation_square_coupons (
        code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        merchant_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,label VARCHAR(120) NOT NULL,
        discount_type VARCHAR(16) NOT NULL,discount_value BIGINT UNSIGNED NOT NULL,currency CHAR(3) NULL,plan_ids_json LONGTEXT NOT NULL,
        enabled TINYINT(1) NOT NULL,expires_at_ms BIGINT NULL,total_limit INT UNSIGNED NULL,user_limit INT UNSIGNED NULL,
        updated_at_ms BIGINT NOT NULL,actor_user_id VARCHAR(32) NOT NULL,
        PRIMARY KEY (code,environment,merchant_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS automation_square_coupon_uses (
        checkout_id CHAR(36) NOT NULL PRIMARY KEY,code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,merchant_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        owner_user_id VARCHAR(32) NOT NULL,state VARCHAR(32) NOT NULL DEFAULT 'RESERVED',terms_json LONGTEXT NOT NULL,
        subscription_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,first_invoice_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
        expires_at_ms BIGINT NOT NULL,created_at_ms BIGINT NOT NULL,updated_at_ms BIGINT NOT NULL,
        INDEX idx_coupon_capacity (code,environment,merchant_id,state,owner_user_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS automation_square_coupon_variations (
        identity_key CHAR(64) NOT NULL PRIMARY KEY,environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        merchant_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,request_json LONGTEXT NOT NULL,
        variation_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,catalog_version VARCHAR(32) NULL,state VARCHAR(32) NOT NULL DEFAULT 'PENDING',
        lease_token CHAR(36) NULL,lease_until_at_ms BIGINT NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
];
module.exports = { SCHEMA };

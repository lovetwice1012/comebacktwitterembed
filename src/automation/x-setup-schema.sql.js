'use strict';

// A browser subscription is connection material shared by an owner's monitored
// accounts, not a notification slot. Existing tables contain no encrypted vault
// or one-time registration session; keep those secrets out of monitor metadata.
const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS automation_x_setup_sessions (
        owner_user_id VARCHAR(32) NOT NULL PRIMARY KEY,
        token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
        consent_version INT UNSIGNED NOT NULL,
        expires_at_ms BIGINT NOT NULL,
        consumed_at_ms BIGINT NULL,
        created_at_ms BIGINT NOT NULL
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS automation_x_subscriptions (
        id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        owner_user_id VARCHAR(32) NOT NULL,
        uaid_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
        channel_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
        content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        sealed_json TEXT NOT NULL,
        key_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        browser_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        revision INT UNSIGNED NOT NULL DEFAULT 1,
        created_at_ms BIGINT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        INDEX x_subscription_owner (owner_user_id,id)
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
];
module.exports = { SCHEMA };

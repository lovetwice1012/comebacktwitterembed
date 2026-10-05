'use strict';
const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS bot_personal_link_users (
        user_id VARCHAR(32) NOT NULL PRIMARY KEY
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS bot_link_cards (
        id CHAR(32) NOT NULL PRIMARY KEY, guild_id VARCHAR(32) NOT NULL,
        channel_id VARCHAR(32) NOT NULL, message_id VARCHAR(32) NULL,
        payload_json MEDIUMTEXT NOT NULL, expires_at_ms BIGINT NOT NULL,
        INDEX idx_link_card_expiry (expires_at_ms)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS bot_saved_links (
        id CHAR(32) NOT NULL PRIMARY KEY, user_id VARCHAR(32) NOT NULL,
        content_key CHAR(64) NOT NULL, provider_id VARCHAR(32) NOT NULL,
        url TEXT NOT NULL, title VARCHAR(512) NOT NULL,
        tags_json TEXT NOT NULL, note TEXT NOT NULL,
        created_at_ms BIGINT NOT NULL, updated_at_ms BIGINT NOT NULL,
        UNIQUE KEY uniq_saved_link (user_id, content_key),
        INDEX idx_saved_link_owner (user_id, updated_at_ms)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS bot_link_notifications (
        id CHAR(32) NOT NULL PRIMARY KEY, user_id VARCHAR(32) NOT NULL,
        request_key VARCHAR(100) NOT NULL, kind VARCHAR(16) NOT NULL,
        url TEXT NOT NULL, title VARCHAR(512) NOT NULL, locale VARCHAR(16) NOT NULL,
        time_zone VARCHAR(64) NOT NULL, due_at_ms BIGINT NOT NULL,
        next_attempt_at_ms BIGINT NOT NULL DEFAULT 0,
        item_id VARCHAR(32) NULL, variation_id VARCHAR(32) NOT NULL DEFAULT '*',
        variation_name VARCHAR(100) NOT NULL DEFAULT '',
        last_stock_state VARCHAR(16) NULL,
        status VARCHAR(24) NOT NULL, lease_token CHAR(32) NULL,
        lease_until_ms BIGINT NOT NULL DEFAULT 0, attempts INT NOT NULL DEFAULT 0,
        last_error VARCHAR(64) NULL, delivered_message_id VARCHAR(32) NULL,
        created_at_ms BIGINT NOT NULL, updated_at_ms BIGINT NOT NULL,
        UNIQUE KEY uniq_link_notification_request (user_id, request_key),
        INDEX idx_link_notification_due (status, due_at_ms, lease_until_ms),
        INDEX idx_link_notification_owner (user_id, kind, created_at_ms),
        INDEX idx_link_notification_stock (item_id, status, variation_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS bot_restock_sources (
        item_id VARCHAR(32) NOT NULL PRIMARY KEY, url TEXT NOT NULL,
        state_json MEDIUMTEXT NULL, next_check_at_ms BIGINT NOT NULL,
        lease_token CHAR(32) NULL, lease_until_ms BIGINT NOT NULL DEFAULT 0,
        failure_count INT NOT NULL DEFAULT 0, last_error VARCHAR(64) NULL,
        checked_at_ms BIGINT NULL,
        INDEX idx_restock_due (next_check_at_ms, lease_until_ms)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
];
module.exports = { SCHEMA };

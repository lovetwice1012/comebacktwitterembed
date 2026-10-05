'use strict';

const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS bot_shared_posts (
        guild_id VARCHAR(32) NOT NULL,
        channel_id VARCHAR(32) NOT NULL,
        content_key CHAR(64) NOT NULL,
        source_message_id VARCHAR(32) NOT NULL,
        link_message_id VARCHAR(32) NOT NULL,
        response_message_id VARCHAR(32) NOT NULL,
        shared_at_ms BIGINT NOT NULL,
        PRIMARY KEY (guild_id, channel_id, content_key),
        INDEX idx_shared_posts_time (shared_at_ms)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS bot_media_galleries (
        gallery_id CHAR(32) NOT NULL PRIMARY KEY,
        guild_id VARCHAR(32) NOT NULL,
        channel_id VARCHAR(32) NOT NULL,
        message_id VARCHAR(32) NULL,
        provider_id VARCHAR(32) NOT NULL,
        payload_json MEDIUMTEXT NOT NULL,
        expires_at_ms BIGINT NOT NULL,
        INDEX idx_media_galleries_expiry (expires_at_ms)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
];

module.exports = { SCHEMA };

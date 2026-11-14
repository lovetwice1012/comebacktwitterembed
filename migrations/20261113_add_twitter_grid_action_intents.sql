CREATE TABLE IF NOT EXISTS bot_twitter_grid_action_intents (
    gallery_id CHAR(32) NOT NULL,
    guild_id VARCHAR(22) NOT NULL,
    channel_id VARCHAR(22) NOT NULL,
    message_id VARCHAR(22) NOT NULL,
    operation_id CHAR(32) NOT NULL,
    payload_json LONGTEXT NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    PRIMARY KEY (gallery_id),
    INDEX idx_grid_intents_updated (updated_at_ms, gallery_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

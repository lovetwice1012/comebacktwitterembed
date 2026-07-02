CREATE TABLE IF NOT EXISTS guild_settings_webui_notice_state (
    guild_id VARCHAR(32) NOT NULL PRIMARY KEY,
    sent_at_ms BIGINT NOT NULL,
    command_user_id VARCHAR(32) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_settings_webui_notice_guild
        FOREIGN KEY (guild_id) REFERENCES guilds(guild_id)
        ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

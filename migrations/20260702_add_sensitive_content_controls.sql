ALTER TABLE guild_provider_settings
    ADD COLUMN non_nsfw_channel_sensitive_display_mode VARCHAR(32) NULL AFTER quote_repost_depth_by_account;

ALTER TABLE guild_provider_settings
    ADD COLUMN pixiv_r18_display_mode VARCHAR(32) NULL AFTER pixiv_tag_limit;

ALTER TABLE guild_provider_settings
    ADD COLUMN pixiv_r18g_display_mode VARCHAR(32) NULL AFTER pixiv_r18_display_mode;

CREATE TABLE IF NOT EXISTS guild_provider_sensitive_content_allowed_targets (
    provider_id VARCHAR(64) NOT NULL,
    guild_id VARCHAR(32) NOT NULL,
    target_type ENUM('user', 'channel', 'role') NOT NULL,
    target_id VARCHAR(32) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (provider_id, guild_id, target_type, target_id),
    INDEX idx_sensitive_allowed_guild (guild_id),
    CONSTRAINT fk_sensitive_allowed_provider
        FOREIGN KEY (provider_id) REFERENCES providers(provider_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_sensitive_allowed_guild
        FOREIGN KEY (guild_id) REFERENCES guilds(guild_id)
        ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS guild_provider_sensitive_content_excluded_targets (
    provider_id VARCHAR(64) NOT NULL,
    guild_id VARCHAR(32) NOT NULL,
    target_type ENUM('user', 'channel', 'role') NOT NULL,
    target_id VARCHAR(32) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (provider_id, guild_id, target_type, target_id),
    INDEX idx_sensitive_excluded_guild (guild_id),
    CONSTRAINT fk_sensitive_excluded_provider
        FOREIGN KEY (provider_id) REFERENCES providers(provider_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_sensitive_excluded_guild
        FOREIGN KEY (guild_id) REFERENCES guilds(guild_id)
        ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

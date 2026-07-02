ALTER TABLE guild_provider_settings
    DROP COLUMN pixiv_sensitive_display_mode;

ALTER TABLE guild_provider_settings
    DROP COLUMN pixiv_sensitive_non_nsfw_channel_sensitive_restriction_enabled;

DROP TABLE IF EXISTS guild_provider_pixiv_sensitive_content_allowed_targets;

DROP TABLE IF EXISTS guild_provider_pixiv_sensitive_content_excluded_targets;

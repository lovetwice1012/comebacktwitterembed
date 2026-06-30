ALTER TABLE guild_provider_settings
    ADD COLUMN display_density VARCHAR(32) NULL AFTER hidden_output_items;
ALTER TABLE guild_provider_settings
    ADD COLUMN media_display_mode VARCHAR(32) NULL AFTER display_density;
ALTER TABLE guild_provider_settings
    ADD COLUMN failure_display_policy VARCHAR(32) NULL AFTER media_display_mode;
ALTER TABLE guild_provider_settings
    ADD COLUMN tiktok_description_max_length INT NULL AFTER failure_display_policy;
ALTER TABLE guild_provider_settings
    ADD COLUMN tiktok_image_limit INT NULL AFTER tiktok_description_max_length;
ALTER TABLE guild_provider_settings
    ADD COLUMN tiktok_video_fallback_mode VARCHAR(32) NULL AFTER tiktok_image_limit;
ALTER TABLE guild_provider_settings
    ADD COLUMN niconico_description_max_length INT NULL AFTER tiktok_video_fallback_mode;
ALTER TABLE guild_provider_settings
    ADD COLUMN spotify_description_max_length INT NULL AFTER niconico_description_max_length;
ALTER TABLE guild_provider_settings
    ADD COLUMN twitch_description_max_length INT NULL AFTER spotify_description_max_length;
ALTER TABLE guild_provider_settings
    ADD COLUMN steam_description_max_length INT NULL AFTER twitch_description_max_length;
ALTER TABLE guild_provider_settings
    ADD COLUMN steam_image_source VARCHAR(32) NULL AFTER steam_description_max_length;
ALTER TABLE guild_provider_settings
    ADD COLUMN amazon_description_max_length INT NULL AFTER steam_image_source;
ALTER TABLE guild_provider_settings
    ADD COLUMN booth_description_max_length INT NULL AFTER amazon_description_max_length;
ALTER TABLE guild_provider_settings
    ADD COLUMN booth_image_limit INT NULL AFTER booth_description_max_length;
ALTER TABLE guild_provider_settings
    ADD COLUMN booth_adult_display_mode VARCHAR(32) NULL AFTER booth_image_limit;

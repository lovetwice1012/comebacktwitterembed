ALTER TABLE guild_provider_settings
    ADD COLUMN twitter_text_mode VARCHAR(32) NULL AFTER tiktok_hq;
ALTER TABLE guild_provider_settings
    ADD COLUMN twitter_stats_layout VARCHAR(32) NULL AFTER twitter_text_mode;
ALTER TABLE guild_provider_settings
    ADD COLUMN twitter_quote_mode VARCHAR(32) NULL AFTER twitter_stats_layout;
ALTER TABLE guild_provider_settings
    ADD COLUMN twitter_quote_layout VARCHAR(32) NULL AFTER twitter_quote_mode;
ALTER TABLE guild_provider_settings
    ADD COLUMN pixiv_caption_max_length INT NULL AFTER twitter_quote_layout;
ALTER TABLE guild_provider_settings
    ADD COLUMN pixiv_tag_limit VARCHAR(32) NULL AFTER pixiv_caption_max_length;
ALTER TABLE guild_provider_settings
    ADD COLUMN instagram_caption_max_length INT NULL AFTER pixiv_tag_limit;
ALTER TABLE guild_provider_settings
    ADD COLUMN instagram_media_limit INT NULL AFTER instagram_caption_max_length;
ALTER TABLE guild_provider_settings
    ADD COLUMN github_card_style VARCHAR(32) NULL AFTER instagram_media_limit;
ALTER TABLE guild_provider_settings
    ADD COLUMN hidden_output_items TEXT NULL AFTER github_card_style;

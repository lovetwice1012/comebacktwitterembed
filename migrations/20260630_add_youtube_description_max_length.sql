ALTER TABLE guild_provider_settings
    ADD COLUMN youtube_description_max_length INT NULL AFTER pixiv_images_per_step;
ALTER TABLE guild_provider_settings
    ADD COLUMN youtube_video_list_limit INT NULL AFTER youtube_description_max_length;

ALTER TABLE guild_provider_settings
    ADD COLUMN amazon_extract_targets TEXT NULL AFTER amazon_description_max_length;

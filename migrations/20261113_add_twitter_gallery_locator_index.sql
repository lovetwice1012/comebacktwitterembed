ALTER TABLE bot_media_galleries
    ADD INDEX idx_media_galleries_locator (guild_id, channel_id, message_id, provider_id, expires_at_ms);

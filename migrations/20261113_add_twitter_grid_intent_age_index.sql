ALTER TABLE bot_twitter_grid_action_intents
    ADD INDEX idx_grid_intents_updated (updated_at_ms, gallery_id);

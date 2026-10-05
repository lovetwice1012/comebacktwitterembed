ALTER TABLE bot_provider_expansion_traces
    ADD INDEX idx_expansion_trace_message (guild_id, channel_id, message_id, created_at_ms);

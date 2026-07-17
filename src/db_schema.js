'use strict';

const fs = require('fs');
const path = require('path');

const TABLES = {
    schemaMigrations: 'schema_migrations',
    users: 'users',
    providers: 'providers',
    guilds: 'guilds',
    twitterAccounts: 'twitter_accounts',
    webhookEndpoints: 'webhook_endpoints',
    autoExtractTargets: 'auto_extract_targets',
    guildProviderSettings: 'guild_provider_settings',
    globalDisableTargets: 'global_disable_targets',
    guildProviderDisableTargets: 'guild_provider_disable_targets',
    guildProviderSensitiveContentAllowedTargets: 'guild_provider_sensitive_content_allowed_targets',
    guildProviderSensitiveContentExcludedTargets: 'guild_provider_sensitive_content_excluded_targets',
    guildProviderPixivR18SensitiveContentAllowedTargets: 'guild_provider_pixiv_r18_sensitive_content_allowed_targets',
    guildProviderPixivR18SensitiveContentExcludedTargets: 'guild_provider_pixiv_r18_sensitive_content_excluded_targets',
    guildProviderPixivR18gSensitiveContentAllowedTargets: 'guild_provider_pixiv_r18g_sensitive_content_allowed_targets',
    guildProviderPixivR18gSensitiveContentExcludedTargets: 'guild_provider_pixiv_r18g_sensitive_content_excluded_targets',
    guildProviderBannedWords: 'guild_provider_banned_words',
    guildProviderButtonVisibility: 'guild_provider_button_visibility',
    guildProviderButtonDisabledTargets: 'guild_provider_button_disabled_targets',
    deregisterReasons: 'deregister_reasons',
    deregisterNotifications: 'deregister_notifications',
    botErrorEvents: 'bot_error_events',
    botErrorBuckets: 'bot_error_buckets',
    botMetricBuckets: 'bot_metric_buckets',
    botAnalyticsEvents: 'bot_analytics_events',
    botProviderContentEvents: 'bot_provider_content_events',
    botProviderContentFacets: 'bot_provider_content_facets',
    botProviderHourlyAggregates: 'bot_provider_hourly_aggregates',
    botProviderHourlyUniqueKeys: 'bot_provider_hourly_unique_keys',
    botErrorAlerts: 'bot_error_alerts',
    providerSettingsCacheInvalidations: 'provider_settings_cache_invalidations',
    dashboardAuditLogs: 'dashboard_audit_logs',
    guildSettingsWebuiNoticeState: 'guild_settings_webui_notice_state',
    dashboardDelegatedAccessGrants: 'dashboard_delegated_access_grants',
};

const SCHEMA_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS ${TABLES.schemaMigrations} (
        migration_id VARCHAR(191) NOT NULL PRIMARY KEY,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.users} (
        user_id VARCHAR(32) NOT NULL PRIMARY KEY,
        registered_at_ms BIGINT NOT NULL,
        additional_auto_extract_slots INT NOT NULL DEFAULT 0,
        save_tweet_quota_override_bytes BIGINT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.providers} (
        provider_id VARCHAR(64) NOT NULL PRIMARY KEY,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.guilds} (
        guild_id VARCHAR(32) NOT NULL PRIMARY KEY,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.dashboardDelegatedAccessGrants} (
        grant_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        guild_id VARCHAR(32) NOT NULL,
        target_type ENUM('user', 'role') NOT NULL,
        target_id VARCHAR(32) NOT NULL,
        access_level ENUM('view', 'edit') NOT NULL,
        granted_by_user_id VARCHAR(32) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_dashboard_delegated_access_target (guild_id, target_type, target_id),
        INDEX idx_dashboard_delegated_access_guild (guild_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.twitterAccounts} (
        twitter_username VARCHAR(191) NOT NULL PRIMARY KEY,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.webhookEndpoints} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        webhook_url_hash CHAR(64) NOT NULL,
        webhook_url TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_webhook_url_hash (webhook_url_hash)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.autoExtractTargets} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        twitter_username VARCHAR(191) NOT NULL,
        webhook_endpoint_id BIGINT UNSIGNED NOT NULL,
        premium_slot TINYINT(1) NOT NULL DEFAULT 0,
        last_extracted_at_ms BIGINT NOT NULL DEFAULT 0,
        created_at_ms BIGINT NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_auto_extract_target (user_id, twitter_username, webhook_endpoint_id),
        INDEX idx_auto_extract_user (user_id),
        INDEX idx_auto_extract_premium (premium_slot),
        CONSTRAINT fk_auto_extract_user
            FOREIGN KEY (user_id) REFERENCES ${TABLES.users}(user_id)
            ON DELETE CASCADE,
        CONSTRAINT fk_auto_extract_twitter_account
            FOREIGN KEY (twitter_username) REFERENCES ${TABLES.twitterAccounts}(twitter_username)
            ON DELETE CASCADE,
        CONSTRAINT fk_auto_extract_webhook
            FOREIGN KEY (webhook_endpoint_id) REFERENCES ${TABLES.webhookEndpoints}(id)
            ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.guildProviderSettings} (
        provider_id VARCHAR(64) NOT NULL,
        guild_id VARCHAR(32) NOT NULL,
        enabled TINYINT(1) NULL,
        default_language VARCHAR(16) NULL,
        edit_original_if_translate TINYINT(1) NULL,
        extract_bot_message TINYINT(1) NULL,
        legacy_mode TINYINT(1) NULL,
        passive_mode TINYINT(1) NULL,
        anonymous_expand TINYINT(1) NULL,
        secondary_extract_mode TINYINT(1) NULL,
        secondary_extract_mode_multiple_images TINYINT(1) NULL,
        secondary_extract_mode_video TINYINT(1) NULL,
        send_media_as_attachments_as_default TINYINT(1) NULL,
        delete_if_only_posted_tweet_link TINYINT(1) NULL,
        delete_if_only_posted_tweet_link_secondary_extract_mode TINYINT(1) NULL,
        suppress_source_embeds_secondary_extract_mode TINYINT(1) NULL,
        always_reply_if_posted_tweet_link TINYINT(1) NULL,
        quote_repost_max_depth INT NULL,
        quote_repost_do_not_extract TINYINT(1) NULL,
        quote_repost_depth_by_account TEXT NULL,
        non_nsfw_channel_sensitive_restriction_enabled TINYINT(1) NULL,
        pixiv_images_per_step INT NULL,
        youtube_description_max_length INT NULL,
        youtube_video_list_limit INT NULL,
        tiktok_hq TINYINT(1) NULL,
        twitter_text_mode VARCHAR(32) NULL,
        twitter_stats_layout VARCHAR(32) NULL,
        twitter_quote_mode VARCHAR(32) NULL,
        twitter_quote_layout VARCHAR(32) NULL,
        pixiv_caption_max_length INT NULL,
        pixiv_tag_limit VARCHAR(32) NULL,
        pixiv_r18_display_mode VARCHAR(32) NULL,
        pixiv_r18g_display_mode VARCHAR(32) NULL,
        pixiv_r18_non_nsfw_channel_sensitive_restriction_enabled TINYINT(1) NULL,
        pixiv_r18g_non_nsfw_channel_sensitive_restriction_enabled TINYINT(1) NULL,
        instagram_caption_max_length INT NULL,
        instagram_media_limit INT NULL,
        github_card_style VARCHAR(32) NULL,
        hidden_output_items TEXT NULL,
        display_density VARCHAR(32) NULL,
        media_display_mode VARCHAR(32) NULL,
        failure_display_policy VARCHAR(32) NULL,
        tiktok_description_max_length INT NULL,
        tiktok_image_limit INT NULL,
        tiktok_video_fallback_mode VARCHAR(32) NULL,
        niconico_description_max_length INT NULL,
        spotify_description_max_length INT NULL,
        twitch_description_max_length INT NULL,
        steam_description_max_length INT NULL,
        steam_image_source VARCHAR(32) NULL,
        amazon_description_max_length INT NULL,
        amazon_extract_targets TEXT NULL,
        booth_description_max_length INT NULL,
        booth_image_limit INT NULL,
        booth_adult_display_mode VARCHAR(32) NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (provider_id, guild_id),
        INDEX idx_guild_provider_settings_guild (guild_id),
        CONSTRAINT fk_guild_provider_settings_provider
            FOREIGN KEY (provider_id) REFERENCES ${TABLES.providers}(provider_id)
            ON DELETE CASCADE,
        CONSTRAINT fk_guild_provider_settings_guild
            FOREIGN KEY (guild_id) REFERENCES ${TABLES.guilds}(guild_id)
            ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.globalDisableTargets} (
        target_type ENUM('user', 'channel') NOT NULL,
        target_id VARCHAR(32) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (target_type, target_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.guildProviderDisableTargets} (
        provider_id VARCHAR(64) NOT NULL,
        guild_id VARCHAR(32) NOT NULL,
        target_type ENUM('user', 'channel', 'role') NOT NULL,
        target_id VARCHAR(32) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (provider_id, guild_id, target_type, target_id),
        INDEX idx_provider_disable_guild (guild_id),
        CONSTRAINT fk_provider_disable_provider
            FOREIGN KEY (provider_id) REFERENCES ${TABLES.providers}(provider_id)
            ON DELETE CASCADE,
        CONSTRAINT fk_provider_disable_guild
            FOREIGN KEY (guild_id) REFERENCES ${TABLES.guilds}(guild_id)
            ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.guildProviderSensitiveContentAllowedTargets} (
        provider_id VARCHAR(64) NOT NULL,
        guild_id VARCHAR(32) NOT NULL,
        target_type ENUM('user', 'channel', 'role') NOT NULL,
        target_id VARCHAR(32) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (provider_id, guild_id, target_type, target_id),
        INDEX idx_sensitive_allowed_guild (guild_id),
        CONSTRAINT fk_sensitive_allowed_provider
            FOREIGN KEY (provider_id) REFERENCES ${TABLES.providers}(provider_id)
            ON DELETE CASCADE,
        CONSTRAINT fk_sensitive_allowed_guild
            FOREIGN KEY (guild_id) REFERENCES ${TABLES.guilds}(guild_id)
            ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.guildProviderSensitiveContentExcludedTargets} (
        provider_id VARCHAR(64) NOT NULL,
        guild_id VARCHAR(32) NOT NULL,
        target_type ENUM('user', 'channel', 'role') NOT NULL,
        target_id VARCHAR(32) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (provider_id, guild_id, target_type, target_id),
        INDEX idx_sensitive_excluded_guild (guild_id),
        CONSTRAINT fk_sensitive_excluded_provider
            FOREIGN KEY (provider_id) REFERENCES ${TABLES.providers}(provider_id)
            ON DELETE CASCADE,
        CONSTRAINT fk_sensitive_excluded_guild
            FOREIGN KEY (guild_id) REFERENCES ${TABLES.guilds}(guild_id)
            ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.guildProviderPixivR18SensitiveContentAllowedTargets} (
        provider_id VARCHAR(64) NOT NULL,
        guild_id VARCHAR(32) NOT NULL,
        target_type ENUM('user', 'channel', 'role') NOT NULL,
        target_id VARCHAR(32) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (provider_id, guild_id, target_type, target_id),
        INDEX idx_pixiv_r18_sensitive_allowed_guild (guild_id),
        CONSTRAINT fk_pixiv_r18_sensitive_allowed_provider
            FOREIGN KEY (provider_id) REFERENCES ${TABLES.providers}(provider_id)
            ON DELETE CASCADE,
        CONSTRAINT fk_pixiv_r18_sensitive_allowed_guild
            FOREIGN KEY (guild_id) REFERENCES ${TABLES.guilds}(guild_id)
            ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.guildProviderPixivR18SensitiveContentExcludedTargets} (
        provider_id VARCHAR(64) NOT NULL,
        guild_id VARCHAR(32) NOT NULL,
        target_type ENUM('user', 'channel', 'role') NOT NULL,
        target_id VARCHAR(32) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (provider_id, guild_id, target_type, target_id),
        INDEX idx_pixiv_r18_sensitive_excluded_guild (guild_id),
        CONSTRAINT fk_pixiv_r18_sensitive_excluded_provider
            FOREIGN KEY (provider_id) REFERENCES ${TABLES.providers}(provider_id)
            ON DELETE CASCADE,
        CONSTRAINT fk_pixiv_r18_sensitive_excluded_guild
            FOREIGN KEY (guild_id) REFERENCES ${TABLES.guilds}(guild_id)
            ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.guildProviderPixivR18gSensitiveContentAllowedTargets} (
        provider_id VARCHAR(64) NOT NULL,
        guild_id VARCHAR(32) NOT NULL,
        target_type ENUM('user', 'channel', 'role') NOT NULL,
        target_id VARCHAR(32) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (provider_id, guild_id, target_type, target_id),
        INDEX idx_pixiv_r18g_sensitive_allowed_guild (guild_id),
        CONSTRAINT fk_pixiv_r18g_sensitive_allowed_provider
            FOREIGN KEY (provider_id) REFERENCES ${TABLES.providers}(provider_id)
            ON DELETE CASCADE,
        CONSTRAINT fk_pixiv_r18g_sensitive_allowed_guild
            FOREIGN KEY (guild_id) REFERENCES ${TABLES.guilds}(guild_id)
            ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.guildProviderPixivR18gSensitiveContentExcludedTargets} (
        provider_id VARCHAR(64) NOT NULL,
        guild_id VARCHAR(32) NOT NULL,
        target_type ENUM('user', 'channel', 'role') NOT NULL,
        target_id VARCHAR(32) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (provider_id, guild_id, target_type, target_id),
        INDEX idx_pixiv_r18g_sensitive_excluded_guild (guild_id),
        CONSTRAINT fk_pixiv_r18g_sensitive_excluded_provider
            FOREIGN KEY (provider_id) REFERENCES ${TABLES.providers}(provider_id)
            ON DELETE CASCADE,
        CONSTRAINT fk_pixiv_r18g_sensitive_excluded_guild
            FOREIGN KEY (guild_id) REFERENCES ${TABLES.guilds}(guild_id)
            ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.guildProviderBannedWords} (
        provider_id VARCHAR(64) NOT NULL,
        guild_id VARCHAR(32) NOT NULL,
        word VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (provider_id, guild_id, word),
        INDEX idx_banned_words_guild (guild_id),
        CONSTRAINT fk_banned_words_provider
            FOREIGN KEY (provider_id) REFERENCES ${TABLES.providers}(provider_id)
            ON DELETE CASCADE,
        CONSTRAINT fk_banned_words_guild
            FOREIGN KEY (guild_id) REFERENCES ${TABLES.guilds}(guild_id)
            ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.guildProviderButtonVisibility} (
        provider_id VARCHAR(64) NOT NULL,
        guild_id VARCHAR(32) NOT NULL,
        button_key VARCHAR(64) NOT NULL,
        hidden TINYINT(1) NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (provider_id, guild_id, button_key),
        CONSTRAINT fk_button_visibility_provider
            FOREIGN KEY (provider_id) REFERENCES ${TABLES.providers}(provider_id)
            ON DELETE CASCADE,
        CONSTRAINT fk_button_visibility_guild
            FOREIGN KEY (guild_id) REFERENCES ${TABLES.guilds}(guild_id)
            ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.guildProviderButtonDisabledTargets} (
        provider_id VARCHAR(64) NOT NULL,
        guild_id VARCHAR(32) NOT NULL,
        target_type ENUM('user', 'channel', 'role') NOT NULL,
        target_id VARCHAR(32) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (provider_id, guild_id, target_type, target_id),
        INDEX idx_button_disabled_guild (guild_id),
        CONSTRAINT fk_button_disabled_provider
            FOREIGN KEY (provider_id) REFERENCES ${TABLES.providers}(provider_id)
            ON DELETE CASCADE,
        CONSTRAINT fk_button_disabled_guild
            FOREIGN KEY (guild_id) REFERENCES ${TABLES.guilds}(guild_id)
            ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.deregisterReasons} (
        reason_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        reason TEXT NOT NULL,
        hint TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.deregisterNotifications} (
        notification_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        auto_extract_target_id BIGINT UNSIGNED NULL,
        user_id VARCHAR(32) NOT NULL,
        reason_id BIGINT UNSIGNED NOT NULL,
        created_at_ms BIGINT NOT NULL,
        dm_sent TINYINT(1) NOT NULL DEFAULT 0,
        dm_sent_at_ms BIGINT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_deregister_dm (dm_sent, created_at_ms),
        INDEX idx_deregister_user (user_id),
        CONSTRAINT fk_deregister_user
            FOREIGN KEY (user_id) REFERENCES ${TABLES.users}(user_id)
            ON DELETE CASCADE,
        CONSTRAINT fk_deregister_target
            FOREIGN KEY (auto_extract_target_id) REFERENCES ${TABLES.autoExtractTargets}(id)
            ON DELETE SET NULL,
        CONSTRAINT fk_deregister_reason
            FOREIGN KEY (reason_id) REFERENCES ${TABLES.deregisterReasons}(reason_id)
            ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.botErrorEvents} (
        error_event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        occurred_at_ms BIGINT NOT NULL,
        expires_at_ms BIGINT NULL,
        error_type VARCHAR(96) NOT NULL,
        severity ENUM('debug', 'info', 'warn', 'error', 'fatal') NOT NULL DEFAULT 'error',
        source VARCHAR(96) NULL,
        provider_id VARCHAR(64) NULL,
        endpoint_key VARCHAR(191) NULL,
        raw_url TEXT NULL,
        normalized_url TEXT NULL,
        url_hash CHAR(64) NULL,
        author_user_id VARCHAR(32) NULL,
        guild_id VARCHAR(32) NULL,
        guild_name_snapshot VARCHAR(255) NULL,
        channel_id VARCHAR(32) NULL,
        channel_name_snapshot VARCHAR(255) NULL,
        message_id VARCHAR(32) NULL,
        command_name VARCHAR(64) NULL,
        component_id VARCHAR(191) NULL,
        discord_code INT NULL,
        http_status INT NULL,
        stack_hash CHAR(64) NULL,
        message_hash CHAR(64) NULL,
        details_json LONGTEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_error_events_time (occurred_at_ms),
        INDEX idx_error_events_type_time (error_type, occurred_at_ms),
        INDEX idx_error_events_provider_time (provider_id, occurred_at_ms),
        INDEX idx_error_events_guild_time (guild_id, occurred_at_ms),
        INDEX idx_error_events_url_hash (url_hash),
        INDEX idx_error_events_stack_hash (stack_hash),
        INDEX idx_error_events_expires (expires_at_ms)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.botErrorBuckets} (
        bucket_start_ms BIGINT NOT NULL,
        bucket_size_seconds INT NOT NULL,
        error_type VARCHAR(96) NOT NULL,
        severity ENUM('debug', 'info', 'warn', 'error', 'fatal') NOT NULL DEFAULT 'error',
        provider_id VARCHAR(64) NOT NULL DEFAULT '',
        guild_id VARCHAR(32) NOT NULL DEFAULT '',
        endpoint_key VARCHAR(191) NOT NULL DEFAULT '',
        count BIGINT UNSIGNED NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (bucket_start_ms, bucket_size_seconds, error_type, severity, provider_id, guild_id, endpoint_key),
        INDEX idx_error_buckets_type_time (error_type, bucket_start_ms),
        INDEX idx_error_buckets_provider_time (provider_id, bucket_start_ms),
        INDEX idx_error_buckets_guild_time (guild_id, bucket_start_ms)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.botMetricBuckets} (
        bucket_start_ms BIGINT NOT NULL,
        bucket_size_seconds INT NOT NULL,
        metric_name VARCHAR(96) NOT NULL,
        provider_id VARCHAR(64) NOT NULL DEFAULT '',
        guild_id VARCHAR(32) NOT NULL DEFAULT '',
        endpoint_key VARCHAR(191) NOT NULL DEFAULT '',
        count BIGINT UNSIGNED NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (bucket_start_ms, bucket_size_seconds, metric_name, provider_id, guild_id, endpoint_key),
        INDEX idx_metric_buckets_name_time (metric_name, bucket_start_ms),
        INDEX idx_metric_buckets_time (bucket_start_ms),
        INDEX idx_metric_buckets_provider_time (provider_id, bucket_start_ms),
        INDEX idx_metric_buckets_guild_time (guild_id, bucket_start_ms)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.botAnalyticsEvents} (
        analytics_event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        occurred_at_ms BIGINT NOT NULL,
        event_type VARCHAR(64) NOT NULL,
        source VARCHAR(96) NULL,
        provider_id VARCHAR(64) NULL,
        account_key VARCHAR(191) NULL,
        endpoint_key VARCHAR(191) NULL,
        raw_url TEXT NULL,
        normalized_url TEXT NULL,
        url_hash CHAR(64) NULL,
        guild_id VARCHAR(32) NULL,
        guild_name_snapshot VARCHAR(255) NULL,
        channel_id VARCHAR(32) NULL,
        channel_name_snapshot VARCHAR(255) NULL,
        author_user_id VARCHAR(32) NULL,
        message_id VARCHAR(32) NULL,
        command_name VARCHAR(64) NULL,
        component_id VARCHAR(191) NULL,
        success TINYINT(1) NULL,
        duration_ms INT UNSIGNED NULL,
        count BIGINT UNSIGNED NOT NULL DEFAULT 1,
        details_json LONGTEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_analytics_time (occurred_at_ms),
        INDEX idx_analytics_event_time (event_type, occurred_at_ms),
        INDEX idx_analytics_provider_account_time (provider_id, account_key, occurred_at_ms),
        INDEX idx_analytics_url_hash (url_hash),
        INDEX idx_analytics_guild_time (guild_id, occurred_at_ms),
        INDEX idx_analytics_user_time (author_user_id, occurred_at_ms),
        INDEX idx_analytics_command_time (command_name, occurred_at_ms),
        INDEX idx_analytics_component_time (component_id, occurred_at_ms)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.botProviderContentEvents} (
        content_event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        occurred_at_ms BIGINT NOT NULL,
        provider_id VARCHAR(64) NOT NULL,
        account_key VARCHAR(191) NULL,
        content_id VARCHAR(191) NULL,
        content_type VARCHAR(64) NULL,
        content_url TEXT NULL,
        normalized_url TEXT NULL,
        url_hash CHAR(64) NULL,
        title TEXT NULL,
        description_preview TEXT NULL,
        author_name VARCHAR(255) NULL,
        language VARCHAR(32) NULL,
        published_at_ms BIGINT NULL,
        \`sensitive\` TINYINT(1) NULL,
        media_count INT UNSIGNED NULL,
        duration_seconds INT UNSIGNED NULL,
        guild_id VARCHAR(32) NULL,
        channel_id VARCHAR(32) NULL,
        author_user_id VARCHAR(32) NULL,
        source VARCHAR(96) NULL,
        raw_metrics_json LONGTEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_content_provider_account_time (provider_id, account_key, occurred_at_ms),
        INDEX idx_content_time (occurred_at_ms),
        INDEX idx_content_provider_type_time (provider_id, content_type, occurred_at_ms),
        INDEX idx_content_guild_time (guild_id, occurred_at_ms),
        INDEX idx_content_user_time (author_user_id, occurred_at_ms),
        INDEX idx_content_url_hash (url_hash)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.botProviderContentFacets} (
        facet_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        content_event_id BIGINT UNSIGNED NOT NULL,
        provider_id VARCHAR(64) NOT NULL,
        account_key VARCHAR(191) NULL,
        facet_key VARCHAR(191) NOT NULL,
        facet_value VARCHAR(512) NULL,
        numeric_value DOUBLE NULL,
        json_value LONGTEXT NULL,
        metric_stage VARCHAR(32) NOT NULL DEFAULT 'initial',
        metric_source VARCHAR(96) NULL,
        collected_at_ms BIGINT NULL,
        schema_version VARCHAR(64) NULL,
        collection_success TINYINT(1) NULL,
        collection_timeout_ms INT UNSIGNED NULL,
        occurred_at_ms BIGINT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_content_facets_stage_schema_time (metric_stage, schema_version, occurred_at_ms),
        INDEX idx_content_facets_time (occurred_at_ms),
        INDEX idx_content_facets_source_time (metric_source, occurred_at_ms),
        INDEX idx_content_facets_key_value_time (facet_key, facet_value, occurred_at_ms),
        INDEX idx_content_facets_provider_key_time (provider_id, facet_key, occurred_at_ms),
        INDEX idx_content_facets_account_key_time (provider_id, account_key, facet_key, occurred_at_ms),
        CONSTRAINT fk_content_facets_event
            FOREIGN KEY (content_event_id) REFERENCES ${TABLES.botProviderContentEvents}(content_event_id)
            ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.botProviderHourlyAggregates} (
        bucket_start_ms BIGINT NOT NULL,
        bucket_size_seconds INT NOT NULL DEFAULT 3600,
        provider_id VARCHAR(64) NOT NULL DEFAULT '',
        account_key VARCHAR(191) NOT NULL DEFAULT '',
        guild_id VARCHAR(32) NOT NULL DEFAULT '',
        content_type VARCHAR(64) NOT NULL DEFAULT '',
        event_type VARCHAR(64) NOT NULL DEFAULT '',
        schema_version VARCHAR(64) NOT NULL DEFAULT '',
        content_events BIGINT UNSIGNED NOT NULL DEFAULT 0,
        analytics_events BIGINT UNSIGNED NOT NULL DEFAULT 0,
        extract_events BIGINT UNSIGNED NOT NULL DEFAULT 0,
        extract_successes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        extract_failures BIGINT UNSIGNED NOT NULL DEFAULT 0,
        send_events BIGINT UNSIGNED NOT NULL DEFAULT 0,
        send_successes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        send_failures BIGINT UNSIGNED NOT NULL DEFAULT 0,
        enrichment_jobs BIGINT UNSIGNED NOT NULL DEFAULT 0,
        enrichment_successes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        enrichment_failures BIGINT UNSIGNED NOT NULL DEFAULT 0,
        analytics_duration_sum_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
        analytics_duration_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
        analytics_duration_max_ms INT UNSIGNED NOT NULL DEFAULT 0,
        enrichment_duration_sum_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
        enrichment_duration_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
        enrichment_duration_max_ms INT UNSIGNED NOT NULL DEFAULT 0,
        media_count_sum BIGINT UNSIGNED NOT NULL DEFAULT 0,
        duration_seconds_sum BIGINT UNSIGNED NOT NULL DEFAULT 0,
        duration_seconds_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
        sensitive_events BIGINT UNSIGNED NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (bucket_start_ms, provider_id, account_key, guild_id, content_type, event_type, schema_version),
        INDEX idx_provider_hourly_provider_time (provider_id, bucket_start_ms),
        INDEX idx_provider_hourly_account_time (provider_id, account_key, bucket_start_ms),
        INDEX idx_provider_hourly_guild_time (guild_id, bucket_start_ms),
        INDEX idx_provider_hourly_event_time (event_type, bucket_start_ms),
        INDEX idx_provider_hourly_schema_time (schema_version, bucket_start_ms)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.botProviderHourlyUniqueKeys} (
        bucket_start_ms BIGINT NOT NULL,
        provider_id VARCHAR(64) NOT NULL DEFAULT '',
        account_key VARCHAR(191) NOT NULL DEFAULT '',
        guild_id VARCHAR(32) NOT NULL DEFAULT '',
        content_type VARCHAR(64) NOT NULL DEFAULT '',
        event_type VARCHAR(64) NOT NULL DEFAULT '',
        key_type ENUM('author_user', 'guild', 'url') NOT NULL,
        key_hash CHAR(64) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (bucket_start_ms, provider_id, account_key, guild_id, content_type, event_type, key_type, key_hash),
        INDEX idx_provider_hourly_unique_lookup (provider_id, account_key, bucket_start_ms, key_type),
        INDEX idx_provider_hourly_unique_guild (guild_id, bucket_start_ms, key_type)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.botErrorAlerts} (
        alert_key VARCHAR(191) NOT NULL PRIMARY KEY,
        provider_id VARCHAR(64) NOT NULL DEFAULT '',
        alert_kind VARCHAR(64) NOT NULL,
        incident_id VARCHAR(64) NULL,
        active TINYINT(1) NOT NULL DEFAULT 0,
        detected_at_ms BIGINT NULL,
        last_seen_at_ms BIGINT NULL,
        resolved_at_ms BIGINT NULL,
        dominant_error_type VARCHAR(96) NULL,
        last_sent_at_ms BIGINT NOT NULL,
        last_current_rate DOUBLE NOT NULL DEFAULT 0,
        last_baseline_rate DOUBLE NOT NULL DEFAULT 0,
        last_current_errors BIGINT UNSIGNED NOT NULL DEFAULT 0,
        last_current_attempts BIGINT UNSIGNED NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_error_alerts_sent (last_sent_at_ms),
        INDEX idx_error_alerts_provider (provider_id),
        INDEX idx_error_alerts_active (active, updated_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.guildSettingsWebuiNoticeState} (
        guild_id VARCHAR(32) NOT NULL PRIMARY KEY,
        sent_at_ms BIGINT NOT NULL,
        command_user_id VARCHAR(32) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_settings_webui_notice_guild
            FOREIGN KEY (guild_id) REFERENCES ${TABLES.guilds}(guild_id)
            ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
];

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

const GUILD_PROVIDER_SETTING_COLUMN_DEFINITIONS = {
    enabled: 'TINYINT(1) NULL',
    default_language: 'VARCHAR(16) NULL',
    edit_original_if_translate: 'TINYINT(1) NULL',
    extract_bot_message: 'TINYINT(1) NULL',
    legacy_mode: 'TINYINT(1) NULL',
    passive_mode: 'TINYINT(1) NULL',
    anonymous_expand: 'TINYINT(1) NULL',
    secondary_extract_mode: 'TINYINT(1) NULL',
    secondary_extract_mode_multiple_images: 'TINYINT(1) NULL',
    secondary_extract_mode_video: 'TINYINT(1) NULL',
    send_media_as_attachments_as_default: 'TINYINT(1) NULL',
    delete_if_only_posted_tweet_link: 'TINYINT(1) NULL',
    delete_if_only_posted_tweet_link_secondary_extract_mode: 'TINYINT(1) NULL',
    suppress_source_embeds_secondary_extract_mode: 'TINYINT(1) NULL',
    always_reply_if_posted_tweet_link: 'TINYINT(1) NULL',
    quote_repost_max_depth: 'INT NULL',
    quote_repost_do_not_extract: 'TINYINT(1) NULL',
    quote_repost_depth_by_account: 'TEXT NULL',
    non_nsfw_channel_sensitive_restriction_enabled: 'TINYINT(1) NULL',
    pixiv_images_per_step: 'INT NULL',
    youtube_description_max_length: 'INT NULL',
    youtube_video_list_limit: 'INT NULL',
    tiktok_hq: 'TINYINT(1) NULL',
    twitter_text_mode: 'VARCHAR(32) NULL',
    twitter_stats_layout: 'VARCHAR(32) NULL',
    twitter_quote_mode: 'VARCHAR(32) NULL',
    twitter_quote_layout: 'VARCHAR(32) NULL',
    pixiv_caption_max_length: 'INT NULL',
    pixiv_tag_limit: 'VARCHAR(32) NULL',
    pixiv_r18_display_mode: 'VARCHAR(32) NULL',
    pixiv_r18g_display_mode: 'VARCHAR(32) NULL',
    pixiv_r18_non_nsfw_channel_sensitive_restriction_enabled: 'TINYINT(1) NULL',
    pixiv_r18g_non_nsfw_channel_sensitive_restriction_enabled: 'TINYINT(1) NULL',
    instagram_caption_max_length: 'INT NULL',
    instagram_media_limit: 'INT NULL',
    github_card_style: 'VARCHAR(32) NULL',
    hidden_output_items: 'TEXT NULL',
    display_density: 'VARCHAR(32) NULL',
    media_display_mode: 'VARCHAR(32) NULL',
    failure_display_policy: 'VARCHAR(32) NULL',
    tiktok_description_max_length: 'INT NULL',
    tiktok_image_limit: 'INT NULL',
    tiktok_video_fallback_mode: 'VARCHAR(32) NULL',
    niconico_description_max_length: 'INT NULL',
    spotify_description_max_length: 'INT NULL',
    twitch_description_max_length: 'INT NULL',
    steam_description_max_length: 'INT NULL',
    steam_image_source: 'VARCHAR(32) NULL',
    amazon_description_max_length: 'INT NULL',
    amazon_extract_targets: 'TEXT NULL',
    booth_description_max_length: 'INT NULL',
    booth_image_limit: 'INT NULL',
    booth_adult_display_mode: 'VARCHAR(32) NULL',
    updated_at: 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
};

let schemaReady = null;

function splitSqlStatements(sql) {
    return String(sql || '')
        .split(/;\s*(?:\r?\n|$)/)
        .map(statement => statement
            .split(/\r?\n/)
            .filter(line => !line.trim().startsWith('--'))
            .join('\n')
            .trim())
        .filter(Boolean);
}

async function appliedMigrationIds(queryDatabase) {
    const rows = await queryDatabase(`SELECT migration_id FROM ${TABLES.schemaMigrations}`);
    return new Set(rows.map(row => row.migration_id));
}

function listMigrationFiles() {
    if (!fs.existsSync(MIGRATIONS_DIR)) return [];
    return fs.readdirSync(MIGRATIONS_DIR)
        .filter(file => file.endsWith('.sql'))
        .sort();
}

function parseAddColumnStatement(statement) {
    const match = String(statement || '').match(/^ALTER\s+TABLE\s+`?([A-Za-z0-9_]+)`?\s+ADD\s+COLUMN\s+`?([A-Za-z0-9_]+)`?\b/i);
    if (!match) return null;
    return { table: match[1], column: match[2] };
}

function parseDropColumnStatement(statement) {
    const match = String(statement || '').match(/^ALTER\s+TABLE\s+`?([A-Za-z0-9_]+)`?\s+DROP\s+COLUMN\s+`?([A-Za-z0-9_]+)`?\b/i);
    if (!match) return null;
    return { table: match[1], column: match[2] };
}

function parseAddIndexStatement(statement) {
    const match = String(statement || '').match(/^ALTER\s+TABLE\s+`?([A-Za-z0-9_]+)`?\s+ADD\s+(?:INDEX|KEY)\s+`?([A-Za-z0-9_]+)`?\b/i);
    if (!match) return null;
    return { table: match[1], index: match[2] };
}

async function shouldSkipMigrationStatement(queryDatabase, statement) {
    const addColumn = parseAddColumnStatement(statement);
    if (addColumn) {
        const rows = await queryDatabase(`SHOW COLUMNS FROM ${addColumn.table} LIKE ?`, [addColumn.column]);
        return rows.length > 0;
    }
    const dropColumn = parseDropColumnStatement(statement);
    if (dropColumn) {
        const rows = await queryDatabase(`SHOW COLUMNS FROM ${dropColumn.table} LIKE ?`, [dropColumn.column]);
        return rows.length === 0;
    }
    const addIndex = parseAddIndexStatement(statement);
    if (addIndex) {
        const rows = await queryDatabase(`SHOW INDEX FROM ${addIndex.table} WHERE Key_name = ?`, [addIndex.index]);
        return rows.length > 0;
    }
    return false;
}

async function applyMigrationFile(queryDatabase, file) {
    const migrationId = path.basename(file, '.sql');
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const statements = splitSqlStatements(sql);

    for (const statement of statements) {
        if (await shouldSkipMigrationStatement(queryDatabase, statement)) continue;
        try {
            await queryDatabase(statement);
        } catch (err) {
            if (!['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME'].includes(err?.code)) throw err;
        }
    }

    await queryDatabase(
        `INSERT INTO ${TABLES.schemaMigrations} (migration_id)
         VALUES (?)
         ON DUPLICATE KEY UPDATE migration_id = migration_id`,
        [migrationId]
    );
}

async function applySchemaMigrations(queryDatabase) {
    const applied = await appliedMigrationIds(queryDatabase);
    for (const file of listMigrationFiles()) {
        const migrationId = path.basename(file, '.sql');
        if (applied.has(migrationId)) continue;
        await applyMigrationFile(queryDatabase, file);
        applied.add(migrationId);
    }
}

async function ensureGuildProviderSettingsColumns(queryDatabase) {
    for (const [column, definition] of Object.entries(GUILD_PROVIDER_SETTING_COLUMN_DEFINITIONS)) {
        const rows = await queryDatabase(`SHOW COLUMNS FROM ${TABLES.guildProviderSettings} LIKE ?`, [column]);
        if (rows.length > 0) continue;
        await queryDatabase(`ALTER TABLE ${TABLES.guildProviderSettings} ADD COLUMN ${column} ${definition}`);
    }
}

async function ensureDatabaseSchema() {
    if (schemaReady) return schemaReady;
    schemaReady = (async () => {
        const { queryDatabase } = require('./db');
        for (const statement of SCHEMA_STATEMENTS) {
            await queryDatabase(statement);
        }
        await ensureGuildProviderSettingsColumns(queryDatabase);
        await applySchemaMigrations(queryDatabase);
    })();
    try {
        await schemaReady;
    } catch (err) {
        schemaReady = null;
        throw err;
    }
}

module.exports = {
    TABLES,
    SCHEMA_STATEMENTS,
    MIGRATIONS_DIR,
    ensureDatabaseSchema,
    _internal: {
        listMigrationFiles,
        parseAddColumnStatement,
        parseDropColumnStatement,
        parseAddIndexStatement,
        shouldSkipMigrationStatement,
        splitSqlStatements,
        ensureGuildProviderSettingsColumns,
    },
};

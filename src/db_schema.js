'use strict';

const TABLES = {
    users: 'users',
    autoExtractTargets: 'auto_extract_targets',
    guildProviderSettings: 'guild_provider_settings',
    globalSettings: 'global_settings',
    deregisterReasons: 'deregister_reasons',
    deregisterNotifications: 'deregister_notifications',
};

const SCHEMA_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS ${TABLES.users} (
        user_id VARCHAR(32) NOT NULL PRIMARY KEY,
        registered_at_ms BIGINT NOT NULL,
        additional_auto_extract_slots INT NOT NULL DEFAULT 0,
        save_tweet_quota_override_bytes BIGINT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.autoExtractTargets} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        twitter_username VARCHAR(191) NOT NULL,
        webhook_url TEXT NOT NULL,
        premium_slot TINYINT(1) NOT NULL DEFAULT 0,
        last_extracted_at_ms BIGINT NOT NULL DEFAULT 0,
        created_at_ms BIGINT NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_auto_extract_user (user_id),
        INDEX idx_auto_extract_premium (premium_slot),
        CONSTRAINT fk_auto_extract_user
            FOREIGN KEY (user_id) REFERENCES ${TABLES.users}(user_id)
            ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.guildProviderSettings} (
        provider_id VARCHAR(64) NOT NULL,
        guild_id VARCHAR(32) NOT NULL,
        setting_key VARCHAR(128) NOT NULL,
        setting_value LONGTEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (provider_id, guild_id, setting_key),
        INDEX idx_guild_provider_settings_guild (guild_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${TABLES.globalSettings} (
        setting_key VARCHAR(128) NOT NULL PRIMARY KEY,
        setting_value LONGTEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
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
        reason_id BIGINT UNSIGNED NULL,
        reason TEXT NULL,
        hint TEXT NULL,
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
            ON DELETE SET NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
];

let schemaReady = null;

async function ensureDatabaseSchema() {
    if (schemaReady) return schemaReady;
    schemaReady = (async () => {
        const { queryDatabase } = require('./db');
        for (const statement of SCHEMA_STATEMENTS) {
            await queryDatabase(statement);
        }
    })();
    try {
        await schemaReady;
    } catch (err) {
        schemaReady = null;
        throw err;
    }
}

module.exports = { TABLES, SCHEMA_STATEMENTS, ensureDatabaseSchema };

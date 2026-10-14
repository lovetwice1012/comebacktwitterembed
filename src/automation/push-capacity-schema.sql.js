'use strict';

// Configuration only. No subscriptions, reservations or personal-slot debits
// are created by these additive tables while the real Push PoC remains gated.
const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS automation_push_pool_policy (
        id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
        free_pool_limit INT UNSIGNED NOT NULL DEFAULT 50,
        supporter_pool_limit INT UNSIGNED NOT NULL DEFAULT 100,
        actor_user_id VARCHAR(32) NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        CHECK (id=1), CHECK (free_pool_limit<=100000), CHECK (supporter_pool_limit<=100000)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS automation_push_plan_policy (
        plan_id VARCHAR(64) NOT NULL PRIMARY KEY,
        eligible TINYINT(1) NOT NULL DEFAULT 0,
        special_slot_limit INT UNSIGNED NOT NULL DEFAULT 0,
        realtime_enabled TINYINT(1) NOT NULL DEFAULT 0,
        actor_user_id VARCHAR(32) NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        CONSTRAINT fk_automation_push_plan_policy FOREIGN KEY (plan_id) REFERENCES automation_notification_plans(plan_id),
        CHECK (eligible IN (0,1)), CHECK (realtime_enabled IN (0,1)), CHECK (special_slot_limit<=100000)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
];
module.exports = { SCHEMA };

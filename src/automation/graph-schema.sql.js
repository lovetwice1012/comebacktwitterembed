'use strict';

// Additive execution-v2 storage. The executor remains disconnected from
// production ingress until its complete graph/queue acceptance gate passes.
const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS automation_flow_locks (
        namespace_key CHAR(64) NOT NULL PRIMARY KEY
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS automation_flow_runs (
        run_id CHAR(36) COLLATE utf8mb4_unicode_ci NOT NULL PRIMARY KEY,
        namespace_key CHAR(64) NOT NULL,
        context_json MEDIUMTEXT NOT NULL,
        needs_sync TINYINT(1) NOT NULL DEFAULT 1,
        revoked_at_ms BIGINT NULL,
        revocation_code VARCHAR(96) NULL,
        INDEX idx_flow_run_namespace (namespace_key),
        INDEX idx_flow_run_sync (needs_sync,namespace_key,run_id),
        CONSTRAINT fk_flow_run_origin FOREIGN KEY (run_id) REFERENCES automation_runs(id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS automation_flow_units (
        id CHAR(36) NOT NULL PRIMARY KEY,
        namespace_key CHAR(64) NOT NULL,
        kind VARCHAR(16) NOT NULL,
        payload_json MEDIUMTEXT NOT NULL,
        checksum CHAR(64) NOT NULL,
        created_at_ms BIGINT NOT NULL,
        INDEX idx_flow_unit_namespace (namespace_key)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS automation_flow_members (
        unit_id CHAR(36) NOT NULL,
        member_id VARCHAR(64) NOT NULL,
        run_id CHAR(36) COLLATE utf8mb4_unicode_ci NOT NULL,
        ordinal INT UNSIGNED NOT NULL,
        PRIMARY KEY (unit_id,member_id),
        INDEX idx_flow_member_run (run_id,unit_id),
        CONSTRAINT fk_flow_member_unit FOREIGN KEY (unit_id) REFERENCES automation_flow_units(id),
        CONSTRAINT fk_flow_member_origin FOREIGN KEY (run_id) REFERENCES automation_flow_runs(run_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS automation_flow_steps (
        id CHAR(36) NOT NULL PRIMARY KEY,
        activation_key CHAR(64) NOT NULL UNIQUE,
        namespace_key CHAR(64) NOT NULL,
        node_id VARCHAR(64) NOT NULL,
        input_unit_id CHAR(36) NOT NULL,
        continuation_unit_id CHAR(36) NULL,
        via_edge_id VARCHAR(64) NULL,
        state VARCHAR(24) NOT NULL DEFAULT 'pending',
        wake_at_ms BIGINT NOT NULL,
        lease_token CHAR(36) NULL,
        lease_until_ms BIGINT NOT NULL DEFAULT 0,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        evaluation_at_ms BIGINT NULL,
        decision_json MEDIUMTEXT NULL,
        created_at_ms BIGINT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        INDEX idx_flow_step_due (state,wake_at_ms,lease_until_ms),
        CONSTRAINT fk_flow_step_input FOREIGN KEY (input_unit_id) REFERENCES automation_flow_units(id),
        CONSTRAINT fk_flow_step_continuation FOREIGN KEY (continuation_unit_id) REFERENCES automation_flow_units(id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS automation_flow_edges (
        receipt_key CHAR(64) NOT NULL PRIMARY KEY,
        namespace_key CHAR(64) NOT NULL,
        run_id CHAR(36) COLLATE utf8mb4_unicode_ci NOT NULL,
        edge_id VARCHAR(64) NOT NULL,
        activation_id CHAR(36) NOT NULL,
        receipt_kind VARCHAR(16) NOT NULL,
        unit_id CHAR(36) NULL,
        created_at_ms BIGINT NOT NULL,
        INDEX idx_flow_edge_lineage (run_id,edge_id,receipt_kind),
        CONSTRAINT fk_flow_edge_origin FOREIGN KEY (run_id) REFERENCES automation_flow_runs(run_id),
        CONSTRAINT fk_flow_edge_step FOREIGN KEY (activation_id) REFERENCES automation_flow_steps(id),
        CONSTRAINT fk_flow_edge_unit FOREIGN KEY (unit_id) REFERENCES automation_flow_units(id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS automation_flow_batches (
        id CHAR(36) NOT NULL PRIMARY KEY,
        namespace_key CHAR(64) NOT NULL,
        group_key CHAR(64) NOT NULL,
        segment INT UNSIGNED NOT NULL,
        node_id VARCHAR(64) NOT NULL,
        key_json TEXT NOT NULL,
        window_start_ms BIGINT NOT NULL,
        closes_at_ms BIGINT NOT NULL,
        max_items INT UNSIGNED NOT NULL,
        mode VARCHAR(16) NOT NULL,
        received_count INT UNSIGNED NOT NULL DEFAULT 0,
        outcome_json MEDIUMTEXT NULL,
        state VARCHAR(16) NOT NULL DEFAULT 'open',
        output_unit_id CHAR(36) NULL,
        created_at_ms BIGINT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        UNIQUE KEY uq_flow_batch_segment (group_key,segment),
        INDEX idx_flow_batch_due (state,closes_at_ms),
        CONSTRAINT fk_flow_batch_output FOREIGN KEY (output_unit_id) REFERENCES automation_flow_units(id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS automation_flow_batch_inputs (
        admission_key CHAR(64) NOT NULL PRIMARY KEY,
        batch_id CHAR(36) NOT NULL,
        activation_id CHAR(36) NOT NULL,
        input_unit_id CHAR(36) NOT NULL,
        ordinal INT UNSIGNED NOT NULL,
        created_at_ms BIGINT NOT NULL,
        UNIQUE KEY uq_flow_batch_input_order (batch_id,ordinal),
        CONSTRAINT fk_flow_batch_input_batch FOREIGN KEY (batch_id) REFERENCES automation_flow_batches(id),
        CONSTRAINT fk_flow_batch_input_step FOREIGN KEY (activation_id) REFERENCES automation_flow_steps(id),
        CONSTRAINT fk_flow_batch_input_unit FOREIGN KEY (input_unit_id) REFERENCES automation_flow_units(id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS automation_flow_merge_decisions (
        namespace_key CHAR(64) NOT NULL,
        node_id VARCHAR(64) NOT NULL,
        run_id CHAR(36) COLLATE utf8mb4_unicode_ci NOT NULL,
        state VARCHAR(16) NOT NULL,
        anchor_unit_id CHAR(36) NULL,
        signature_key CHAR(64) NOT NULL,
        decision_json MEDIUMTEXT NOT NULL,
        output_unit_id CHAR(36) NULL,
        created_at_ms BIGINT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        PRIMARY KEY (namespace_key,node_id,run_id),
        INDEX idx_flow_merge_ready (namespace_key,node_id,state,anchor_unit_id),
        CONSTRAINT fk_flow_merge_origin FOREIGN KEY (run_id) REFERENCES automation_flow_runs(run_id),
        CONSTRAINT fk_flow_merge_anchor FOREIGN KEY (anchor_unit_id) REFERENCES automation_flow_units(id),
        CONSTRAINT fk_flow_merge_output FOREIGN KEY (output_unit_id) REFERENCES automation_flow_units(id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS automation_flow_sends (
        id CHAR(36) NOT NULL PRIMARY KEY,
        activation_id CHAR(36) NOT NULL UNIQUE,
        namespace_key CHAR(64) NOT NULL,
        unit_id CHAR(36) NOT NULL,
        destination_alias VARCHAR(64) NOT NULL,
        state VARCHAR(24) NOT NULL DEFAULT 'unprojected',
        created_at_ms BIGINT NOT NULL,
        INDEX idx_flow_send_state (state,created_at_ms),
        CONSTRAINT fk_flow_send_step FOREIGN KEY (activation_id) REFERENCES automation_flow_steps(id),
        CONSTRAINT fk_flow_send_unit FOREIGN KEY (unit_id) REFERENCES automation_flow_units(id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
];
module.exports = { SCHEMA };

ALTER TABLE bot_provider_content_facets
    ADD COLUMN metric_stage VARCHAR(32) NOT NULL DEFAULT 'initial' AFTER json_value;

ALTER TABLE bot_provider_content_facets
    ADD COLUMN metric_source VARCHAR(96) NULL AFTER metric_stage;

ALTER TABLE bot_provider_content_facets
    ADD COLUMN collected_at_ms BIGINT NULL AFTER metric_source;

ALTER TABLE bot_provider_content_facets
    ADD COLUMN schema_version VARCHAR(64) NULL AFTER collected_at_ms;

ALTER TABLE bot_provider_content_facets
    ADD COLUMN collection_success TINYINT(1) NULL AFTER schema_version;

ALTER TABLE bot_provider_content_facets
    ADD COLUMN collection_timeout_ms INT UNSIGNED NULL AFTER collection_success;

ALTER TABLE bot_provider_content_facets
    ADD INDEX idx_content_facets_stage_schema_time (metric_stage, schema_version, occurred_at_ms);

ALTER TABLE bot_provider_content_facets
    ADD INDEX idx_content_facets_source_time (metric_source, occurred_at_ms);

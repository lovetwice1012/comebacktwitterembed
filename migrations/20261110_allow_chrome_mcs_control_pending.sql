-- Provider control notices have no encrypted inbox payload. Their replay IDs
-- use the same durable pending table and are linked to an audit entry instead.
ALTER TABLE automation_x_mcs_pending MODIFY COLUMN inbox_id BIGINT UNSIGNED NULL;

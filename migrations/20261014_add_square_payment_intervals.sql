-- Keep every legacy binding and durable creation request. Each key replacement
-- is a single ALTER, so replay also works when startup created the new schema.
ALTER TABLE automation_square_bindings DROP PRIMARY KEY, ADD PRIMARY KEY (plan_id,environment,merchant_id,cadence);

ALTER TABLE automation_square_catalog_creations ADD COLUMN cadence VARCHAR(32) NOT NULL DEFAULT '';

UPDATE automation_square_catalog_creations SET cadence=JSON_UNQUOTE(JSON_EXTRACT(terms_json,'$.cadence')) WHERE cadence='';

ALTER TABLE automation_square_catalog_creations MODIFY COLUMN cadence VARCHAR(32) NOT NULL;

ALTER TABLE automation_square_catalog_creations DROP INDEX unique_square_catalog_plan, ADD UNIQUE KEY unique_square_catalog_plan (environment,merchant_id,plan_id,cadence);

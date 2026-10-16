-- Preserve the exact licensed source of each immutable workflow edition.
ALTER TABLE automation_revisions ADD COLUMN source_package_id CHAR(36) NULL;
ALTER TABLE automation_revisions ADD COLUMN source_package_version INT UNSIGNED NULL;

-- An install record proves package identity, but an old draft may have been
-- edited or restored from history. Its exact edition needs explicit review.
UPDATE automation_revisions r
JOIN automation_package_installs i ON i.workflow_id=r.workflow_id
SET r.source_package_id=i.package_id,r.source_package_version=NULL
WHERE r.source_package_id IS NULL;

-- Immutable dictionary revisions retain the verified package edition they came from.
-- Existing records remain NULL when their historical origin is not known.
ALTER TABLE automation_dictionary_revisions ADD COLUMN source_package_id CHAR(36) NULL;
ALTER TABLE automation_dictionary_revisions ADD COLUMN source_package_version INT UNSIGNED NULL;
ALTER TABLE automation_dictionary_revisions ADD COLUMN origin_reviewed TINYINT(1) NULL;

-- The current dictionary-install map is an exact, server-written association.
UPDATE automation_dictionary_revisions r
JOIN automation_package_dictionary_installs i
  ON JSON_SEARCH(i.dictionary_bindings_json,'one',r.dictionary_id,NULL,'$.*.id') IS NOT NULL
SET r.source_package_id=i.package_id,r.origin_reviewed=1,r.source_package_version=CASE
    WHEN CAST(JSON_UNQUOTE(JSON_EXTRACT(i.dictionary_bindings_json,
         REPLACE(JSON_UNQUOTE(JSON_SEARCH(i.dictionary_bindings_json,'one',r.dictionary_id,NULL,'$.*.id')),'.id','.revision'))) AS UNSIGNED)=r.revision
    THEN i.version ELSE NULL END
WHERE r.source_package_id IS NULL;

-- Official workflow installation creates its first immutable bindings together
-- with its package record. That proves package identity even if a later update
-- replaced the original package-version number. Keep that unknown version NULL.
UPDATE automation_dictionary_revisions r
JOIN automation_revisions w ON w.revision=1
JOIN automation_package_installs i ON i.workflow_id=w.workflow_id
  AND JSON_SEARCH(w.bindings_json,'one',r.dictionary_id,NULL,'$.dictionaries.*.id') IS NOT NULL
SET r.source_package_id=i.package_id,r.source_package_version=NULL,r.origin_reviewed=1
WHERE r.source_package_id IS NULL;

-- Keep exact package dependencies on each immutable dictionary revision.
-- NULL preserves legacy nearest-source behavior without inferring lineage.
ALTER TABLE automation_dictionary_revisions ADD COLUMN package_dependencies_json TEXT NULL;

-- Keep server-verified dependency metadata outside the unchanged portable bundle.
ALTER TABLE automation_package_versions ADD COLUMN package_dependencies_json MEDIUMTEXT NULL;

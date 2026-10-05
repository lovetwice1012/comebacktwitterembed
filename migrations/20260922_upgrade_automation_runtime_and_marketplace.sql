-- Additive upgrade for locally applied early automation schemas.
-- The migration runner skips ADD COLUMN/INDEX statements already satisfied.
ALTER TABLE automation_runs MODIFY COLUMN workflow_id CHAR(36) NULL;
ALTER TABLE automation_runs MODIFY COLUMN revision INT UNSIGNED NULL;
ALTER TABLE automation_runs ADD COLUMN owner_user_id VARCHAR(32) NULL;
ALTER TABLE automation_runs ADD COLUMN guild_id VARCHAR(32) NULL;
ALTER TABLE automation_runs ADD COLUMN scope VARCHAR(16) NOT NULL DEFAULT 'private';
UPDATE automation_runs r
LEFT JOIN automation_workflows w ON w.id=r.workflow_id
LEFT JOIN auto_watch_targets a ON r.target_kind='auto' AND a.id=r.target_id
LEFT JOIN price_watch_targets p ON r.target_kind='price' AND p.id=r.target_id
SET r.owner_user_id=COALESCE(a.user_id,p.user_id,w.owner_user_id,'0'),
    r.guild_id=COALESCE(a.guild_id,p.guild_id,w.guild_id),
    r.scope=CASE WHEN a.destination_type='dm' OR p.destination_type='dm' THEN 'private' ELSE COALESCE(w.scope,'private') END
WHERE r.owner_user_id IS NULL;
ALTER TABLE automation_runs MODIFY COLUMN owner_user_id VARCHAR(32) NOT NULL;
ALTER TABLE automation_jobs ADD COLUMN group_key CHAR(64) NULL;
ALTER TABLE automation_jobs ADD COLUMN parent_job_id CHAR(36) NULL;
ALTER TABLE automation_jobs ADD INDEX idx_automation_job_group (group_key,state,due_at_ms);
ALTER TABLE automation_jobs ADD INDEX idx_automation_job_parent (parent_job_id);

ALTER TABLE automation_packages ADD COLUMN published_version INT UNSIGNED NULL;
ALTER TABLE automation_package_versions ADD COLUMN title VARCHAR(120) NOT NULL DEFAULT '';
ALTER TABLE automation_package_versions ADD COLUMN description TEXT NULL;
ALTER TABLE automation_package_versions ADD COLUMN category VARCHAR(64) NOT NULL DEFAULT 'general';
ALTER TABLE automation_package_versions ADD COLUMN visibility VARCHAR(16) NOT NULL DEFAULT 'private';
ALTER TABLE automation_package_versions ADD COLUMN status VARCHAR(24) NOT NULL DEFAULT 'legacy_unreviewed';
ALTER TABLE automation_package_versions ADD COLUMN review_note TEXT NULL;
-- Earlier schemas did not retain per-version review/visibility evidence.
-- Only the old head can inherit its recorded approval; historical editions
-- remain owner-only rather than silently treating all of them as reviewed.
UPDATE automation_package_versions v JOIN automation_packages p ON p.id=v.package_id
SET v.title=p.title,v.description=p.description,v.category=p.category,
    v.visibility=IF(v.version=p.latest_version,p.visibility,'private'),
    v.status=CASE WHEN v.version=p.latest_version THEN
        CASE WHEN p.status='active' THEN 'active' WHEN p.status='pending' THEN 'pending' WHEN p.status='draft' THEN 'draft' ELSE 'legacy_unreviewed' END
        ELSE 'legacy_unreviewed' END,
    v.review_note=IF(v.version=p.latest_version,NULL,'旧スキーマには版別の公開審査記録がありません。所有者だけが参照できます。')
WHERE v.title='' AND v.status='legacy_unreviewed';
UPDATE automation_package_versions SET description='' WHERE description IS NULL;
ALTER TABLE automation_package_versions MODIFY COLUMN description TEXT NOT NULL;
UPDATE automation_packages p JOIN automation_package_versions v ON v.package_id=p.id AND v.version=p.latest_version
SET p.published_version=p.latest_version WHERE p.published_version IS NULL AND p.status='active' AND v.status='active';

CREATE TABLE IF NOT EXISTS automation_package_dictionary_installs (
        id CHAR(36) NOT NULL PRIMARY KEY,
        package_id CHAR(36) NOT NULL,
        version INT UNSIGNED NOT NULL,
        dictionary_bindings_json MEDIUMTEXT NOT NULL,
        owner_user_id VARCHAR(32) NOT NULL,
        guild_id VARCHAR(32) NULL,
        scope VARCHAR(16) NOT NULL,
        created_at_ms BIGINT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        INDEX idx_automation_dictionary_install_owner (owner_user_id, scope),
        INDEX idx_automation_dictionary_install_guild (guild_id, scope)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS automation_author_follows (
        follower_user_id VARCHAR(32) NOT NULL,
        author_user_id VARCHAR(32) NOT NULL,
        created_at_ms BIGINT NOT NULL,
        PRIMARY KEY (follower_user_id,author_user_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS automation_moderation_policy (
        id TINYINT NOT NULL PRIMARY KEY,
        dictionary_id CHAR(36) NULL,
        dictionary_revision INT UNSIGNED NULL,
        use_starter TINYINT(1) NOT NULL DEFAULT 1,
        revision INT UNSIGNED NOT NULL DEFAULT 1,
        updated_at_ms BIGINT NOT NULL,
        actor_user_id VARCHAR(32) NOT NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

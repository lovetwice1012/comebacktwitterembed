-- Additive defaults preserve existing channel registrations and their slots.
ALTER TABLE auto_watch_targets ADD COLUMN youtube_include_releases TINYINT(1) NOT NULL DEFAULT 1;
ALTER TABLE auto_watch_targets ADD COLUMN youtube_include_community TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE auto_watch_targets ADD COLUMN youtube_releases_since_ms BIGINT NULL;
ALTER TABLE auto_watch_targets ADD COLUMN youtube_community_since_ms BIGINT NULL;
ALTER TABLE auto_watch_targets ADD COLUMN youtube_releases_baseline_at_ms BIGINT NULL;
ALTER TABLE auto_watch_targets ADD COLUMN youtube_community_baseline_at_ms BIGINT NULL;

#!/usr/bin/env python3
"""Build the local request-root index used by the fast admin read paths."""
import argparse
import datetime as dt
from pathlib import Path
import sqlite3


SCHEMA = """
CREATE TABLE IF NOT EXISTS request_roots (
  run_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, occurred_at TEXT NOT NULL,
  guild_id TEXT NOT NULL, payload TEXT NOT NULL, event_count INTEGER NOT NULL DEFAULT 1,
  completed_seq INTEGER, completed_at TEXT, completed_payload TEXT, shard_id TEXT NOT NULL DEFAULT '',
  trigger_type TEXT NOT NULL DEFAULT '', provider_id TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '', content_value TEXT NOT NULL DEFAULT '', duration_ms REAL, outcome TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS request_roots_time ON request_roots(occurred_at,seq);
CREATE INDEX IF NOT EXISTS request_roots_guild_time ON request_roots(guild_id,occurred_at,seq);
CREATE INDEX IF NOT EXISTS request_roots_completed_time ON request_roots(completed_at,seq);
CREATE TABLE IF NOT EXISTS request_roots_meta (id INTEGER PRIMARY KEY CHECK(id=1),ready INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT '');
INSERT OR IGNORE INTO request_roots_meta(id,ready,updated_at) VALUES(1,0,'');
"""


def backfill(path: Path):
    if not path.is_absolute() or path == Path(path.anchor) or ".." in path.parts:
        raise ValueError("database path must be absolute and without traversal")
    if not path.is_file() or path.is_symlink():
        raise ValueError("database path must be a regular file")
    connection = sqlite3.connect(str(path), timeout=60, isolation_level=None)
    try:
        connection.execute("PRAGMA busy_timeout=60000")
        connection.executescript(SCHEMA)
        columns = {row[1] for row in connection.execute("PRAGMA table_info(request_roots)")}
        additions = {
            "trigger_type": "TEXT NOT NULL DEFAULT ''", "provider_id": "TEXT NOT NULL DEFAULT ''",
            "user_id": "TEXT NOT NULL DEFAULT ''", "message_id": "TEXT NOT NULL DEFAULT ''",
            "content_value": "TEXT NOT NULL DEFAULT ''", "duration_ms": "REAL", "outcome": "TEXT NOT NULL DEFAULT ''",
        }
        for name, definition in additions.items():
            if name not in columns:
                connection.execute(f"ALTER TABLE request_roots ADD COLUMN {name} {definition}")
        connection.execute("BEGIN IMMEDIATE")
        try:
            connection.execute("UPDATE request_roots_meta SET ready=0,updated_at=? WHERE id=1", (dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),))
            connection.execute("DELETE FROM request_roots")
            connection.execute("""
WITH first_seq AS (
  SELECT run_id, MIN(seq) AS seq FROM events WHERE kind='request.started' AND run_id<>'' GROUP BY run_id
), first_rows AS (
  SELECT e.run_id,e.seq,e.occurred_at,e.guild_id,e.payload,
         CAST(COALESCE(json_extract(e.payload,'$.shard_id'),json_extract(e.payload,'$.shardId'),'') AS TEXT) AS shard_id
  FROM events e JOIN first_seq f ON f.run_id=e.run_id AND f.seq=e.seq
), last_seq AS (
  SELECT run_id, MAX(seq) AS seq FROM events WHERE kind='request.completed' AND run_id<>'' GROUP BY run_id
), last_rows AS (
  SELECT e.run_id,e.seq,e.occurred_at,e.payload FROM events e JOIN last_seq l ON l.run_id=e.run_id AND l.seq=e.seq
), event_counts AS (
  SELECT run_id, COUNT(*) AS event_count FROM events WHERE run_id<>'' GROUP BY run_id
)
INSERT INTO request_roots(run_id,seq,occurred_at,guild_id,payload,event_count,completed_seq,completed_at,completed_payload,shard_id,trigger_type,provider_id,user_id,message_id,content_value,duration_ms,outcome)
SELECT f.run_id,f.seq,f.occurred_at,f.guild_id,f.payload,c.event_count,l.seq,l.occurred_at,l.payload,f.shard_id,
       CAST(COALESCE(json_extract(f.payload,'$.triggerType'),json_extract(f.payload,'$.trigger_type'),'') AS TEXT),
       CAST(COALESCE(json_extract(f.payload,'$.provider'),json_extract(f.payload,'$.providerId'),json_extract(f.payload,'$.provider_id'),'') AS TEXT),
       CAST(COALESCE(json_extract(f.payload,'$.userId'),json_extract(f.payload,'$.user_id'),'') AS TEXT),
       CAST(COALESCE(json_extract(f.payload,'$.messageId'),json_extract(f.payload,'$.message_id'),'') AS TEXT),
       CAST(COALESCE(json_extract(f.payload,'$.contentId'),json_extract(f.payload,'$.content_id'),json_extract(f.payload,'$.canonicalUrl'),json_extract(f.payload,'$.url'),'') AS TEXT),
       CAST(COALESCE(json_extract(l.payload,'$.durationMs'),json_extract(l.payload,'$.details.durationMs')) AS REAL),
       CAST(COALESCE(json_extract(l.payload,'$.outcome'),json_extract(l.payload,'$.resultCode'),json_extract(l.payload,'$.outcome_code'),json_extract(l.payload,'$.details.outcome'),'') AS TEXT)
FROM first_rows f JOIN event_counts c ON c.run_id=f.run_id LEFT JOIN last_rows l ON l.run_id=f.run_id
""")
            stamp = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
            connection.execute("UPDATE request_roots_meta SET ready=1,updated_at=? WHERE id=1", (stamp,))
            count = connection.execute("SELECT COUNT(*) FROM request_roots").fetchone()[0]
            connection.execute("COMMIT")
        except BaseException:
            connection.execute("ROLLBACK")
            raise
        return count
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    args = parser.parse_args()
    count = backfill(Path(args.db).resolve())
    print(f"backfilled_request_roots={count}")


if __name__ == "__main__":
    main()

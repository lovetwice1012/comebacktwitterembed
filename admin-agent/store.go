package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db     *sql.DB
	readDB *sql.DB
}
type Object = map[string]any

func encode(v any) string { b, _ := json.Marshal(v); return string(b) }
func decode(s string) any {
	var v any
	if json.Unmarshal([]byte(s), &v) != nil {
		return s
	}
	return v
}
func str(v any) string { s, _ := v.(string); return s }
func first(m Object, keys ...string) string {
	for _, k := range keys {
		if s := str(m[k]); s != "" {
			return s
		}
	}
	return ""
}
func nested(m Object, k string) Object {
	o, _ := m[k].(map[string]any)
	if o == nil {
		return Object{}
	}
	return o
}

func openStore(dir string) (*Store, error) {
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, e
	}
	db, e := sql.Open("sqlite", filepath.Join(dir, "state.db"))
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	_, e = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL,guild_id TEXT NOT NULL,kind TEXT NOT NULL,occurred_at TEXT NOT NULL,persisted_at TEXT NOT NULL,payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_guild_time ON events(guild_id,occurred_at,seq);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id,seq);
CREATE INDEX IF NOT EXISTS events_kind_time ON events(kind,occurred_at,seq);
CREATE TABLE IF NOT EXISTS request_roots (run_id TEXT PRIMARY KEY,seq INTEGER NOT NULL,occurred_at TEXT NOT NULL,guild_id TEXT NOT NULL,payload TEXT NOT NULL,event_count INTEGER NOT NULL DEFAULT 1,completed_seq INTEGER,completed_at TEXT,completed_payload TEXT,shard_id TEXT NOT NULL DEFAULT '',trigger_type TEXT NOT NULL DEFAULT '',provider_id TEXT NOT NULL DEFAULT '',user_id TEXT NOT NULL DEFAULT '',message_id TEXT NOT NULL DEFAULT '',content_value TEXT NOT NULL DEFAULT '',duration_ms REAL,outcome TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS request_roots_time ON request_roots(occurred_at,seq);
CREATE INDEX IF NOT EXISTS request_roots_guild_time ON request_roots(guild_id,occurred_at,seq);
CREATE INDEX IF NOT EXISTS request_roots_completed_time ON request_roots(completed_at,seq);
CREATE TABLE IF NOT EXISTS request_roots_meta (id INTEGER PRIMARY KEY CHECK(id=1),ready INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT '');
INSERT OR IGNORE INTO request_roots_meta(id,ready,updated_at) VALUES(1,0,'');
CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY,idem TEXT NOT NULL UNIQUE,type TEXT NOT NULL,input TEXT NOT NULL,status TEXT NOT NULL,actor TEXT NOT NULL,via TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,result TEXT,error TEXT);
CREATE INDEX IF NOT EXISTS actions_status_time ON actions(status,created_at);
CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL UNIQUE,title TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,evidence TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0,recovery_count INTEGER NOT NULL DEFAULT 0,recovery_start TEXT);
CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY,incident_id TEXT NOT NULL,revision INTEGER NOT NULL,channel TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at TEXT NOT NULL,response TEXT,last_error TEXT,created_at TEXT NOT NULL,UNIQUE(incident_id,revision,channel));
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status,next_at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS auth_attempts (address TEXT PRIMARY KEY,attempts INTEGER NOT NULL,last_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY,input TEXT NOT NULL,status TEXT NOT NULL,result TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reports (cache_key TEXT PRIMARY KEY,kind TEXT NOT NULL,filters TEXT NOT NULL,current_action_id TEXT,status TEXT NOT NULL,last_successful_action_id TEXT,generated_at TEXT,result TEXT,error TEXT,updated_at TEXT NOT NULL);
`)
	if e != nil {
		db.Close()
		return nil, e
	}
	if e = ensureRequestRootColumns(db); e != nil {
		db.Close()
		return nil, e
	}
	// Keep writes serialized on the durable connection, but let independent
	// read handlers use WAL snapshots concurrently. The admin overview asks
	// for metrics, shards and runs together; sharing one connection made each
	// heavy read wait behind the previous one until its 15s deadline.
	var readDB *sql.DB
	if runtime.GOOS == "linux" {
		readDB, e = sql.Open("sqlite", filepath.Join(dir, "state.db"))
		if e != nil {
			db.Close()
			return nil, e
		}
		readDB.SetMaxOpenConns(4)
		readDB.SetMaxIdleConns(4)
		if _, e = readDB.Exec("PRAGMA busy_timeout=5000"); e != nil {
			readDB.Close()
			db.Close()
			return nil, e
		}
	}
	s := &Store{db: db, readDB: readDB}
	var hasEvent int
	if e = db.QueryRow("SELECT 1 FROM events LIMIT 1").Scan(&hasEvent); errors.Is(e, sql.ErrNoRows) {
		_, e = db.Exec("UPDATE request_roots_meta SET ready=1,updated_at=? WHERE id=1", time.Now().UTC().Format(timestampLayout))
	}
	if e != nil && !errors.Is(e, sql.ErrNoRows) {
		if readDB != nil {
			readDB.Close()
		}
		db.Close()
		return nil, e
	}
	_, e = db.Exec("INSERT OR IGNORE INTO settings(key,value) VALUES('policy',?)", encode(defaultPolicy()))
	return s, e
}

func ensureRequestRootColumns(db *sql.DB) error {
	rows, err := db.Query("PRAGMA table_info(request_roots)")
	if err != nil {
		return err
	}
	columns := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, typ string
		var notNull, pk int
		var defaultValue any
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &pk); err != nil {
			rows.Close()
			return err
		}
		columns[name] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	additions := map[string]string{
		"trigger_type": "TEXT NOT NULL DEFAULT ''", "provider_id": "TEXT NOT NULL DEFAULT ''",
		"user_id": "TEXT NOT NULL DEFAULT ''", "message_id": "TEXT NOT NULL DEFAULT ''",
		"content_value": "TEXT NOT NULL DEFAULT ''", "duration_ms": "REAL", "outcome": "TEXT NOT NULL DEFAULT ''",
	}
	changed := false
	for name, definition := range additions {
		if columns[name] {
			continue
		}
		if _, err := db.Exec("ALTER TABLE request_roots ADD COLUMN " + name + " " + definition); err != nil {
			return err
		}
		changed = true
	}
	if changed {
		_, err = db.Exec("UPDATE request_roots_meta SET ready=0,updated_at='' WHERE id=1")
	}
	return err
}

func (s *Store) queryDB() *sql.DB {
	if s.readDB != nil {
		return s.readDB
	}
	return s.db
}

func (s *Store) requestRootsReady(ctx context.Context) bool {
	var ready int
	if e := s.queryDB().QueryRowContext(ctx, "SELECT ready FROM request_roots_meta WHERE id=1").Scan(&ready); e != nil {
		return false
	}
	return ready == 1
}

func (s *Store) Close() error {
	if s.readDB != nil {
		_ = s.readDB.Close()
	}
	return s.db.Close()
}

func (s *Store) getSetting(key string, dst any) error {
	var value string
	e := s.db.QueryRow("SELECT value FROM settings WHERE key=?", key).Scan(&value)
	if e != nil {
		return e
	}
	return json.Unmarshal([]byte(value), dst)
}
func (s *Store) setSetting(key string, v any) error {
	_, e := s.db.Exec("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, encode(v))
	return e
}
func (s *Store) recoverActions() error {
	_, e := s.db.Exec("UPDATE actions SET status='unknown',updated_at=?,error=? WHERE status='running'", now(), encode(Object{"code": "CORE_RESTART_DURING_EXECUTION", "message": "The previous process ended during execution. Side effects may have completed; this action will not be replayed."}))
	return e
}

func (s *Store) ingest(events []Object) (int64, int, error) {
	if len(events) == 0 || len(events) > 500 {
		return 0, 0, errors.New("events batch must contain 1..500 records")
	}
	tx, e := s.db.Begin()
	if e != nil {
		return 0, 0, e
	}
	defer tx.Rollback()
	accepted := 0
	var cursor int64
	for _, item := range events {
		id := first(item, "id", "eventId", "event_id")
		if id == "" {
			id = randomID()
			item["id"] = id
		}
		if len(id) > 200 {
			return 0, 0, errors.New("event ID too long")
		}
		run := first(item, "runId", "requestId", "operationId", "traceId", "run_id", "request_id", "operation_id", "trace_id")
		kind := first(item, "kind", "type", "eventType", "event_type")
		if kind == "" {
			kind = "observation"
		}
		guild := first(item, "guildId", "guild_id")
		if guild == "" {
			guild = first(nested(item, "context"), "guildId", "guild_id")
		}
		occurred := first(item, "occurredAt", "occurred_at", "timestamp")
		if t, e := time.Parse(time.RFC3339Nano, occurred); e == nil {
			occurred = t.UTC().Format(timestampLayout)
		} else {
			occurred = now()
			item["timestampInferred"] = true
		}
		payload := encode(item)
		if len(payload) > 8<<20 {
			return 0, 0, errors.New("event exceeds 8 MiB; producer must provide explicit truncation metadata")
		}
		res, e := tx.Exec("INSERT OR IGNORE INTO events(id,run_id,guild_id,kind,occurred_at,persisted_at,payload) VALUES(?,?,?,?,?,?,?)", id, run, guild, kind, occurred, now(), payload)
		if e != nil {
			return 0, 0, e
		}
		n, _ := res.RowsAffected()
		accepted += int(n)
		if n > 0 && run != "" {
			if e = updateRequestRoot(tx, run, kind, occurred, guild, payload, item, res); e != nil {
				return 0, 0, e
			}
		}
	}
	if e = tx.QueryRow("SELECT COALESCE(MAX(seq),0) FROM events").Scan(&cursor); e != nil {
		return 0, 0, e
	}
	if e = tx.Commit(); e != nil {
		return 0, 0, e
	}
	return cursor, accepted, nil
}

func updateRequestRoot(tx *sql.Tx, run, kind, occurred, guild, payload string, item Object, result sql.Result) error {
	seq, err := result.LastInsertId()
	if err != nil {
		return err
	}
	switch kind {
	case "request.started":
		shard := first(item, "shardId", "shard_id")
		if shard == "" {
			shard = first(nested(item, "context"), "shardId", "shard_id")
		}
		trigger := first(item, "triggerType", "trigger_type")
		provider := first(item, "provider", "providerId", "provider_id")
		user := first(item, "userId", "user_id")
		message := first(item, "messageId", "message_id")
		content := first(item, "contentId", "content_id", "canonicalUrl", "url")
		_, err = tx.Exec(`INSERT INTO request_roots(run_id,seq,occurred_at,guild_id,payload,event_count,shard_id,trigger_type,provider_id,user_id,message_id,content_value)
VALUES(?,?,?,?,?,1,?,?,?,?,?,?)
ON CONFLICT(run_id) DO UPDATE SET
  event_count=request_roots.event_count+1,
  seq=CASE WHEN excluded.seq<request_roots.seq THEN excluded.seq ELSE request_roots.seq END,
  occurred_at=CASE WHEN excluded.seq<request_roots.seq THEN excluded.occurred_at ELSE request_roots.occurred_at END,
  guild_id=CASE WHEN excluded.seq<request_roots.seq THEN excluded.guild_id ELSE request_roots.guild_id END,
  payload=CASE WHEN excluded.seq<request_roots.seq THEN excluded.payload ELSE request_roots.payload END,
  shard_id=CASE WHEN request_roots.shard_id='' THEN excluded.shard_id ELSE request_roots.shard_id END,
  trigger_type=CASE WHEN request_roots.trigger_type='' THEN excluded.trigger_type ELSE request_roots.trigger_type END,
  provider_id=CASE WHEN request_roots.provider_id='' THEN excluded.provider_id ELSE request_roots.provider_id END,
  user_id=CASE WHEN request_roots.user_id='' THEN excluded.user_id ELSE request_roots.user_id END,
  message_id=CASE WHEN request_roots.message_id='' THEN excluded.message_id ELSE request_roots.message_id END,
  content_value=CASE WHEN request_roots.content_value='' THEN excluded.content_value ELSE request_roots.content_value END`, run, seq, occurred, guild, payload, shard, trigger, provider, user, message, content)
	case "request.completed":
		completed, _ := decode(payload).(map[string]any)
		outcome := first(completed, "outcome", "resultCode", "outcome_code")
		if outcome == "" {
			outcome = first(nested(completed, "details"), "outcome", "resultCode")
		}
		var duration any
		if value, ok := completed["durationMs"].(float64); ok && value >= 0 {
			duration = value
		} else if value, ok := nested(completed, "details")["durationMs"].(float64); ok && value >= 0 {
			duration = value
		}
		_, err = tx.Exec(`UPDATE request_roots SET event_count=event_count+1,
  completed_seq=CASE WHEN completed_seq IS NULL OR ? > completed_seq THEN ? ELSE completed_seq END,
  completed_at=CASE WHEN completed_seq IS NULL OR ? > completed_seq THEN ? ELSE completed_at END,
  completed_payload=CASE WHEN completed_seq IS NULL OR ? > completed_seq THEN ? ELSE completed_payload END,
  outcome=CASE WHEN completed_seq IS NULL OR ? > completed_seq THEN ? ELSE outcome END,
  duration_ms=CASE WHEN completed_seq IS NULL OR ? > completed_seq THEN ? ELSE duration_ms END
WHERE run_id=?`, seq, seq, seq, occurred, seq, payload, seq, outcome, seq, duration, run)
	default:
		_, err = tx.Exec("UPDATE request_roots SET event_count=event_count+1 WHERE run_id=?", run)
	}
	return err
}

type Action struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Input     any    `json:"input"`
	Status    string `json:"status"`
	Actor     string `json:"actor"`
	Via       string `json:"initiatedVia"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	Result    any    `json:"result,omitempty"`
	Error     any    `json:"error,omitempty"`
}

func scanAction(row interface{ Scan(...any) error }) (Action, error) {
	var a Action
	var input string
	var result, err sql.NullString
	e := row.Scan(&a.ID, &a.Type, &input, &a.Status, &a.Actor, &a.Via, &a.CreatedAt, &a.UpdatedAt, &result, &err)
	a.Input = decode(input)
	if result.Valid {
		a.Result = decode(result.String)
	}
	if err.Valid {
		a.Error = decode(err.String)
	}
	return a, e
}

const actionColumns = "id,type,input,status,actor,via,created_at,updated_at,result,error"

func (s *Store) action(id string) (Action, error) {
	return scanAction(s.queryDB().QueryRow("SELECT "+actionColumns+" FROM actions WHERE id=?", id))
}
func (s *Store) enqueue(typ string, input Object, idem, actor, via string) (Action, bool, error) {
	if idem == "" || len(idem) > 200 {
		return Action{}, false, errors.New("idempotencyKey is required (max 200 characters)")
	}
	id := randomID()
	t := now()
	res, e := s.db.Exec("INSERT OR IGNORE INTO actions(id,idem,type,input,status,actor,via,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?,?,?)", id, idem, typ, encode(input), actor, via, t, t)
	if e != nil {
		return Action{}, false, e
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		a, e := scanAction(s.db.QueryRow("SELECT "+actionColumns+" FROM actions WHERE idem=?", idem))
		if e == nil && (a.Type != typ || encode(a.Input) != encode(input) || a.Actor != actor) {
			return Action{}, false, errors.New("idempotencyKey already belongs to different input or actor")
		}
		return a, false, e
	}
	a, e := s.action(id)
	return a, true, e
}
func (s *Store) finish(id, status string, result, err any) error {
	var r, e any
	if result != nil {
		r = encode(result)
	}
	if err != nil {
		e = encode(err)
	}
	_, x := s.db.Exec("UPDATE actions SET status=?,updated_at=?,result=?,error=? WHERE id=?", status, now(), r, e, id)
	return x
}

func dateFilter(from, to string) (string, string, error) {
	if to == "" {
		to = now()
	}
	if from == "" {
		from = time.Now().UTC().Add(-24 * time.Hour).Format(timestampLayout)
	}
	f, e := time.Parse(time.RFC3339Nano, from)
	if e != nil {
		return "", "", fmt.Errorf("invalid from timestamp")
	}
	t, e := time.Parse(time.RFC3339Nano, to)
	if e != nil || !t.After(f) {
		return "", "", fmt.Errorf("invalid to timestamp")
	}
	return f.UTC().Format(timestampLayout), t.UTC().Format(timestampLayout), nil
}
func validID(s string) bool {
	if len(s) < 1 || len(s) > 200 {
		return false
	}
	return !strings.ContainsAny(s, "/\\\x00")
}

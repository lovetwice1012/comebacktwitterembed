package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct{ db *sql.DB }
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
	s := &Store{db: db}
	_, e = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL,guild_id TEXT NOT NULL,kind TEXT NOT NULL,occurred_at TEXT NOT NULL,persisted_at TEXT NOT NULL,payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_guild_time ON events(guild_id,occurred_at,seq);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id,seq);
CREATE INDEX IF NOT EXISTS events_kind_time ON events(kind,occurred_at,seq);
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
	_, e = db.Exec("INSERT OR IGNORE INTO settings(key,value) VALUES('policy',?)", encode(defaultPolicy()))
	return s, e
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
	}
	if e = tx.QueryRow("SELECT COALESCE(MAX(seq),0) FROM events").Scan(&cursor); e != nil {
		return 0, 0, e
	}
	if e = tx.Commit(); e != nil {
		return 0, 0, e
	}
	return cursor, accepted, nil
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
	return scanAction(s.db.QueryRow("SELECT "+actionColumns+" FROM actions WHERE id=?", id))
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

package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

//go:embed web/*
var assets embed.FS

type App struct {
	cfg             Config
	store           *Store
	boot            string
	wake            chan struct{}
	stateMu         sync.Mutex
	lastSnapshot    Object
	lastMonitorSave time.Time
	hasMonitorSave  bool
	failures        map[string]int
}

func newApp(cfg Config, s *Store) *App {
	return &App{cfg: cfg, store: s, boot: randomID(), wake: make(chan struct{}, 1), failures: map[string]int{}, lastMonitorSave: time.Now()}
}
func jsonResponse(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, code, message string) {
	jsonResponse(w, status, Object{"ok": false, "error": Object{"code": code, "message": message}})
}
func body(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 24<<20)
	d := json.NewDecoder(r.Body)
	if e := d.Decode(v); e != nil {
		fail(w, 400, "INVALID_JSON", e.Error())
		return false
	}
	return true
}
func tokenHash(token string) string {
	x := sha256.Sum256([]byte(token))
	return hex.EncodeToString(x[:])
}
func (a *App) authenticate(r *http.Request) (string, string, bool) {
	token := r.Header.Get("X-Admin-Agent-Token")
	if token == "" {
		token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	}
	if len(a.cfg.Token) > 0 && subtle.ConstantTimeCompare([]byte(token), []byte(a.cfg.Token)) == 1 {
		actor := r.Header.Get("X-Admin-Actor")
		if actor != "" && actor != a.cfg.Owner {
			return "", "", false
		}
		return a.cfg.Owner, "dashboard", true
	}
	c, e := r.Cookie("cbte_admin_session")
	if e != nil {
		return "", "", false
	}
	var csrf, expires string
	if a.store.db.QueryRow("SELECT csrf,expires_at FROM sessions WHERE hash=?", tokenHash(c.Value)).Scan(&csrf, &expires) != nil || expires < now() {
		return "", "", false
	}
	if r.Method != "GET" && r.Method != "HEAD" && subtle.ConstantTimeCompare([]byte(csrf), []byte(r.Header.Get("X-CSRF-Token"))) != 1 {
		return "", "", false
	}
	return a.cfg.Owner, "standalone", true
}
func (a *App) protect(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, _, ok := a.authenticate(r); !ok {
			fail(w, 401, "UNAUTHORIZED", "Owner authentication is required")
			return
		}
		h(w, r)
	}
}
func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	a.passkeyRoutes(mux)
	mux.HandleFunc("POST /auth/login", a.login)
	mux.HandleFunc("GET /auth/session", a.session)
	mux.HandleFunc("POST /auth/logout", a.protect(a.logout))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		a.stateMu.Lock()
		age := time.Since(a.lastMonitorSave)
		a.stateMu.Unlock()
		if age > max(60*time.Second, 3*a.cfg.MonitorInterval) {
			fail(w, 503, "MONITOR_NOT_PROGRESSING", "Durable monitoring has not progressed")
			return
		}
		var one int
		if a.store.db.QueryRow("SELECT 1").Scan(&one) != nil {
			fail(w, 503, "STORE_UNAVAILABLE", "Management state cannot be read")
			return
		}
		jsonResponse(w, 200, Object{"ok": true, "version": version})
	})
	mux.HandleFunc("GET /v1/health", a.protect(a.health))
	mux.HandleFunc("GET /v1/catalog", a.protect(func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, 200, Object{"actions": catalog(), "version": 1})
	}))
	mux.HandleFunc("POST /v1/account/password", a.protect(a.changePassword))
	mux.HandleFunc("POST /v1/events", a.protect(a.ingest))
	mux.HandleFunc("GET /v1/events", a.protect(a.events))
	mux.HandleFunc("GET /v1/runs", a.protect(a.rootRuns))
	mux.HandleFunc("GET /v1/runs/{id}", a.protect(a.run))
	mux.HandleFunc("POST /v1/actions", a.protect(a.createAction))
	mux.HandleFunc("GET /v1/actions", a.protect(a.actions))
	mux.HandleFunc("GET /v1/actions/{id}", a.protect(a.action))
	mux.HandleFunc("GET /v1/metrics", a.protect(a.metrics))
	mux.HandleFunc("GET /v1/reports/{kind}", a.protect(a.getReport))
	mux.HandleFunc("POST /v1/reports/{kind}", a.protect(a.buildReport))
	mux.HandleFunc("GET /v1/incidents", a.protect(a.incidents))
	mux.HandleFunc("GET /v1/incidents/{id}", a.protect(a.incident))
	mux.HandleFunc("POST /v1/incidents/{id}/acknowledge", a.protect(a.acknowledge))
	mux.HandleFunc("GET /v1/policies", a.protect(a.getPolicy))
	mux.HandleFunc("PUT /v1/policies", a.protect(a.putPolicy))
	mux.HandleFunc("GET /v1/notifications", a.protect(a.notifications))
	sub, _ := fs.Sub(assets, "web")
	mux.Handle("/", http.FileServer(http.FS(sub)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; media-src https:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'")
		mux.ServeHTTP(w, r)
	})
}
func (a *App) cookiePath() string {
	if a.cfg.BasePath == "" {
		return "/"
	}
	return a.cfg.BasePath + "/"
}
func clientAddress(r *http.Request) string {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(host)
	// Only the local gateway may assert a single client address. It replaces,
	// rather than appends to, the public request's forwarded header.
	if ip != nil && ip.IsLoopback() {
		if forwarded := net.ParseIP(r.Header.Get("X-Forwarded-For")); forwarded != nil {
			return forwarded.String()
		}
	}
	return host
}
func (a *App) login(w http.ResponseWriter, r *http.Request) {
	passwordHash := a.cfg.PasswordHash
	_ = a.store.getSetting("password_hash", &passwordHash)

	if passwordHash == "" {
		fail(w, 503, "LOCAL_LOGIN_UNCONFIGURED", "Independent login password hash has not been configured")
		return
	}
	host := clientAddress(r)
	var attempts int
	var last string
	_ = a.store.db.QueryRow("SELECT attempts,last_at FROM auth_attempts WHERE address=?", host).Scan(&attempts, &last)
	if t, e := time.Parse(time.RFC3339Nano, last); e == nil && time.Since(t) < 15*time.Minute && attempts >= 10 {
		fail(w, 429, "LOGIN_RATE_LIMIT", "Wait 15 minutes before trying again")
		return
	}
	var input struct {
		Password string `json:"password"`
	}
	if !body(w, r, &input) {
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(input.Password)) != nil {
		if t, e := time.Parse(time.RFC3339Nano, last); e != nil || time.Since(t) > 15*time.Minute {
			attempts = 0
		}
		_, _ = a.store.db.Exec("INSERT INTO auth_attempts(address,attempts,last_at) VALUES(?,?,?) ON CONFLICT(address) DO UPDATE SET attempts=excluded.attempts,last_at=excluded.last_at", host, attempts+1, now())
		fail(w, 401, "INVALID_LOGIN", "Invalid credentials")
		return
	}
	_, _ = a.store.db.Exec("DELETE FROM auth_attempts WHERE address=?", host)
	token, csrf := randomID(), randomID()
	expiry := time.Now().UTC().Add(8 * time.Hour)
	if _, e := a.store.db.Exec("INSERT INTO sessions(hash,csrf,expires_at) VALUES(?,?,?)", tokenHash(token), csrf, expiry.Format(timestampLayout)); e != nil {
		fail(w, 503, "STORE_ERROR", e.Error())
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "cbte_admin_session", Value: token, Path: a.cookiePath(), HttpOnly: true, Secure: a.cfg.CookieSecure, SameSite: http.SameSiteStrictMode, Expires: expiry})
	jsonResponse(w, 200, Object{"ok": true, "csrf": csrf, "owner": a.cfg.Owner, "expiresAt": expiry.Format(timestampLayout)})
}
func (a *App) changePassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Password string `json:"password"`
	}
	if !body(w, r, &in) {
		return
	}
	if len(in.Password) < 14 || len(in.Password) > 72 {
		fail(w, 400, "PASSWORD_LENGTH", "Use a password of 14 to 72 bytes")
		return
	}
	h, e := bcrypt.GenerateFromPassword([]byte(in.Password), 12)
	if e != nil {
		fail(w, 500, "PASSWORD_HASH_FAILED", "Could not prepare password hash")
		return
	}
	tx, e := a.store.db.Begin()
	if e != nil {
		fail(w, 503, "STORE_ERROR", e.Error())
		return
	}
	defer tx.Rollback()
	if _, e = tx.Exec("INSERT INTO settings(key,value) VALUES('password_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", encode(string(h))); e == nil {
		_, e = tx.Exec("DELETE FROM sessions")
	}
	if e == nil {
		e = tx.Commit()
	}
	if e != nil {
		fail(w, 503, "STORE_ERROR", e.Error())
		return
	}
	jsonResponse(w, 200, Object{"ok": true, "sessionsRevoked": true})
}
func (a *App) session(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := a.authenticate(r); !ok {
		fail(w, 401, "UNAUTHORIZED", "Login required")
		return
	}
	var csrf string
	if c, e := r.Cookie("cbte_admin_session"); e == nil {
		_ = a.store.db.QueryRow("SELECT csrf FROM sessions WHERE hash=?", tokenHash(c.Value)).Scan(&csrf)
	}
	jsonResponse(w, 200, Object{"ok": true, "csrf": csrf, "owner": a.cfg.Owner})
}
func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	if c, e := r.Cookie("cbte_admin_session"); e == nil {
		_, _ = a.store.db.Exec("DELETE FROM sessions WHERE hash=?", tokenHash(c.Value))
	}
	http.SetCookie(w, &http.Cookie{Name: "cbte_admin_session", Value: "", Path: a.cookiePath(), HttpOnly: true, Secure: a.cfg.CookieSecure, MaxAge: -1})
	jsonResponse(w, 200, Object{"ok": true})
}
func (a *App) health(w http.ResponseWriter, r *http.Request) {
	var cursor int64
	var pending, unknown int
	e := a.store.db.QueryRow("SELECT COALESCE(MAX(seq),0) FROM events").Scan(&cursor)
	if e != nil {
		fail(w, 503, "STORE_ERROR", e.Error())
		return
	}
	if e = a.store.db.QueryRow("SELECT COUNT(*) FROM actions WHERE status IN ('queued','running')").Scan(&pending); e != nil {
		fail(w, 503, "STORE_ERROR", e.Error())
		return
	}
	if e = a.store.db.QueryRow("SELECT COUNT(*) FROM actions WHERE status='unknown'").Scan(&unknown); e != nil {
		fail(w, 503, "STORE_ERROR", e.Error())
		return
	}
	a.stateMu.Lock()
	snapshot := a.lastSnapshot
	lastMonitorSave, hasMonitorSave := a.lastMonitorSave, a.hasMonitorSave
	a.stateMu.Unlock()
	passwordHash := a.cfg.PasswordHash
	_ = a.store.getSetting("password_hash", &passwordHash)
	monitorState := "not_observed"
	var savedAt any
	if hasMonitorSave {
		savedAt = lastMonitorSave.UTC().Format(timestampLayout)
		monitorState = "progressing"
		if time.Since(lastMonitorSave) > max(60*time.Second, 3*a.cfg.MonitorInterval) {
			monitorState = "stalled"
		}
	}
	jsonResponse(w, 200, Object{"ok": true, "version": version, "bootId": a.boot, "time": now(), "cursor": cursor, "pendingActions": pending, "unknownActions": unknown, "monitor": Object{"state": monitorState, "lastPersistedAt": savedAt, "scope": "management_observation_loop_only"}, "snapshot": snapshot, "journalCollectors": a.journalHealth(), "capabilities": Object{"worker": a.cfg.Worker != "" || a.cfg.WorkerURL != "", "workerIsolation": map[bool]string{true: "independent-service", false: "local-child"}[a.cfg.WorkerURL != ""], "localLogin": passwordHash != "", "executor": a.cfg.ExecutorSocket != "", "discordNotifications": a.cfg.DiscordWebhook != "", "secondaryNotifications": a.cfg.PushWebhook != "", "llm": false, "messageViews": false, "linkClicks": false}})
}
func (a *App) ingest(w http.ResponseWriter, r *http.Request) {
	var raw json.RawMessage
	if !body(w, r, &raw) {
		return
	}
	var events []Object
	if len(raw) > 0 && raw[0] == '[' {
		if json.Unmarshal(raw, &events) != nil {
			fail(w, 400, "INVALID_EVENTS", "Expected event array")
			return
		}
	} else {
		var item Object
		if json.Unmarshal(raw, &item) != nil {
			fail(w, 400, "INVALID_EVENTS", "Expected event object")
			return
		}
		if batch, ok := item["events"].([]any); ok {
			for _, v := range batch {
				o, ok := v.(map[string]any)
				if !ok {
					fail(w, 400, "INVALID_EVENTS", "Each event must be an object")
					return
				}
				events = append(events, o)
			}
		} else {
			events = []Object{item}
		}
	}
	cursor, n, e := a.store.ingest(events)
	if e != nil {
		fail(w, 503, "INGEST_FAILED", e.Error())
		return
	}
	jsonResponse(w, 200, Object{"ok": true, "accepted": n, "cursor": cursor, "persistedAt": now()})
}
func pageLimit(r *http.Request) int {
	n, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if n <= 0 {
		n = 100
	}
	return min(n, 500)
}
func eventQuery(r *http.Request) (string, []any, error) {
	q := r.URL.Query()
	from, to, e := dateFilter(q.Get("from"), q.Get("to"))
	if e != nil {
		return "", nil, e
	}
	where := "occurred_at>=? AND occurred_at<?"
	args := []any{from, to}
	if guild := q.Get("guildId"); guild != "" {
		where += " AND guild_id=?"
		args = append(args, guild)
	}
	if kind := q.Get("kind"); kind != "" {
		where += " AND kind=?"
		args = append(args, kind)
	}
	if run := q.Get("runId"); run != "" {
		where += " AND run_id=?"
		args = append(args, run)
	}
	return where, args, nil
}
func (a *App) events(w http.ResponseWriter, r *http.Request) {
	where, args, e := eventQuery(r)
	if e != nil {
		fail(w, 400, "INVALID_FILTER", e.Error())
		return
	}
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		n, e := strconv.ParseInt(cursor, 10, 64)
		if e != nil {
			fail(w, 400, "INVALID_CURSOR", "cursor must be an integer")
			return
		}
		where += " AND seq<?"
		args = append(args, n)
	}
	limit := pageLimit(r)
	args = append(args, limit+1)
	rows, e := a.store.db.Query("SELECT seq,id,run_id,kind,occurred_at,persisted_at,payload FROM events WHERE "+where+" ORDER BY seq DESC LIMIT ?", args...)
	if e != nil {
		fail(w, 503, "QUERY_FAILED", e.Error())
		return
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		var seq int64
		var id, run, kind, occurred, persisted, payload string
		if e := rows.Scan(&seq, &id, &run, &kind, &occurred, &persisted, &payload); e != nil {
			fail(w, 503, "QUERY_FAILED", e.Error())
			return
		}
		items = append(items, Object{"seq": seq, "id": id, "runId": run, "kind": kind, "occurredAt": occurred, "persistedAt": persisted, "payload": decode(payload)})
	}
	if e := rows.Err(); e != nil {
		fail(w, 503, "QUERY_FAILED", e.Error())
		return
	}
	var next any
	if len(items) > limit {
		items = items[:limit]
		next = items[len(items)-1]["seq"]
	}
	jsonResponse(w, 200, Object{"items": items, "nextCursor": next, "snapshotAt": now()})
}
func (a *App) runs(w http.ResponseWriter, r *http.Request) {
	where, args, e := eventQuery(r)
	if e != nil {
		fail(w, 400, "INVALID_FILTER", e.Error())
		return
	}
	where += " AND run_id<>''"
	having := ""
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		n, e := strconv.ParseInt(cursor, 10, 64)
		if e != nil {
			fail(w, 400, "INVALID_CURSOR", "cursor must be integer")
			return
		}
		having = " HAVING MAX(seq)<?"
		args = append(args, n)
	}
	limit := pageLimit(r)
	args = append(args, limit+1)
	rows, e := a.store.db.Query("SELECT run_id,MAX(seq),MIN(occurred_at),MAX(occurred_at),COUNT(*),MAX(guild_id) FROM events WHERE "+where+" GROUP BY run_id"+having+" ORDER BY MAX(seq) DESC LIMIT ?", args...)
	if e != nil {
		fail(w, 503, "QUERY_FAILED", e.Error())
		return
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		var id, first, last, guild string
		var seq, count int64
		if e := rows.Scan(&id, &seq, &first, &last, &count, &guild); e != nil {
			fail(w, 503, "QUERY_FAILED", e.Error())
			return
		}
		items = append(items, Object{"id": id, "cursor": seq, "firstAt": first, "lastAt": last, "eventCount": count, "guildId": guild})
	}
	if e := rows.Err(); e != nil {
		fail(w, 503, "QUERY_FAILED", e.Error())
		return
	}
	var next any
	if len(items) > limit {
		items = items[:limit]
		next = items[len(items)-1]["cursor"]
	}
	jsonResponse(w, 200, Object{"items": items, "nextCursor": next})
}
func (a *App) run(w http.ResponseWriter, r *http.Request) {
	rows, e := a.store.db.Query("SELECT seq,payload FROM events WHERE run_id=? ORDER BY seq", r.PathValue("id"))
	if e != nil {
		fail(w, 503, "QUERY_FAILED", e.Error())
		return
	}
	defer rows.Close()
	items := []any{}
	for rows.Next() {
		var seq int64
		var payload string
		if e := rows.Scan(&seq, &payload); e != nil {
			fail(w, 503, "QUERY_FAILED", e.Error())
			return
		}
		items = append(items, Object{"seq": seq, "payload": decode(payload)})
	}
	if e := rows.Err(); e != nil {
		fail(w, 503, "QUERY_FAILED", e.Error())
		return
	}
	if len(items) == 0 {
		fail(w, 404, "NOT_FOUND", "Run not found")
		return
	}
	jsonResponse(w, 200, Object{"id": r.PathValue("id"), "events": items, "summary": Object{"eventCount": len(items)}})
}
func (a *App) createAction(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Type           string `json:"type"`
		Input          Object `json:"input"`
		IdempotencyKey string `json:"idempotencyKey"`
	}
	if !body(w, r, &in) {
		return
	}
	if in.Input == nil {
		in.Input = Object{}
	}
	if !knownAction(in.Type) {
		fail(w, 400, "UNKNOWN_ACTION", "Action is not in the supported catalog")
		return
	}
	actor, via, _ := a.authenticate(r)
	ac, created, e := a.store.enqueue(in.Type, in.Input, in.IdempotencyKey, actor, via)
	if e != nil {
		fail(w, 409, "ACTION_REJECTED", e.Error())
		return
	}
	select {
	case a.wake <- struct{}{}:
	default:
	}
	status := 200
	if created {
		status = 202
	}
	jsonResponse(w, status, ac)
}
func (a *App) actions(w http.ResponseWriter, r *http.Request) {
	args := []any{}
	where := "1=1"
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		parts := strings.SplitN(cursor, "|", 2)
		if len(parts) != 2 {
			fail(w, 400, "INVALID_CURSOR", "Use the returned opaque nextCursor")
			return
		}
		where += " AND (created_at<? OR (created_at=? AND id<?))"
		args = append(args, parts[0], parts[0], parts[1])
	}
	if status := r.URL.Query().Get("status"); status != "" {
		where += " AND status=?"
		args = append(args, status)
	}
	limit := pageLimit(r)
	args = append(args, limit+1)
	rows, e := a.store.db.Query("SELECT "+actionColumns+" FROM actions WHERE "+where+" ORDER BY created_at DESC,id DESC LIMIT ?", args...)
	if e != nil {
		fail(w, 503, "QUERY_FAILED", e.Error())
		return
	}
	defer rows.Close()
	items := []Action{}
	for rows.Next() {
		ac, e := scanAction(rows)
		if e != nil {
			fail(w, 503, "QUERY_FAILED", e.Error())
			return
		}
		items = append(items, ac)
	}
	if e := rows.Err(); e != nil {
		fail(w, 503, "QUERY_FAILED", e.Error())
		return
	}
	var next any
	if len(items) > limit {
		items = items[:limit]
		next = items[len(items)-1].CreatedAt + "|" + items[len(items)-1].ID
	}
	jsonResponse(w, 200, Object{"items": items, "nextCursor": next})
}
func (a *App) action(w http.ResponseWriter, r *http.Request) {
	ac, e := a.store.action(r.PathValue("id"))
	if errors.Is(e, sql.ErrNoRows) {
		fail(w, 404, "NOT_FOUND", "Action not found")
		return
	}
	if e != nil {
		fail(w, 503, "QUERY_FAILED", e.Error())
		return
	}
	jsonResponse(w, 200, ac)
}

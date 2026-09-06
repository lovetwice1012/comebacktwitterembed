package main

import (
	"database/sql"
	"errors"
	"net/http"
	"time"
)

func (a *App) channels() []string {
	v := []string{}
	if a.cfg.DiscordWebhook != "" {
		v = append(v, "discord")
	}
	if a.cfg.PushWebhook != "" {
		v = append(v, "push")
	}
	return v
}
func (a *App) queueNotification(tx *sql.Tx, id string, revision int, title, status string) error {
	for _, channel := range a.channels() {
		payload := Object{"incidentId": id, "revision": revision, "title": title, "status": status, "observedAt": now(), "url": a.cfg.PublicURL}
		_, e := tx.Exec("INSERT OR IGNORE INTO outbox(id,incident_id,revision,channel,payload,status,next_at,created_at) VALUES(?,?,?,?,?,'pending',?,?)", randomID(), id, revision, channel, encode(payload), now(), now())
		if e != nil {
			return e
		}
	}
	return nil
}
func (a *App) upsertIncident(fingerprint, title string, evidence Object) (string, bool, error) {
	tx, e := a.store.db.Begin()
	if e != nil {
		return "", false, e
	}
	defer tx.Rollback()
	var id, status string
	var revision int
	e = tx.QueryRow("SELECT id,status,revision FROM incidents WHERE fingerprint=?", fingerprint).Scan(&id, &status, &revision)
	changed := errors.Is(e, sql.ErrNoRows) || status == "Resolved" || status == "Suppressed"
	if errors.Is(e, sql.ErrNoRows) {
		id = randomID()
		revision = 1
		_, e = tx.Exec("INSERT INTO incidents(id,fingerprint,title,status,revision,created_at,updated_at,evidence) VALUES(?,?,?,'Confirmed',?,?,?,?)", id, fingerprint, title, revision, now(), now(), encode(evidence))
	} else if e == nil {
		if status == "Resolved" || status == "Suppressed" {
			revision++
		}
		_, e = tx.Exec("UPDATE incidents SET title=?,status='Confirmed',revision=?,updated_at=?,evidence=?,acknowledged=CASE WHEN status IN ('Resolved','Suppressed') THEN 0 ELSE acknowledged END,recovery_count=0,recovery_start=NULL WHERE id=?", title, revision, now(), encode(evidence), id)
	}
	if e != nil {
		return "", false, e
	}
	if changed {
		if e = a.queueNotification(tx, id, revision, title, "Confirmed"); e != nil {
			return "", false, e
		}
	}
	return id, changed, tx.Commit()
}
func (a *App) recoverIncident(fingerprint string, evidence Object) error {
	tx, e := a.store.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var id, title, status string
	var revision, count int
	var start sql.NullString
	e = tx.QueryRow("SELECT id,title,status,revision,recovery_count,recovery_start FROM incidents WHERE fingerprint=?", fingerprint).Scan(&id, &title, &status, &revision, &count, &start)
	if errors.Is(e, sql.ErrNoRows) || status == "Resolved" || status == "Suppressed" {
		return nil
	}
	if e != nil {
		return e
	}
	count++
	if !start.Valid {
		start = sql.NullString{String: now(), Valid: true}
	}
	t, _ := time.Parse(time.RFC3339Nano, start.String)
	next := "Verifying"
	if count >= 3 && time.Since(t) >= 2*time.Minute {
		next = "Resolved"
	}
	if next != status {
		revision++
	}
	_, e = tx.Exec("UPDATE incidents SET status=?,revision=?,updated_at=?,evidence=?,recovery_count=?,recovery_start=? WHERE id=?", next, revision, now(), encode(evidence), count, start.String, id)
	if e != nil {
		return e
	}
	if next == "Resolved" && status != "Resolved" {
		if e = a.queueNotification(tx, id, revision, title, next); e != nil {
			return e
		}
	}
	return tx.Commit()
}
func scanIncident(row interface{ Scan(...any) error }) (Object, error) {
	var id, fingerprint, title, status, created, updated, evidence string
	var revision, ack, count int
	var recovery sql.NullString
	e := row.Scan(&id, &fingerprint, &title, &status, &revision, &created, &updated, &evidence, &ack, &count, &recovery)
	return Object{"id": id, "fingerprint": fingerprint, "title": title, "status": status, "actionable": status != "Resolved" && status != "Suppressed", "revision": revision, "createdAt": created, "updatedAt": updated, "evidence": decode(evidence), "acknowledged": ack == 1, "recoverySuccessCount": count, "recoveryStartedAt": nullable(recovery)}, e
}

const incidentColumns = "id,fingerprint,title,status,revision,created_at,updated_at,evidence,acknowledged,recovery_count,recovery_start"

func (a *App) incidents(w http.ResponseWriter, r *http.Request) {
	where := "1=1"
	args := []any{}
	if r.URL.Query().Get("status") == "active" {
		where = "status NOT IN ('Resolved','Suppressed')"
	}
	if c := r.URL.Query().Get("cursor"); c != "" {
		where += " AND updated_at<?"
		args = append(args, c)
	}
	args = append(args, pageLimit(r)+1)
	rows, e := a.store.db.Query("SELECT "+incidentColumns+" FROM incidents WHERE "+where+" ORDER BY updated_at DESC LIMIT ?", args...)
	if e != nil {
		fail(w, 503, "QUERY_FAILED", e.Error())
		return
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		item, e := scanIncident(rows)
		if e != nil {
			fail(w, 503, "QUERY_FAILED", e.Error())
			return
		}
		items = append(items, item)
	}
	if e := rows.Err(); e != nil {
		fail(w, 503, "QUERY_FAILED", e.Error())
		return
	}
	var next any
	if len(items) > pageLimit(r) {
		items = items[:pageLimit(r)]
		next = items[len(items)-1]["updatedAt"]
	}
	jsonResponse(w, 200, Object{"items": items, "nextCursor": next})
}
func (a *App) incident(w http.ResponseWriter, r *http.Request) {
	item, e := scanIncident(a.store.db.QueryRow("SELECT "+incidentColumns+" FROM incidents WHERE id=?", r.PathValue("id")))
	if errors.Is(e, sql.ErrNoRows) {
		fail(w, 404, "NOT_FOUND", "Incident not found")
		return
	}
	if e != nil {
		fail(w, 503, "QUERY_FAILED", e.Error())
		return
	}
	jsonResponse(w, 200, item)
}
func (a *App) acknowledge(w http.ResponseWriter, r *http.Request) {
	actor, via, _ := a.authenticate(r)
	tx, e := a.store.db.Begin()
	if e != nil {
		fail(w, 503, "STORE_ERROR", e.Error())
		return
	}
	defer tx.Rollback()
	id := r.PathValue("id")
	res, e := tx.Exec("UPDATE incidents SET acknowledged=1,updated_at=? WHERE id=?", now(), id)
	if e != nil {
		fail(w, 503, "STORE_ERROR", e.Error())
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		fail(w, 404, "NOT_FOUND", "Incident not found")
		return
	}
	if e = a.auditAuthTx(tx, "admin.incident.acknowledged", actor, via, Object{"incidentId": id, "acknowledged": true}); e == nil {
		e = tx.Commit()
	}
	if e != nil {
		fail(w, 503, "STORE_ERROR", e.Error())
		return
	}
	jsonResponse(w, 200, Object{"ok": true, "acknowledged": true})
}
func (a *App) notifications(w http.ResponseWriter, r *http.Request) {
	rows, e := a.store.db.Query("SELECT id,incident_id,revision,channel,payload,status,attempts,next_at,response,last_error,created_at FROM outbox ORDER BY created_at DESC LIMIT ?", pageLimit(r))
	if e != nil {
		fail(w, 503, "QUERY_FAILED", e.Error())
		return
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		var id, incident, channel, payload, status, next, created string
		var revision, attempts int
		var response, problem sql.NullString
		if e := rows.Scan(&id, &incident, &revision, &channel, &payload, &status, &attempts, &next, &response, &problem, &created); e != nil {
			fail(w, 503, "QUERY_FAILED", e.Error())
			return
		}
		items = append(items, Object{"id": id, "incidentId": incident, "revision": revision, "channel": channel, "payload": decode(payload), "status": status, "attempts": attempts, "nextAt": next, "response": decode(response.String), "lastError": nullable(problem), "createdAt": created})
	}
	if e := rows.Err(); e != nil {
		fail(w, 503, "QUERY_FAILED", e.Error())
		return
	}
	jsonResponse(w, 200, Object{"items": items, "configuredChannels": a.channels()})
}

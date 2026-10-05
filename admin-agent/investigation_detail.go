package main

import (
	"database/sql"
	"errors"
	"net/http"
)

func (a *App) eventDetail(w http.ResponseWriter, r *http.Request) {
	var payload string
	err := a.store.queryDB().QueryRow("SELECT payload FROM events WHERE id=?", r.PathValue("id")).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "NOT_FOUND", "Event not found")
		return
	}
	if err != nil {
		fail(w, 503, "QUERY_FAILED", err.Error())
		return
	}
	jsonResponse(w, 200, Object{"id": r.PathValue("id"), "payload": decode(payload)})
}

func (a *App) notificationDetail(w http.ResponseWriter, r *http.Request) {
	var incident, channel, payload, status, next, created string
	var revision, attempts int
	var response, problem sql.NullString
	err := a.store.queryDB().QueryRow("SELECT incident_id,revision,channel,payload,status,attempts,next_at,response,last_error,created_at FROM outbox WHERE id=?", r.PathValue("id")).Scan(&incident, &revision, &channel, &payload, &status, &attempts, &next, &response, &problem, &created)
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "NOT_FOUND", "Notification not found")
		return
	}
	if err != nil {
		fail(w, 503, "QUERY_FAILED", err.Error())
		return
	}
	jsonResponse(w, 200, Object{"id": r.PathValue("id"), "incidentId": incident, "revision": revision, "channel": channel, "payload": decode(payload), "status": status, "attempts": attempts, "nextAt": next, "response": decode(response.String), "lastError": nullable(problem), "createdAt": created})
}

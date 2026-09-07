package main

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Request lists and metrics use the same root start cohort and most recent
// terminal event. Child fetches, retries and sends never create extra roots.
func (a *App) rootRuns(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	from, to, e := dateFilter(r.URL.Query().Get("from"), r.URL.Query().Get("to"))
	if e != nil {
		fail(w, 400, "INVALID_FILTER", e.Error())
		return
	}
	cutoff := time.Now().UTC().Add(-max(600*time.Second, 2*a.cfg.WorkerTimeout)).Format(timestampLayout)
	outcome := `COALESCE(json_extract(c.payload,'$.outcome'),json_extract(c.payload,'$.details.outcome'),'X')`
	var query string
	var args []any
	triggerPayload := "s.payload"
	if a.store.requestRootsReady(ctx) {
		triggerPayload = "payload"
		rootOutcome := `COALESCE(json_extract(completed_payload,'$.outcome'),json_extract(completed_payload,'$.details.outcome'),'X')`
		query = `SELECT * FROM (SELECT run_id,seq,occurred_at,COALESCE(completed_at,occurred_at),guild_id,payload,event_count,CASE WHEN completed_seq IS NULL THEN CASE WHEN occurred_at<? THEN 'X' ELSE 'I' END WHEN ` + rootOutcome + ` IN ('F','D','P','E','U','S','C','I','X') THEN ` + rootOutcome + ` ELSE 'X' END AS outcome FROM request_roots WHERE occurred_at>=? AND occurred_at<?`
		args = []any{cutoff, from, to}
		if guild := r.URL.Query().Get("guildId"); guild != "" {
			query += " AND guild_id=?"
			args = append(args, guild)
		}
	} else {
		query = `SELECT * FROM (SELECT s.run_id,s.seq,s.occurred_at,COALESCE(c.occurred_at,s.occurred_at),s.guild_id,s.payload,(SELECT COUNT(*) FROM events z WHERE z.run_id=s.run_id) AS event_count,CASE WHEN c.seq IS NULL THEN CASE WHEN s.occurred_at<? THEN 'X' ELSE 'I' END WHEN ` + outcome + ` IN ('F','D','P','E','U','S','C','I','X') THEN ` + outcome + ` ELSE 'X' END AS outcome FROM events s LEFT JOIN events c ON c.seq=(SELECT MAX(t.seq) FROM events t WHERE t.run_id=s.run_id AND t.kind='request.completed') WHERE s.kind='request.started' AND s.run_id<>'' AND s.occurred_at>=? AND s.occurred_at<? AND s.seq=(SELECT MIN(z.seq) FROM events z WHERE z.run_id=s.run_id AND z.kind='request.started')`
		args = []any{cutoff, from, to}
		if guild := r.URL.Query().Get("guildId"); guild != "" {
			query += " AND s.guild_id=?"
			args = append(args, guild)
		}
	}
	if r.URL.Query().Get("scope") != "all" {
		query += ` AND COALESCE(json_extract(` + triggerPayload + `,'$.triggerType'),json_extract(` + triggerPayload + `,'$.trigger_type'),'') NOT IN ('diagnostic','admin_operation')`
	}
	query += ") roots WHERE 1=1"
	filter := r.URL.Query().Get("outcome")
	if r.URL.Query().Get("problematic") == "1" {
		filter = "D,P,E,U,X"
	}
	if filter != "" {
		values := strings.Split(filter, ",")
		placeholders := []string{}
		for _, v := range values {
			if _, ok := outcomeNames[v]; !ok {
				fail(w, 400, "INVALID_OUTCOME", "Unknown result classification")
				return
			}
			placeholders = append(placeholders, "?")
			args = append(args, v)
		}
		query += " AND outcome IN (" + strings.Join(placeholders, ",") + ")"
	}
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		n, e := strconv.ParseInt(cursor, 10, 64)
		if e != nil {
			fail(w, 400, "INVALID_CURSOR", "cursor must be integer")
			return
		}
		query += " AND seq<?"
		args = append(args, n)
	}
	limit := pageLimit(r)
	query += " ORDER BY seq DESC LIMIT ?"
	args = append(args, limit+1)
	rows, e := a.store.queryDB().QueryContext(ctx, query, args...)
	if e != nil {
		fail(w, 503, "QUERY_FAILED", e.Error())
		return
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		var id, firstAt, lastAt, guild, payload, result string
		var seq, count int64
		if e := rows.Scan(&id, &seq, &firstAt, &lastAt, &guild, &payload, &count, &result); e != nil {
			fail(w, 503, "QUERY_FAILED", e.Error())
			return
		}
		v, _ := decode(payload).(map[string]any)
		items = append(items, Object{"id": id, "cursor": seq, "firstAt": firstAt, "lastAt": lastAt, "guildId": guild, "eventCount": count, "outcome": result, "provider": first(v, "provider", "providerId", "provider_id"), "channelId": first(v, "channelId", "channel_id"), "userId": first(v, "userId", "user_id"), "triggerType": first(v, "triggerType", "trigger_type"), "input": v})
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
	jsonResponse(w, 200, Object{"items": items, "nextCursor": next, "from": from, "to": to, "snapshotAt": now(), "definitionVersion": "root-request-v1"})
}

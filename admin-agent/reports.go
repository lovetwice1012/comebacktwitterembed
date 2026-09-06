package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"
)

func validReportKind(kind string) bool {
	return kind == "overview" || kind == "analytics" || kind == "guild-preview" || kind == "provider-preview"
}
func normalizeFilters(input Object) (Object, error) {
	result := Object{}
	for key, v := range input {
		if len(key) > 100 {
			return nil, errors.New("filter key too long")
		}
		if v == nil {
			continue
		}
		if s, ok := v.(string); ok && s == "" {
			continue
		}
		if len(encode(v)) > 8192 {
			return nil, errors.New("filter value too large")
		}
		switch key {
		case "from", "to", "startAt", "endAt":
			s, ok := v.(string)
			if !ok {
				return nil, errors.New("date filter must be a string")
			}
			t, e := time.Parse(time.RFC3339Nano, s)
			if e != nil {
				return nil, e
			}
			v = t.UTC().Format(timestampLayout)
		case "days", "limit", "periodDays":
			if s, ok := v.(string); ok {
				n, e := strconv.Atoi(s)
				if e != nil {
					return nil, e
				}
				v = n
			}
		}
		result[key] = v
	}
	return result, nil
}
func reportKey(kind string, filters Object) string {
	return tokenHash("complete-report-v1:" + kind + ":" + encode(filters))
}
func (a *App) reportSnapshot(key string) (Object, error) {
	var kind, filters, status, updated string
	var action, success, generated, payload, problem sql.NullString
	e := a.store.db.QueryRow("SELECT kind,filters,current_action_id,status,last_successful_action_id,generated_at,result,error,updated_at FROM reports WHERE cache_key=?", key).Scan(&kind, &filters, &action, &status, &success, &generated, &payload, &problem, &updated)
	if e != nil {
		return nil, e
	}
	if action.Valid && (status == "queued" || status == "running") {
		if ac, e := a.store.action(action.String); e == nil {
			if ac.Status == "succeeded" || ac.Status == "failed" || ac.Status == "unknown" {
				if e = a.completeReport(ac.ID, ac.Status, ac.Result, ac.Error); e == nil {
					return a.reportSnapshot(key)
				}
			} else {
				status = ac.Status
			}
		}
	}
	var report any
	metadata := Object{}
	if payload.Valid {
		v, _ := decode(payload.String).(map[string]any)
		if value, ok := v["report"]; ok {
			report = value
			for _, k := range []string{"definitionVersion", "watermark", "generatedAt"} {
				metadata[k] = v[k]
			}
		} else {
			report = decode(payload.String)
		}
	}
	var failedAt any
	if problem.Valid && problem.String != "null" {
		failedAt = updated
	}
	var lastError any
	if problem.Valid {
		lastError = decode(problem.String)
	}
	return Object{"kind": kind, "filters": decode(filters), "key": key, "actionId": nullable(action), "status": status, "report": report, "metadata": metadata, "cache": Object{"ready": payload.Valid, "refreshing": status == "queued" || status == "running", "updatedAt": nullable(generated), "lastError": lastError, "failedAt": failedAt}, "lastSuccessfulActionId": nullable(success)}, nil
}
func (a *App) getReport(w http.ResponseWriter, r *http.Request) {
	kind := r.PathValue("kind")
	if !validReportKind(kind) {
		fail(w, 400, "UNKNOWN_REPORT_KIND", "Unsupported report kind")
		return
	}
	filters := Object{}
	if raw := r.URL.Query().Get("filters"); raw != "" {
		if json.Unmarshal([]byte(raw), &filters) != nil {
			fail(w, 400, "INVALID_FILTERS", "filters must be a JSON object")
			return
		}
	}
	filters, e := normalizeFilters(filters)
	if e != nil {
		fail(w, 400, "INVALID_FILTERS", e.Error())
		return
	}
	key := reportKey(kind, filters)
	snapshot, e := a.reportSnapshot(key)
	if errors.Is(e, sql.ErrNoRows) {
		jsonResponse(w, 200, Object{"kind": kind, "filters": filters, "key": key, "actionId": nil, "status": "not_generated", "report": nil, "cache": Object{"ready": false, "refreshing": false, "updatedAt": nil, "lastError": nil, "failedAt": nil}})
		return
	}
	if e != nil {
		fail(w, 503, "REPORT_STORE_ERROR", e.Error())
		return
	}
	jsonResponse(w, 200, snapshot)
}
func (a *App) buildReport(w http.ResponseWriter, r *http.Request) {
	kind := r.PathValue("kind")
	if !validReportKind(kind) {
		fail(w, 400, "UNKNOWN_REPORT_KIND", "Unsupported report kind")
		return
	}
	var in struct {
		Filters Object `json:"filters"`
		Force   bool   `json:"force"`
	}
	if !body(w, r, &in) {
		return
	}
	filters, e := normalizeFilters(in.Filters)
	if e != nil {
		fail(w, 400, "INVALID_FILTERS", e.Error())
		return
	}
	key := reportKey(kind, filters)
	tx, e := a.store.db.Begin()
	if e != nil {
		fail(w, 503, "REPORT_STORE_ERROR", e.Error())
		return
	}
	defer tx.Rollback()
	var previous, status, generated sql.NullString
	e = tx.QueryRow("SELECT r.current_action_id,a.status,r.generated_at FROM reports r LEFT JOIN actions a ON a.id=r.current_action_id WHERE r.cache_key=?", key).Scan(&previous, &status, &generated)
	if e != nil && !errors.Is(e, sql.ErrNoRows) {
		fail(w, 503, "REPORT_STORE_ERROR", e.Error())
		return
	}
	recent := false
	if t, e := time.Parse(time.RFC3339Nano, generated.String); e == nil {
		recent = time.Since(t) < 5*time.Minute
	}
	if status.String == "queued" || status.String == "running" || !in.Force && recent && kind == "overview" {
		tx.Rollback()
		snapshot, e := a.reportSnapshot(key)
		if e != nil {
			fail(w, 503, "REPORT_STORE_ERROR", e.Error())
			return
		}
		jsonResponse(w, 200, snapshot)
		return
	}
	actor, via, _ := a.authenticate(r)
	id := randomID()
	input := Object{"kind": kind, "filters": filters, "reportKey": key}
	t := now()
	_, e = tx.Exec("INSERT INTO actions(id,idem,type,input,status,actor,via,created_at,updated_at) VALUES(?,?,'reports.build',?,'queued',?,?,?,?)", id, "report:"+key+":"+id, encode(input), actor, via, t, t)
	if e == nil {
		_, e = tx.Exec("INSERT INTO reports(cache_key,kind,filters,current_action_id,status,updated_at) VALUES(?,?,?,?,'queued',?) ON CONFLICT(cache_key) DO UPDATE SET current_action_id=excluded.current_action_id,status='queued',error=NULL,updated_at=excluded.updated_at", key, kind, encode(filters), id, t)
	}
	if e == nil {
		e = tx.Commit()
	}
	if e != nil {
		fail(w, 503, "REPORT_STORE_ERROR", e.Error())
		return
	}
	snapshot, e := a.reportSnapshot(key)
	if e != nil {
		fail(w, 503, "REPORT_STORE_ERROR", e.Error())
		return
	}
	jsonResponse(w, 202, snapshot)
}
func (a *App) completeReport(actionID, status string, result, problem any) error {
	var errJSON any
	if problem != nil {
		errJSON = encode(problem)
	}
	if status == "succeeded" {
		_, e := a.store.db.Exec("UPDATE reports SET status=?,last_successful_action_id=?,generated_at=?,result=?,error=NULL,updated_at=? WHERE current_action_id=?", status, actionID, now(), encode(result), now(), actionID)
		return e
	}
	if status == "unknown" && problem == nil {
		errJSON = encode(Object{"code": "REPORT_RESULT_UNKNOWN", "message": "Generation ended without a confirmed complete report"})
	}
	_, e := a.store.db.Exec("UPDATE reports SET status=?,error=?,updated_at=? WHERE current_action_id=?", status, errJSON, now(), actionID)
	return e
}

func (a *App) scheduleReportRefresh(p Policy) {
	until, _ := time.Parse(time.RFC3339Nano, p.ReportsPausedUntil)
	if time.Now().Before(until) {
		return
	}
	interval := time.Duration(max(300, p.ReportsRefreshIntervalSeconds)) * time.Second
	tx, e := a.store.db.Begin()
	if e != nil {
		return
	}
	defer tx.Rollback()
	var active int
	if tx.QueryRow("SELECT COUNT(*) FROM actions WHERE type='reports.build' AND status IN ('queued','running')").Scan(&active) != nil || active > 0 {
		return
	}
	var key, kind, filters string
	e = tx.QueryRow("SELECT cache_key,kind,filters FROM reports WHERE kind='overview' AND status IN ('succeeded','failed') AND updated_at<? AND (status='succeeded' OR updated_at<?) ORDER BY updated_at LIMIT 1", time.Now().UTC().Add(-interval).Format(timestampLayout), time.Now().UTC().Add(-time.Hour).Format(timestampLayout)).Scan(&key, &kind, &filters)
	if e != nil {
		return
	}
	id := randomID()
	t := now()
	input := Object{"kind": kind, "filters": decode(filters), "reportKey": key}
	if _, e = tx.Exec("INSERT INTO actions(id,idem,type,input,status,actor,via,created_at,updated_at) VALUES(?,?,'reports.build',?,'queued',?,'automation',?,?)", id, "scheduled-report:"+key+":"+id, encode(input), a.cfg.Owner, t, t); e != nil {
		return
	}
	if _, e = tx.Exec("UPDATE reports SET current_action_id=?,status='queued',error=NULL,updated_at=? WHERE cache_key=?", id, t, key); e != nil {
		return
	}
	_ = tx.Commit()
}

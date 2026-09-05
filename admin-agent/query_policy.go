package main

import "time"

func (a *App) cancelOwnedOverdueQueries() {
	var result, status, updated string
	e := a.store.db.QueryRow("SELECT COALESCE(result,'null'),status,updated_at FROM actions WHERE type='diagnostics.queries' ORDER BY created_at DESC LIMIT 1").Scan(&result, &status, &updated)
	last, _ := time.Parse(time.RFC3339Nano, updated)
	if e != nil || time.Since(last) > time.Minute {
		_, _, _ = a.store.enqueue("diagnostics.queries", Object{"includeCompleted": false}, "owned-query-scan:"+time.Now().UTC().Format("200601021504"), a.cfg.Owner, "automation")
	}
	if e != nil || status != "succeeded" || time.Since(last) > 90*time.Second {
		return
	}
	data, _ := decode(result).(map[string]any)
	rows, _ := data["queries"].([]any)
	for _, raw := range rows {
		query, _ := raw.(map[string]any)
		id := str(query["queryId"])
		if id == "" || query["overdue"] != true || str(query["state"]) != "running" {
			continue
		}
		_, _, _ = a.store.enqueue("diagnostics.query.cancel", Object{"queryId": id, "onlyIfOverdue": true, "reason": "Policy-authorized cancellation of registered overdue report query; worker revalidates exact statement and connection ownership"}, "owned-query-cancel:"+id, a.cfg.Owner, "automation")
	}
}

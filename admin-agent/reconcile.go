package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// A core restart does not imply that the independent worker stopped. Inspect
// durable receipts, never reissue an unknown operation to discover its result.
func (a *App) reconcileUnknown(ctx context.Context) {
	if a.cfg.WorkerURL == "" {
		return
	}
	rows, e := a.store.db.Query("SELECT " + actionColumns + " FROM actions WHERE status='unknown' ORDER BY created_at DESC LIMIT 10")
	if e != nil {
		return
	}
	actions := []Action{}
	for rows.Next() {
		ac, e := scanAction(rows)
		if e != nil {
			rows.Close()
			return
		}
		actions = append(actions, ac)
	}
	rows.Close()
	for _, ac := range actions {
		child, cancel := context.WithTimeout(ctx, 3*time.Second)
		workerURL := a.cfg.WorkerURL
		if ac.Type == "reports.build" {
			workerURL = a.cfg.ReportWorkerURL
		}
		if workerURL == "" {
			cancel()
			continue
		}
		target := strings.TrimSuffix(workerURL, "/execute") + "/receipts/" + ac.ID
		req, e := http.NewRequestWithContext(child, "GET", target, nil)
		if e != nil {
			cancel()
			continue
		}
		req.Header.Set("X-Admin-Agent-Token", a.cfg.Token)
		req.Header.Set("Authorization", "Bearer "+a.cfg.Token)
		client := http.Client{Timeout: 3 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
		res, e := client.Do(req)
		if e != nil {
			cancel()
			continue
		}
		var receipt struct {
			State  string `json:"state"`
			Result struct {
				OK     bool     `json:"ok"`
				Data   any      `json:"data"`
				Error  any      `json:"error"`
				Events []Object `json:"events"`
			} `json:"result"`
		}
		e = json.NewDecoder(io.LimitReader(res.Body, 24<<20)).Decode(&receipt)
		res.Body.Close()
		cancel()
		if e != nil || res.StatusCode != 200 || receipt.State != "completed" {
			continue
		}
		if len(receipt.Result.Events) > 0 {
			if _, _, e = a.store.ingest(receipt.Result.Events); e != nil {
				continue
			}
		}
		status := "succeeded"
		problem := receipt.Result.Error
		if !receipt.Result.OK {
			status = "failed"
		}
		data, _ := receipt.Result.Data.(map[string]any)
		if ac.Type == "message.send" || ac.Type == "url.test_send" {
			switch str(data["outcome"]) {
			case "delivery_unknown":
				status = "unknown"
			case "partial_success", "failed":
				status = "failed"
			}
		}
		if p, ok := problem.(map[string]any); ok && str(p["code"]) == "DELIVERY_UNKNOWN" {
			status = "unknown"
		}
		if e = a.store.finish(ac.ID, status, receipt.Result.Data, problem); e != nil {
			continue
		}
		if ac.Type == "reports.build" {
			_ = a.completeReport(ac.ID, status, receipt.Result.Data, problem)
		}
		_, _, _ = a.store.ingest([]Object{{"id": randomID(), "kind": "admin.action.reconciled", "runId": ac.ID, "occurredAt": now(), "status": status, "evidence": "independent_worker_durable_receipt"}})
	}
}

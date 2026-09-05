package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Policy struct {
	Revision                      int    `json:"revision"`
	AutoInvestigate               bool   `json:"autoInvestigate"`
	AutoRestartHungBot            bool   `json:"autoRestartHungBot"`
	AutoPauseReports              bool   `json:"autoPauseReports"`
	AutoRestartAnalysis           bool   `json:"autoRestartAnalysis"`
	AutoCancelOverdueQueries      bool   `json:"autoCancelOverdueQueries"`
	AutoRefreshReports            bool   `json:"autoRefreshReports"`
	ReportsRefreshIntervalSeconds int    `json:"reportsRefreshIntervalSeconds"`
	ReportsPausedUntil            string `json:"reportsPausedUntil"`
	DesiredState                  string `json:"desiredState"`
	MaintenanceUntil              string `json:"maintenanceUntil"`
	RestartCooldownSeconds        int    `json:"restartCooldownSeconds"`
	RestartDailyLimit             int    `json:"restartDailyLimit"`
	HeartbeatGraceSeconds         int    `json:"heartbeatGraceSeconds"`
}

func defaultPolicy() Policy {
	return Policy{Revision: 1, AutoInvestigate: true, AutoPauseReports: true, AutoRestartAnalysis: true, AutoCancelOverdueQueries: true, AutoRefreshReports: true, ReportsRefreshIntervalSeconds: 900, DesiredState: "running", RestartCooldownSeconds: 900, RestartDailyLimit: 3, HeartbeatGraceSeconds: 180}
}
func (a *App) loadPolicy() (Policy, error) {
	var p Policy
	e := a.store.getSetting("policy", &p)
	return p, e
}
func (a *App) getPolicy(w http.ResponseWriter, r *http.Request) {
	p, e := a.loadPolicy()
	if e != nil {
		fail(w, 503, "POLICY_UNAVAILABLE", e.Error())
		return
	}
	jsonResponse(w, 200, p)
}
func (a *App) putPolicy(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Policy
		ExpectedRevision int `json:"expectedRevision"`
	}
	if !body(w, r, &in) {
		return
	}
	p := in.Policy
	if p.DesiredState != "running" && p.DesiredState != "stopped" && p.DesiredState != "maintenance" {
		fail(w, 400, "INVALID_POLICY", "desiredState must be running, stopped or maintenance")
		return
	}
	if p.RestartCooldownSeconds < 900 || p.RestartDailyLimit < 1 || p.RestartDailyLimit > 3 || p.HeartbeatGraceSeconds < 120 {
		fail(w, 400, "INVALID_POLICY", "Restart cooldown >=900 seconds, daily limit 1..3, heartbeat grace >=120 seconds required")
		return
	}
	if p.ReportsRefreshIntervalSeconds < 300 {
		fail(w, 400, "INVALID_POLICY", "reportsRefreshIntervalSeconds must be at least 300")
		return
	}
	if p.MaintenanceUntil != "" {
		t, e := time.Parse(time.RFC3339Nano, p.MaintenanceUntil)
		if e != nil {
			fail(w, 400, "INVALID_POLICY", "maintenanceUntil must be ISO timestamp")
			return
		}
		p.MaintenanceUntil = t.UTC().Format(timestampLayout)
	}
	if p.ReportsPausedUntil != "" {
		t, e := time.Parse(time.RFC3339Nano, p.ReportsPausedUntil)
		if e != nil {
			fail(w, 400, "INVALID_POLICY", "reportsPausedUntil must be ISO timestamp")
			return
		}
		p.ReportsPausedUntil = t.UTC().Format(timestampLayout)
	}
	tx, e := a.store.db.Begin()
	if e != nil {
		fail(w, 503, "STORE_ERROR", e.Error())
		return
	}
	defer tx.Rollback()
	var raw string
	if e = tx.QueryRow("SELECT value FROM settings WHERE key='policy'").Scan(&raw); e != nil {
		fail(w, 503, "STORE_ERROR", e.Error())
		return
	}
	var current Policy
	if e = jsonUnmarshal(raw, &current); e != nil {
		fail(w, 503, "STORE_ERROR", e.Error())
		return
	}
	if in.ExpectedRevision != current.Revision {
		fail(w, 409, "REVISION_CONFLICT", "Policy changed; reload the current revision before saving")
		return
	}
	p.Revision = current.Revision + 1
	if _, e = tx.Exec("UPDATE settings SET value=? WHERE key='policy'", encode(p)); e != nil {
		fail(w, 503, "STORE_ERROR", e.Error())
		return
	}
	if e = tx.Commit(); e != nil {
		fail(w, 503, "STORE_ERROR", e.Error())
		return
	}
	actor, via, _ := a.authenticate(r)
	_, _, _ = a.store.ingest([]Object{{"id": randomID(), "kind": "admin.policy.changed", "occurredAt": now(), "actor": actor, "initiatedVia": via, "before": current, "after": p}})
	jsonResponse(w, 200, p)
}
func jsonUnmarshal(s string, v any) error { return json.Unmarshal([]byte(s), v) }

func safeCommand(ctx context.Context, name string, args ...string) Object {
	child, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(child, name, args...)
	configureProcess(cmd)
	out := &boundedBuffer{limit: 512 << 10}
	cmd.Stdout = out
	cmd.Stderr = out
	e := cmd.Run()
	v := Object{"command": name, "args": args, "output": out.b.String(), "truncated": out.truncated, "observedAt": now(), "ok": e == nil}
	if e != nil {
		v["error"] = e.Error()
	}
	return v
}
func parseProperties(output string) Object {
	v := Object{}
	for _, line := range strings.Split(output, "\n") {
		parts := strings.SplitN(line, "=", 2)
		if len(parts) == 2 {
			v[parts[0]] = parts[1]
		}
	}
	return v
}
func unitSnapshot(ctx context.Context, unit string) Object {
	raw := safeCommand(ctx, "systemctl", "show", unit, "--no-pager", "--property=Id,LoadState,ActiveState,SubState,MainPID,InvocationID,ExecMainStatus,ExecMainCode,Result,NRestarts,Job,ActiveEnterTimestamp,ActiveEnterTimestampMonotonic,ControlGroup")
	props := parseProperties(str(raw["output"]))
	props["observation"] = raw
	return props
}
func readEvidence(path string) Object {
	b, e := os.ReadFile(path)
	if e != nil {
		return Object{"available": false, "error": e.Error()}
	}
	truncated := len(b) > 256<<10
	if truncated {
		b = b[:256<<10]
	}
	return Object{"available": true, "raw": string(b), "truncated": truncated}
}
func (a *App) httpProbe(ctx context.Context, target string) Object {
	if target == "" {
		return Object{"configured": false, "state": "unconfigured"}
	}
	start := time.Now()
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, "GET", target, nil)
	if e != nil {
		return Object{"configured": true, "ok": false, "error": "Invalid configured URL"}
	}
	client := http.Client{Timeout: 3 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
	res, e := client.Do(req)
	v := Object{"configured": true, "observedAt": now(), "durationMs": time.Since(start).Milliseconds()}
	if e != nil {
		v["ok"] = false
		v["error"] = "HTTP connection, TLS or deadline failed"
		return v
	}
	defer res.Body.Close()
	v["status"] = res.StatusCode
	v["ok"] = res.StatusCode >= 200 && res.StatusCode < 400
	return v
}
func (a *App) collect(ctx context.Context, deep bool) Object {
	unit := unitSnapshot(ctx, a.cfg.BotUnit)
	v := Object{"observedAt": now(), "bootId": a.boot, "ruleVersion": "deterministic-v1", "unit": unit, "localHTTP": a.httpProbe(ctx, a.cfg.LocalHealthURL), "publicHTTP": a.httpProbe(ctx, a.cfg.PublicHealthURL), "host": Object{"meminfo": readEvidence("/proc/meminfo"), "loadavg": readEvidence("/proc/loadavg"), "pressureCPU": readEvidence("/proc/pressure/cpu"), "pressureMemory": readEvidence("/proc/pressure/memory"), "pressureIO": readEvidence("/proc/pressure/io"), "disk": diskSnapshot(a.cfg.StateDir)}}
	if a.cfg.WorkerURL != "" {
		v["analysisHTTP"] = a.httpProbe(ctx, strings.TrimSuffix(a.cfg.WorkerURL, "/execute")+"/health")
	}
	if pid, e := strconv.Atoi(str(unit["MainPID"])); e == nil && pid > 0 {
		root := filepath.Join("/proc", strconv.Itoa(pid))
		proc := Object{"pid": pid, "status": readEvidence(filepath.Join(root, "status")), "io": readEvidence(filepath.Join(root, "io")), "stat": readEvidence(filepath.Join(root, "stat"))}
		fds, e := os.ReadDir(filepath.Join(root, "fd"))
		if e == nil {
			proc["fdCount"] = len(fds)
		} else {
			proc["fdCountUnavailable"] = e.Error()
		}
		v["process"] = proc
	}
	var payload, persisted string
	e := a.store.db.QueryRow("SELECT payload,persisted_at FROM events WHERE kind IN ('heartbeat','bot.heartbeat','runtime.heartbeat') ORDER BY seq DESC LIMIT 1").Scan(&payload, &persisted)
	if e == nil {
		v["heartbeat"] = decode(payload)
		v["heartbeatPersistedAt"] = persisted
		t, _ := time.Parse(time.RFC3339Nano, persisted)
		v["heartbeatAgeSeconds"] = time.Since(t).Seconds()
	} else {
		v["heartbeatState"] = "unobserved"
	}
	if deep {
		v["journal"] = safeCommand(ctx, "journalctl", "-u", a.cfg.BotUnit, "--since", "-30 minutes", "-n", "200", "--no-pager", "-o", "short-iso")
		v["kernelJournal"] = safeCommand(ctx, "journalctl", "-k", "--since", "-30 minutes", "-n", "150", "--no-pager", "-o", "short-iso")
		v["mysqlUnit"] = unitSnapshot(ctx, "mysql.service")
		v["diskIO"] = readEvidence("/proc/diskstats")
		v["vmstat"] = readEvidence("/proc/vmstat")
	}
	return v
}
func (a *App) monitor(ctx context.Context) {
	ticker := time.NewTicker(a.cfg.MonitorInterval)
	defer ticker.Stop()
	a.monitorOnce(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.monitorOnce(ctx)
		}
	}
}
func (a *App) monitorOnce(ctx context.Context) {
	snapshot := a.collect(ctx, false)
	a.stateMu.Lock()
	a.lastSnapshot = snapshot
	a.stateMu.Unlock()
	eventID := randomID()
	if _, _, e := a.store.ingest([]Object{{"id": eventID, "kind": "monitor.snapshot", "occurredAt": now(), "component": "admin-agent", "details": snapshot}}); e != nil {
		log.Printf("monitor state could not be persisted: %v", e)
		return
	}
	a.stateMu.Lock()
	a.lastMonitorSave = time.Now()
	a.hasMonitorSave = true
	a.stateMu.Unlock()
	notifySystemd("WATCHDOG=1\nSTATUS=State store and monitor progressing")
	p, e := a.loadPolicy()
	if e != nil {
		return
	}
	maintenance := p.DesiredState != "running"
	if t, e := time.Parse(time.RFC3339Nano, p.MaintenanceUntil); e == nil && time.Now().Before(t) {
		maintenance = true
	}
	unit := nested(snapshot, "unit")
	local, pub := nested(snapshot, "localHTTP"), nested(snapshot, "publicHTTP")
	active := str(unit["ActiveState"])
	evidence := Object{"eventIds": []string{eventID}, "snapshot": snapshot, "maintenance": maintenance, "ruleVersion": "deterministic-v1"}
	if !maintenance {
		if active == "failed" || active == "inactive" {
			a.bad("bot.process.unavailable")
			if a.failures["bot.process.unavailable"] >= 2 {
				a.detect("bot.process.unavailable", "Botプロセスが停止しています", Object{"claim": "systemd reports inactive or failed. Exit cause requires the unit result and journal.", "supports": evidence, "unconfirmed": []string{"stop intent outside management core", "kernel OOM attribution"}, "nextActions": []string{"diagnostics.collect", "logs.read"}}, p)
			}
		} else if active == "active" {
			a.good("bot.process.unavailable", evidence)
		}
		if age, ok := snapshot["heartbeatAgeSeconds"].(float64); ok && age > float64(p.HeartbeatGraceSeconds) && active == "active" {
			a.bad("bot.heartbeat.stale")
			if a.failures["bot.heartbeat.stale"] >= 3 {
				a.detect("bot.heartbeat.stale", "Botの進捗記録が停止しています", Object{"claim": "systemd is active but the last durable heartbeat is stale. This is not by itself proof of a process hang.", "supports": evidence, "unconfirmed": []string{"producer spool backlog", "event loop responsiveness", "database health"}, "nextActions": []string{"diagnostics.collect", "diagnostics.db"}}, p)
			}
		} else if age, ok := snapshot["heartbeatAgeSeconds"].(float64); ok && age < 30 && active == "active" {
			a.good("bot.heartbeat.stale", Object{"scope": "Heartbeat delivery and systemd activity recovered; content fetching and Discord delivery remain separate capabilities.", "supports": evidence})
		}
	}
	if local["configured"] == true {
		if local["ok"] == false {
			a.bad("dashboard.local.unavailable")
			if a.failures["dashboard.local.unavailable"] >= 3 {
				a.detect("dashboard.local.unavailable", "通常ダッシュボードのローカルHTTPが応答しません", Object{"claim": "Repeated local health probes failed.", "supports": evidence, "nextActions": []string{"diagnostics.collect", "logs.read"}}, p)
			}
		} else if local["ok"] == true {
			a.good("dashboard.local.unavailable", Object{"scope": "Local HTTP health endpoint only", "supports": evidence})
		}
	}
	if pub["configured"] == true && local["ok"] == true {
		if pub["ok"] == false {
			a.bad("dashboard.public.path")
			if a.failures["dashboard.public.path"] >= 3 {
				a.detect("dashboard.public.path", "公開経路だけでHTTP失敗を確認しました", Object{"claim": "Local HTTP succeeds while the configured public endpoint fails. DNS/TLS/proxy/tunnel or upstream auth may be involved.", "supports": evidence, "unconfirmed": []string{"external witness reachability", "exact public path component"}, "nextActions": []string{"diagnostics.collect"}}, p)
			}
		} else {
			a.good("dashboard.public.path", Object{"scope": "Configured public HTTP endpoint recovered", "supports": evidence})
		}
	}
	if p.AutoRestartHungBot && !maintenance {
		a.maybeRepairHungBot(ctx, snapshot, p)
	}
	disk := nested(nested(snapshot, "host"), "disk")
	if free, ok := disk["freeBytes"].(uint64); ok {
		if free < 2<<30 {
			a.detect("management.storage.pressure", "管理記録用ディスクの空き容量が少なくなっています", Object{"freeBytes": free, "thresholdBytes": uint64(2 << 30), "eventIds": []string{eventID}, "automaticDeletion": false}, p)
		} else {
			a.good("management.storage.pressure", Object{"freeBytes": free, "scope": "Management storage capacity"})
		}
	}
	if p.AutoPauseReports {
		a.maybePauseReports(snapshot, p, eventID)
	}
	if analysis := nested(snapshot, "analysisHTTP"); analysis["configured"] == true {
		if analysis["ok"] == false {
			a.bad("analysis.unavailable")
			if a.failures["analysis.unavailable"] >= 3 {
				workerUnit := unitSnapshot(ctx, "cbte-admin-analysis.service")
				a.detect("analysis.unavailable", "独立分析workerが応答していません", Object{"eventIds": []string{eventID}, "http": analysis, "unit": workerUnit, "nextActions": []string{"analysis.status", "analysis.restart"}}, p)
				if p.AutoRestartAnalysis && !maintenance && str(workerUnit["InvocationID"]) != "" && (str(workerUnit["ActiveState"]) == "failed" || str(workerUnit["ActiveState"]) == "inactive") {
					_, _, _ = a.store.enqueue("analysis.restart", Object{"expectedInvocationId": str(workerUnit["InvocationID"]), "reason": "Independent worker failed three health probes and systemd reports failed/inactive"}, "analysis-repair:"+str(workerUnit["InvocationID"]), a.cfg.Owner, "automation")
				}
			}
		} else if analysis["ok"] == true {
			a.good("analysis.unavailable", Object{"eventIds": []string{eventID}, "scope": "Independent analysis HTTP recovered; provider or database operations require their own checks"})
		}
	}
	a.diagnoseProviderOutcomes(ctx, p)
	if p.AutoCancelOverdueQueries && a.cfg.ReportWorkerURL != "" {
		a.cancelOwnedOverdueQueries()
	}
	if p.AutoRefreshReports && a.cfg.ReportWorkerURL != "" {
		a.scheduleReportRefresh(p)
	}
	_, _ = a.store.db.Exec("DELETE FROM sessions WHERE expires_at<?", now())
	a.reconcileUnknown(ctx)
}
func (a *App) bad(key string) { a.failures[key]++ }
func (a *App) good(key string, evidence Object) {
	a.failures[key] = 0
	if e := a.recoverIncident(key, evidence); e != nil {
		log.Printf("incident recovery persistence failed: %v", e)
	}
}
func (a *App) detect(key, title string, evidence Object, p Policy) {
	id, created, e := a.upsertIncident(key, title, evidence)
	if e != nil {
		log.Printf("incident persistence failed: %v", e)
		return
	}
	if created && p.AutoInvestigate {
		_, _, e = a.store.enqueue("diagnostics.collect", Object{"incidentId": id}, "investigation:"+id, a.cfg.Owner, "automation")
		if e != nil {
			log.Printf("automatic investigation failed: %v", e)
		}
	}
}
func (a *App) maybeRepairHungBot(ctx context.Context, snapshot Object, p Policy) {
	// Independent evidence is required: systemd identity, stale telemetry, failed local
	// HTTP, and a successful fresh independent DB probe. Read-only investigation is
	// always allowed; an unavailable dependency never triggers a restart loop.
	unit := nested(snapshot, "unit")
	if str(unit["ActiveState"]) != "active" || str(unit["InvocationID"]) == "" || str(unit["Job"]) != "" && str(unit["Job"]) != "0" {
		return
	}
	heartbeat := nested(snapshot, "heartbeat")
	heartbeatPID := number(nested(heartbeat, "details")["pid"], 0)
	currentPID, _ := strconv.Atoi(str(unit["MainPID"]))
	if heartbeatPID == 0 || heartbeatPID != currentPID {
		return
	}
	age, ok := snapshot["heartbeatAgeSeconds"].(float64)
	if !ok || age < float64(p.HeartbeatGraceSeconds) || a.failures["dashboard.local.unavailable"] < 3 || a.failures["bot.heartbeat.stale"] < 3 {
		return
	}
	var raw, status, when string
	e := a.store.db.QueryRow("SELECT COALESCE(result,'null'),status,updated_at FROM actions WHERE type='diagnostics.db' ORDER BY created_at DESC LIMIT 1").Scan(&raw, &status, &when)
	t, _ := time.Parse(time.RFC3339Nano, when)
	if e != nil || status != "succeeded" || time.Since(t) > time.Minute {
		key := "db-check:" + str(unit["InvocationID"]) + ":" + time.Now().UTC().Format("200601021504")
		_, _, _ = a.store.enqueue("diagnostics.db", Object{}, key, a.cfg.Owner, "automation")
		return
	}
	dbResult, _ := decode(raw).(map[string]any)
	if first(nested(nested(dbResult, "results"), "connection"), "status") != "ok" {
		return
	}
	var count int
	var last sql.NullString
	_ = a.store.db.QueryRow("SELECT COUNT(*),MAX(created_at) FROM actions WHERE type='service.restart' AND created_at>?", time.Now().UTC().Add(-24*time.Hour).Format(timestampLayout)).Scan(&count, &last)
	lt, _ := time.Parse(time.RFC3339Nano, last.String)
	if count >= p.RestartDailyLimit || last.Valid && time.Since(lt) < time.Duration(p.RestartCooldownSeconds)*time.Second {
		return
	}
	_, _, _ = a.store.enqueue("service.restart", Object{"expectedInvocationId": str(unit["InvocationID"]), "reason": "Policy-authorized recovery: stale heartbeat, local HTTP failure, active process, recent successful independent DB diagnosis", "policyRevision": p.Revision}, "hung-repair:"+str(unit["InvocationID"]), a.cfg.Owner, "automation")
}

func diskSnapshot(dir string) Object { return platformDiskSnapshot(dir) }

func (a *App) maybePauseReports(snapshot Object, p Policy, eventID string) {
	raw := str(nested(nested(snapshot, "host"), "pressureIO")["raw"])
	pressure := 0.0
	for _, line := range strings.Split(raw, "\n") {
		if !strings.HasPrefix(line, "full ") {
			continue
		}
		for _, field := range strings.Fields(line) {
			if strings.HasPrefix(field, "avg10=") {
				pressure, _ = strconv.ParseFloat(strings.TrimPrefix(field, "avg10="), 64)
			}
		}
	}
	if pressure < 30 {
		a.failures["reports.io_pressure"] = 0
		return
	}
	a.failures["reports.io_pressure"]++
	if a.failures["reports.io_pressure"] < 3 {
		return
	}
	until, _ := time.Parse(time.RFC3339Nano, p.ReportsPausedUntil)
	if time.Until(until) > 2*time.Minute {
		return
	}
	pauseUntil := time.Now().UTC().Add(5 * time.Minute).Format(timestampLayout)
	if _, e := a.store.db.Exec("UPDATE settings SET value=json_set(value,'$.reportsPausedUntil',?,'$.revision',json_extract(value,'$.revision')+1) WHERE key='policy'", pauseUntil); e != nil {
		return
	}
	_, _, _ = a.store.ingest([]Object{{"id": randomID(), "kind": "admin.reports.paused", "occurredAt": now(), "reportsPausedUntil": pauseUntil, "reason": "IO full PSI avg10>=30 across three observations", "observedPressure": pressure, "evidenceIds": []string{eventID}}})
}

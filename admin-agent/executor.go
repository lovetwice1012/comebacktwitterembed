package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type ExecutorRequest struct {
	ID    string `json:"id"`
	Type  string `json:"type"`
	Input Object `json:"input"`
}

func (a *App) executor(ctx context.Context, id, typ string, input Object) (any, error) {
	if reason := serviceActionUnavailable(a.cfg, typ, input); reason != "" {
		return nil, errors.New(reason)
	}
	d := net.Dialer{Timeout: 3 * time.Second}
	conn, e := d.DialContext(ctx, "unix", a.cfg.ExecutorSocket)
	if e != nil {
		return nil, fmt.Errorf("executor unavailable")
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(45 * time.Second))
	if e = json.NewEncoder(conn).Encode(ExecutorRequest{id, typ, input}); e != nil {
		return nil, e
	}
	var response struct {
		OK    bool   `json:"ok"`
		Data  any    `json:"data"`
		Error string `json:"error"`
	}
	if e = json.NewDecoder(conn).Decode(&response); e != nil {
		return nil, e
	}
	if !response.OK {
		return response.Data, errors.New(response.Error)
	}
	return response.Data, nil
}
func serveExecutor(ctx context.Context, cfg Config) error {
	uid := envInt("ADMIN_AGENT_EXECUTOR_ALLOWED_UID", -1)
	if uid < 0 {
		return errors.New("ADMIN_AGENT_EXECUTOR_ALLOWED_UID is required")
	}
	gid := envInt("ADMIN_AGENT_EXECUTOR_GROUP_GID", -1)
	state := env("ADMIN_AGENT_EXECUTOR_STATE_DIR", "/var/lib/cbte-admin-executor")
	s, e := openStore(state)
	if e != nil {
		return e
	}
	defer s.db.Close()
	_, e = s.db.Exec("UPDATE receipts SET status='unknown',result=? WHERE status='running'", encode(Object{"error": "Executor restarted before operation receipt. Inspect systemd before proceeding."}))
	if e != nil {
		return e
	}
	if e = os.MkdirAll(filepath.Dir(cfg.ExecutorSocket), 0750); e != nil {
		return e
	}
	if gid >= 0 {
		if e = os.Chown(filepath.Dir(cfg.ExecutorSocket), 0, gid); e != nil {
			return e
		}
	}
	if info, e := os.Lstat(cfg.ExecutorSocket); e == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return errors.New("executor path exists and is not a socket")
		}
		_ = os.Remove(cfg.ExecutorSocket)
	}
	listener, e := net.ListenUnix("unix", &net.UnixAddr{Name: cfg.ExecutorSocket, Net: "unix"})
	if e != nil {
		return e
	}
	defer listener.Close()
	if e = os.Chmod(cfg.ExecutorSocket, 0660); e != nil {
		return e
	}
	if gid >= 0 {
		if e = os.Chown(cfg.ExecutorSocket, 0, gid); e != nil {
			return e
		}
	}
	go func() { <-ctx.Done(); listener.Close() }()
	var lock sync.Mutex
	for {
		conn, e := listener.AcceptUnix()
		if e != nil {
			if ctx.Err() != nil {
				return nil
			}
			return e
		}
		go func(c *net.UnixConn) {
			defer c.Close()
			_ = c.SetDeadline(time.Now().Add(50 * time.Second))
			if !peerAllowed(c, uid) {
				_ = json.NewEncoder(c).Encode(Object{"ok": false, "error": "Unix peer UID rejected"})
				return
			}
			line, e := bufio.NewReaderSize(c, 32769).ReadSlice('\n')
			if e != nil || len(line) > 32768 {
				_ = json.NewEncoder(c).Encode(Object{"ok": false, "error": "Invalid bounded executor request"})
				return
			}
			var req ExecutorRequest
			if json.Unmarshal(line, &req) != nil || !validID(req.ID) {
				_ = json.NewEncoder(c).Encode(Object{"ok": false, "error": "Invalid executor request"})
				return
			}
			lock.Lock()
			defer lock.Unlock()
			data, e := executePrivileged(ctx, s, cfg, req)
			if e != nil {
				_ = json.NewEncoder(c).Encode(Object{"ok": false, "data": data, "error": e.Error()})
			} else {
				_ = json.NewEncoder(c).Encode(Object{"ok": true, "data": data})
			}
		}(conn)
	}
}
func executePrivileged(parent context.Context, s *Store, cfg Config, req ExecutorRequest) (any, error) {
	if e := validateServiceProfile(cfg); e != nil {
		return nil, e
	}
	if reason := serviceActionUnavailable(cfg, req.Type, req.Input); reason != "" {
		return nil, errors.New(reason)
	}
	if req.Type != "service.status" && req.Type != "service.start" && req.Type != "service.stop" && req.Type != "service.restart" && req.Type != "logs.read" && req.Type != "kernel.logs" && req.Type != "agent.status" && req.Type != "agent.restart" && req.Type != "database.status" && req.Type != "database.restart" && req.Type != "analysis.status" && req.Type != "analysis.restart" && req.Type != "logs.previous_boot" && req.Type != "logs.boots" {
		return nil, errors.New("executor action is not allowed")
	}
	unit, verb := privilegedActionUnit(cfg, req.Type)
	ctx, cancel := context.WithTimeout(parent, 35*time.Second)
	defer cancel()
	var savedInput, status string
	var result sql.NullString
	e := s.db.QueryRow("SELECT input,status,result FROM receipts WHERE id=?", req.ID).Scan(&savedInput, &status, &result)
	if e == nil {
		if savedInput != encode(req) {
			return nil, errors.New("receipt ID input mismatch")
		}
		if status != "succeeded" {
			return decode(result.String), fmt.Errorf("existing executor receipt status: %s", status)
		}
		return decode(result.String), nil
	}
	if !errors.Is(e, sql.ErrNoRows) {
		return nil, e
	}
	if _, e = s.db.Exec("INSERT INTO receipts(id,input,status,created_at) VALUES(?,?,'running',?)", req.ID, encode(req), now()); e != nil {
		return nil, e
	}
	finish := func(data any, problem error) (any, error) {
		state := "succeeded"
		if problem != nil {
			state = "failed"
		}
		if ctx.Err() != nil {
			state = "unknown"
		}
		if _, e := s.db.Exec("UPDATE receipts SET status=?,result=? WHERE id=?", state, encode(Object{"data": data, "error": errorString(problem)}), req.ID); e != nil {
			return data, e
		}
		return Object{"data": data, "error": errorString(problem)}, problem
	}
	before := unitSnapshot(ctx, unit)
	if verb == "status" {
		return finish(before, nil)
	}
	if req.Type == "logs.boots" {
		result := safeCommand(ctx, "journalctl", "--list-boots", "--no-pager")
		return finish(result, nil)
	}
	if req.Type == "logs.previous_boot" {
		lines := number(req.Input["lines"], 200)
		if lines < 1 || lines > 500 {
			return finish(nil, errors.New("lines must be 1..500"))
		}
		source := str(req.Input["source"])
		units := map[string]string{"bot": cfg.BotUnit, "database": "mysql.service", "nginx": "nginx.service", "core": "cbte-admin.service", "analysis": "cbte-admin-analysis.service", "reports": "cbte-admin-reports.service"}
		args := []string{"-b", "-1", "-n", strconv.Itoa(lines), "--no-pager", "-o", "json"}
		if source == "kernel" {
			args = append(args, "_TRANSPORT=kernel")
		} else if target, ok := units[source]; ok {
			args = append(args, "-u", target)
		} else {
			return finish(nil, errors.New("source must be bot, database, nginx, core, analysis, reports or kernel"))
		}
		result := safeCommand(ctx, "journalctl", args...)
		if result["ok"] != true {
			return finish(result, errors.New("previous-boot journal unavailable"))
		}
		return finish(result, nil)
	}
	if req.Type == "logs.read" || req.Type == "kernel.logs" {
		lines := number(req.Input["lines"], 200)
		minutes := number(req.Input["minutes"], 60)
		if lines < 1 || lines > 500 || minutes < 1 || minutes > 1440 {
			return finish(nil, errors.New("lines 1..500 and minutes 1..1440 required"))
		}
		args := []string{"--since", fmt.Sprintf("-%d minutes", minutes), "-n", strconv.Itoa(lines), "--no-pager", "-o", "short-iso"}
		if req.Type == "kernel.logs" {
			args = append([]string{"-k"}, args...)
		} else {
			args = append([]string{"-u", cfg.BotUnit}, args...)
		}
		data := safeCommand(ctx, "journalctl", args...)
		if data["ok"] != true {
			return finish(data, errors.New("journal collection failed"))
		}
		return finish(data, nil)
	}
	job := str(before["Job"])
	if job != "" && !strings.HasPrefix(job, "0") {
		return finish(before, errors.New("systemd already has a job for this unit"))
	}
	expected := str(req.Input["expectedInvocationId"])
	if verb == "stop" || verb == "restart" {
		if expected == "" || expected != str(before["InvocationID"]) {
			return finish(before, errors.New("expectedInvocationId required and must match current unit"))
		}
	}
	if verb == "restart" {
		var count int
		var last sql.NullString
		_ = s.db.QueryRow("SELECT COUNT(*),MAX(created_at) FROM receipts WHERE id<>? AND json_extract(input,'$.type')=? AND created_at>?", req.ID, req.Type, time.Now().UTC().Add(-24*time.Hour).Format(timestampLayout)).Scan(&count, &last)
		lt, _ := time.Parse(time.RFC3339Nano, last.String)
		if count >= 3 || last.Valid && time.Since(lt) < 15*time.Minute {
			return finish(before, errors.New("executor restart budget exceeded (15 minute cooldown, 3 per 24 hours)"))
		}
	}
	call := safeCommand(ctx, "systemctl", verb, unit, "--no-block")
	if call["ok"] != true {
		return finish(Object{"before": before, "call": call}, errors.New("systemctl rejected operation"))
	}
	var after Object
	for {
		after = unitSnapshot(ctx, unit)
		state := str(after["ActiveState"])
		if verb == "stop" && (state == "inactive" || state == "failed") {
			break
		}
		if (verb == "start" || verb == "restart") && state == "active" && (verb != "restart" || str(after["InvocationID"]) != expected) {
			break
		}
		select {
		case <-ctx.Done():
			return finish(Object{"before": before, "call": call, "after": after}, errors.New("systemd operation not confirmed before deadline; outcome unknown"))
		case <-time.After(time.Second):
		}
	}
	return finish(Object{"before": before, "call": call, "after": after, "verification": "systemd unit transition only; functional recovery requires subsequent probes"}, nil)
}
func number(v any, fallback int) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	}
	return fallback
}
func errorString(e error) any {
	if e == nil {
		return nil
	}
	return e.Error()
}

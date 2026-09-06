package main

import (
	"bufio"
	"context"
	"encoding/json"
	"os/exec"
	"strconv"
	"time"
)

func (a *App) journalHealth() Object {
	collectors := Object{}
	for _, source := range []string{"bot", "database", "kernel", "nginx", "core", "analysis"} {
		if reason := serviceActionUnavailable(a.cfg, "logs.previous_boot", Object{"source": source}); reason != "" {
			collectors[source] = Object{"state": "not_applicable", "available": false, "reason": reason}
			continue
		}
		var info Object
		if a.store.getSetting("journal_health_"+source, &info) == nil {
			collectors[source] = info
		} else {
			collectors[source] = Object{"state": "not_observed"}
		}
	}
	return collectors
}

// Per-entry journal cursors are advanced only after the corresponding event
// transaction commits. --follow --no-tail reads forwards; truncating a normal
// `journalctl -n` response would silently skip backlog entries.
func (a *App) collectJournals(ctx context.Context) {
	for _, source := range []string{"bot", "database", "kernel", "nginx", "core", "analysis"} {
		if serviceActionUnavailable(a.cfg, "logs.previous_boot", Object{"source": source}) != "" {
			continue
		}
		go func(source string) {
			ticker := time.NewTicker(15 * time.Second)
			defer ticker.Stop()
			for {
				a.collectJournalBatch(ctx, source)
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
			}
		}(source)
	}
	<-ctx.Done()
}
func (a *App) collectJournalBatch(ctx context.Context, source string) {
	if serviceActionUnavailable(a.cfg, "logs.previous_boot", Object{"source": source}) != "" {
		return
	}
	var cursor string
	_ = a.store.getSetting("journal_cursor_"+source, &cursor)
	args := []string{"--no-pager", "--output=json", "--follow", "--no-tail"}
	switch source {
	case "bot":
		args = append(args, "-u", a.cfg.BotUnit)
	case "database":
		args = append(args, "-u", "mysql.service")
	case "kernel":
		args = append(args, "_TRANSPORT=kernel")
	case "nginx":
		args = append(args, "-u", "nginx.service")
	case "core":
		args = append(args, "-u", "cbte-admin.service")
	case "analysis":
		args = append(args, "-u", "cbte-admin-analysis.service")
	default:
		return
	}
	if cursor != "" {
		args = append(args, "--after-cursor", cursor)
	} else {
		args = append(args, "--since", "-5 minutes")
	}
	child, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	cmd := exec.CommandContext(child, "journalctl", args...)
	configureProcess(cmd)
	stderr := &boundedBuffer{limit: 16 << 10}
	cmd.Stderr = stderr
	stdout, e := cmd.StdoutPipe()
	if e != nil {
		return
	}
	if e = cmd.Start(); e != nil {
		_ = a.store.setSetting("journal_health_"+source, Object{"available": false, "error": "journalctl could not start", "observedAt": now()})
		return
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	events := []Object{}
	lastCursor, lastAt := "", ""
	bytes := 0
	for scanner.Scan() {
		line := append([]byte(nil), scanner.Bytes()...)
		var item Object
		if json.Unmarshal(line, &item) != nil {
			continue
		}
		c := first(item, "__CURSOR")
		if c == "" {
			continue
		}
		stamp := now()
		if micros, e := strconv.ParseInt(first(item, "__REALTIME_TIMESTAMP"), 10, 64); e == nil {
			stamp = time.UnixMicro(micros).UTC().Format(timestampLayout)
		}
		events = append(events, Object{"id": "journal:" + tokenHash(c), "kind": "journal.entry", "occurredAt": stamp, "source": source, "bootId": first(item, "_BOOT_ID"), "details": item})
		lastCursor = c
		lastAt = stamp
		bytes += len(line)
		if len(events) >= 200 || bytes >= 4<<20 {
			cancel()
			break
		}
	}
	readErr := scanner.Err()
	endedByDeadline := child.Err() != nil
	cancel()
	_ = cmd.Wait()
	if len(events) > 0 {
		if _, _, e = a.store.ingest(events); e != nil {
			return
		}
		if e = a.store.setSetting("journal_cursor_"+source, lastCursor); e != nil {
			return
		}
	}
	state := Object{"available": true, "observedAt": now(), "recordsInBatch": len(events), "lastEventAt": lastAt, "cursorPresent": lastCursor != "" || cursor != "", "initialLookbackMinutes": 5, "batchLimit": 200}
	if len(events) == 0 && stderr.b.Len() > 0 {
		state["available"] = false
		state["error"] = stderr.b.String()
	}
	if readErr != nil && !endedByDeadline {
		state["available"] = false
		state["error"] = readErr.Error()
	}
	_ = a.store.setSetting("journal_health_"+source, state)
}

package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os/exec"
	"strconv"
	"time"
)

const (
	journalBatchEventLimit = 50
	journalBatchByteLimit  = 512 << 10
	journalStoreTimeout    = 3 * time.Second
)

func journalStateLimit(cfg Config) int64 {
	if cfg.JournalStateMaxBytes > 0 {
		return cfg.JournalStateMaxBytes
	}
	return 2 << 30
}

func (a *App) reportJournalPause(ctx context.Context, source, reason string, cursorPresent bool, rawEventsStored any) {
	stateCtx, cancel := context.WithTimeout(ctx, journalStoreTimeout)
	defer cancel()
	_ = a.store.setSettingContext(stateCtx, "journal_health_"+source, Object{
		"state": "paused", "available": false, "reason": reason, "observedAt": now(),
		"cursorPresent": cursorPresent, "cursorAdvanced": false, "rawEventsStored": rawEventsStored,
	})
}

func (a *App) reportJournalStoragePause(ctx context.Context, source string, cursorPresent, started bool, size, limit int64) {
	stateCtx, cancel := context.WithTimeout(ctx, journalStoreTimeout)
	defer cancel()
	_ = a.store.setSettingContext(stateCtx, "journal_health_"+source, Object{
		"state": "paused", "available": false, "reason": "storage_limit", "observedAt": now(),
		"cursorPresent": cursorPresent, "cursorAdvanced": false, "rawEventsStored": false,
		"journalctlStarted": started, "storageLimited": true, "stateBytes": size,
		"stateLimitBytes": limit, "rawEventsAvailableVia": "journalctl",
	})
}

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
	a.collectJournalBatchWith(ctx, source, exec.CommandContext)
}

// The factory seam keeps the real collector path testable with a bounded,
// deterministic journalctl substitute and an actual SQLite store.
func (a *App) collectJournalBatchWith(ctx context.Context, source string, command func(context.Context, string, ...string) *exec.Cmd) {
	if serviceActionUnavailable(a.cfg, "logs.previous_boot", Object{"source": source}) != "" {
		return
	}
	var cursor string
	cursorCtx, cancelCursorRead := context.WithTimeout(ctx, journalStoreTimeout)
	cursorErr := a.store.getSettingContext(cursorCtx, "journal_cursor_"+source, &cursor)
	cancelCursorRead()
	if cursorErr != nil && !errors.Is(cursorErr, sql.ErrNoRows) {
		a.reportJournalPause(ctx, source, "cursor_unavailable", false, false)
		return
	}
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
		// Persist the initial lookback boundary before reading. If storage is
		// full before the first cursor is committed, a moving "-5 minutes"
		// window would silently discard the oldest unpersisted records.
		var since string
		sinceCtx, cancelSinceRead := context.WithTimeout(ctx, journalStoreTimeout)
		sinceErr := a.store.getSettingContext(sinceCtx, "journal_start_"+source, &since)
		cancelSinceRead()
		if errors.Is(sinceErr, sql.ErrNoRows) {
			proposed := time.Now().UTC().Add(-5 * time.Minute).Format("2006-01-02 15:04:05 UTC")
			writeCtx, cancelSinceWrite := context.WithTimeout(ctx, journalStoreTimeout)
			_, sinceErr = a.store.db.ExecContext(writeCtx, "INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", "journal_start_"+source, encode(proposed))
			cancelSinceWrite()
			if sinceErr == nil {
				readCtx, cancelRead := context.WithTimeout(ctx, journalStoreTimeout)
				sinceErr = a.store.getSettingContext(readCtx, "journal_start_"+source, &since)
				cancelRead()
			}
		}
		if sinceErr == nil {
			_, sinceErr = time.Parse("2006-01-02 15:04:05 MST", since)
		}
		if sinceErr != nil || since == "" {
			a.reportJournalPause(ctx, source, "initial_boundary_unavailable", false, false)
			return
		}
		args = append(args, "--since", since)
	}
	// Avoid repeatedly launching six journalctl processes to read the same
	// undeliverable entries while storage is already known to be at its cap.
	stateBytes, sizeErr := a.store.stateBytes()
	if sizeErr != nil {
		a.reportJournalPause(ctx, source, "storage_size_unavailable", cursor != "", false)
		return
	}
	stateLimit := journalStateLimit(a.cfg)
	if stateBytes >= stateLimit {
		a.reportJournalStoragePause(ctx, source, cursor != "", false, stateBytes, stateLimit)
		return
	}
	child, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	cmd := command(child, "journalctl", args...)
	configureProcess(cmd)
	stderr := &boundedBuffer{limit: 16 << 10}
	cmd.Stderr = stderr
	stdout, e := cmd.StdoutPipe()
	if e != nil {
		return
	}
	if e = cmd.Start(); e != nil {
		stateCtx, cancelStateWrite := context.WithTimeout(ctx, journalStoreTimeout)
		_ = a.store.setSettingContext(stateCtx, "journal_health_"+source, Object{"available": false, "error": "journalctl could not start", "observedAt": now()})
		cancelStateWrite()
		return
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	events := []Object{}
	lastCursor, lastAt := "", ""
	bytes := 0
	malformed := false
	for scanner.Scan() {
		line := append([]byte(nil), scanner.Bytes()...)
		var item Object
		if json.Unmarshal(line, &item) != nil {
			// Advancing beyond a line we could not interpret would silently
			// discard it. Keep the last confirmed cursor and report the pause.
			malformed = true
			cancel()
			break
		}
		c := first(item, "__CURSOR")
		if c == "" {
			malformed = true
			cancel()
			break
		}
		stamp := now()
		if micros, e := strconv.ParseInt(first(item, "__REALTIME_TIMESTAMP"), 10, 64); e == nil {
			stamp = time.UnixMicro(micros).UTC().Format(timestampLayout)
		}
		events = append(events, Object{"id": "journal:" + tokenHash(c), "kind": "journal.entry", "occurredAt": stamp, "source": source, "bootId": first(item, "_BOOT_ID"), "details": item})
		lastCursor = c
		lastAt = stamp
		bytes += len(line)
		if len(events) >= journalBatchEventLimit || bytes >= journalBatchByteLimit {
			cancel()
			break
		}
	}
	readErr := scanner.Err()
	endedByDeadline := child.Err() != nil
	cancel()
	_ = cmd.Wait()
	stateBytes, sizeErr = a.store.stateBytes()
	if sizeErr != nil {
		a.reportJournalPause(ctx, source, "storage_size_unavailable", cursor != "", false)
		return
	}
	storageLimited := stateBytes >= stateLimit
	if len(events) > 0 && !storageLimited {
		storeCtx, cancelStore := context.WithTimeout(ctx, journalStoreTimeout)
		if _, _, e = a.store.ingestContext(storeCtx, events); e != nil {
			cancelStore()
			// A failed COMMIT can have an ambiguous outcome; do not claim that
			// the raw events were absent. Retrying the unchanged cursor is safe.
			a.reportJournalPause(ctx, source, "event_persist_failed", cursor != "", nil)
			return
		}
		if e = a.store.setSettingContext(storeCtx, "journal_cursor_"+source, lastCursor); e != nil {
			cancelStore()
			a.reportJournalPause(ctx, source, "cursor_persist_failed", cursor != "", true)
			return
		}
		cancelStore()
	}
	state := Object{"available": true, "observedAt": now(), "recordsInBatch": len(events), "lastEventAt": lastAt, "cursorPresent": !storageLimited && lastCursor != "" || cursor != "", "initialLookbackMinutes": 5, "batchLimit": journalBatchEventLimit, "batchByteLimit": journalBatchByteLimit, "stateBytes": stateBytes, "stateLimitBytes": stateLimit, "rawEventsStored": !storageLimited}
	if storageLimited {
		a.reportJournalStoragePause(ctx, source, cursor != "", true, stateBytes, stateLimit)
		return
	}
	if len(events) == 0 && stderr.b.Len() > 0 {
		state["available"] = false
		state["error"] = stderr.b.String()
	}
	if malformed {
		state["state"] = "paused"
		state["available"] = false
		state["reason"] = "invalid_journal_entry"
		state["cursorAdvanced"] = lastCursor != ""
		state["unverifiedEntryRetained"] = true
	}
	if readErr != nil && !endedByDeadline {
		state["available"] = false
		state["error"] = readErr.Error()
	}
	stateCtx, cancelStateWrite := context.WithTimeout(ctx, journalStoreTimeout)
	_ = a.store.setSettingContext(stateCtx, "journal_health_"+source, state)
	cancelStateWrite()
}

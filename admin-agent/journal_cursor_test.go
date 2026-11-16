package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The child uses the same executable and command path as the real collector,
// but emits a controlled sequence instead of reading the system journal.
func TestJournalCursorHelperProcess(t *testing.T) {
	if os.Getenv("CBTE_TEST_JOURNAL_HELPER") != "1" {
		return
	}
	if raw := os.Getenv("CBTE_TEST_JOURNAL_RAW_LINES"); raw != "" {
		var lines []string
		if err := json.Unmarshal([]byte(raw), &lines); err != nil {
			os.Exit(2)
		}
		after := ""
		for i, value := range os.Args {
			if value == "--after-cursor" && i+1 < len(os.Args) {
				after = os.Args[i+1]
			}
		}
		start := 0
		for i, line := range lines {
			var entry Object
			if json.Unmarshal([]byte(line), &entry) == nil && after != "" && first(entry, "__CURSOR") == after {
				start = i + 1
				break
			}
		}
		for _, line := range lines[start:] {
			fmt.Println(line)
		}
		os.Exit(0)
	}
	var entries []Object
	if err := json.Unmarshal([]byte(os.Getenv("CBTE_TEST_JOURNAL_ENTRIES")), &entries); err != nil {
		os.Exit(2)
	}
	after := ""
	for i, value := range os.Args {
		if value == "--after-cursor" && i+1 < len(os.Args) {
			after = os.Args[i+1]
		}
	}
	start := 0
	for i, entry := range entries {
		if first(entry, "__CURSOR") == after && after != "" {
			start = i + 1
			break
		}
	}
	for _, entry := range entries[start:] {
		fmt.Println(encode(entry))
	}
	os.Exit(0)
}

func TestJournalMalformedEntriesDoNotAdvancePastUnverifiedData(t *testing.T) {
	for _, invalid := range []string{"{bad json", `{"MESSAGE":"cursor missing"}`} {
		t.Run(invalid, func(t *testing.T) {
			a := testApp(t)
			a.cfg.JournalStateMaxBytes = 1 << 40
			if err := a.store.setSetting("journal_cursor_bot", "prior"); err != nil {
				t.Fatal(err)
			}
			lines := []string{encode(Object{"__CURSOR": "first", "MESSAGE": "valid"}), invalid, encode(Object{"__CURSOR": "later", "MESSAGE": "must not pass"})}
			calls := 0
			command := func(ctx context.Context, name string, args ...string) *exec.Cmd {
				calls++
				cmd := exec.CommandContext(ctx, os.Args[0], append([]string{"-test.run=^TestJournalCursorHelperProcess$", "--"}, args...)...)
				cmd.Env = append(os.Environ(), "CBTE_TEST_JOURNAL_HELPER=1", "CBTE_TEST_JOURNAL_RAW_LINES="+encode(lines))
				return cmd
			}
			for i := 0; i < 2; i++ {
				a.collectJournalBatchWith(context.Background(), "bot", command)
				if cursor, count := journalCursor(t, a), journalCount(t, a); cursor != "first" || count != 1 {
					t.Fatalf("invalid line was skipped: cursor=%q count=%d", cursor, count)
				}
				var health Object
				if err := a.store.getSetting("journal_health_bot", &health); err != nil || health["available"] != false || health["reason"] != "invalid_journal_entry" {
					t.Fatalf("missing failure report: %#v %v", health, err)
				}
			}
			if calls != 2 {
				t.Fatalf("unexpected collector calls: %d", calls)
			}
		})
	}
}

func fakeJournal(t *testing.T, entries []Object, calls *int) func(context.Context, string, ...string) *exec.Cmd {
	t.Helper()
	return func(ctx context.Context, name string, args ...string) *exec.Cmd {
		if name != "journalctl" {
			t.Fatalf("unexpected program: %q", name)
		}
		*calls++
		cmd := exec.CommandContext(ctx, os.Args[0], append([]string{"-test.run=^TestJournalCursorHelperProcess$", "--"}, args...)...)
		cmd.Env = append(os.Environ(), "CBTE_TEST_JOURNAL_HELPER=1", "CBTE_TEST_JOURNAL_ENTRIES="+encode(entries))
		return cmd
	}
}

func journalCursor(t *testing.T, a *App) string {
	t.Helper()
	var value string
	if err := a.store.getSetting("journal_cursor_bot", &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func journalCount(t *testing.T, a *App) int {
	t.Helper()
	var count int
	if err := a.store.db.QueryRow("SELECT COUNT(*) FROM events WHERE kind='journal.entry'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func sampleJournal() []Object {
	return []Object{{"__CURSOR": "first", "__REALTIME_TIMESTAMP": "1700000000000000", "MESSAGE": "first"},
		{"__CURSOR": "second", "__REALTIME_TIMESTAMP": "1700000001000000", "MESSAGE": "second"}}
}

func TestJournalStoragePausePreservesCursorAndResumesWithoutDuplicates(t *testing.T) {
	a := testApp(t)
	if err := a.store.setSetting("journal_cursor_bot", "prior"); err != nil {
		t.Fatal(err)
	}
	a.cfg.JournalStateMaxBytes = 1
	calls := 0
	command := fakeJournal(t, sampleJournal(), &calls)
	a.collectJournalBatchWith(context.Background(), "bot", command)
	if cursor, count := journalCursor(t, a), journalCount(t, a); cursor != "prior" || count != 0 {
		t.Fatalf("storage pause changed cursor or stored an event: cursor=%q count=%d", cursor, count)
	}
	var health Object
	if err := a.store.getSetting("journal_health_bot", &health); err != nil {
		t.Fatal(err)
	}
	if health["state"] != "paused" || health["available"] != false || health["journalctlStarted"] != false || health["reason"] != "storage_limit" || health["storageLimited"] != true || health["cursorAdvanced"] != false || calls != 0 {
		t.Fatalf("storage pause was not visible: %#v", health)
	}
	response := request(t, a, "GET", "/v1/health", nil)
	if response.Code != 200 {
		t.Fatalf("health endpoint failed during a collection pause: %d", response.Code)
	}
	visible := nested(nested(object(t, response), "journalCollectors"), "bot")
	if visible["available"] != false || visible["state"] != "paused" || visible["journalctlStarted"] != false {
		t.Fatalf("health API misrepresented the paused collector: %#v", visible)
	}
	// Other event producers remain independent from the journal-only limit.
	if _, accepted, err := a.store.ingest([]Object{{"id": "ordinary", "kind": "observation"}}); err != nil || accepted != 1 {
		t.Fatalf("ordinary event ingestion regressed: %d %v", accepted, err)
	}
	a.cfg.JournalStateMaxBytes = 1 << 40
	a.collectJournalBatchWith(context.Background(), "bot", command)
	if cursor, count := journalCursor(t, a), journalCount(t, a); cursor != "second" || count != 2 {
		t.Fatalf("resume did not persist the backlog: cursor=%q count=%d", cursor, count)
	}
	a.collectJournalBatchWith(context.Background(), "bot", command)
	if cursor, count := journalCursor(t, a), journalCount(t, a); cursor != "second" || count != 2 || calls != 2 {
		t.Fatalf("replay duplicated an event: cursor=%q count=%d calls=%d", cursor, count, calls)
	}
}

func TestJournalFirstRunPauseKeepsInitialLookbackFixed(t *testing.T) {
	a := testApp(t)
	a.cfg.JournalStateMaxBytes = 1
	calls := 0
	base := fakeJournal(t, sampleJournal(), &calls)
	var boundaries []string
	command := func(ctx context.Context, name string, args ...string) *exec.Cmd {
		for i, value := range args {
			if value == "--since" && i+1 < len(args) {
				boundaries = append(boundaries, args[i+1])
			}
		}
		return base(ctx, name, args...)
	}
	a.collectJournalBatchWith(context.Background(), "bot", command)
	a.collectJournalBatchWith(context.Background(), "bot", command)
	var start, cursor string
	if err := a.store.getSetting("journal_start_bot", &start); err != nil {
		t.Fatal(err)
	}
	if err := a.store.getSetting("journal_cursor_bot", &cursor); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("a paused first run wrote a cursor: %q %v", cursor, err)
	}
	if len(boundaries) != 0 || start == "" || journalCount(t, a) != 0 {
		t.Fatalf("initial lookback moved while paused: boundaries=%v stored=%q", boundaries, start)
	}
	a.cfg.JournalStateMaxBytes = 1 << 40
	a.collectJournalBatchWith(context.Background(), "bot", command)
	if len(boundaries) != 1 || boundaries[0] != start {
		t.Fatalf("resumed collection did not use the fixed boundary: boundaries=%v stored=%q", boundaries, start)
	}
	if got := journalCursor(t, a); got != "second" || journalCount(t, a) != 2 {
		t.Fatalf("first-run backlog did not resume: cursor=%q count=%d", got, journalCount(t, a))
	}
}

func TestJournalFirstRunDoesNotReadBeforeBoundaryIsDurable(t *testing.T) {
	a := testApp(t)
	if _, err := a.store.db.Exec(`CREATE TRIGGER test_reject_initial_boundary BEFORE INSERT ON settings
		WHEN NEW.key='journal_start_bot' BEGIN SELECT RAISE(ABORT, 'simulated boundary failure'); END`); err != nil {
		t.Fatal(err)
	}
	calls := 0
	a.collectJournalBatchWith(context.Background(), "bot", fakeJournal(t, sampleJournal(), &calls))
	var health Object
	if err := a.store.getSetting("journal_health_bot", &health); err != nil {
		t.Fatal(err)
	}
	if calls != 0 || journalCount(t, a) != 0 || health["reason"] != "initial_boundary_unavailable" {
		t.Fatalf("undurable initial boundary was used: calls=%d health=%#v", calls, health)
	}
}

func TestJournalReadAndSizeFailuresNeverAdvanceCursor(t *testing.T) {
	t.Run("invalid cursor setting", func(t *testing.T) {
		a := testApp(t)
		if err := a.store.setSetting("journal_cursor_bot", 123); err != nil {
			t.Fatal(err)
		}
		calls := 0
		a.collectJournalBatchWith(context.Background(), "bot", fakeJournal(t, sampleJournal(), &calls))
		var health Object
		if err := a.store.getSetting("journal_health_bot", &health); err != nil {
			t.Fatal(err)
		}
		if calls != 0 || journalCount(t, a) != 0 || health["reason"] != "cursor_unavailable" {
			t.Fatalf("invalid cursor was treated as missing: calls=%d health=%#v", calls, health)
		}
	})
	t.Run("primary database size unavailable", func(t *testing.T) {
		a := testApp(t)
		if err := a.store.setSetting("journal_cursor_bot", "prior"); err != nil {
			t.Fatal(err)
		}
		a.store.path = filepath.Join(t.TempDir(), "missing.db")
		calls := 0
		a.collectJournalBatchWith(context.Background(), "bot", fakeJournal(t, sampleJournal(), &calls))
		var health Object
		if err := a.store.getSetting("journal_health_bot", &health); err != nil {
			t.Fatal(err)
		}
		if cursor, count := journalCursor(t, a), journalCount(t, a); calls != 0 || cursor != "prior" || count != 0 || health["reason"] != "storage_size_unavailable" {
			t.Fatalf("unknown storage size was accepted: calls=%d cursor=%q count=%d health=%#v", calls, cursor, count, health)
		}
	})
}

func TestJournalIngestFailureNeverAdvancesAndRetryDeduplicates(t *testing.T) {
	a := testApp(t)
	if err := a.store.setSetting("journal_cursor_bot", "prior"); err != nil {
		t.Fatal(err)
	}
	a.cfg.JournalStateMaxBytes = 1 << 40
	if _, err := a.store.db.Exec(`CREATE TRIGGER test_reject_journal BEFORE INSERT ON events
		WHEN NEW.kind='journal.entry' BEGIN SELECT RAISE(ABORT, 'simulated ingestion failure'); END`); err != nil {
		t.Fatal(err)
	}
	calls := 0
	command := fakeJournal(t, sampleJournal(), &calls)
	a.collectJournalBatchWith(context.Background(), "bot", command)
	if cursor, count := journalCursor(t, a), journalCount(t, a); cursor != "prior" || count != 0 {
		t.Fatalf("failed ingest advanced cursor: cursor=%q count=%d", cursor, count)
	}
	var health Object
	if err := a.store.getSetting("journal_health_bot", &health); err != nil || health["reason"] != "event_persist_failed" || health["cursorAdvanced"] != false {
		t.Fatalf("failed ingest did not report a pause: %#v %v", health, err)
	}
	if _, err := a.store.db.Exec("DROP TRIGGER test_reject_journal"); err != nil {
		t.Fatal(err)
	}
	a.collectJournalBatchWith(context.Background(), "bot", command)
	if cursor, count := journalCursor(t, a), journalCount(t, a); cursor != "second" || count != 2 {
		t.Fatalf("retry failed: cursor=%q count=%d", cursor, count)
	}
}

func TestJournalCommitFailureNeverAdvancesCursor(t *testing.T) {
	a := testApp(t)
	if err := a.store.setSetting("journal_cursor_bot", "prior"); err != nil {
		t.Fatal(err)
	}
	a.cfg.JournalStateMaxBytes = 1 << 40
	// A deferred foreign key fails at COMMIT, after the journal event INSERTs
	// have succeeded. This exercises a different boundary from an INSERT error.
	for _, statement := range []string{
		"PRAGMA foreign_keys=ON",
		"CREATE TABLE journal_test_parent (id INTEGER PRIMARY KEY)",
		"CREATE TABLE journal_test_child (parent_id INTEGER REFERENCES journal_test_parent(id) DEFERRABLE INITIALLY DEFERRED)",
		`CREATE TRIGGER test_fail_commit AFTER INSERT ON events WHEN NEW.kind='journal.entry'
		 BEGIN INSERT INTO journal_test_child(parent_id) VALUES(99); END`,
	} {
		if _, err := a.store.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	calls := 0
	command := fakeJournal(t, sampleJournal(), &calls)
	a.collectJournalBatchWith(context.Background(), "bot", command)
	if cursor, count := journalCursor(t, a), journalCount(t, a); cursor != "prior" || count != 0 {
		t.Fatalf("failed COMMIT advanced cursor or retained an event: cursor=%q count=%d", cursor, count)
	}
	if _, err := a.store.db.Exec("DROP TRIGGER test_fail_commit"); err != nil {
		t.Fatal(err)
	}
	a.collectJournalBatchWith(context.Background(), "bot", command)
	if cursor, count := journalCursor(t, a), journalCount(t, a); cursor != "second" || count != 2 {
		t.Fatalf("retry after failed COMMIT failed: cursor=%q count=%d", cursor, count)
	}
}

func TestJournalCursorWriteFailureReplaysCommittedEventsWithoutDuplication(t *testing.T) {
	a := testApp(t)
	if err := a.store.setSetting("journal_cursor_bot", "prior"); err != nil {
		t.Fatal(err)
	}
	a.cfg.JournalStateMaxBytes = 1 << 40
	if _, err := a.store.db.Exec(`CREATE TRIGGER test_reject_cursor BEFORE INSERT ON settings
		WHEN NEW.key='journal_cursor_bot' BEGIN SELECT RAISE(ABORT, 'simulated cursor failure'); END`); err != nil {
		t.Fatal(err)
	}
	calls := 0
	command := fakeJournal(t, sampleJournal(), &calls)
	a.collectJournalBatchWith(context.Background(), "bot", command)
	if cursor, count := journalCursor(t, a), journalCount(t, a); cursor != "prior" || count != 2 {
		t.Fatalf("cursor write failure lost evidence: cursor=%q count=%d", cursor, count)
	}
	var health Object
	if err := a.store.getSetting("journal_health_bot", &health); err != nil || health["reason"] != "cursor_persist_failed" || health["rawEventsStored"] != true {
		t.Fatalf("cursor write failure did not report a pause: %#v %v", health, err)
	}
	if _, err := a.store.db.Exec("DROP TRIGGER test_reject_cursor"); err != nil {
		t.Fatal(err)
	}
	a.collectJournalBatchWith(context.Background(), "bot", command)
	if cursor, count := journalCursor(t, a), journalCount(t, a); cursor != "second" || count != 2 {
		t.Fatalf("retry duplicated events: cursor=%q count=%d", cursor, count)
	}
}

func TestStateSizeReportsMissingDatabase(t *testing.T) {
	s := &Store{path: filepath.Join(t.TempDir(), "missing.db")}
	if _, err := s.stateBytes(); !errors.Is(err, os.ErrNotExist) || !strings.Contains(err.Error(), "missing.db") {
		t.Fatalf("missing database was treated as empty: %v", err)
	}
}

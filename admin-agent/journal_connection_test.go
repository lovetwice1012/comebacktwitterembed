package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"modernc.org/sqlite"
)

// This test-only wrapper uses the real SQLite driver but simulates a failure
// on the explicit ROLLBACK after a real deferred-constraint COMMIT failure.
type rollbackFaultDriver struct {
	opens, closes, failures atomic.Int32
	failRollback            atomic.Bool
}

func (d *rollbackFaultDriver) Open(name string) (driver.Conn, error) {
	inner, err := (&sqlite.Driver{}).Open(name)
	if err != nil {
		return nil, err
	}
	d.opens.Add(1)
	return &rollbackFaultConn{Conn: inner, owner: d}, nil
}

type rollbackFaultConn struct {
	driver.Conn
	owner *rollbackFaultDriver
}

func (c *rollbackFaultConn) Close() error { c.owner.closes.Add(1); return c.Conn.Close() }
func (c *rollbackFaultConn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	return c.Conn.(driver.ConnBeginTx).BeginTx(ctx, opts)
}
func (c *rollbackFaultConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if strings.EqualFold(strings.TrimSpace(query), "ROLLBACK") && c.owner.failRollback.CompareAndSwap(true, false) {
		c.owner.failures.Add(1)
		return nil, errors.New("simulated rollback failure")
	}
	return c.Conn.(driver.ExecerContext).ExecContext(ctx, query, args)
}
func (c *rollbackFaultConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	return c.Conn.(driver.QueryerContext).QueryContext(ctx, query, args)
}

func TestJournalFailedCommitAndRollbackReopenConfiguredWriter(t *testing.T) {
	a := testApp(t)
	if err := a.store.db.Close(); err != nil {
		t.Fatal(err)
	}
	fault := &rollbackFaultDriver{}
	name := fmt.Sprintf("journal-fault-%d", time.Now().UnixNano())
	sql.Register(name, fault)
	uri, err := url.Parse(sqliteWriterURI(a.store.path))
	if err != nil {
		t.Fatal(err)
	}
	values := uri.Query()
	values.Add("_pragma", "foreign_keys(ON)") // Test-only deferred COMMIT error.
	uri.RawQuery = values.Encode()
	a.store.db, err = sql.Open(name, uri.String())
	if err != nil {
		t.Fatal(err)
	}
	a.store.db.SetMaxOpenConns(1)
	for _, statement := range []string{
		"CREATE TABLE journal_test_parent (id INTEGER PRIMARY KEY)",
		"CREATE TABLE journal_test_child (parent_id INTEGER REFERENCES journal_test_parent(id) DEFERRABLE INITIALLY DEFERRED)",
		`CREATE TRIGGER test_fail_commit AFTER INSERT ON events WHEN NEW.kind='journal.entry'
		 BEGIN INSERT INTO journal_test_child(parent_id) VALUES(99); END`,
	} {
		if _, err := a.store.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.store.setSetting("journal_cursor_bot", "prior"); err != nil {
		t.Fatal(err)
	}
	a.cfg.JournalStateMaxBytes = 1 << 40
	fault.failRollback.Store(true)
	calls := 0
	command := fakeJournal(t, sampleJournal(), &calls)
	a.collectJournalBatchWith(context.Background(), "bot", command)
	if fault.failures.Load() != 1 || fault.opens.Load() < 2 || fault.closes.Load() < 1 {
		t.Fatalf("writer was not discarded and reopened: failures=%d opens=%d closes=%d", fault.failures.Load(), fault.opens.Load(), fault.closes.Load())
	}
	if cursor, count := journalCursor(t, a), journalCount(t, a); cursor != "prior" || count != 0 {
		t.Fatalf("failed COMMIT/ROLLBACK changed durable state: cursor=%q count=%d", cursor, count)
	}
	for pragma, expected := range map[string]int{"busy_timeout": 5000, "synchronous": 2, "foreign_keys": 1} {
		var value int
		if err := a.store.db.QueryRow("PRAGMA " + pragma).Scan(&value); err != nil || value != expected {
			t.Fatalf("%s after reconnect: got %d want %d: %v", pragma, value, expected, err)
		}
	}
	var mode string
	if err := a.store.db.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("journal mode after reconnect: %q %v", mode, err)
	}
	if _, err := a.store.db.Exec("DROP TRIGGER test_fail_commit"); err != nil {
		t.Fatal(err)
	}
	a.collectJournalBatchWith(context.Background(), "bot", command)
	if cursor, count := journalCursor(t, a), journalCount(t, a); cursor != "second" || count != 2 {
		t.Fatalf("reconnected writer could not ingest: cursor=%q count=%d", cursor, count)
	}

	// The replacement must wait for another SQLite writer instead of failing
	// immediately with SQLITE_BUSY when contention clears within the timeout.
	locker, err := sql.Open("sqlite", sqliteConnectionURI(a.store.path, nil))
	if err != nil {
		t.Fatal(err)
	}
	defer locker.Close()
	if _, err := locker.Exec("BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := a.store.db.Exec("INSERT INTO settings(key,value) VALUES('journal_contention_test','1')")
		result <- err
	}()
	select {
	case err := <-result:
		t.Fatalf("replacement writer did not wait for the lock: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	if _, err := locker.Exec("COMMIT"); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("replacement writer failed after lock release: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("replacement writer did not resume after lock release")
	}
}

func TestSQLiteConnectionURIHandlesSpacesAndHash(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state # 日本語")
	store, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.setSetting("connection_path", "ok"); err != nil {
		t.Fatal(err)
	}
	var actual string
	if err := store.getSetting("connection_path", &actual); err != nil || actual != "ok" {
		t.Fatalf("database path did not survive URI encoding: %q %v", actual, err)
	}
}

func TestSQLiteReaderPragmasApplyToMultipleConnections(t *testing.T) {
	a := testApp(t)
	db, err := sql.Open("sqlite", sqliteReaderURI(a.store.path))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(2)
	first, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	for i, conn := range []*sql.Conn{first, second} {
		var value int
		if err := conn.QueryRowContext(context.Background(), "PRAGMA busy_timeout").Scan(&value); err != nil || value != 5000 {
			t.Fatalf("reader connection %d busy_timeout=%d: %v", i, value, err)
		}
	}
}

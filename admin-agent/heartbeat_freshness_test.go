package main

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

// A pooled reader can retain an older WAL snapshot after a failed query. Keep
// that condition deterministic here instead of relying on a cancellation race.
func TestHeartbeatDoesNotReusePinnedAnalyticsSnapshot(t *testing.T) {
	a := testApp(t)
	s := a.store
	if s.readDB == nil {
		var err error
		s.readDB, err = sql.Open("sqlite", s.path)
		if err != nil {
			t.Fatal(err)
		}
	}
	s.readDB.SetMaxOpenConns(1)
	s.readDB.SetMaxIdleConns(1)
	ctx := context.Background()
	old := time.Now().UTC().Add(-10 * time.Minute).Format(timestampLayout)
	if _, _, err := s.ingest([]Object{{"id": "old", "kind": "heartbeat", "occurredAt": old}}); err != nil {
		t.Fatal(err)
	}
	reader, err := s.readDB.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = reader.ExecContext(ctx, "BEGIN"); err != nil {
		reader.Close()
		t.Fatal(err)
	}
	var pinned string
	err = reader.QueryRowContext(ctx, "SELECT occurred_at FROM latest_heartbeat WHERE id=1").Scan(&pinned)
	reader.Close()
	defer func() { _, _ = s.readDB.Exec("ROLLBACK") }()
	if err != nil || pinned != old {
		t.Fatalf("pin reader snapshot: timestamp=%s error=%v", pinned, err)
	}
	for i := 0; i < 3; i++ {
		stamp := time.Now().UTC().Add(time.Duration(i) * time.Second).Format(timestampLayout)
		if _, _, err := s.ingest([]Object{{"id": stamp, "kind": "heartbeat", "occurredAt": stamp}}); err != nil {
			t.Fatal(err)
		}
		if err := s.readDB.QueryRow("SELECT occurred_at FROM latest_heartbeat WHERE id=1").Scan(&pinned); err != nil || pinned != old {
			t.Fatalf("fixture lost pinned snapshot: timestamp=%s error=%v", pinned, err)
		}
		_, observed, _, err := s.latestHeartbeat(ctx)
		if err != nil || observed != stamp {
			t.Fatalf("monitor read stale pooled heartbeat: got=%s want=%s error=%v", observed, stamp, err)
		}
	}
}

func TestHeartbeatStillReportsRealStaleness(t *testing.T) {
	a := testApp(t)
	old := time.Now().UTC().Add(-10 * time.Minute).Format(timestampLayout)
	if _, _, err := a.store.ingest([]Object{{"id": "stopped-bot", "kind": "heartbeat", "occurredAt": old}}); err != nil {
		t.Fatal(err)
	}
	_, observed, _, err := a.store.latestHeartbeat(context.Background())
	if err != nil || observed != old {
		t.Fatalf("real stale heartbeat was hidden: got=%s want=%s error=%v", observed, old, err)
	}
}

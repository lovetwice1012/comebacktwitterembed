package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestReportReadReleasesWaitWhenRequestIsCancelled(t *testing.T) {
	a := testApp(t)
	// Initialize authentication before deliberately occupying the query pool.
	if w := request(t, a, "GET", "/v1/catalog", nil); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	conn, err := a.store.queryDB().Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := httptest.NewRequest("GET", "/v1/reports/overview", nil).WithContext(ctx)
	r.Header.Set("X-Admin-Agent-Token", a.cfg.Token)
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { a.routes().ServeHTTP(w, r); close(done) }()
	cancel()
	select {
	case <-done:
		if w.Code != 503 {
			t.Fatalf("cancelled read must be an unavailable result, got %d", w.Code)
		}
	case <-time.After(200 * time.Millisecond):
		conn.Close()
		<-done
		t.Fatal("report read kept waiting for the database after its client cancelled")
	}
}

func TestInterruptedWorkerResponseKeepsTransportFailureAndUncertainty(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			conn.Close()
		}
	}))
	defer server.Close()
	for _, kind := range []string{"reports.build", "settings.change"} {
		t.Run(kind, func(t *testing.T) {
			a := testApp(t)
			a.cfg.WorkerURL, a.cfg.ReportWorkerURL = server.URL, server.URL
			ac, _, err := a.store.enqueue(kind, Object{"kind": "overview"}, "transport-test", a.cfg.Owner, "test")
			if err != nil {
				t.Fatal(err)
			}
			a.execute(context.Background(), ac)
			result, err := a.store.action(ac.ID)
			if err != nil {
				t.Fatal(err)
			}
			problem, _ := result.Error.(map[string]any)
			if str(problem["code"]) != "WORKER_TRANSPORT_FAILED" {
				t.Fatalf("transport error was hidden: %v", problem)
			}
			if kind == "settings.change" && result.Status != "unknown" {
				t.Fatalf("write outcome must remain unknown: %s", result.Status)
			}
		})
	}
}

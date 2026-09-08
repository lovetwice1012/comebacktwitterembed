package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func activeProxyFixture(t *testing.T, activeNode string, peer http.Handler) *App {
	t.Helper()
	peerServer := httptest.NewServer(peer)
	t.Cleanup(peerServer.Close)
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/status" || r.Header.Get("Authorization") != "Bearer "+strings.Repeat("c", 64) {
			http.Error(w, "bad controller request", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"activeNode":%q}`, activeNode)
	}))
	t.Cleanup(controller.Close)
	a := testApp(t)
	a.cfg.RecoveryNode = "primary"
	a.cfg.RecoveryControllerURL = controller.URL
	a.cfg.RecoveryControllerToken = strings.Repeat("c", 64)
	a.cfg.ActivePeerURL = peerServer.URL
	a.cfg.ActivePeerToken = strings.Repeat("p", 64)
	return a
}

func TestActiveProxyForwardsAuthenticatedReadsToCurrentOwner(t *testing.T) {
	called := 0
	a := activeProxyFixture(t, "oci", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called++
		if r.URL.Path != "/v1/shards" || r.Header.Get("X-Admin-Agent-Token") != strings.Repeat("p", 64) || r.Header.Get("X-Admin-Actor") != "123" || r.Header.Get(activeProxyHeader) != tokenHash(strings.Repeat("p", 64)) || r.Header.Get("Cookie") != "" {
			http.Error(w, "bad peer request", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"state":"recent_heartbeat","items":[]}`)
	}))
	r := httptest.NewRequest(http.MethodGet, "/v1/shards?x=1", nil)
	r.Header.Set("X-Admin-Agent-Token", a.cfg.Token)
	r.Header.Set("X-Admin-Actor", a.cfg.Owner)
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	if w.Code != http.StatusOK || called != 1 || !strings.Contains(w.Body.String(), "recent_heartbeat") || w.Header().Get("X-CBTE-Active-Source") != "oci" {
		t.Fatalf("active proxy failed: status=%d called=%d headers=%v body=%s", w.Code, called, w.Header(), w.Body.String())
	}
}

func TestActiveProxyKeepsLocalOwnerAndDoesNotForwardTelemetryPosts(t *testing.T) {
	called := 0
	a := activeProxyFixture(t, "primary", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called++ }))
	r := httptest.NewRequest(http.MethodGet, "/v1/shards", nil)
	r.Header.Set("X-Admin-Agent-Token", a.cfg.Token)
	r.Header.Set("X-Admin-Actor", a.cfg.Owner)
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	if w.Code != http.StatusOK || called != 0 || w.Header().Get("X-CBTE-Active-Source") != "local" {
		t.Fatalf("local active owner was not retained: status=%d called=%d headers=%v body=%s", w.Code, called, w.Header(), w.Body.String())
	}
	post := httptest.NewRequest(http.MethodPost, "/v1/events", strings.NewReader(`{"id":"local-event"}`))
	post.Header.Set("X-Admin-Agent-Token", a.cfg.Token)
	post.Header.Set("X-Admin-Actor", a.cfg.Owner)
	post.Header.Set("Content-Type", "application/json")
	postWriter := httptest.NewRecorder()
	a.routes().ServeHTTP(postWriter, post)
	if postWriter.Code != http.StatusOK || called != 0 {
		t.Fatalf("telemetry post was forwarded: status=%d called=%d body=%s", postWriter.Code, called, postWriter.Body.String())
	}
}


func TestRecoveryViewsStayOnLocalControllerDuringPrimaryOutage(t *testing.T) {
	for _, path := range []string{"/v1/recovery", "/v1/recovery/workload-logs"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		if activeProxyPath(r) {
			t.Fatalf("recovery path was routed to the active peer: %s", path)
		}
	}
}

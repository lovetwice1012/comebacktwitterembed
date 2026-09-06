package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestRecoveryStatusBothAdminsAndCredentialBoundary(t *testing.T) {
	a := oauthApp(t)
	token := strings.Repeat("fixture-recovery-token-", 3)
	var calls atomic.Int32
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "GET" || r.URL.Path != "/v1/status" || r.Header.Get("Authorization") != "Bearer "+token {
			t.Error("controller request lost fixed endpoint or authentication")
		}
		if r.Header.Get("X-Admin-Agent-Token") != "" || r.Header.Get("Cookie") != "" {
			t.Error("administrator session was forwarded to controller")
		}
		jsonResponse(w, 200, Object{"phase": "STANDBY_READY", "activeNode": "primary", "primaryEnrolled": true,
			"candidate":                     Object{"checks": Object{"ciphertextVerified": true}, "statusToken": "must-not-reach-browser"},
			"nodeObservations":              Object{"primary": Object{"instanceId": "primary:observed-instance", "receivedAt": 1234, "stale": true, "scope": "last_reported_observation_not_current_health", "primaryIoWatch": Object{"state": "observing", "reason": "continuous_stall_candidate", "continuousSeconds": 175, "evidence": Object{"physicalWrites": "18446744073709551615"}}}},
			"authorityObservationFetchedAt": "2026-09-06T05:00:00Z",
			"lastError":                     Object{"message": "header accidentally contained " + token}, "authorityControllerToken": "must-not-reach-browser"})
	}))
	defer controller.Close()
	a.cfg.RecoveryControllerURL, a.cfg.RecoveryControllerToken = controller.URL, token
	for _, actor := range []string{firstAdmin, secondAdmin} {
		w := principalRequest(a, "GET", "/v1/recovery", actor, nil, nil, "")
		if w.Code != 200 || object(t, w)["available"] != true || object(t, w)["phase"] != "STANDBY_READY" {
			t.Fatalf("allowed administrator recovery status failed %s", w.Body)
		}
		if strings.Contains(w.Body.String(), token) || strings.Contains(w.Body.String(), "must-not-reach-browser") {
			t.Fatal("controller credentials escaped to browser")
		}
		observed := nested(nested(object(t, w), "nodeObservations"), "primary")
		if observed["stale"] != true || nested(observed, "primaryIoWatch")["state"] != "observing" || nested(nested(observed, "primaryIoWatch"), "evidence")["physicalWrites"] != "18446744073709551615" {
			t.Fatal("last reported I/O observation was dropped or misrepresented")
		}
	}
	if denied := principalRequest(a, "GET", "/v1/recovery", "111111111111111111", nil, nil, ""); denied.Code != 401 {
		t.Fatal("outside user obtained recovery status")
	}
	if calls.Load() != 2 {
		t.Fatal("unauthenticated request reached recovery controller")
	}
}

func TestRecoveryStatusRejectsExternalEndpointsAndRedirects(t *testing.T) {
	token := strings.Repeat("s", 48)
	for _, base := range []string{"https://127.0.0.1:34212", "http://outside.invalid:34212", "http://127.0.0.1.evil.test", "http://user@127.0.0.1", "http://127.0.0.1?redirect=/other", "http://127.0.0.1#fragment"} {
		if _, e := recoveryEndpoint(base, token); e == nil {
			t.Fatalf("untrusted endpoint accepted: %s", base)
		}
	}
	if u, e := recoveryEndpoint("http://localhost:34212/ignored", token); e != nil || u.String() != "http://127.0.0.1:34212/v1/status" {
		t.Fatalf("localhost was not pinned to loopback: %v %v", u, e)
	}
	a := oauthApp(t)
	var destinationCalls atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { destinationCalls.Add(1) }))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 302) }))
	defer redirect.Close()
	a.cfg.RecoveryControllerURL, a.cfg.RecoveryControllerToken = redirect.URL, token
	w := principalRequest(a, "GET", "/v1/recovery", secondAdmin, nil, nil, "")
	if w.Code != 503 || object(t, w)["state"] != "upstream_error" || destinationCalls.Load() != 0 {
		t.Fatal("redirect was followed or reported as healthy")
	}
}

func TestRecoveryUnavailableAndOversizedResponsesAreNotReadiness(t *testing.T) {
	a := oauthApp(t)
	if w := principalRequest(a, "GET", "/v1/recovery", firstAdmin, nil, nil, ""); w.Code != 200 || object(t, w)["configured"] != false || object(t, w)["available"] != false {
		t.Fatal("unconfigured controller reported ready")
	}
	for _, response := range []string{`{"ok":true}`, `{"phase":"ACTIVE","oversize":"` + strings.Repeat("x", recoveryStatusLimit) + `"}`} {
		controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(response)) }))
		a.cfg.RecoveryControllerURL, a.cfg.RecoveryControllerToken = controller.URL, strings.Repeat("s", 48)
		w := principalRequest(a, "GET", "/v1/recovery", firstAdmin, nil, nil, "")
		controller.Close()
		if w.Code != 503 || object(t, w)["available"] != false || object(t, w)["state"] != "invalid_response" {
			t.Fatal("invalid controller response accepted")
		}
	}
}

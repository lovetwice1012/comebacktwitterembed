package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestWorkloadLogsBridgeBothAdminsSafeTailAndCredentialBoundary(t *testing.T) {
	a := oauthApp(t)
	token := strings.Repeat("fixture-log-status-", 3)
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "GET" || r.URL.Path != "/v1/workload-logs" || r.URL.Query().Get("component") != "bot" || r.URL.Query().Get("archive") != "1" || r.Header.Get("Authorization") != "Bearer "+token {
			t.Error("workload logs bridge changed its fixed target or role authentication")
		}
		if r.Header.Get("Cookie") != "" || r.Header.Get("X-Admin-Agent-Token") != "" {
			t.Error("browser session credentials reached the root controller")
		}
		jsonResponse(w, 200, Object{"ok": true, "available": true, "state": "available", "component": "bot", "archive": 1,
			"text": "<script>literal log</script>\nfailed startup " + token, "truncated": true, "omittedBytes": 500,
			"logHealth": Object{"droppedBytes": 100, "trimmedBytes": 60, "writeError": "OSError:28"}, "authorityToken": "private-role"})
	}))
	defer upstream.Close()
	a.cfg.RecoveryControllerURL, a.cfg.RecoveryControllerToken = upstream.URL, token
	for _, actor := range []string{firstAdmin, secondAdmin} {
		w := principalRequest(a, "GET", "/v1/recovery/workload-logs?component=bot&archive=1", actor, nil, nil, "")
		value := object(t, w)
		if w.Code != 200 || value["available"] != true || !strings.Contains(str(value["text"]), "<script>literal log</script>") || nested(value, "logHealth")["droppedBytes"] != float64(100) {
			t.Fatalf("log evidence or loss metadata was hidden: %d %s", w.Code, w.Body)
		}
		if strings.Contains(w.Body.String(), token) || strings.Contains(w.Body.String(), "private-role") {
			t.Fatal("control credentials escaped log bridge")
		}
	}
	if w := principalRequest(a, "GET", "/v1/recovery/workload-logs?component=bot", "111111111111111111", nil, nil, ""); w.Code != 401 {
		t.Fatal("outside user read private logs")
	}
	if calls.Load() != 2 {
		t.Fatal("unauthorized user reached root reader")
	}
}

func TestWorkloadLogQueryRejectsPathsAndLimitsBeforeUpstream(t *testing.T) {
	a := oauthApp(t)
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer upstream.Close()
	a.cfg.RecoveryControllerURL, a.cfg.RecoveryControllerToken = upstream.URL, strings.Repeat("x", 48)
	for _, query := range []string{"component=../../secret", "component=core", "component=", "path=/etc/shadow", "component=bot&component=reports", "bytes=262145", "lines=1001", "archive=8", "lines=-1", "component=%ZZ"} {
		w := principalRequest(a, "GET", "/v1/recovery/workload-logs?"+query, firstAdmin, nil, nil, "")
		if w.Code != 400 {
			t.Fatalf("invalid log selector accepted: %s %d", query, w.Code)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("invalid selector reached root reader")
	}
}

func TestWorkloadLogsMissingFilesAndPendingControllerAreExplicit(t *testing.T) {
	a := oauthApp(t)
	for _, pending := range []bool{false, true} {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if pending {
				http.NotFound(w, r)
				return
			}
			jsonResponse(w, 200, Object{"ok": true, "available": false, "state": "not_started", "component": "reports", "archive": 0, "text": "", "files": []any{}})
		}))
		a.cfg.RecoveryControllerURL, a.cfg.RecoveryControllerToken = upstream.URL, strings.Repeat("x", 48)
		w := principalRequest(a, "GET", "/v1/recovery/workload-logs?component=reports", firstAdmin, nil, nil, "")
		upstream.Close()
		value := object(t, w)
		if pending && (w.Code != 503 || value["state"] != "controller_endpoint_pending") || !pending && (w.Code != 200 || value["state"] != "not_started" || value["available"] != false) {
			t.Fatalf("missing log state was concealed: %d %s", w.Code, w.Body)
		}
	}
}

func TestWorkloadLogsRejectRedirectOversizeAndMismatchedComponent(t *testing.T) {
	a := oauthApp(t)
	var destinationCalls atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { destinationCalls.Add(1) }))
	defer destination.Close()
	for _, scenario := range []string{"redirect", "oversize", "component"} {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch scenario {
			case "redirect":
				http.Redirect(w, r, destination.URL, 302)
			case "oversize":
				_, _ = w.Write([]byte(`{"text":"` + strings.Repeat("x", workloadLogsResponseLimit) + `"}`))
			default:
				jsonResponse(w, 200, Object{"ok": true, "available": true, "component": "reports", "archive": 0, "text": "wrong log"})
			}
		}))
		a.cfg.RecoveryControllerURL, a.cfg.RecoveryControllerToken = upstream.URL, strings.Repeat("x", 48)
		w := principalRequest(a, "GET", "/v1/recovery/workload-logs?component=bot", firstAdmin, nil, nil, "")
		upstream.Close()
		if w.Code != 503 || object(t, w)["available"] != false {
			t.Fatalf("invalid upstream log accepted: %s %d", scenario, w.Code)
		}
	}
	if destinationCalls.Load() != 0 {
		t.Fatal("workload log request followed a redirect")
	}
}

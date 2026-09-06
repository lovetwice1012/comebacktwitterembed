package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func testApp(t *testing.T) *App {
	t.Helper()
	s, e := openStore(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.db.Close() })
	return newApp(Config{Token: strings.Repeat("a", 64), Owner: "123", WorkerTimeout: 120 * time.Second}, s)
}
func request(t *testing.T, a *App, method, path string, input any) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(encode(input)))
	r.Header.Set("X-Admin-Agent-Token", a.cfg.Token)
	r.Header.Set("X-Admin-Actor", a.cfg.Owner)
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	return w
}
func object(t *testing.T, w *httptest.ResponseRecorder) Object {
	t.Helper()
	var v Object
	if e := json.Unmarshal(w.Body.Bytes(), &v); e != nil {
		t.Fatalf("invalid JSON status=%d: %s", w.Code, w.Body.String())
	}
	return v
}
func TestDurableIngestAndEventDedup(t *testing.T) {
	a := testApp(t)
	event := Object{"eventId": "event1", "kind": "request.started", "requestId": "req1", "guildId": "guild1", "occurredAt": "2026-09-05T01:02:03.100Z"}
	for i := 0; i < 2; i++ {
		w := request(t, a, "POST", "/v1/events", Object{"events": []Object{event}})
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
	}
	var count int
	var stamp string
	if e := a.store.db.QueryRow("SELECT COUNT(*),occurred_at FROM events").Scan(&count, &stamp); e != nil {
		t.Fatal(e)
	}
	if count != 1 || stamp != "2026-09-05T01:02:03.100000000Z" {
		t.Fatalf("unexpected normalized persistence count=%d stamp=%s", count, stamp)
	}
}
func TestAuthenticationActorAndCookieCSRF(t *testing.T) {
	a := testApp(t)
	for _, actor := range []string{"wrong"} {
		r := httptest.NewRequest("GET", "/v1/health", nil)
		r.Header.Set("X-Admin-Agent-Token", a.cfg.Token)
		r.Header.Set("X-Admin-Actor", actor)
		w := httptest.NewRecorder()
		a.routes().ServeHTTP(w, r)
		if w.Code != 401 {
			t.Fatalf("wrong actor accepted %d", w.Code)
		}
	}
	token, csrf := randomID(), randomID()
	_, e := a.store.db.Exec("INSERT INTO sessions(hash,csrf,expires_at) VALUES(?,?,?)", tokenHash(token), csrf, time.Now().UTC().Add(time.Hour).Format(timestampLayout))
	if e != nil {
		t.Fatal(e)
	}
	for _, withCSRF := range []bool{false, true} {
		r := httptest.NewRequest("POST", "/v1/actions", strings.NewReader(encode(Object{"type": "url.inspect", "input": Object{"url": "https://example.com"}, "idempotencyKey": "csrf"})))
		r.AddCookie(&http.Cookie{Name: "cbte_admin_session", Value: token})
		if withCSRF {
			r.Header.Set("X-CSRF-Token", csrf)
		}
		w := httptest.NewRecorder()
		a.routes().ServeHTTP(w, r)
		want := 401
		if withCSRF {
			want = 202
		}
		if w.Code != want {
			t.Fatalf("csrf=%v got=%d %s", withCSRF, w.Code, w.Body)
		}
	}
}
func TestPasswordBootstrapAndLoginOnBasePath(t *testing.T) {
	a := testApp(t)
	a.cfg.BasePath = "/ops"
	password := "a valid long password!"
	w := request(t, a, "POST", "/v1/account/password", Object{"password": password})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	r := httptest.NewRequest("POST", "/auth/login", strings.NewReader(encode(Object{"password": password})))
	w = httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Path != "/ops/" || !cookies[0].HttpOnly {
		t.Fatalf("wrong session cookie %+v", cookies)
	}
	if strings.Contains(w.Body.String(), password) {
		t.Fatal("password exposed")
	}
}
func TestIdempotencyConflictAndUnknownRecovery(t *testing.T) {
	a := testApp(t)
	first, created, e := a.store.enqueue("message.send", Object{"x": 1}, "same", a.cfg.Owner, "standalone")
	if e != nil || !created {
		t.Fatal(e)
	}
	second, created, e := a.store.enqueue("message.send", Object{"x": 1}, "same", a.cfg.Owner, "standalone")
	if e != nil || created || first.ID != second.ID {
		t.Fatal("duplicate action")
	}
	if _, _, e = a.store.enqueue("message.send", Object{"x": 2}, "same", a.cfg.Owner, "standalone"); e == nil {
		t.Fatal("conflicting idempotency accepted")
	}
	_, _ = a.store.db.Exec("UPDATE actions SET status='running' WHERE id=?", first.ID)
	if e = a.store.recoverActions(); e != nil {
		t.Fatal(e)
	}
	ac, e := a.store.action(first.ID)
	if e != nil || ac.Status != "unknown" {
		t.Fatalf("action replay risk: %+v %v", ac, e)
	}
}
func TestMetricsRootAccountingAndDrillDown(t *testing.T) {
	a := testApp(t)
	start := time.Now().UTC().Add(-time.Minute)
	events := []Object{}
	outcomes := []string{"F", "D", "P", "E", "U", "S", "C", "I", "X", "F"}
	for i, outcome := range outcomes {
		id := fmt.Sprintf("r%d", i)
		trigger := "human_message"
		if i == 9 {
			trigger = "diagnostic"
		}
		events = append(events, Object{"id": id + "s", "runId": id, "kind": "request.started", "occurredAt": start.Format(time.RFC3339Nano), "guildId": "g1", "userId": "u1", "messageId": "m1", "triggerType": trigger, "provider": "twitter"})
		if outcome != "I" {
			events = append(events, Object{"id": id + "c", "runId": id, "kind": "request.completed", "occurredAt": start.Add(time.Second).Format(time.RFC3339Nano), "outcome": outcome, "durationMs": 1000.0})
		}
		events = append(events, Object{"id": id + "http", "runId": id, "kind": "http.completed", "occurredAt": start.Format(time.RFC3339Nano), "outcome": "F"})
	}
	if _, _, e := a.store.ingest(events); e != nil {
		t.Fatal(e)
	}
	w := request(t, a, "GET", "/v1/metrics", nil)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	v := object(t, w)
	if v["requestCount"] != float64(9) || v["problemRequestCount"] != float64(5) {
		t.Fatalf("bad root counts %s", w.Body)
	}
	full := nested(v, "fullSuccess")
	if full["numerator"] != float64(1) || full["denominator"] != float64(6) {
		t.Fatalf("wrong success accounting: %v", full)
	}
	w = request(t, a, "GET", "/v1/runs?outcome=D,P,E,U,X", nil)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	items := object(t, w)["items"].([]any)
	if len(items) != 5 {
		t.Fatalf("drill down does not match card %s", w.Body)
	}
	w = request(t, a, "GET", "/v1/runs?limit=2", nil)
	v = object(t, w)
	if len(v["items"].([]any)) != 2 || v["nextCursor"] == nil {
		t.Fatalf("missing pagination %s", w.Body)
	}
}
func TestZeroDenominatorIsNull(t *testing.T) {
	a := testApp(t)
	v := object(t, request(t, a, "GET", "/v1/metrics", nil))
	if nested(v, "fullSuccess")["ratio"] != nil {
		t.Fatal("no data must not be zero percent")
	}
}

func TestCoverageDoesNotTreatDiagnosticOnlyDataAsProductionMeasurement(t *testing.T) {
	a := testApp(t)
	_, _, e := a.store.ingest([]Object{{"id": "d-start", "kind": "request.started", "runId": "diagnostic", "triggerType": "diagnostic", "occurredAt": now()}, {"id": "d-end", "kind": "request.completed", "runId": "diagnostic", "outcome": "F", "occurredAt": now()}})
	if e != nil {
		t.Fatal(e)
	}
	w := request(t, a, "GET", "/v1/metrics", nil)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	v := object(t, w)
	coverage := nested(v, "coverage")
	if coverage["measurementState"] != "not_measured" || coverage["firstRecordedRequestAt"] != nil || coverage["recordedProductionRequests"] != float64(0) {
		t.Fatalf("diagnostic data created false production coverage: %v", coverage)
	}
}
func TestCoverageUsesOccurredHeartbeatTimeInsteadOfDelayedIngestTime(t *testing.T) {
	a := testApp(t)
	old := time.Now().UTC().Add(-48 * time.Hour).Format(timestampLayout)
	_, _, e := a.store.ingest([]Object{{"id": "old-start", "kind": "request.started", "runId": "real", "triggerType": "human_message", "occurredAt": old}, {"id": "old-heartbeat", "kind": "heartbeat", "occurredAt": old}})
	if e != nil {
		t.Fatal(e)
	}
	v := object(t, request(t, a, "GET", "/v1/metrics", nil))
	coverage := nested(v, "coverage")
	if coverage["collectionState"] != "heartbeat_stale" || coverage["measurementState"] != "not_measured" {
		t.Fatalf("delayed heartbeat falsely established live measurement: %v", coverage)
	}
	_, _, e = a.store.ingest([]Object{{"id": "new-heartbeat", "kind": "heartbeat", "occurredAt": now()}})
	if e != nil {
		t.Fatal(e)
	}
	coverage = nested(object(t, request(t, a, "GET", "/v1/metrics", nil)), "coverage")
	if coverage["measurementState"] != "no_matching_requests" || coverage["collectionState"] != "recent_heartbeat" {
		t.Fatalf("no-record and unavailable states not distinguished: %v", coverage)
	}
}
func TestHealthSeparatesAPIResponseFromMonitorProgress(t *testing.T) {
	a := testApp(t)
	v := object(t, request(t, a, "GET", "/v1/health", nil))
	if nested(v, "monitor")["state"] != "not_observed" {
		t.Fatal("fresh process falsely claims monitoring evidence")
	}
	a.lastMonitorSave = time.Now().Add(-5 * time.Minute)
	a.hasMonitorSave = true
	v = object(t, request(t, a, "GET", "/v1/health", nil))
	if nested(v, "monitor")["state"] != "stalled" {
		t.Fatal("stalled monitor presented as current")
	}
}
func TestTimestampTiePagination(t *testing.T) {
	a := testApp(t)
	stamp := now()
	for i := 0; i < 4; i++ {
		ac, _, e := a.store.enqueue("url.inspect", Object{}, fmt.Sprint(i), a.cfg.Owner, "test")
		if e != nil {
			t.Fatal(e)
		}
		_, _ = a.store.db.Exec("UPDATE actions SET created_at=? WHERE id=?", stamp, ac.ID)
	}
	seen := map[string]bool{}
	path := "/v1/actions?limit=2"
	for i := 0; i < 2; i++ {
		w := request(t, a, "GET", path, nil)
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		v := object(t, w)
		for _, row := range v["items"].([]any) {
			id := row.(map[string]any)["id"].(string)
			if seen[id] {
				t.Fatal("repeated page item")
			}
			seen[id] = true
		}
		if i == 0 {
			path = "/v1/actions?limit=2&cursor=" + str(v["nextCursor"])
		}
	}
	if len(seen) != 4 {
		t.Fatalf("lost timestamp tied rows: %d", len(seen))
	}
}
func TestPolicyRevisionAndRestartBounds(t *testing.T) {
	a := testApp(t)
	p := defaultPolicy()
	input := decode(encode(p)).(map[string]any)
	input["expectedRevision"] = 0
	w := request(t, a, "PUT", "/v1/policies", input)
	if w.Code != 409 {
		t.Fatalf("stale revision accepted: %s", w.Body)
	}
	input["expectedRevision"] = 1
	input["restartCooldownSeconds"] = 10
	w = request(t, a, "PUT", "/v1/policies", input)
	if w.Code != 400 {
		t.Fatal("unbounded restart policy")
	}
}
func TestIncidentOutboxAndPositiveRecovery(t *testing.T) {
	a := testApp(t)
	a.cfg.PushWebhook = "https://example.invalid/notify"
	id, created, e := a.upsertIncident("same", "test", Object{"evidence": "yes"})
	if e != nil || !created {
		t.Fatal(e)
	}
	_, created, e = a.upsertIncident("same", "test", Object{"evidence": "new observation"})
	if e != nil || created {
		t.Fatal("unchanged incident notified twice")
	}
	var count int
	_ = a.store.db.QueryRow("SELECT COUNT(*) FROM outbox").Scan(&count)
	if count != 1 {
		t.Fatal(count)
	}
	if e = a.recoverIncident("same", Object{}); e != nil {
		t.Fatal(e)
	}
	var status string
	_ = a.store.db.QueryRow("SELECT status FROM incidents WHERE id=?", id).Scan(&status)
	if status != "Verifying" {
		t.Fatal("single probe was treated as recovered")
	}
	_, _ = a.store.db.Exec("UPDATE incidents SET recovery_start=?,recovery_count=2 WHERE id=?", time.Now().UTC().Add(-3*time.Minute).Format(timestampLayout), id)
	if e = a.recoverIncident("same", Object{"scope": "HTTP only"}); e != nil {
		t.Fatal(e)
	}
	_ = a.store.db.QueryRow("SELECT status FROM incidents WHERE id=?", id).Scan(&status)
	if status != "Resolved" {
		t.Fatal(status)
	}
	_ = a.store.db.QueryRow("SELECT COUNT(*) FROM outbox").Scan(&count)
	if count != 2 {
		t.Fatal("recovery notification missing")
	}
}
func TestNotificationsDoNotRepeatUnchanged(t *testing.T) {
	a := testApp(t)
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"accepted"}`))
	}))
	defer server.Close()
	a.cfg.PushWebhook = server.URL
	if _, _, e := a.upsertIncident("notify", "test", Object{}); e != nil {
		t.Fatal(e)
	}
	a.sendOneNotification(context.Background())
	a.sendOneNotification(context.Background())
	if calls != 1 {
		t.Fatal(calls)
	}
	var status string
	_ = a.store.db.QueryRow("SELECT status FROM outbox").Scan(&status)
	if status != "accepted" {
		t.Fatal(status)
	}
}
func TestWorkerHelperProcess(t *testing.T) {
	if os.Getenv("CBTE_TEST_WORKER") != "1" {
		return
	}
	var request Object
	_ = json.NewDecoder(os.Stdin).Decode(&request)
	_ = json.NewEncoder(os.Stdout).Encode(Object{"ok": false, "data": Object{"outcome": "partial_success", "steps": []Object{{"messageId": "confirmed-1"}}}, "error": Object{"code": "REAL_CAUSE", "message": "provider response failed", "stack": "actual stack"}, "events": []Object{{"id": "worker-evidence", "kind": "parse.failed", "runId": request["actionId"], "occurredAt": now(), "details": Object{"httpStatus": 502, "body": "raw failure"}}}})
	os.Exit(1)
}
func TestWorkerNonzeroStructuredErrorAndEvidenceSurvive(t *testing.T) {
	a := testApp(t)
	exe, e := os.Executable()
	if e != nil {
		t.Fatal(e)
	}
	t.Setenv("CBTE_TEST_WORKER", "1")
	a.cfg.Node = exe
	a.cfg.Worker = "-test.run=TestWorkerHelperProcess"
	ac, _, e := a.store.enqueue("url.inspect", Object{}, "worker-error", a.cfg.Owner, "test")
	if e != nil {
		t.Fatal(e)
	}
	a.execute(context.Background(), ac)
	ac, e = a.store.action(ac.ID)
	if e != nil {
		t.Fatal(e)
	}
	if ac.Status != "failed" {
		t.Fatal(ac)
	}
	problem := ac.Error.(map[string]any)
	if problem["code"] != "REAL_CAUSE" {
		t.Fatalf("structured cause lost %+v", ac)
	}
	var count int
	_ = a.store.db.QueryRow("SELECT COUNT(*) FROM events WHERE id='worker-evidence'").Scan(&count)
	if count != 1 {
		t.Fatal("worker error evidence discarded")
	}
	if !bytes.Contains([]byte(encode(ac.Result)), []byte("confirmed-1")) {
		t.Fatal("partial result discarded")
	}
}
func TestPasswordHashNeverReturnedInHealth(t *testing.T) {
	a := testApp(t)
	h, _ := bcrypt.GenerateFromPassword([]byte("long enough password"), bcrypt.MinCost)
	a.cfg.PasswordHash = string(h)
	w := request(t, a, "GET", "/v1/health", nil)
	if strings.Contains(w.Body.String(), string(h)) {
		t.Fatal("hash exposed")
	}
}

func TestIndependentWorkerUnknownReceiptReconciliation(t *testing.T) {
	a := testApp(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Admin-Agent-Token") != a.cfg.Token {
			t.Error("missing worker token")
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Object{"state": "completed", "result": Object{"ok": true, "data": Object{"outcome": "full_success", "steps": []Object{{"messageId": "discord-confirmed"}}}, "events": []Object{}}})
	}))
	defer server.Close()
	a.cfg.WorkerURL = server.URL + "/execute"
	ac, _, e := a.store.enqueue("message.send", Object{}, "core-restart", a.cfg.Owner, "test")
	if e != nil {
		t.Fatal(e)
	}
	if e = a.store.finish(ac.ID, "unknown", nil, Object{"code": "CORE_RESTART_DURING_EXECUTION"}); e != nil {
		t.Fatal(e)
	}
	a.reconcileUnknown(context.Background())
	after, e := a.store.action(ac.ID)
	if e != nil || after.Status != "succeeded" {
		t.Fatalf("receipt reconciliation failed %+v %v", after, e)
	}
}
func TestWorkerHTTPPreservesFailedProtocolAndUnknown(t *testing.T) {
	a := testApp(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(409)
		json.NewEncoder(w).Encode(Object{"ok": false, "error": Object{"code": "DELIVERY_UNKNOWN", "message": "prior running receipt survived restart"}, "events": []Object{{"id": "http-worker-error", "kind": "delivery.unknown", "occurredAt": now()}}})
	}))
	defer server.Close()
	a.cfg.WorkerURL = server.URL
	ac, _, e := a.store.enqueue("message.send", Object{}, "worker-unknown", a.cfg.Owner, "test")
	if e != nil {
		t.Fatal(e)
	}
	a.execute(context.Background(), ac)
	after, e := a.store.action(ac.ID)
	if e != nil || after.Status != "unknown" {
		t.Fatalf("unknown delivery marked incorrectly: %+v %v", after, e)
	}
	var count int
	_ = a.store.db.QueryRow("SELECT COUNT(*) FROM events WHERE id='http-worker-error'").Scan(&count)
	if count != 1 {
		t.Fatal("HTTP worker error evidence lost")
	}
}

func TestUnconfiguredReportWorkerNamesCorrectLaneWithoutInteractiveFallback(t *testing.T) {
	a := testApp(t)
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		jsonResponse(w, 200, Object{"ok": true, "data": Object{"wrongLane": true}})
	}))
	defer server.Close()
	a.cfg.Worker = "configured-interactive-worker.js"
	a.cfg.WorkerURL = server.URL
	ac, _, e := a.store.enqueue("reports.build", Object{"kind": "analytics", "filters": Object{}}, "report-lane-unconfigured", a.cfg.Owner, "test")
	if e != nil {
		t.Fatal(e)
	}
	a.execute(context.Background(), ac)
	result, e := a.store.action(ac.ID)
	if e != nil {
		t.Fatal(e)
	}
	problem, _ := result.Error.(map[string]any)
	if result.Status != "failed" || problem["code"] != "REPORT_WORKER_UNCONFIGURED" || problem["configuration"] != "ADMIN_AGENT_REPORT_WORKER_URL" || problem["availability"] != "unconfigured" || problem["executionStarted"] != false {
		t.Fatalf("incorrect report-worker availability: %+v", result)
	}
	if called {
		t.Fatal("report execution incorrectly fell back to the interactive worker")
	}
}

func TestUnconfiguredInteractiveWorkerNamesBothSupportedConfigurationPaths(t *testing.T) {
	a := testApp(t)
	ac, _, e := a.store.enqueue("url.inspect", Object{}, "interactive-unconfigured", a.cfg.Owner, "test")
	if e != nil {
		t.Fatal(e)
	}
	a.execute(context.Background(), ac)
	result, e := a.store.action(ac.ID)
	if e != nil {
		t.Fatal(e)
	}
	problem, _ := result.Error.(map[string]any)
	if result.Status != "failed" || problem["code"] != "WORKER_UNCONFIGURED" || problem["lane"] != "interactive" || problem["executionStarted"] != false || !strings.Contains(str(problem["message"]), "ADMIN_AGENT_WORKER_URL") {
		t.Fatalf("incorrect interactive-worker configuration failure: %+v", result)
	}
}

func TestReportSnapshotsDeduplicateAndKeepCompleteResultOnFailure(t *testing.T) {
	a := testApp(t)
	w := request(t, a, "POST", "/v1/reports/analytics", Object{"filters": Object{"days": "7", "guildId": "g1"}})
	if w.Code != 202 {
		t.Fatal(w.Body.String())
	}
	first := object(t, w)
	id := str(first["actionId"])
	w = request(t, a, "POST", "/v1/reports/analytics", Object{"filters": Object{"guildId": "g1", "days": 7}})
	if w.Code != 200 || str(object(t, w)["actionId"]) != id {
		t.Fatalf("same normalized report was duplicated %s", w.Body)
	}
	result := Object{"kind": "analytics", "report": Object{"allRows": []Object{{"value": 1}, {"value": 2}}, "complete": true}, "definitionVersion": "test"}
	if e := a.store.finish(id, "succeeded", result, nil); e != nil {
		t.Fatal(e)
	}
	if e := a.completeReport(id, "succeeded", result, nil); e != nil {
		t.Fatal(e)
	}
	w = request(t, a, "POST", "/v1/reports/analytics", Object{"filters": Object{"days": 7, "guildId": "g1"}, "force": true})
	next := object(t, w)
	secondID := str(next["actionId"])
	if secondID == id {
		t.Fatal("explicit refresh reused completed action")
	}
	problem := Object{"code": "REPORT_FAILED", "message": "DB unavailable"}
	a.store.finish(secondID, "failed", nil, problem)
	a.completeReport(secondID, "failed", nil, problem)
	snapshot, e := a.reportSnapshot(str(first["key"]))
	if e != nil {
		t.Fatal(e)
	}
	cache := nested(snapshot, "cache")
	if cache["ready"] != true || cache["refreshing"] != false || cache["lastError"] == nil {
		t.Fatalf("failed refresh erased prior report %+v", snapshot)
	}
	if nested(snapshot, "report")["complete"] != true {
		t.Fatal("last complete payload not preserved")
	}
}

func TestReportPressurePauseIsBoundedAndRequiresRepeatedEvidence(t *testing.T) {
	a := testApp(t)
	p := defaultPolicy()
	snapshot := Object{"host": Object{"pressureIO": Object{"raw": "some avg10=40.00 avg60=10.00\nfull avg10=35.00 avg60=10.00\n"}}}
	for i := 0; i < 2; i++ {
		a.maybePauseReports(snapshot, p, "evidence")
	}
	loaded, _ := a.loadPolicy()
	if loaded.ReportsPausedUntil != "" {
		t.Fatal("single pressure sample paused reports")
	}
	a.maybePauseReports(snapshot, p, "evidence")
	loaded, _ = a.loadPolicy()
	until, e := time.Parse(time.RFC3339Nano, loaded.ReportsPausedUntil)
	if e != nil || time.Until(until) > 5*time.Minute || time.Until(until) < 4*time.Minute {
		t.Fatal("report pause must have bounded automatic expiry")
	}
}

func TestManualReportsNeverScheduleByAge(t *testing.T) {
	a := testApp(t)
	for _, kind := range []string{"analytics", "guild-preview", "provider-preview"} {
		input := Object{"filters": Object{}}
		first := object(t, request(t, a, "POST", "/v1/reports/"+kind, input))
		id := str(first["actionId"])
		result := Object{"report": Object{"complete": true}}
		if e := a.store.finish(id, "succeeded", result, nil); e != nil {
			t.Fatal(e)
		}
		if e := a.completeReport(id, "succeeded", result, nil); e != nil {
			t.Fatal(e)
		}
		old := time.Now().UTC().Add(-48 * time.Hour).Format(timestampLayout)
		if _, e := a.store.db.Exec("UPDATE reports SET updated_at=?,generated_at=? WHERE current_action_id=?", old, old, id); e != nil {
			t.Fatal(e)
		}
		a.scheduleReportRefresh(defaultPolicy())
		var active int
		if e := a.store.db.QueryRow("SELECT COUNT(*) FROM actions WHERE type='reports.build' AND status IN ('queued','running')").Scan(&active); e != nil {
			t.Fatal(e)
		}
		if active != 0 {
			t.Fatal("manual report was scheduled by age")
		}
		read := object(t, request(t, a, "GET", "/v1/reports/"+kind, nil))
		if nested(read, "cache")["ready"] != true {
			t.Fatal("old completed report disappeared")
		}
		if _, e := a.store.db.Exec("UPDATE reports SET generated_at=? WHERE current_action_id=?", now(), id); e != nil {
			t.Fatal(e)
		}
		next := object(t, request(t, a, "POST", "/v1/reports/"+kind, input))
		if str(next["actionId"]) == id {
			t.Fatal("explicit generation reused completed job")
		}
		a.store.finish(str(next["actionId"]), "failed", nil, Object{"code": "test"})
		a.completeReport(str(next["actionId"]), "failed", nil, Object{"code": "test"})
	}
}

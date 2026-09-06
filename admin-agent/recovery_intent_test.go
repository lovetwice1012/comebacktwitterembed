package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func intentApp(t *testing.T) *App {
	a := oauthApp(t)
	a.cfg.RecoveryIntentToken = strings.Repeat("intent-fixture-", 4)
	a.cfg.RecoveryNode = "primary"
	return a
}

func fakeIntentExecutor(t *testing.T, a *App) *atomic.Int32 {
	t.Helper()
	dir, e := os.MkdirTemp("", "cbte-intent-")
	if e != nil {
		t.Fatal(e)
	}
	a.cfg.ExecutorSocket = filepath.Join(dir, "test.sock")
	listener, e := net.Listen("unix", a.cfg.ExecutorSocket)
	if e != nil {
		os.RemoveAll(dir)
		t.Fatal(e)
	}
	var calls atomic.Int32
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			connection, e := listener.Accept()
			if e != nil {
				return
			}
			_ = connection.SetDeadline(time.Now().Add(time.Second))
			var request ExecutorRequest
			if json.NewDecoder(connection).Decode(&request) == nil {
				calls.Add(1)
				_ = json.NewEncoder(connection).Encode(Object{"ok": true, "data": Object{"fixture": true, "type": request.Type}})
			}
			connection.Close()
		}
	}()
	t.Cleanup(func() { listener.Close(); <-done; os.RemoveAll(dir) })
	return &calls
}

func intentAck(w http.ResponseWriter, r *http.Request, a *App, actor string, t *testing.T) {
	t.Helper()
	var input RecoveryIntent
	if r.Method != http.MethodPost || r.URL.Path != "/v1/intent" || r.Header.Get("Authorization") != "Bearer "+a.cfg.RecoveryIntentToken || json.NewDecoder(r.Body).Decode(&input) != nil {
		t.Error("invalid intent request boundary")
	}
	if input.ActorID != actor || input.Node != a.cfg.RecoveryNode {
		t.Errorf("intent principal mismatch: %+v", input)
	}
	policy, e := a.loadPolicy()
	if e != nil || policy.Revision != input.Revision || policy.DesiredState != input.DesiredState {
		t.Error("controller called before local policy transaction committed")
	}
	jsonResponse(w, 200, Object{"ok": true, "node": input.Node, "revision": input.Revision, "desiredState": input.DesiredState})
}

func TestRecoveryIntentPolicyWaitsForDurableAckAndActualPrincipal(t *testing.T) {
	for _, actor := range []string{firstAdmin, secondAdmin} {
		t.Run(actor, func(t *testing.T) {
			a := intentApp(t)
			controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { intentAck(w, r, a, actor, t) }))
			defer controller.Close()
			a.cfg.RecoveryControllerURL = controller.URL
			p := defaultPolicy()
			p.DesiredState = "stopped"
			input := decode(encode(p)).(Object)
			input["expectedRevision"] = 1
			issued := httptest.NewRecorder()
			session, e := a.newAdminSession(issued, actor, "discord", "fixture")
			if e != nil {
				t.Fatal(e)
			}
			w := principalRequest(a, "PUT", "/v1/policies", "", input, cookieNamed(issued.Result().Cookies(), "cbte_admin_session"), str(session["csrf"]))
			if w.Code != 200 {
				t.Fatal(w.Body.String())
			}
			var saved SavedRecoveryIntent
			if e = a.store.getSetting("recovery_intent", &saved); e != nil || !saved.Acknowledged || saved.Revision != 2 || saved.ActorID != actor {
				t.Fatalf("intent receipt did not persist: %+v %v", saved, e)
			}
			var principal, via string
			e = a.store.db.QueryRow("SELECT json_extract(payload,'$.actor'),json_extract(payload,'$.initiatedVia') FROM events WHERE kind='admin.policy.changed'").Scan(&principal, &via)
			if e != nil || principal != actor || via != "standalone" {
				t.Fatalf("policy actor audit lost: %s %s %v", principal, via, e)
			}
		})
	}
}

func TestRecoveryIntentFailureDoesNotRunAnyServiceOperation(t *testing.T) {
	for _, typ := range []string{"service.stop", "service.start", "service.restart"} {
		t.Run(typ, func(t *testing.T) {
			a := intentApp(t)
			calls := fakeIntentExecutor(t, a)
			controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				jsonResponse(w, 503, Object{"error": "fixture-unavailable"})
			}))
			defer controller.Close()
			a.cfg.RecoveryControllerURL = controller.URL
			ac, _, e := a.store.enqueue(typ, Object{}, typ, secondAdmin, "standalone")
			if e != nil {
				t.Fatal(e)
			}
			a.execute(context.Background(), ac)
			result, e := a.store.action(ac.ID)
			if e != nil || result.Status != "failed" || nested(Object{"error": result.Error}, "error")["code"] != "RECOVERY_INTENT_UNACKNOWLEDGED" || calls.Load() != 0 {
				t.Fatalf("service executed without intent ACK: %+v %v calls=%d", result, e, calls.Load())
			}
			var saved SavedRecoveryIntent
			if e = a.store.getSetting("recovery_intent", &saved); e != nil || saved.Acknowledged || saved.ActorID != secondAdmin || saved.Revision != 2 {
				t.Fatalf("pending intent was not retained for retry: %+v %v", saved, e)
			}
		})
	}
}

func TestRecoveryIntentRetryOnlyDeliversIntentAndNeverReplaysStop(t *testing.T) {
	a := intentApp(t)
	calls := fakeIntentExecutor(t, a)
	var accept atomic.Bool
	var expectedActor atomic.Value
	expectedActor.Store(secondAdmin)
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !accept.Load() {
			jsonResponse(w, 503, Object{})
			return
		}
		intentAck(w, r, a, expectedActor.Load().(string), t)
	}))
	defer controller.Close()
	a.cfg.RecoveryControllerURL = controller.URL
	ac, _, _ := a.store.enqueue("service.stop", Object{}, "retry-intent", secondAdmin, "standalone")
	a.execute(context.Background(), ac)
	accept.Store(true)
	a.retryRecoveryIntent(context.Background())
	var saved SavedRecoveryIntent
	if e := a.store.getSetting("recovery_intent", &saved); e != nil || !saved.Acknowledged || saved.Revision != 2 || calls.Load() != 0 {
		t.Fatalf("intent retry replayed stop or lost receipt: %+v %v calls=%d", saved, e, calls.Load())
	}
	ac, _, _ = a.store.enqueue("service.stop", Object{}, "explicit-new-stop", firstAdmin, "dashboard")
	// A new service action records and transmits the new actual actor.
	expectedActor.Store(firstAdmin)
	a.execute(context.Background(), ac)
	if calls.Load() != 1 {
		t.Fatal("explicit stop did not execute after acknowledgement")
	}
}

func TestRecoveryIntentPolicyFailureRetainsLocalStateAndAuditAtomically(t *testing.T) {
	a := intentApp(t)
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { jsonResponse(w, 409, Object{}) }))
	defer controller.Close()
	a.cfg.RecoveryControllerURL = controller.URL
	p := defaultPolicy()
	p.DesiredState = "maintenance"
	input := decode(encode(p)).(Object)
	input["expectedRevision"] = 1
	w := principalRequest(a, "PUT", "/v1/policies", secondAdmin, input, nil, "")
	if w.Code != 503 || nested(object(t, w), "error")["localPolicySaved"] != true {
		t.Fatal("unacknowledged policy returned success")
	}
	current, e := a.loadPolicy()
	if e != nil || current.DesiredState != "maintenance" || current.Revision != 2 {
		t.Fatal("policy not persisted for retry")
	}
	if _, e = a.store.db.Exec("CREATE TRIGGER fail_policy_audit BEFORE INSERT ON events WHEN NEW.kind='admin.policy.changed' BEGIN SELECT RAISE(ABORT,'fixture failure'); END"); e != nil {
		t.Fatal(e)
	}
	input["expectedRevision"] = 2
	input["desiredState"] = "running"
	w = principalRequest(a, "PUT", "/v1/policies", firstAdmin, input, nil, "")
	current, e = a.loadPolicy()
	if w.Code != 503 || e != nil || current.Revision != 2 || current.DesiredState != "maintenance" {
		t.Fatal("policy update escaped failed audit transaction")
	}
}

func TestRecoveryIntentConfigurationAndAckBoundaries(t *testing.T) {
	for _, response := range []string{`{"ok":true,"node":"primary","desiredState":"stopped","revision":99}`, `{"ok":true}`, strings.Repeat("x", 4097)} {
		a := intentApp(t)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(response)) }))
		a.cfg.RecoveryControllerURL = server.URL
		if e := a.acknowledgeRecoveryIntent(context.Background(), RecoveryIntent{"primary", "stopped", 2, firstAdmin}); e == nil {
			t.Fatal("invalid or oversized acknowledgement accepted")
		}
		server.Close()
	}
	a := oauthApp(t)
	a.cfg.RecoveryControllerURL = "http://127.0.0.1:34212"
	if a.recoveryIntentConfigured() {
		t.Fatal("read-only recovery URL accidentally enabled intent mutation")
	}
	a.cfg.RecoveryNode = "primary"
	if e := a.acknowledgeRecoveryIntent(context.Background(), RecoveryIntent{"primary", "stopped", 2, firstAdmin}); e == nil {
		t.Fatal("partially configured intent bridge did not fail closed")
	}
}

func TestQueuedAutomaticRestartCannotOverrideNewerManualStop(t *testing.T) {
	a := oauthApp(t)
	calls := fakeIntentExecutor(t, a)
	p := defaultPolicy()
	p.DesiredState = "stopped"
	if e := a.store.setSetting("policy", p); e != nil {
		t.Fatal(e)
	}
	ac, _, _ := a.store.enqueue("service.restart", Object{}, "stale-auto-restart", firstAdmin, "automation")
	a.execute(context.Background(), ac)
	result, _ := a.store.action(ac.ID)
	current, _ := a.loadPolicy()
	if calls.Load() != 0 || current.DesiredState != "stopped" || current.Revision != 1 || nested(Object{"error": result.Error}, "error")["code"] != "SERVICE_INTENT_CHANGED" {
		t.Fatal("old queued automatic restart overrode manual stop")
	}
}

func TestRecoveryIntentRedirectAndCancelledStopNeverReachExecutor(t *testing.T) {
	a := intentApp(t)
	executorCalls := fakeIntentExecutor(t, a)
	var redirected atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirected.Add(1)
		intentAck(w, r, a, firstAdmin, t)
	}))
	defer destination.Close()
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, 307)
	}))
	defer controller.Close()
	a.cfg.RecoveryControllerURL = controller.URL
	for index, cancelFirst := range []bool{false, true} {
		ac, _, e := a.store.enqueue("service.stop", Object{}, "redirect-or-cancel-"+string(rune('a'+index)), firstAdmin, "standalone")
		if e != nil {
			t.Fatal(e)
		}
		ctx, cancel := context.WithCancel(context.Background())
		if cancelFirst {
			cancel()
		}
		a.execute(ctx, ac)
		cancel()
		result, _ := a.store.action(ac.ID)
		if result.Status != "failed" || nested(Object{"error": result.Error}, "error")["code"] != "RECOVERY_INTENT_UNACKNOWLEDGED" {
			t.Fatalf("intent failure was mistaken for an unknown executed operation: %+v", result)
		}
	}
	if redirected.Load() != 0 || executorCalls.Load() != 0 {
		t.Fatal("intent redirect or cancelled request reached service executor")
	}
}

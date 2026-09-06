package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func emergencyInput() Object {
	return Object{"expectedEpoch": 2, "candidateId": strings.Repeat("a", 24), "backupId": "20260905T173004Z", "backupSha256": strings.Repeat("b", 64), "sourceTimestamp": "2026-09-05T17:30:04Z", "expectedPrimaryIntentRevision": 3, "expectedPrimaryIntentState": "maintenance", "expectedOciPolicyRevision": 24, "reason": "Primary did not return after authorized reboot", "acceptBackupRollback": true, "acceptMissingSavedata": true, "acceptPrimaryIntentOverride": true}
}

func TestEmergencyApprovalUsesActualAdminOCIProducerAndAuditedAction(t *testing.T) {
	a := oauthApp(t)
	a.cfg.ServiceControlProfile, a.cfg.RecoveryNode, a.cfg.BotUnit = "oci-guarded", "oci", ociWorkloadUnit
	a.cfg.RecoveryIntentToken = strings.Repeat("producer", 8)
	var received []Object
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v1/emergency-approvals" || r.Header.Get("Authorization") != "Bearer "+a.cfg.RecoveryIntentToken || r.Header.Get("Cookie") != "" {
			t.Error("emergency approval used the wrong route, role or browser credential")
		}
		var body Object
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Fatal("invalid approval body")
		}
		received = append(received, body)
		body["state"], body["overriddenGate"] = "approved", "PRIMARY_OPERATOR_RUNNING"
		body["primaryIntentPreserved"], body["doesNotArm"], body["requiresOtherGates"] = true, true, true
		jsonResponse(w, 200, Object{"ok": true, "approval": body})
	}))
	defer upstream.Close()
	a.cfg.RecoveryControllerURL = upstream.URL
	before, _ := a.loadPolicy()
	for _, actor := range []string{firstAdmin, secondAdmin} {
		w := principalRequest(a, "POST", "/v1/actions", actor, Object{"type": "recovery.emergency.approve", "input": emergencyInput(), "idempotencyKey": actor}, nil, "")
		if w.Code != 202 {
			t.Fatalf("authorized approval was not queued: %d %s", w.Code, w.Body)
		}
		ac, err := a.store.action(str(object(t, w)["id"]))
		if err != nil {
			t.Fatal(err)
		}
		a.execute(context.Background(), ac)
		saved, _ := a.store.action(ac.ID)
		if saved.Status != "succeeded" || received[len(received)-1]["actorId"] != actor || received[len(received)-1]["approvalId"] != ac.ID {
			t.Fatalf("approval lost actual principal/action binding: %#v", saved)
		}
	}
	after, _ := a.loadPolicy()
	if before != after {
		t.Fatal("approval rewrote the management operator policy")
	}
}

func TestEmergencyApprovalRejectsAutomationMissingAcknowledgementsAndPrimaryCore(t *testing.T) {
	a := oauthApp(t)
	a.cfg.ServiceControlProfile, a.cfg.RecoveryNode, a.cfg.BotUnit = "oci-guarded", "oci", ociWorkloadUnit
	a.cfg.RecoveryIntentToken = strings.Repeat("p", 48)
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer upstream.Close()
	a.cfg.RecoveryControllerURL = upstream.URL
	for _, scenario := range []string{"automation", "missing_ack", "forged_actor"} {
		input := emergencyInput()
		ac := Action{ID: strings.Repeat("a", 48), Actor: firstAdmin, Via: "dashboard"}
		if scenario == "automation" {
			ac.Via = "automation"
		}
		if scenario == "missing_ack" {
			input["acceptBackupRollback"] = false
		}
		if scenario == "forged_actor" {
			input["actorId"] = secondAdmin
		}
		if _, issue := a.approveEmergencyRecovery(context.Background(), ac, input); issue == nil {
			t.Fatalf("implicit or incomplete approval accepted: %s", scenario)
		}
	}
	a.cfg.RecoveryNode, a.cfg.ServiceControlProfile, a.cfg.BotUnit = "primary", "systemd", "cbte.service"
	w := principalRequest(a, "POST", "/v1/actions", firstAdmin, Object{"type": "recovery.emergency.approve", "input": emergencyInput(), "idempotencyKey": "primary"}, nil, "")
	if w.Code != 501 || calls.Load() != 0 {
		t.Fatal("primary/automatic/incomplete operation reached the approval authority")
	}
}

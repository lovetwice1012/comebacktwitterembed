package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func manualSwitchTestInput() Object {
	return Object{
		"targetNode": "primary", "executeAt": "2030-01-01T00:00:00Z", "expectedEpoch": 7,
		"expectedCandidateId": "", "expectedBackupId": "", "expectedBackupSha256": "", "expectedBackupTimestamp": "",
		"reason": "管理者が確認した切り替え", "confirm": true, "acceptDataRisk": true, "acceptPrimaryIntentOverride": true,
	}
}

func TestSubmitManualSwitchUsesControllerStatusCredential(t *testing.T) {
	a := testApp(t)
	token := strings.Repeat("r", 64)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/manual-switch" || r.Header.Get("Authorization") != "Bearer "+token {
			http.Error(w, "bad request", http.StatusUnauthorized)
			return
		}
		fmt.Fprint(w, `{"ok":true,"manualSwitch":{"state":"scheduled","targetNode":"primary"}}`)
	}))
	defer server.Close()
	a.cfg.RecoveryControllerURL, a.cfg.RecoveryControllerToken = server.URL, token
	action := Action{ID: strings.Repeat("a", 48), Actor: a.cfg.Owner, Via: "dashboard"}
	result, problem := a.submitManualSwitch(context.Background(), action, manualSwitchTestInput())
	if problem != nil || nested(result.(Object), "manualSwitch")["state"] != "scheduled" {
		t.Fatalf("manual switch request failed: result=%v problem=%v", result, problem)
	}
}

func TestSubmitManualSwitchRejectsIncompleteConfirmation(t *testing.T) {
	a := testApp(t)
	a.cfg.RecoveryControllerURL, a.cfg.RecoveryControllerToken = "http://127.0.0.1:34212", strings.Repeat("r", 64)
	action := Action{ID: strings.Repeat("a", 48), Actor: a.cfg.Owner, Via: "standalone"}
	input := manualSwitchTestInput()
	input["acceptDataRisk"] = false
	result, problem := a.submitManualSwitch(context.Background(), action, input)
	if result != nil || str(problem.(Object)["message"]) == "" || str(problem.(Object)["code"]) != "INVALID_MANUAL_SWITCH" {
		t.Fatalf("incomplete confirmation was accepted: result=%v problem=%v", result, problem)
	}
}

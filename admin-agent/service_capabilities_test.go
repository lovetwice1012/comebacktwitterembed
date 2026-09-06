package main

import (
	"context"
	"strings"
	"testing"
)

func ociServiceConfig() Config {
	return Config{ServiceControlProfile: "oci-guarded", RecoveryNode: "oci", BotUnit: ociWorkloadUnit}
}

func TestOCIServiceProfileCannotBypassGuardianOrUsePrimaryMappings(t *testing.T) {
	for _, cfg := range []Config{
		{RecoveryNode: "oci", BotUnit: "cbte.service"},
		{ServiceControlProfile: "oci-guarded", BotUnit: "mysql.service"},
		{ServiceControlProfile: "systemd", RecoveryNode: "oci", BotUnit: ociWorkloadUnit},
		{ServiceControlProfile: "arbitrary", BotUnit: ociWorkloadUnit},
	} {
		if validateServiceProfile(cfg) == nil {
			t.Fatalf("unsafe profile accepted: %#v", cfg)
		}
	}
	if serviceProfile(Config{RecoveryNode: "oci", BotUnit: ociWorkloadUnit}) != "oci-guarded" {
		t.Fatal("OCI node did not infer its restricted profile")
	}
	for _, typ := range []string{"service.start", "service.stop", "service.restart", "service.status"} {
		unit, _ := privilegedActionUnit(ociServiceConfig(), typ)
		if unit != ociWorkloadUnit {
			t.Fatalf("OCI Bot action targets a non-guardian unit: %s", unit)
		}
	}
}

func TestServiceCatalogExplainsOCIUnsupportedOperationsAndPreservesPrimary(t *testing.T) {
	for _, cfg := range []Config{ociServiceConfig(), {BotUnit: "cbte.service"}} {
		for _, item := range catalogForConfig(cfg) {
			typ := str(item["type"])
			if typ == "analysis.restart" || typ == "database.restart" || typ == "analysis.status" || typ == "database.status" {
				unsupported := serviceProfile(cfg) == "oci-guarded"
				if (item["available"] == false) != unsupported || unsupported && str(item["unavailableReason"]) == "" {
					t.Fatalf("incorrect operation availability: %#v", item)
				}
			}
		}
	}
	if unit, verb := privilegedActionUnit(Config{BotUnit: "cbte.service"}, "database.restart"); unit != "mysql.service" || verb != "restart" {
		t.Fatal("primary MySQL control changed")
	}
}

func TestOCIUnsupportedActionsRejectAtAPIAndPrivilegedBoundary(t *testing.T) {
	a := testApp(t)
	a.cfg.ServiceControlProfile, a.cfg.RecoveryNode, a.cfg.BotUnit = "oci-guarded", "oci", ociWorkloadUnit
	for _, req := range []ExecutorRequest{
		{ID: "disabled-analysis", Type: "analysis.restart", Input: Object{}},
		{ID: "disabled-database", Type: "database.restart", Input: Object{}},
		{ID: "disabled-logs", Type: "logs.previous_boot", Input: Object{"source": "reports"}},
	} {
		w := request(t, a, "POST", "/v1/actions", Object{"type": req.Type, "input": req.Input, "idempotencyKey": req.ID})
		if w.Code != 501 || !strings.Contains(w.Body.String(), "ACTION_UNAVAILABLE_IN_DEPLOYMENT") {
			t.Fatalf("unsupported action accepted: %d %s", w.Code, w.Body.String())
		}
		// A nil store intentionally proves refusal occurs before a privileged
		// command or receipt lookup, even if the core boundary is bypassed.
		if _, err := executePrivileged(context.Background(), nil, a.cfg, req); err == nil {
			t.Fatal("root executor accepted unsupported OCI operation")
		}
	}
	var count int
	if err := a.store.db.QueryRow("SELECT COUNT(*) FROM actions").Scan(&count); err != nil || count != 0 {
		t.Fatalf("unsupported requests created actions: %d %v", count, err)
	}
}

func TestPreviouslyQueuedUnsupportedOCIActionCannotReachExecutor(t *testing.T) {
	a := testApp(t)
	a.cfg.ServiceControlProfile, a.cfg.RecoveryNode, a.cfg.BotUnit = "oci-guarded", "oci", ociWorkloadUnit
	ac, _, err := a.store.enqueue("analysis.restart", Object{"expectedInvocationId": "old"}, "old-queued-action", a.cfg.Owner, "automation")
	if err != nil {
		t.Fatal(err)
	}
	a.execute(context.Background(), ac)
	var status, issue string
	if err := a.store.db.QueryRow("SELECT status,error FROM actions WHERE id=?", ac.ID).Scan(&status, &issue); err != nil || status != "failed" || !strings.Contains(issue, "ACTION_UNAVAILABLE_IN_DEPLOYMENT") {
		t.Fatalf("queued operation did not fail explicitly: %s %s %v", status, issue, err)
	}
}

func TestOCIAbsentStandbyWorkersDoNotCreateIncidentsOrAutoRestart(t *testing.T) {
	a := testApp(t)
	a.cfg.ServiceControlProfile, a.cfg.RecoveryNode, a.cfg.BotUnit = "oci-guarded", "oci", ociWorkloadUnit
	policy := defaultPolicy()
	policy.AutoRestartAnalysis = true
	snapshot := Object{"analysisHTTP": Object{"configured": true, "ok": false}}
	for range 6 {
		a.monitorAnalysis(context.Background(), snapshot, policy, true, "standby-observation")
	}
	var count int
	if err := a.store.db.QueryRow("SELECT COUNT(*) FROM incidents").Scan(&count); err != nil || count != 0 {
		t.Fatalf("intentionally absent worker created an incident: %d %v", count, err)
	}
	for range 4 {
		a.monitorAnalysis(context.Background(), snapshot, policy, false, "active-observation")
	}
	if err := a.store.db.QueryRow("SELECT COUNT(*) FROM actions WHERE type='analysis.restart'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("OCI monitor queued unsupported restart: %d %v", count, err)
	}
	var evidence string
	if err := a.store.db.QueryRow("SELECT evidence FROM incidents WHERE fingerprint='analysis.unavailable'").Scan(&evidence); err != nil || !strings.Contains(evidence, "not_applicable") || strings.Contains(evidence, "analysis.restart") {
		t.Fatalf("OCI incident claims a nonexistent unit failed: %s %v", evidence, err)
	}
}

func TestOCIMissingUnitJournalsAreNotMisrepresentedAsEmptyCollectedLogs(t *testing.T) {
	a := testApp(t)
	a.cfg.ServiceControlProfile, a.cfg.RecoveryNode, a.cfg.BotUnit = "oci-guarded", "oci", ociWorkloadUnit
	for _, source := range []string{"database", "analysis"} {
		a.collectJournalBatch(context.Background(), source)
		if nested(a.journalHealth(), source)["state"] != "not_applicable" {
			t.Fatalf("unsupported journal source was treated as a live collector: %s", source)
		}
	}
}

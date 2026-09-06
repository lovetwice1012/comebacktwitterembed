package main

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestPlannedOCIAbsenceSuppressesOnlyKnownAbsenceIncidentsAndKeepsHistory(t *testing.T) {
	a := testApp(t)
	a.cfg.ServiceControlProfile, a.cfg.RecoveryNode, a.cfg.BotUnit = "oci-guarded", "oci", ociWorkloadUnit
	a.cfg.DiscordWebhook = "https://fixture.invalid/no-network-is-used"
	ids := map[string]string{}
	for _, fingerprint := range []string{"analysis.unavailable", "dashboard.local.unavailable", "bot.process.unavailable", "management.storage.pressure", "provider.twitter.failed"} {
		id, _, err := a.upsertIncident(fingerprint, fingerprint, Object{"observedFailure": fingerprint, "endpoint": "unavailable"})
		if err != nil {
			t.Fatal(err)
		}
		ids[fingerprint] = id
	}
	policy := defaultPolicy()
	policy.DesiredState, policy.Revision = "maintenance", 3
	if err := a.suppressPlannedOCIIncidents(policy, "planned-monitor-observation"); err != nil {
		t.Fatal(err)
	}
	for key, id := range ids {
		var status, evidence string
		var successes int
		if err := a.store.db.QueryRow("SELECT status,evidence,recovery_count FROM incidents WHERE id=?", id).Scan(&status, &evidence, &successes); err != nil {
			t.Fatal(err)
		}
		planned := key != "management.storage.pressure" && key != "provider.twitter.failed"
		if planned {
			if status != "Suppressed" || successes != 0 || !strings.Contains(evidence, "planned_standby") || !strings.Contains(evidence, "not_established") || !strings.Contains(evidence, "observedFailure") {
				t.Fatalf("suppression lost failure evidence or claimed recovery: %s %s", status, evidence)
			}
		} else if status != "Confirmed" {
			t.Fatalf("unrelated incident was suppressed: %s %s", key, status)
		}
	}
	active := object(t, request(t, a, "GET", "/v1/incidents?status=active", nil))
	if len(active["items"].([]any)) != 2 {
		t.Fatalf("planned incidents remained active: %#v", active)
	}
	history := object(t, request(t, a, "GET", "/v1/incidents", nil))
	if len(history["items"].([]any)) != 5 {
		t.Fatal("suppressed incidents were deleted from history")
	}
	var pending, suppressed, events int
	_ = a.store.db.QueryRow("SELECT COUNT(*) FROM outbox WHERE status='pending'").Scan(&pending)
	_ = a.store.db.QueryRow("SELECT COUNT(*) FROM outbox WHERE status='suppressed'").Scan(&suppressed)
	_ = a.store.db.QueryRow("SELECT COUNT(*) FROM events WHERE kind='monitor.incident.suppressed'").Scan(&events)
	if pending != 2 || suppressed != 3 || events != 3 {
		t.Fatalf("wrong notification/history transition: pending=%d suppressed=%d events=%d", pending, suppressed, events)
	}
	if err := a.suppressPlannedOCIIncidents(policy, "later-monitor-observation"); err != nil {
		t.Fatal(err)
	}
	_ = a.store.db.QueryRow("SELECT COUNT(*) FROM events WHERE kind='monitor.incident.suppressed'").Scan(&events)
	if events != 3 {
		t.Fatal("unchanged planned standby generated repeated history events")
	}
}

func TestRunningOCIRedetectsRealFailureAfterSuppression(t *testing.T) {
	a := testApp(t)
	a.cfg.ServiceControlProfile, a.cfg.RecoveryNode, a.cfg.BotUnit = "oci-guarded", "oci", ociWorkloadUnit
	id, _, err := a.upsertIncident("analysis.unavailable", "worker missing", Object{"oldFailure": true})
	if err != nil {
		t.Fatal(err)
	}
	policy := defaultPolicy()
	policy.DesiredState = "maintenance"
	if err := a.suppressPlannedOCIIncidents(policy, "standby"); err != nil {
		t.Fatal(err)
	}
	policy.DesiredState = "running"
	policy.Revision++
	if err := a.suppressPlannedOCIIncidents(policy, "running"); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		a.monitorAnalysis(context.Background(), Object{"analysisHTTP": Object{"configured": true, "ok": false}}, policy, false, "current-worker-failure")
	}
	var status string
	var revision, events int
	_ = a.store.db.QueryRow("SELECT status,revision FROM incidents WHERE id=?", id).Scan(&status, &revision)
	_ = a.store.db.QueryRow("SELECT COUNT(*) FROM events WHERE kind='monitor.incident.suppressed' AND payload LIKE '%oldFailure%'").Scan(&events)
	if status != "Confirmed" || revision != 3 || events != 1 {
		t.Fatalf("real running failure did not reopen with old history intact: %s rev=%d events=%d", status, revision, events)
	}
}

func TestSuppressionNeverMeansHealthyAndDoesNotAffectPrimary(t *testing.T) {
	a := testApp(t)
	id, _, _ := a.upsertIncident("bot.process.unavailable", "stopped", Object{})
	policy := defaultPolicy()
	policy.DesiredState = "maintenance"
	if err := a.suppressPlannedOCIIncidents(policy, "primary-maintenance"); err != nil {
		t.Fatal(err)
	}
	var status string
	_ = a.store.db.QueryRow("SELECT status FROM incidents WHERE id=?", id).Scan(&status)
	if status != "Confirmed" {
		t.Fatal("primary behavior was changed by OCI suppression")
	}
	a.cfg.ServiceControlProfile, a.cfg.RecoveryNode, a.cfg.BotUnit = "oci-guarded", "oci", ociWorkloadUnit
	if err := a.suppressPlannedOCIIncidents(policy, "oci-maintenance"); err != nil {
		t.Fatal(err)
	}
	for range 4 {
		if err := a.recoverIncident("bot.process.unavailable", Object{"not_a_recovery_claim": true}); err != nil {
			t.Fatal(err)
		}
	}
	_ = a.store.db.QueryRow("SELECT status FROM incidents WHERE id=?", id).Scan(&status)
	if status != "Suppressed" {
		t.Fatal("planned suppression was misrepresented as healthy recovery")
	}
	policy.DesiredState = "running"
	policy.MaintenanceUntil = time.Now().Add(time.Minute).UTC().Format(time.RFC3339)
	if workloadMonitoringState(a.cfg, policy)["state"] != "planned_standby" {
		t.Fatal("timed OCI maintenance was not described in health response")
	}
}

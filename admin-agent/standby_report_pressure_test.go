package main

import (
	"testing"
	"time"
)

func TestLongRestorePressureCannotAdvanceOCIStandbySeedRevision(t *testing.T) {
	for _, desired := range []string{"maintenance", "stopped", "running-with-maintenance"} {
		t.Run(desired, func(t *testing.T) {
			a := testApp(t)
			a.cfg.ServiceControlProfile, a.cfg.RecoveryNode, a.cfg.BotUnit = "oci-guarded", "oci", ociWorkloadUnit
			policy := defaultPolicy()
			policy.Revision, policy.DesiredState = 22, desired
			policy.ReportsPausedUntil = "2020-01-01T00:00:00Z"
			if desired == "running-with-maintenance" {
				policy.DesiredState = "running"
				policy.MaintenanceUntil = time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
			}
			if err := a.store.setSetting("policy", policy); err != nil {
				t.Fatal(err)
			}
			snapshot := Object{"host": Object{"pressureIO": Object{"raw": "full avg10=99.00 avg60=95.00\n"}}}
			a.failures["reports.io_pressure"] = 100 // Pressure has persisted across a long import.
			for range 2 {
				a.maybePauseReports(snapshot, policy, "long-restore-cycle")
			}
			current, err := a.loadPolicy()
			if err != nil || current != policy || a.failures["reports.io_pressure"] != 0 {
				t.Fatalf("standby seed was changed by host pressure: %#v %v", current, err)
			}
			var pauses int
			_ = a.store.db.QueryRow("SELECT COUNT(*) FROM events WHERE kind='admin.reports.paused'").Scan(&pauses)
			if pauses != 0 {
				t.Fatal("planned standby generated automatic pause events")
			}
		})
	}
}

func TestOCIActiveReportPressureStillPausesAfterRepeatedEvidence(t *testing.T) {
	a := testApp(t)
	a.cfg.ServiceControlProfile, a.cfg.RecoveryNode, a.cfg.BotUnit = "oci-guarded", "oci", ociWorkloadUnit
	policy := defaultPolicy()
	policy.Revision = 22
	_ = a.store.setSetting("policy", policy)
	snapshot := Object{"host": Object{"pressureIO": Object{"raw": "full avg10=99.00 avg60=95.00\n"}}}
	for range 2 {
		a.maybePauseReports(snapshot, policy, "running-cycle")
	}
	current, _ := a.loadPolicy()
	if current.Revision != 22 || current.ReportsPausedUntil != "" {
		t.Fatal("active reports paused without three observations")
	}
	a.maybePauseReports(snapshot, policy, "running-cycle-3")
	current, _ = a.loadPolicy()
	until, err := time.Parse(time.RFC3339Nano, current.ReportsPausedUntil)
	if err != nil || current.Revision != 23 || time.Until(until) < 4*time.Minute || time.Until(until) > 5*time.Minute {
		t.Fatalf("active OCI report pressure protection was lost: %#v %v", current, err)
	}
}

func TestReportPauseRechecksLatestOCIStopPolicyBeforeMutation(t *testing.T) {
	a := testApp(t)
	a.cfg.ServiceControlProfile, a.cfg.RecoveryNode, a.cfg.BotUnit = "oci-guarded", "oci", ociWorkloadUnit
	stale := defaultPolicy()
	current := stale
	current.DesiredState, current.Revision = "maintenance", 24
	_ = a.store.setSetting("policy", current)
	a.failures["reports.io_pressure"] = 3
	a.maybePauseReports(Object{"host": Object{"pressureIO": Object{"raw": "full avg10=99.00\n"}}}, stale, "stale-running-snapshot")
	loaded, _ := a.loadPolicy()
	if loaded != current {
		t.Fatal("stale monitor snapshot overwrote current maintenance seed")
	}
}

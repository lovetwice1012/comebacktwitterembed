package main

import "time"

func plannedOCIAbsence(cfg Config, policy Policy, at time.Time) bool {
	if serviceProfile(cfg) != "oci-guarded" {
		return false
	}
	if policy.DesiredState == "stopped" || policy.DesiredState == "maintenance" {
		return true
	}
	until, err := time.Parse(time.RFC3339Nano, policy.MaintenanceUntil)
	return policy.DesiredState == "running" && err == nil && at.Before(until)
}

func workloadMonitoringState(cfg Config, policy Policy) Object {
	value := Object{"state": "observing", "desiredState": policy.DesiredState, "policyRevision": policy.Revision, "maintenanceUntil": policy.MaintenanceUntil}
	if plannedOCIAbsence(cfg, policy, time.Now()) {
		value["state"] = "planned_standby"
		value["message"] = "OCIは待機・保守設定中です。Bot・通常Web・分析workerの予定された停止は通知対象外です。正常稼働を確認した意味ではありません。"
	}
	return value
}

func (a *App) suppressPlannedOCIIncidents(policy Policy, eventID string) error {
	if !plannedOCIAbsence(a.cfg, policy, time.Now()) {
		return nil
	}
	// Only these absence diagnoses are explained by the planned workload stop.
	// Storage, provider, database and public-path incidents remain untouched.
	for _, key := range []string{"bot.process.unavailable", "dashboard.local.unavailable", "analysis.unavailable"} {
		a.failures[key] = 0
	}
	tx, err := a.store.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.Query("SELECT id,fingerprint,status,revision,evidence FROM incidents WHERE fingerprint IN ('bot.process.unavailable','dashboard.local.unavailable','analysis.unavailable') AND status IN ('Confirmed','Investigating','Verifying')")
	if err != nil {
		return err
	}
	type item struct {
		id, fingerprint, status, evidence string
		revision                          int
	}
	items := []item{}
	for rows.Next() {
		var value item
		if err = rows.Scan(&value.id, &value.fingerprint, &value.status, &value.revision, &value.evidence); err != nil {
			rows.Close()
			return err
		}
		items = append(items, value)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, value := range items {
		evidence := Object{"reason": "planned_standby", "actionable": false, "endpointHealth": "not_established",
			"claim":          "OCI operator policy requests stopped or maintenance operation. Expected workload absence is non-actionable; endpoint health has not been established.",
			"policyRevision": policy.Revision, "desiredState": policy.DesiredState, "maintenanceUntil": policy.MaintenanceUntil,
			"eventIds": []string{eventID}, "classifiedAt": now(), "previousStatus": value.status, "previousEvidence": decode(value.evidence)}
		if _, err = tx.Exec("UPDATE incidents SET status='Suppressed',revision=revision+1,updated_at=?,evidence=?,recovery_count=0,recovery_start=NULL WHERE id=?", now(), encode(evidence), value.id); err != nil {
			return err
		}
		if _, err = tx.Exec("UPDATE outbox SET status='suppressed',last_error=? WHERE incident_id=? AND status='pending'", "Pending notification retries suppressed by planned_standby policy", value.id); err != nil {
			return err
		}
		if err = a.auditAuthTx(tx, "monitor.incident.suppressed", "system", "monitor", Object{"incidentId": value.id, "fingerprint": value.fingerprint, "previousRevision": value.revision, "revision": value.revision + 1, "evidence": evidence}); err != nil {
			return err
		}
	}
	return tx.Commit()
}

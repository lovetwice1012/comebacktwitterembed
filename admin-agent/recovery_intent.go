package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

type RecoveryIntent struct {
	Node         string `json:"node"`
	DesiredState string `json:"desiredState"`
	Revision     int    `json:"revision"`
	ActorID      string `json:"actorId"`
}

type SavedRecoveryIntent struct {
	RecoveryIntent
	Acknowledged   bool   `json:"acknowledged"`
	InitiatedVia   string `json:"initiatedVia"`
	UpdatedAt      string `json:"updatedAt"`
	AcknowledgedAt string `json:"acknowledgedAt,omitempty"`
}

func (a *App) recoveryIntentConfigured() bool {
	// The same URL also serves the independent read-only recovery status panel.
	// Either intent-specific variable opts into strict, fail-closed delivery.
	return a.cfg.RecoveryIntentToken != "" || a.cfg.RecoveryNode != ""
}

func (a *App) saveRecoveryIntentTx(tx *sql.Tx, p Policy, actor, via string) error {
	if !a.recoveryIntentConfigured() {
		return nil
	}
	saved := SavedRecoveryIntent{RecoveryIntent: RecoveryIntent{a.cfg.RecoveryNode, p.DesiredState, p.Revision, actor}, InitiatedVia: via, UpdatedAt: now()}
	_, e := tx.Exec("INSERT INTO settings(key,value) VALUES('recovery_intent',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", encode(saved))
	return e
}

func (a *App) acknowledgeRecoveryIntent(ctx context.Context, intent RecoveryIntent) error {
	if !a.recoveryIntentConfigured() {
		return nil
	}
	u, e := recoveryEndpoint(a.cfg.RecoveryControllerURL, a.cfg.RecoveryIntentToken)
	if e != nil || (a.cfg.RecoveryNode != "primary" && a.cfg.RecoveryNode != "oci") || intent.Node != a.cfg.RecoveryNode || intent.Revision < 1 || !a.allowedAdmin(intent.ActorID) || (intent.DesiredState != "running" && intent.DesiredState != "stopped" && intent.DesiredState != "maintenance") {
		return errors.New("Recovery intent configuration or persisted intent is invalid")
	}
	u.Path = "/v1/intent"
	deadline, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	request, e := http.NewRequestWithContext(deadline, http.MethodPost, u.String(), strings.NewReader(encode(intent)))
	if e != nil {
		return errors.New("Recovery intent request could not be prepared")
	}
	request.Header.Set("Authorization", "Bearer "+a.cfg.RecoveryIntentToken)
	request.Header.Set("Content-Type", "application/json")
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true, MaxResponseHeaderBytes: 4096}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, e := client.Do(request)
	if e != nil {
		return errors.New("Recovery controller acknowledgement could not be confirmed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("Recovery controller did not accept the persisted intent")
	}
	data, e := io.ReadAll(io.LimitReader(response.Body, 4097))
	var result struct {
		OK           bool   `json:"ok"`
		Node         string `json:"node"`
		DesiredState string `json:"desiredState"`
		Revision     int    `json:"revision"`
	}
	if e != nil || len(data) > 4096 || json.Unmarshal(data, &result) != nil || !result.OK || result.Node != intent.Node || result.DesiredState != intent.DesiredState || result.Revision != intent.Revision {
		return errors.New("Recovery controller acknowledgement did not match the persisted intent")
	}
	res, e := a.store.db.Exec("UPDATE settings SET value=json_set(value,'$.acknowledged',json('true'),'$.acknowledgedAt',?) WHERE key='recovery_intent' AND json_extract(value,'$.node')=? AND json_extract(value,'$.revision')=? AND json_extract(value,'$.desiredState')=? AND json_extract(value,'$.actorId')=?", now(), intent.Node, intent.Revision, intent.DesiredState, intent.ActorID)
	if e != nil {
		return errors.New("Recovery acknowledgement could not be saved locally")
	}
	if n, e := res.RowsAffected(); e != nil || n != 1 {
		return errors.New("Local recovery intent changed before acknowledgement")
	}
	return nil
}

func (a *App) confirmPolicyRecoveryIntent(ctx context.Context, p Policy, actor string) Object {
	if e := a.acknowledgeRecoveryIntent(ctx, RecoveryIntent{a.cfg.RecoveryNode, p.DesiredState, p.Revision, actor}); e != nil {
		return Object{"code": "RECOVERY_INTENT_UNACKNOWLEDGED", "message": "稼働方針はローカルに保存しましたが、復旧コントローラーの受領を確認できません。サービス操作は実行していません。状態を再取得してから再試行してください。", "cause": e.Error(), "retryable": true, "localPolicySaved": true, "executionStarted": false, "policyRevision": p.Revision, "desiredState": p.DesiredState}
	}
	return nil
}

// Called with recoveryIntentMu held through the subsequent executor operation.
func (a *App) saveServicePolicy(ctx context.Context, ac Action) Object {
	tx, e := a.store.db.Begin()
	if e != nil {
		return Object{"code": "POLICY_SAVE_FAILED", "message": e.Error(), "executionStarted": false}
	}
	defer tx.Rollback()
	var raw string
	var previous Policy
	if e = tx.QueryRow("SELECT value FROM settings WHERE key='policy'").Scan(&raw); e == nil {
		e = json.Unmarshal([]byte(raw), &previous)
	}
	if e != nil {
		return Object{"code": "POLICY_SAVE_FAILED", "message": e.Error(), "executionStarted": false}
	}
	if ac.Via == "automation" && ac.Type != "service.stop" {
		maintenanceUntil, _ := time.Parse(time.RFC3339Nano, previous.MaintenanceUntil)
		if previous.DesiredState != "running" || time.Now().Before(maintenanceUntil) {
			return Object{"code": "SERVICE_INTENT_CHANGED", "message": "Automatic service operation was cancelled because the current policy is stopped or under maintenance", "executionStarted": false}
		}
	}
	p := previous
	p.Revision++
	p.DesiredState = "running"
	if ac.Type == "service.stop" {
		p.DesiredState = "stopped"
	}
	if _, e = tx.Exec("UPDATE settings SET value=? WHERE key='policy'", encode(p)); e == nil {
		e = a.auditAuthTx(tx, "admin.policy.changed", ac.Actor, ac.Via, Object{"before": previous, "after": p, "actionId": ac.ID, "actionType": ac.Type})
	}
	if e == nil {
		e = a.saveRecoveryIntentTx(tx, p, ac.Actor, ac.Via)
	}
	if e == nil {
		e = tx.Commit()
	}
	if e != nil {
		return Object{"code": "POLICY_SAVE_FAILED", "message": e.Error(), "executionStarted": false}
	}
	return a.confirmPolicyRecoveryIntent(ctx, p, ac.Actor)
}

// Retry only the durable intent. This never replays a service operation.
func (a *App) retryRecoveryIntent(ctx context.Context) {
	if !a.recoveryIntentConfigured() || !a.recoveryIntentMu.TryLock() {
		return
	}
	defer a.recoveryIntentMu.Unlock()
	var saved SavedRecoveryIntent
	if e := a.store.getSetting("recovery_intent", &saved); e != nil || saved.Acknowledged {
		return
	}
	_ = a.acknowledgeRecoveryIntent(ctx, saved.RecoveryIntent)
}

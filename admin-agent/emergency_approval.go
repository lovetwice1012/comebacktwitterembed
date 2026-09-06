package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

type emergencyApprovalRequest struct {
	ApprovalID                    string `json:"approvalId"`
	ActorID                       string `json:"actorId"`
	ExpectedEpoch                 int64  `json:"expectedEpoch"`
	CandidateID                   string `json:"candidateId"`
	BackupID                      string `json:"backupId"`
	BackupSHA256                  string `json:"backupSha256"`
	SourceTimestamp               string `json:"sourceTimestamp"`
	ExpectedPrimaryIntentRevision *int64 `json:"expectedPrimaryIntentRevision"`
	ExpectedPrimaryIntentState    string `json:"expectedPrimaryIntentState"`
	ExpectedOCIPolicyRevision     int64  `json:"expectedOciPolicyRevision"`
	Reason                        string `json:"reason"`
	AcceptBackupRollback          bool   `json:"acceptBackupRollback"`
	AcceptMissingSavedata         bool   `json:"acceptMissingSavedata"`
	AcceptPrimaryIntentOverride   bool   `json:"acceptPrimaryIntentOverride"`
}

var approvalCandidateID = regexp.MustCompile(`^[0-9a-f]{24}$`)
var approvalBackupHash = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (a *App) approveEmergencyRecovery(parent context.Context, action Action, input Object) (any, any) {
	fail := func(code, message string) (any, any) {
		return nil, Object{"code": code, "message": message, "executionStarted": false}
	}
	if a.cfg.RecoveryNode != "oci" || !a.allowedAdmin(action.Actor) || (action.Via != "dashboard" && action.Via != "standalone") {
		return fail("EXPLICIT_OCI_ADMIN_REQUIRED", "OCIの許可された管理者による明示操作が必要です。自動処理は承認できません。")
	}
	if len(input) != 12 {
		return fail("INVALID_EMERGENCY_APPROVAL", "復旧候補・世代・運転指示・理由と3項目の確認が必要です。")
	}
	for key := range input {
		switch key {
		case "expectedEpoch", "candidateId", "backupId", "backupSha256", "sourceTimestamp", "expectedPrimaryIntentRevision", "expectedPrimaryIntentState", "expectedOciPolicyRevision", "reason", "acceptBackupRollback", "acceptMissingSavedata", "acceptPrimaryIntentOverride":
		default:
			return fail("INVALID_EMERGENCY_APPROVAL", "許可されていない承認フィールドが含まれています。")
		}
	}
	var body emergencyApprovalRequest
	if json.Unmarshal([]byte(encode(input)), &body) != nil || body.ExpectedEpoch < 1 || body.ExpectedOCIPolicyRevision < 1 || !approvalCandidateID.MatchString(body.CandidateID) || !approvalBackupHash.MatchString(body.BackupSHA256) || !body.AcceptBackupRollback || !body.AcceptMissingSavedata || !body.AcceptPrimaryIntentOverride || len(strings.TrimSpace(body.Reason)) < 5 || len(body.Reason) > 4000 {
		return fail("INVALID_EMERGENCY_APPROVAL", "対象と明示確認が不完全です。バックアップ以後の変更消失・savedata未移行・本体指示条件の一回限りの免除を確認してください。")
	}
	body.ApprovalID, body.ActorID = action.ID, action.Actor
	u, err := recoveryEndpoint(a.cfg.RecoveryControllerURL, a.cfg.RecoveryIntentToken)
	if err != nil {
		return fail("EMERGENCY_APPROVAL_UNCONFIGURED", "OCI管理者の承認通知先が設定されていません。")
	}
	u.Path = "/v1/emergency-approvals"
	ctx, cancel := context.WithTimeout(parent, 12*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), strings.NewReader(encode(body)))
	if err != nil {
		return fail("EMERGENCY_APPROVAL_UNCONFIGURED", "承認通知を構成できません。")
	}
	request.Header.Set("Authorization", "Bearer "+a.cfg.RecoveryIntentToken)
	request.Header.Set("Content-Type", "application/json")
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	client := http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return nil, Object{"code": "ACTION_OUTCOME_UNKNOWN", "message": "承認の保存結果が不明です。緊急復旧画面の承認IDと操作履歴を確認してください。", "approvalId": action.ID}
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, (64<<10)+1))
	var result Object
	if err != nil || len(data) > 64<<10 || json.Unmarshal(data, &result) != nil {
		return nil, workerProblem("ACTION_OUTCOME_UNKNOWN", errors.New("承認応答を検証できません。緊急復旧画面で保存済み承認IDを確認してください。"))
	}
	if response.StatusCode != 200 {
		return fail("EMERGENCY_APPROVAL_REJECTED", str(redactRecovery(first(nested(result, "error"), "message"), a.cfg.RecoveryIntentToken)))
	}
	receipt := nested(result, "approval")
	var primaryRevision any
	if body.ExpectedPrimaryIntentRevision != nil {
		primaryRevision = float64(*body.ExpectedPrimaryIntentRevision)
	}
	validState := receipt["state"] == "approved" || receipt["state"] == "reserved" || receipt["state"] == "consumed" || receipt["state"] == "expired" || receipt["state"] == "invalidated"
	if result["ok"] != true || !validState || str(receipt["approvalId"]) != action.ID || str(receipt["actorId"]) != action.Actor || str(receipt["candidateId"]) != body.CandidateID || str(receipt["backupSha256"]) != body.BackupSHA256 || str(receipt["backupId"]) != body.BackupID || str(receipt["sourceTimestamp"]) != body.SourceTimestamp || receipt["expectedEpoch"] != float64(body.ExpectedEpoch) || receipt["expectedPrimaryIntentRevision"] != primaryRevision || receipt["expectedPrimaryIntentState"] != body.ExpectedPrimaryIntentState || receipt["expectedOciPolicyRevision"] != float64(body.ExpectedOCIPolicyRevision) || receipt["overriddenGate"] != "PRIMARY_OPERATOR_RUNNING" || receipt["primaryIntentPreserved"] != true || receipt["doesNotArm"] != true || receipt["requiresOtherGates"] != true {
		return nil, workerProblem("ACTION_OUTCOME_UNKNOWN", errors.New("保存済み承認が確認対象と一致しません。起動許可を推定せず承認履歴を確認してください。"))
	}
	value := Object{"approval": redactRecovery(receipt, a.cfg.RecoveryIntentToken), "doesNotDirectlyStartWorkload": true, "message": "一回限りの承認を記録しました。自動有効化・本体運転指示の変更は行わず、残るすべての起動条件を満たすまで待機します。"}
	if receipt["state"] == "expired" || receipt["state"] == "invalidated" {
		return value, Object{"code": "EMERGENCY_APPROVAL_NO_LONGER_VALID", "message": "この承認は失効または対象変更により無効です。現在の候補を再確認してください。"}
	}
	return value, nil
}

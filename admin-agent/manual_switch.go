package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

var manualSwitchInputFields = map[string]bool{
	"targetNode": true, "executeAt": true, "expectedEpoch": true,
	"expectedCandidateId": true, "expectedBackupId": true,
	"expectedBackupSha256": true, "expectedBackupTimestamp": true,
	"reason": true, "confirm": true, "acceptDataRisk": true,
	"acceptPrimaryIntentOverride": true,
}

type manualSwitchInput struct {
	TargetNode                  string `json:"targetNode"`
	ExecuteAt                   string `json:"executeAt"`
	ExpectedEpoch               int    `json:"expectedEpoch"`
	ExpectedCandidateID         string `json:"expectedCandidateId"`
	ExpectedBackupID            string `json:"expectedBackupId"`
	ExpectedBackupSHA256        string `json:"expectedBackupSha256"`
	ExpectedBackupTimestamp     string `json:"expectedBackupTimestamp"`
	Reason                      string `json:"reason"`
	Confirm                     bool   `json:"confirm"`
	AcceptDataRisk              bool   `json:"acceptDataRisk"`
	AcceptPrimaryIntentOverride bool   `json:"acceptPrimaryIntentOverride"`
}

func validManualSwitchInput(input Object) bool {
	if len(input) != len(manualSwitchInputFields) {
		return false
	}
	for key := range input {
		if !manualSwitchInputFields[key] {
			return false
		}
	}
	return true
}

func (a *App) recoveryControllerJSON(ctx context.Context, path string, value Object) (Object, int, error) {
	if a.cfg.RecoveryControllerURL == "" || len(a.cfg.RecoveryControllerToken) < 32 {
		return nil, 0, errors.New("recovery controller is not configured")
	}
	endpoint, err := recoveryEndpoint(a.cfg.RecoveryControllerURL, a.cfg.RecoveryControllerToken)
	if err != nil {
		return nil, 0, err
	}
	endpoint.Path = path
	payload := []byte(encode(value))
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), strings.NewReader(string(payload)))
	if err != nil {
		return nil, 0, err
	}
	request.Header.Set("Authorization", "Bearer "+a.cfg.RecoveryControllerToken)
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 12 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 256<<10))
	if err != nil || len(data) > 256<<10 {
		return nil, response.StatusCode, errors.New("recovery controller response could not be read")
	}
	var result Object
	if json.Unmarshal(data, &result) != nil {
		return nil, response.StatusCode, errors.New("recovery controller response was invalid")
	}
	return result, response.StatusCode, nil
}

func (a *App) submitManualSwitch(parent context.Context, action Action, input Object) (any, any) {
	fail := func(code, message string) (any, any) {
		return nil, Object{"code": code, "message": message, "executionStarted": false, "operationId": action.ID}
	}
	if !a.allowedAdmin(action.Actor) || (action.Via != "dashboard" && action.Via != "standalone") {
		return fail("EXPLICIT_ADMIN_REQUIRED", "許可された管理者による明示操作が必要です")
	}
	if !validManualSwitchInput(input) {
		return fail("INVALID_MANUAL_SWITCH", "手動切り替えの入力項目が不正です")
	}
	var in manualSwitchInput
	if json.Unmarshal([]byte(encode(input)), &in) != nil || (in.TargetNode != "primary" && in.TargetNode != "oci") || in.ExpectedEpoch < 1 || len(strings.TrimSpace(in.Reason)) < 5 || len(in.Reason) > 1000 || !in.Confirm || !in.AcceptDataRisk || !in.AcceptPrimaryIntentOverride {
		return fail("INVALID_MANUAL_SWITCH", "切り替え先・現在epoch・理由・影響確認を入力してください")
	}
	body := Object{
		"operationId": action.ID, "actorId": action.Actor, "targetNode": in.TargetNode,
		"executeAt": in.ExecuteAt, "expectedEpoch": in.ExpectedEpoch,
		"expectedCandidateId": in.ExpectedCandidateID, "expectedBackupId": in.ExpectedBackupID,
		"expectedBackupSha256": in.ExpectedBackupSHA256, "expectedBackupTimestamp": in.ExpectedBackupTimestamp,
		"reason": strings.TrimSpace(in.Reason), "confirm": in.Confirm,
		"acceptDataRisk": in.AcceptDataRisk, "acceptPrimaryIntentOverride": in.AcceptPrimaryIntentOverride,
	}
	result, status, err := a.recoveryControllerJSON(parent, "/v1/manual-switch", body)
	if err != nil {
		return nil, Object{"code": "ACTION_OUTCOME_UNKNOWN", "message": "手動切り替えの受付結果を確認できません。復旧状態と操作履歴を再取得してください。", "operationId": action.ID}
	}
	if status != http.StatusOK || result["ok"] != true {
		message := "手動切り替えは受け付けられませんでした"
		if item := nested(result, "error"); item != nil {
			if value := str(item["message"]); value != "" {
				message = value
			}
		}
		return fail("MANUAL_SWITCH_REJECTED", message)
	}
	return result, nil
}

func (a *App) cancelManualSwitch(parent context.Context, action Action, input Object) (any, any) {
	fail := func(code, message string) (any, any) {
		return nil, Object{"code": code, "message": message, "executionStarted": false, "operationId": action.ID}
	}
	if !a.allowedAdmin(action.Actor) || (action.Via != "dashboard" && action.Via != "standalone") {
		return fail("EXPLICIT_ADMIN_REQUIRED", "許可された管理者による明示操作が必要です")
	}
	if len(input) != 1 || input["operationId"] == nil || str(input["operationId"]) == "" {
		return fail("INVALID_MANUAL_SWITCH_CANCEL", "キャンセルするoperationIdを指定してください")
	}
	operationID := str(input["operationId"])
	result, status, err := a.recoveryControllerJSON(parent, "/v1/manual-switch/cancel", Object{"operationId": operationID, "actorId": action.Actor})
	if err != nil {
		return nil, Object{"code": "ACTION_OUTCOME_UNKNOWN", "message": "手動切り替えのキャンセル結果を確認できません。復旧状態を再取得してください。", "operationId": operationID}
	}
	if status != http.StatusOK || result["ok"] != true {
		message := "手動切り替えをキャンセルできませんでした"
		if item := nested(result, "error"); item != nil && str(item["message"]) != "" {
			message = str(item["message"])
		}
		return fail("MANUAL_SWITCH_CANCEL_REJECTED", message)
	}
	return result, nil
}

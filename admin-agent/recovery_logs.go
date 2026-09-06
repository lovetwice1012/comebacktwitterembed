package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"time"
)

const workloadLogsResponseLimit = 2 << 20

var workloadLogErrorCode = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)

func workloadLogQuery(query url.Values) (url.Values, bool) {
	result := url.Values{}
	for key, values := range query {
		if len(values) != 1 || (key != "component" && key != "archive" && key != "bytes" && key != "lines") {
			return nil, false
		}
		result.Set(key, values[0])
	}
	component := result.Get("component")
	if component == "" {
		if _, exists := result["component"]; exists {
			return nil, false
		}
		component = "bot"
		result.Set("component", component)
	}
	if component != "bot" && component != "interactive" && component != "reports" {
		return nil, false
	}
	for key, bound := range map[string][3]int{"archive": {0, 0, 7}, "bytes": {65536, 1, 262144}, "lines": {200, 1, 1000}} {
		raw := result.Get(key)
		if raw == "" {
			if _, exists := result[key]; exists {
				return nil, false
			}
			result.Set(key, strconv.Itoa(bound[0]))
			continue
		}
		value, err := strconv.Atoi(raw)
		if err != nil || strconv.Itoa(value) != raw || value < bound[1] || value > bound[2] {
			return nil, false
		}
	}
	return result, true
}

func (a *App) recoveryWorkloadLogs(w http.ResponseWriter, r *http.Request) {
	parsed, parseErr := url.ParseQuery(r.URL.RawQuery)
	query, ok := workloadLogQuery(parsed)
	if parseErr != nil || !ok {
		fail(w, 400, "INVALID_WORKLOAD_LOG_QUERY", "ログはbot・interactive・reportsのみ指定できます。範囲外・重複・パス指定は使用できません。")
		return
	}
	if a.cfg.RecoveryControllerURL == "" || a.cfg.RecoveryControllerToken == "" {
		recoveryUnavailable(w, "not_configured", "OCIログ取得先が設定されていません。", false, 200)
		return
	}
	u, err := recoveryEndpoint(a.cfg.RecoveryControllerURL, a.cfg.RecoveryControllerToken)
	if err != nil {
		recoveryUnavailable(w, "invalid_configuration", "OCIログ取得のローカル接続設定が不正です。", true, 503)
		return
	}
	u.Path, u.RawQuery = "/v1/workload-logs", query.Encode()
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		recoveryUnavailable(w, "invalid_configuration", "OCIログ取得先を構成できません。", true, 503)
		return
	}
	request.Header.Set("Authorization", "Bearer "+a.cfg.RecoveryControllerToken)
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	client := http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		recoveryUnavailable(w, "unavailable", "OCIログを取得できません。コントローラーの接続状態を確認してください。", true, 503)
		return
	}
	defer response.Body.Close()
	if response.StatusCode == 404 {
		recoveryUnavailable(w, "controller_endpoint_pending", "稼働中コントローラーへのログ取得機能の反映待ちです。復元処理が完了した後の更新で利用できます。", true, 503)
		return
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, workloadLogsResponseLimit+1))
	var value Object
	if err != nil || len(data) > workloadLogsResponseLimit || json.Unmarshal(data, &value) != nil {
		recoveryUnavailable(w, "invalid_response", "OCIログの応答が不正、またはサイズ上限を超えました。", true, 503)
		return
	}
	if response.StatusCode != 200 {
		issue := nested(value, "error")
		code := first(issue, "code")
		if !workloadLogErrorCode.MatchString(code) {
			code = "WORKLOAD_LOGS_UNAVAILABLE"
		}
		message := first(issue, "message")
		if message == "" || len(message) > 2048 {
			message = "OCIログの所有権・候補との対応・ファイル状態を確認できません。"
		}
		message = str(redactRecovery(message, a.cfg.RecoveryControllerToken))
		jsonResponse(w, 503, Object{"available": false, "state": code, "error": Object{"code": code, "message": message}, "fetchedAt": now()})
		return
	}
	text, isText := value["text"].(string)
	_, isAvailable := value["available"].(bool)
	expectedArchive, _ := strconv.Atoi(query.Get("archive"))
	if value["ok"] != true || str(value["component"]) != query.Get("component") || value["archive"] != float64(expectedArchive) || !isAvailable || !isText || len(text) > 3*262144 {
		recoveryUnavailable(w, "invalid_response", "OCIログ応答の対象・本文を検証できません。", true, 503)
		return
	}
	result := Object{"configured": true, "fetchedAt": now()}
	for _, key := range []string{"ok", "available", "state", "message", "component", "archive", "text", "files", "observedAt", "limits", "candidateId", "pointerEpoch", "activationEpoch", "currentActivation", "phase", "activationUpdatedAt", "metadataSource", "logHealth", "fileBytes", "returnedBytes", "returnedLines", "omittedBytes", "truncated", "firstLinePartial", "fileUpdatedAt", "snapshotChanged", "encoding", "controlCredentialsRedacted"} {
		if item, exists := value[key]; exists {
			result[key] = redactRecovery(item, a.cfg.RecoveryControllerToken)
		}
	}
	jsonResponse(w, 200, result)
}

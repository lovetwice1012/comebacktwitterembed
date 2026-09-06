package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const recoveryStatusLimit = 1 << 20

var recoverySecretKey = regexp.MustCompile(`(?i)^(authorization|cookie|set-cookie|password|secret|token|.*[_-]token|.*[_-]secret|.*Token|.*Secret|private[_-]?key|access[_-]?key)$`)

func recoveryEndpoint(base, token string) (*url.URL, error) {
	u, e := url.Parse(base)
	if e != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || len(token) < 32 || strings.ContainsAny(token, "\r\n") {
		return nil, errors.New("invalid recovery configuration")
	}
	host := u.Hostname()
	if host != "127.0.0.1" && host != "localhost" && host != "::1" {
		return nil, errors.New("recovery controller must use loopback HTTP")
	}
	// Never resolve localhost through an externally configured DNS/proxy.
	if host == "localhost" {
		port := u.Port()
		u.Host = "127.0.0.1"
		if port != "" {
			u.Host = net.JoinHostPort("127.0.0.1", port)
		}
	}
	u.Path, u.RawPath = "/v1/status", ""
	return u, nil
}

func redactRecovery(value any, token string) any {
	switch v := value.(type) {
	case string:
		return strings.ReplaceAll(v, token, "[credential omitted]")
	case []any:
		for i := range v {
			v[i] = redactRecovery(v[i], token)
		}
	case map[string]any:
		for key, item := range v {
			if recoverySecretKey.MatchString(key) {
				v[key] = "[credential omitted]"
			} else {
				v[key] = redactRecovery(item, token)
			}
		}
	}
	return value
}

func recoveryUnavailable(w http.ResponseWriter, code, message string, configured bool, status int) {
	result := Object{"configured": configured, "available": false, "state": code, "message": message, "fetchedAt": now()}
	if status >= 400 {
		result["error"] = Object{"code": code, "message": message}
	}
	jsonResponse(w, status, result)
}

func (a *App) recoveryStatus(w http.ResponseWriter, r *http.Request) {
	if a.cfg.RecoveryControllerURL == "" || a.cfg.RecoveryControllerToken == "" {
		recoveryUnavailable(w, "not_configured", "緊急復旧コントローラーの接続設定が未設定です。", false, 200)
		return
	}
	u, e := recoveryEndpoint(a.cfg.RecoveryControllerURL, a.cfg.RecoveryControllerToken)
	if e != nil {
		recoveryUnavailable(w, "invalid_configuration", "緊急復旧コントローラーのローカル接続設定を確認してください。", true, 503)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	request, e := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if e != nil {
		recoveryUnavailable(w, "invalid_configuration", "緊急復旧コントローラーの接続先を構成できません。", true, 503)
		return
	}
	request.Header.Set("Authorization", "Bearer "+a.cfg.RecoveryControllerToken)
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, e := client.Do(request)
	if e != nil {
		recoveryUnavailable(w, "unavailable", "緊急復旧コントローラーへ接続できません。他の管理操作は引き続き利用できます。", true, 503)
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		recoveryUnavailable(w, "upstream_error", "緊急復旧コントローラーが成功応答を返しませんでした。", true, 503)
		return
	}
	data, e := io.ReadAll(io.LimitReader(response.Body, recoveryStatusLimit+1))
	var value Object
	if e != nil || len(data) > recoveryStatusLimit || json.Unmarshal(data, &value) != nil || str(value["phase"]) == "" {
		recoveryUnavailable(w, "invalid_response", "緊急復旧コントローラーの状態を読み取れません。", true, 503)
		return
	}
	result := Object{"configured": true, "available": true, "fetchedAt": now()}
	for _, key := range []string{"phase", "updatedAt", "backup", "candidate", "gates", "lastError", "primaryEnrolled", "activeNode", "epoch", "download", "import", "nextPrepareAt"} {
		if item, exists := value[key]; exists {
			result[key] = redactRecovery(item, a.cfg.RecoveryControllerToken)
		}
	}
	jsonResponse(w, 200, result)
}

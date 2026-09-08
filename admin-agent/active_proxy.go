package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const activeProxyHeader = "X-CBTE-Active-Proxy"
const activeProxyBodyLimit = 24 << 20

// activeProxyPath contains the management API that must follow the current
// Bot owner.  Producer telemetry stays local so a standby Bot cannot loop its
// own event spool through the peer; reads and admin actions use the active
// core's durable state instead.
func activeProxyPath(r *http.Request) bool {
	if !strings.HasPrefix(r.URL.Path, "/v1/") {
		return false
	}
	if r.URL.Path == "/v1/account/password" || (r.URL.Path == "/v1/events" && r.Method != http.MethodGet && r.Method != http.MethodHead) {
		return false
	}
	// Recovery status and workload logs describe this OCI controller and its
	// validated candidate, even while the current primary is unreachable. They
	// must remain local so the emergency path can inspect its own gates.
	if r.URL.Path == "/v1/recovery" || strings.HasPrefix(r.URL.Path, "/v1/recovery/") {
		return false
	}
	for _, prefix := range []string{"/v1/health", "/v1/recovery", "/v1/catalog", "/v1/events", "/v1/runs", "/v1/actions", "/v1/metrics", "/v1/shards", "/v1/reports", "/v1/incidents", "/v1/policies", "/v1/notifications"} {
		if r.URL.Path == prefix || strings.HasPrefix(r.URL.Path, prefix+"/") {
			return true
		}
	}
	return false
}

func (a *App) activeNode(ctx context.Context) (string, error) {
	if a.cfg.RecoveryControllerURL == "" || a.cfg.RecoveryControllerToken == "" {
		return "", errors.New("recovery controller is not configured")
	}
	endpoint, err := recoveryEndpoint(a.cfg.RecoveryControllerURL, a.cfg.RecoveryControllerToken)
	if err != nil {
		return "", err
	}
	requestCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+a.cfg.RecoveryControllerToken)
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", errors.New("recovery controller did not return status")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 512<<10))
	if err != nil {
		return "", err
	}
	var value Object
	if json.Unmarshal(data, &value) != nil {
		return "", errors.New("recovery controller returned invalid JSON")
	}
	node := first(value, "activeNode", "active_node")
	if node == "" {
		node = first(nested(value, "authority"), "activeNode", "active_node")
	}
	if node != "primary" && node != "oci" {
		return "", errors.New("recovery controller returned an unknown active node")
	}
	return node, nil
}

func activePeerEndpoint(raw string, path string, query string) (*url.URL, error) {
	base, err := url.Parse(raw)
	if err != nil || base.Scheme != "http" || base.User != nil || base.RawQuery != "" || base.Fragment != "" || base.Hostname() == "" {
		return nil, errors.New("active peer must be a local HTTP endpoint")
	}
	host := base.Hostname()
	if host != "127.0.0.1" && host != "localhost" && host != "::1" {
		return nil, errors.New("active peer must use loopback HTTP")
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/" + strings.TrimLeft(path, "/")
	base.RawQuery = query
	return base, nil
}

func (a *App) proxyActive(w http.ResponseWriter, r *http.Request) bool {
	if !activeProxyPath(r) {
		return false
	}
	// The OCI controller must be able to observe its own operator intent while
	// primary is unreachable.  Policies are node-local assertions; routing an
	// OCI GET through the unavailable primary makes the promotion gate stale
	// forever, while a local OCI PUT remains scoped to the standby node.
	if a.cfg.RecoveryNode == "oci" && r.URL.Path == "/v1/policies" {
		w.Header().Set("X-CBTE-Active-Source", "local-standby")
		return false
	}
	// Only a peer that knows this core's bearer token may assert that it is an
	// already-forwarded request.  A browser-provided boolean header must not be
	// able to bypass active-node selection.
	if r.Header.Get(activeProxyHeader) == tokenHash(a.cfg.Token) {
		return false
	}
	if a.cfg.RecoveryNode != "primary" && a.cfg.RecoveryNode != "oci" {
		return false
	}
	actor, _, authenticated := a.authenticate(r)
	if !authenticated {
		return false
	}
	node, err := a.activeNode(r.Context())
	if err != nil {
		// The local endpoint remains useful when the authority/controller link is
		// unavailable.  Mark the result so the UI does not mistake it for a
		// confirmed active-node view.
		w.Header().Set("X-CBTE-Active-Source", "unverified-local")
		return false
	}
	if node == a.cfg.RecoveryNode {
		w.Header().Set("X-CBTE-Active-Source", "local")
		return false
	}
	if len(a.cfg.ActivePeerToken) < 32 || a.cfg.ActivePeerURL == "" {
		fail(w, http.StatusServiceUnavailable, "ACTIVE_PEER_UNCONFIGURED", "現在の稼働ノードへ接続する管理経路が未設定です")
		return true
	}
	endpoint, err := activePeerEndpoint(a.cfg.ActivePeerURL, r.URL.Path, r.URL.RawQuery)
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "ACTIVE_PEER_INVALID", "現在の稼働ノードへの管理経路設定が不正です")
		return true
	}
	var body []byte
	if r.Body != nil && r.Body != http.NoBody {
		body, err = io.ReadAll(io.LimitReader(r.Body, activeProxyBodyLimit+1))
		if err != nil {
			fail(w, http.StatusBadRequest, "ACTIVE_PROXY_BODY_FAILED", "管理操作の入力を読み取れません")
			return true
		}
		if len(body) > activeProxyBodyLimit {
			fail(w, http.StatusRequestEntityTooLarge, "ACTIVE_PROXY_BODY_TOO_LARGE", "管理操作の入力は24 MiB以下にしてください")
			return true
		}
	}
	request, err := http.NewRequestWithContext(r.Context(), r.Method, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "ACTIVE_PEER_INVALID", "現在の稼働ノードへの管理要求を作成できません")
		return true
	}
	request.Header.Set("X-Admin-Agent-Token", a.cfg.ActivePeerToken)
	request.Header.Set("X-Admin-Actor", actor)
	request.Header.Set(activeProxyHeader, tokenHash(a.cfg.ActivePeerToken))
	if contentType := r.Header.Get("Content-Type"); contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	client := &http.Client{Timeout: 45 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "ACTIVE_PEER_UNAVAILABLE", "現在の稼働ノードの管理コアへ接続できません")
		return true
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, activeProxyBodyLimit+1))
	if err != nil || len(data) > activeProxyBodyLimit {
		fail(w, http.StatusBadGateway, "ACTIVE_PEER_RESPONSE_INVALID", "現在の稼働ノードの応答を読み取れません")
		return true
	}
	w.Header().Set("X-CBTE-Active-Source", node)
	for _, key := range []string{"Content-Type", "Cache-Control", "ETag"} {
		if value := response.Header.Get(key); value != "" {
			w.Header().Set(key, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(data)
	return true
}

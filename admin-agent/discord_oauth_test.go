package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
)

const firstAdmin = "796972193287503913"
const secondAdmin = "933314562487386122"

type oauthTransport func(*http.Request) (*http.Response, error)

func (f oauthTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func oauthApp(t *testing.T) *App {
	a := testApp(t)
	a.cfg.Owner = firstAdmin
	a.cfg.AllowedUserIDs = []string{firstAdmin, secondAdmin}
	a.cfg.PublicURL = "https://admin.example.test/ops/"
	a.cfg.BasePath = "/ops"
	a.cfg.CookieSecure = true
	a.cfg.DiscordClientID = "123456789012345678"
	a.cfg.DiscordClientSecret = "fixture-client-secret-not-production"
	a.cfg.DiscordRedirectURI = "https://admin.example.test/ops/auth/discord/callback"
	return a
}
func oauthStart(t *testing.T, a *App) (*httptest.ResponseRecorder, string, []*http.Cookie) {
	t.Helper()
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, httptest.NewRequest("GET", "/auth/discord/login", nil))
	if w.Code != 302 {
		t.Fatalf("OAuth start failed: %d %s", w.Code, w.Body)
	}
	u, e := url.Parse(w.Header().Get("Location"))
	if e != nil {
		t.Fatal(e)
	}
	return w, u.Query().Get("state"), w.Result().Cookies()
}
func oauthCallback(a *App, state string, cookies []*http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest("GET", "/auth/discord/callback?code=fixture-code&state="+url.QueryEscape(state)+"&user_id="+firstAdmin, nil)
	for _, cookie := range cookies {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	return w
}
func configureProvider(t *testing.T, a *App, id, verifier string) *atomic.Int32 {
	t.Helper()
	calls := new(atomic.Int32)
	a.oauthClient = &http.Client{Transport: oauthTransport(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		var body any
		switch r.URL.String() {
		case discordTokenURL:
			if r.Method != "POST" {
				t.Error("token exchange must POST")
			}
			if r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
				t.Error("token endpoint requires form encoding")
			}
			if e := r.ParseForm(); e != nil {
				t.Error(e)
			}
			if r.Form.Get("code_verifier") != verifier || r.Form.Get("redirect_uri") != a.cfg.DiscordRedirectURI {
				t.Error("PKCE/callback binding lost")
			}
			user, password, ok := r.BasicAuth()
			if !ok || user != a.cfg.DiscordClientID || password != a.cfg.DiscordClientSecret {
				t.Error("client authentication missing")
			}
			body = Object{"access_token": "fixture-oauth-access-token", "token_type": "Bearer", "scope": "identify", "refresh_token": "must-not-be-stored"}
		case discordIdentityURL:
			if r.Header.Get("Authorization") != "Bearer fixture-oauth-access-token" {
				t.Error("fresh user identity must use OAuth token")
			}
			body = Object{"id": id, "username": "actual-discord-user", "bot": false}
		default:
			t.Fatalf("unexpected external request %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(encode(body))), Request: r}, nil
	})}
	return calls
}
func cookieNamed(cookies []*http.Cookie, name string) *http.Cookie {
	for _, cookie := range cookies {
		if cookie.Name == name {
			return cookie
		}
	}
	return nil
}
func principalRequest(a *App, method, path, actor string, input any, session *http.Cookie, csrf string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(encode(input)))
	r.Header.Set("Origin", a.managementOrigin())
	if session != nil {
		r.AddCookie(session)
		r.Header.Set("X-CSRF-Token", csrf)
	} else {
		r.Header.Set("X-Admin-Agent-Token", a.cfg.Token)
		r.Header.Set("X-Admin-Actor", actor)
	}
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	return w
}

func TestAllowedAdminDefaults(t *testing.T) {
	t.Setenv("ADMIN_ALLOWED_USER_IDS", "")
	t.Setenv("ADMIN_OWNER_ID", "")
	cfg := config()
	a := newApp(cfg, nil)
	if !a.allowedAdmin(firstAdmin) || !a.allowedAdmin(secondAdmin) || a.allowedAdmin("111111111111111111") {
		t.Fatal("incorrect default administrator allowlist")
	}
	if cfg.Owner != firstAdmin {
		t.Fatal("automation owner changed")
	}
}
func TestDiscordOAuthActualAllowedIdentityAndActionAudit(t *testing.T) {
	a := oauthApp(t)
	start, state, cookies := oauthStart(t, a)
	verifier := cookieNamed(cookies, discordPKCECookie).Value
	u, _ := url.Parse(start.Header().Get("Location"))
	challenge := sha256.Sum256([]byte(verifier))
	if u.Query().Get("scope") != "identify" || u.Query().Get("code_challenge_method") != "S256" || u.Query().Get("code_challenge") != base64.RawURLEncoding.EncodeToString(challenge[:]) {
		t.Fatal("OAuth state/PKCE not configured")
	}
	for _, cookie := range cookies {
		if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/ops/" {
			t.Fatalf("incorrect OAuth cookie %+v", cookie)
		}
	}
	calls := configureProvider(t, a, secondAdmin, verifier)
	callback := oauthCallback(a, state, cookies)
	if callback.Code != 303 {
		t.Fatalf("callback failed: %d %s", callback.Code, callback.Body)
	}
	session := cookieNamed(callback.Result().Cookies(), "cbte_admin_session")
	if session == nil {
		t.Fatal("administrator session missing")
	}
	profile := principalRequest(a, "GET", "/auth/session", "", nil, session, "")
	value := object(t, profile)
	if value["actor"] != secondAdmin || value["authMethod"] != "discord" {
		t.Fatalf("actual identity lost: %v", value)
	}
	action := principalRequest(a, "POST", "/v1/actions", "", Object{"type": "settings.get", "input": Object{"guildId": "123"}, "idempotencyKey": "discord-actual-actor"}, session, str(value["csrf"]))
	if action.Code != 202 || object(t, action)["actor"] != secondAdmin {
		t.Fatalf("audit actor mismatch %s", action.Body)
	}
	if calls.Load() != 2 {
		t.Fatal("fresh /users/@me verification not performed")
	}
	var persisted string
	a.store.db.QueryRow("SELECT group_concat(payload) FROM events").Scan(&persisted)
	if strings.Contains(persisted, "fixture-oauth-access-token") || strings.Contains(persisted, a.cfg.DiscordClientSecret) || strings.Contains(persisted, verifier) {
		t.Fatal("OAuth secrets leaked into audit data")
	}
}
func TestDiscordOAuthOutsideAccountCannotCreateSession(t *testing.T) {
	a := oauthApp(t)
	_, state, cookies := oauthStart(t, a)
	configureProvider(t, a, "111111111111111111", cookieNamed(cookies, discordPKCECookie).Value)
	w := oauthCallback(a, state, cookies)
	if w.Code != 403 {
		t.Fatalf("outsider admitted: %d %s", w.Code, w.Body)
	}
	if cookieNamed(w.Result().Cookies(), "cbte_admin_session") != nil {
		t.Fatal("outsider session issued")
	}
	var count int
	a.store.db.QueryRow("SELECT COUNT(*) FROM sessions").Scan(&count)
	if count != 0 {
		t.Fatal("outsider session persisted")
	}
}
func TestDiscordStatePKCEExpiryAndReplay(t *testing.T) {
	a := oauthApp(t)
	_, state, cookies := oauthStart(t, a)
	calls := configureProvider(t, a, firstAdmin, cookieNamed(cookies, discordPKCECookie).Value)
	bad := []*http.Cookie{{Name: discordStateCookie, Value: state}, {Name: discordPKCECookie, Value: strings.Repeat("z", 96)}}
	if w := oauthCallback(a, state, bad); w.Code != 400 {
		t.Fatal("wrong PKCE cookie accepted")
	}
	if calls.Load() != 0 {
		t.Fatal("provider contacted before browser binding")
	}
	if w := oauthCallback(a, state, cookies); w.Code != 303 {
		t.Fatal(w.Body.String())
	}
	if w := oauthCallback(a, state, cookies); w.Code != 400 {
		t.Fatal("state replay accepted")
	}
	if calls.Load() != 2 {
		t.Fatal("replay exchanged another token")
	}
	_, state, cookies = oauthStart(t, a)
	a.store.db.Exec("UPDATE discord_oauth_states SET expires_at=?", time.Now().UTC().Add(-time.Minute).Format(timestampLayout))
	if w := oauthCallback(a, state, cookies); w.Code != 400 {
		t.Fatal("expired state accepted")
	}
}
func TestOAuthOptionalConfigurationDoesNotWeakenOtherAuthentication(t *testing.T) {
	a := oauthApp(t)
	a.cfg.DiscordClientSecret = ""
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, httptest.NewRequest("GET", "/auth/discord/login", nil))
	if w.Code != 503 || len(w.Result().Cookies()) != 0 {
		t.Fatal("unconfigured OAuth created state or fallback session")
	}
	methods := httptest.NewRecorder()
	a.routes().ServeHTTP(methods, httptest.NewRequest("GET", "/auth/methods", nil))
	if object(t, methods)["discord"] != false {
		t.Fatal("unconfigured OAuth advertised")
	}
}
func TestBothTrustedAdminActorsAndRemovedSessionAuthorization(t *testing.T) {
	a := oauthApp(t)
	for _, id := range []string{firstAdmin, secondAdmin} {
		w := principalRequest(a, "POST", "/v1/actions", id, Object{"type": "url.inspect", "input": Object{}, "idempotencyKey": id}, nil, "")
		if w.Code != 202 || object(t, w)["actor"] != id {
			t.Fatalf("allowed admin rejected or misattributed: %s", w.Body)
		}
	}
	w := principalRequest(a, "GET", "/v1/actions", "111111111111111111", nil, nil, "")
	if w.Code != 401 {
		t.Fatal("outsider trusted actor allowed")
	}
	issued := httptest.NewRecorder()
	value, e := a.newAdminSession(issued, secondAdmin, "discord", "second")
	if e != nil {
		t.Fatal(e)
	}
	a.cfg.AllowedUserIDs = []string{firstAdmin}
	w = principalRequest(a, "GET", "/v1/actions", "", nil, cookieNamed(issued.Result().Cookies(), "cbte_admin_session"), str(value["csrf"]))
	if w.Code != 401 {
		t.Fatal("removed administrator session remained privileged")
	}
}
func TestSecondAdminPasswordChangeAuditAndOriginCheck(t *testing.T) {
	a := oauthApp(t)
	issued := httptest.NewRecorder()
	value, e := a.newAdminSession(issued, secondAdmin, "discord", "second")
	if e != nil {
		t.Fatal(e)
	}
	cookie := cookieNamed(issued.Result().Cookies(), "cbte_admin_session")
	bad := httptest.NewRequest("POST", "/v1/account/password", strings.NewReader(encode(Object{"password": "new password enough length"})))
	bad.AddCookie(cookie)
	bad.Header.Set("X-CSRF-Token", str(value["csrf"]))
	bad.Header.Set("Origin", "https://outside.example")
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, bad)
	if w.Code != 401 {
		t.Fatal("cross-origin mutation accepted")
	}
	w = principalRequest(a, "POST", "/v1/account/password", "", Object{"password": "new password enough length"}, cookie, str(value["csrf"]))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var actor string
	a.store.db.QueryRow("SELECT json_extract(payload,'$.actor') FROM events WHERE kind='admin.password.changed'").Scan(&actor)
	if actor != secondAdmin {
		t.Fatal("password change attributed to automation owner")
	}
}

func TestPasskeyCeremonyBoundToActualAdminAndDiscoverableLogin(t *testing.T) {
	a := oauthApp(t)
	begin := principalRequest(a, "POST", "/v1/account/passkeys/register/begin", secondAdmin, Object{}, nil, "")
	if begin.Code != 200 {
		t.Fatal(begin.Body.String())
	}
	v := object(t, begin)
	opts := nested(nested(v, "options"), "publicKey")
	if nested(opts, "user")["name"] != secondAdmin {
		t.Fatal("second administrator passkey bound to original owner")
	}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	credentialID := make([]byte, 32)
	rand.Read(credentialID)
	cose, _ := cbor.Marshal(map[int]any{1: 2, 3: -7, -1: 1, -2: key.X.FillBytes(make([]byte, 32)), -3: key.Y.FillBytes(make([]byte, 32))})
	rp := sha256.Sum256([]byte("admin.example.test"))
	auth := append([]byte{}, rp[:]...)
	auth = append(auth, 0x45, 0, 0, 0, 0)
	auth = append(auth, make([]byte, 16)...)
	auth = binary.BigEndian.AppendUint16(auth, uint16(len(credentialID)))
	auth = append(auth, credentialID...)
	auth = append(auth, cose...)
	att, _ := cbor.Marshal(map[string]any{"fmt": "none", "attStmt": map[string]any{}, "authData": auth})
	creation := Object{"id": b64(credentialID), "rawId": b64(credentialID), "type": "public-key", "response": Object{"clientDataJSON": b64(passkeyClientData("webauthn.create", str(opts["challenge"]), a.managementOrigin())), "attestationObject": b64(att)}, "clientExtensionResults": Object{}}
	finishFor := func(actor string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/v1/account/passkeys/register/finish", strings.NewReader(encode(creation)))
		r.Header.Set("Origin", a.managementOrigin())
		r.Header.Set("X-Admin-Agent-Token", a.cfg.Token)
		r.Header.Set("X-Admin-Actor", actor)
		r.Header.Set("X-WebAuthn-Session", str(v["sessionId"]))
		w := httptest.NewRecorder()
		a.routes().ServeHTTP(w, r)
		return w
	}
	if wrong := finishFor(firstAdmin); wrong.Code != 400 {
		t.Fatal("one admin consumed another admin's ceremony")
	}
	if correct := finishFor(secondAdmin); correct.Code != 200 {
		t.Fatal(correct.Body.String())
	}
	loginBegin := passkeyRequest(t, a, "/auth/passkeys/login/begin", Object{}, false, "")
	lv := object(t, loginBegin)
	challenge := str(nested(nested(lv, "options"), "publicKey")["challenge"])
	client := passkeyClientData("webauthn.get", challenge, a.managementOrigin())
	clientHash := sha256.Sum256(client)
	assertionAuth := append([]byte{}, rp[:]...)
	assertionAuth = append(assertionAuth, 0x05, 0, 0, 0, 1)
	digest := sha256.Sum256(append(append([]byte{}, assertionAuth...), clientHash[:]...))
	signature, _ := ecdsa.SignASN1(rand.Reader, key, digest[:])
	user := passkeyOwner{id: secondAdmin}
	assertion := Object{"id": b64(credentialID), "rawId": b64(credentialID), "type": "public-key", "response": Object{"clientDataJSON": b64(client), "authenticatorData": b64(assertionAuth), "signature": b64(signature), "userHandle": b64(user.WebAuthnID())}, "clientExtensionResults": Object{}}
	login := passkeyRequest(t, a, "/auth/passkeys/login/finish", assertion, false, str(lv["sessionId"]))
	if login.Code != 200 || object(t, login)["actor"] != secondAdmin {
		t.Fatalf("discoverable login lost principal: %d %s", login.Code, login.Body)
	}
	var principal, method string
	a.store.db.QueryRow("SELECT principal,auth_method FROM sessions ORDER BY expires_at DESC LIMIT 1").Scan(&principal, &method)
	if principal != secondAdmin || method != "passkey" {
		t.Fatal("passkey session did not preserve its account")
	}
}

func TestDiscordOAuthConcurrentBeginsRespectCapacity(t *testing.T) {
	a := oauthApp(t)
	results := make(chan int, 15)
	var group sync.WaitGroup
	for i := 0; i < 15; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			w := httptest.NewRecorder()
			a.routes().ServeHTTP(w, httptest.NewRequest("GET", "/auth/discord/login", nil))
			results <- w.Code
		}()
	}
	group.Wait()
	close(results)
	counts := map[int]int{}
	for code := range results {
		counts[code]++
	}
	if counts[302] != 10 || counts[429] != 5 {
		t.Fatalf("parallel OAuth begins bypassed limit: %v", counts)
	}
}

func TestDiscordCallbackConfigAndBoundedIdentityFailure(t *testing.T) {
	a := oauthApp(t)
	for _, uri := range []string{"https://outside.test/ops/auth/discord/callback", "https://admin.example.test/auth/discord/callback", "https://admin.example.test/ops/auth/discord/callback?next=/", "http://admin.example.test/ops/auth/discord/callback"} {
		a.cfg.DiscordRedirectURI = uri
		if a.discordOAuthConfig() == nil {
			t.Fatalf("unsafe callback configuration accepted %s", uri)
		}
	}
	a.cfg.DiscordRedirectURI = "https://admin.example.test/ops/auth/discord/callback"
	_, state, cookies := oauthStart(t, a)
	a.oauthClient = &http.Client{Transport: oauthTransport(func(r *http.Request) (*http.Response, error) {
		deadline, exists := r.Context().Deadline()
		if !exists || time.Until(deadline) > 12*time.Second {
			t.Error("identity provider request is not bounded by callback deadline")
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(strings.Repeat("x", (1<<20)+1)))}, nil
	})}
	w := oauthCallback(a, state, cookies)
	if w.Code != 502 || cookieNamed(w.Result().Cookies(), "cbte_admin_session") != nil {
		t.Fatal("oversized provider response granted access")
	}
	if replay := oauthCallback(a, state, cookies); replay.Code != 400 {
		t.Fatal("failed provider request left OAuth state replayable")
	}
}

func TestActualAdminIdentityReachesIndependentActionWorker(t *testing.T) {
	a := oauthApp(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input Object
		if e := json.NewDecoder(r.Body).Decode(&input); e != nil {
			t.Error(e)
		}
		if input["actorId"] != secondAdmin || input["initiatedVia"] != "standalone" {
			t.Errorf("worker audit lost actual administrator: %v", input)
		}
		jsonResponse(w, 200, Object{"ok": true, "data": Object{"actor": input["actorId"]}})
	}))
	defer server.Close()
	a.cfg.WorkerURL = server.URL
	action, _, e := a.store.enqueue("settings.get", Object{"guildId": "123"}, "second-admin-worker", secondAdmin, "standalone")
	if e != nil {
		t.Fatal(e)
	}
	a.execute(context.Background(), action)
	result, e := a.store.action(action.ID)
	if e != nil || result.Status != "succeeded" || nested(Object{"result": result.Result}, "result")["actor"] != secondAdmin {
		t.Fatalf("worker did not receive administrator principal: %+v %v", result, e)
	}
}

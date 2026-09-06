package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const discordAuthorizeURL = "https://discord.com/oauth2/authorize"
const discordTokenURL = "https://discord.com/api/oauth2/token"
const discordIdentityURL = "https://discord.com/api/v10/users/@me"
const discordStateCookie = "cbte_discord_state"
const discordPKCECookie = "cbte_discord_pkce"

var discordIDPattern = regexp.MustCompile(`^[0-9]{17,20}$`)

func (a *App) discordOAuthRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /auth/methods", a.authMethods)
	mux.HandleFunc("GET /auth/discord/login", a.discordLogin)
	mux.HandleFunc("GET /auth/discord/callback", a.discordCallback)
}
func (a *App) discordOAuthConfig() error {
	if a.cfg.DiscordClientID == "" || a.cfg.DiscordClientSecret == "" || a.cfg.DiscordRedirectURI == "" {
		return errors.New("Discord OAuth is not configured")
	}
	if !discordIDPattern.MatchString(a.cfg.DiscordClientID) || len(a.cfg.DiscordClientSecret) < 16 {
		return errors.New("Discord OAuth client configuration is invalid")
	}
	u, e := url.Parse(a.cfg.DiscordRedirectURI)
	if e != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != a.cfg.BasePath+"/auth/discord/callback" {
		return errors.New("Discord callback URI must be the exact management callback")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost")) {
		return errors.New("Discord callback requires HTTPS")
	}
	if u.Scheme+"://"+u.Host != a.managementOrigin() {
		return errors.New("Discord callback origin must match the configured management origin")
	}
	if u.Scheme == "https" && !a.cfg.CookieSecure {
		return errors.New("Discord OAuth requires Secure session cookies")
	}
	return nil
}
func (a *App) authMethods(w http.ResponseWriter, r *http.Request) {
	password := a.cfg.PasswordHash
	_ = a.store.getSetting("password_hash", &password)
	jsonResponse(w, 200, Object{"password": password != "", "passkeys": a.managementOrigin() != "", "discord": a.discordOAuthConfig() == nil, "discordLoginPath": "auth/discord/login"})
}
func (a *App) oauthCookies(w http.ResponseWriter, state, verifier string, clear bool) {
	age := 600
	expires := time.Now().UTC().Add(10 * time.Minute)
	if clear {
		age = -1
		expires = time.Unix(1, 0)
	}
	for name, value := range map[string]string{discordStateCookie: state, discordPKCECookie: verifier} {
		http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: a.cookiePath(), HttpOnly: true, Secure: a.cfg.CookieSecure, SameSite: http.SameSiteLaxMode, MaxAge: age, Expires: expires})
	}
}
func (a *App) discordLogin(w http.ResponseWriter, r *http.Request) {
	if e := a.discordOAuthConfig(); e != nil {
		fail(w, 503, "DISCORD_OAUTH_UNAVAILABLE", e.Error())
		return
	}
	if !a.sameOrigin(r) {
		fail(w, 403, "ORIGIN_REJECTED", "OAuth initiation origin rejected")
		return
	}
	if e := a.ensureAuthStorage(); e != nil {
		fail(w, 503, "OAUTH_STORE_UNAVAILABLE", "OAuth state storage is unavailable")
		return
	}
	// Serialize the bounded state allocation and rate check; parallel starts must
	// not bypass the per-address or global limits.
	a.oauthStartMu.Lock()
	defer a.oauthStartMu.Unlock()
	address := "discord:" + clientAddress(r)
	var attempts int
	var last string
	_ = a.store.db.QueryRow("SELECT attempts,last_at FROM auth_attempts WHERE address=?", address).Scan(&attempts, &last)
	if t, e := time.Parse(time.RFC3339Nano, last); e != nil || time.Since(t) > 10*time.Minute {
		attempts = 0
	}
	if attempts >= 10 {
		fail(w, 429, "OAUTH_RATE_LIMIT", "Wait before beginning another Discord login")
		return
	}
	_, _ = a.store.db.Exec("INSERT INTO auth_attempts(address,attempts,last_at) VALUES(?,?,?) ON CONFLICT(address) DO UPDATE SET attempts=excluded.attempts,last_at=excluded.last_at", address, attempts+1, now())
	_, _ = a.store.db.Exec("DELETE FROM discord_oauth_states WHERE expires_at<?", now())
	var pending int
	if e := a.store.db.QueryRow("SELECT COUNT(*) FROM discord_oauth_states").Scan(&pending); e != nil || pending >= 100 {
		fail(w, 503, "OAUTH_STATE_CAPACITY", "OAuth state capacity unavailable")
		return
	}
	state, verifier := randomID(), randomID()+randomID()
	expires := time.Now().UTC().Add(10 * time.Minute).Format(timestampLayout)
	if _, e := a.store.db.Exec("INSERT INTO discord_oauth_states(state_hash,verifier_hash,redirect_uri,expires_at,created_at) VALUES(?,?,?,?,?)", tokenHash(state), tokenHash(verifier), a.cfg.DiscordRedirectURI, expires, now()); e != nil {
		fail(w, 503, "OAUTH_STORE_UNAVAILABLE", "OAuth state could not be persisted")
		return
	}
	challenge := sha256.Sum256([]byte(verifier))
	q := url.Values{"client_id": {a.cfg.DiscordClientID}, "response_type": {"code"}, "redirect_uri": {a.cfg.DiscordRedirectURI}, "scope": {"identify"}, "state": {state}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}, "prompt": {"consent"}}
	a.oauthCookies(w, state, verifier, false)
	http.Redirect(w, r, discordAuthorizeURL+"?"+q.Encode(), http.StatusFound)
}
func (a *App) consumeDiscordState(r *http.Request) (string, error) {
	if e := a.ensureAuthStorage(); e != nil {
		return "", e
	}
	q := r.URL.Query()
	if len(q["state"]) != 1 {
		return "", errors.New("Missing or repeated OAuth state")
	}
	state := q.Get("state")
	s, e := r.Cookie(discordStateCookie)
	if e != nil || len(state) != 48 || subtle.ConstantTimeCompare([]byte(state), []byte(s.Value)) != 1 {
		return "", errors.New("OAuth state cookie does not match")
	}
	p, e := r.Cookie(discordPKCECookie)
	if e != nil || len(p.Value) < 43 || len(p.Value) > 128 {
		return "", errors.New("OAuth PKCE cookie missing")
	}
	tx, e := a.store.db.Begin()
	if e != nil {
		return "", e
	}
	defer tx.Rollback()
	var hash, redirect, expires string
	if e = tx.QueryRow("SELECT verifier_hash,redirect_uri,expires_at FROM discord_oauth_states WHERE state_hash=?", tokenHash(state)).Scan(&hash, &redirect, &expires); e != nil {
		return "", errors.New("OAuth state is missing or already used")
	}
	if subtle.ConstantTimeCompare([]byte(hash), []byte(tokenHash(p.Value))) != 1 || redirect != a.cfg.DiscordRedirectURI {
		return "", errors.New("OAuth browser binding or callback changed")
	}
	if _, e = tx.Exec("DELETE FROM discord_oauth_states WHERE state_hash=?", tokenHash(state)); e != nil {
		return "", e
	}
	if e = tx.Commit(); e != nil {
		return "", e
	}
	if expires < now() {
		return "", errors.New("OAuth state expired")
	}
	return p.Value, nil
}
func (a *App) discordClient() *http.Client {
	if a.oauthClient != nil {
		return a.oauthClient
	}
	return &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
}
func boundedOAuthJSON(response *http.Response, dst any) error {
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return errors.New("Discord returned a non-success status")
	}
	data, e := io.ReadAll(io.LimitReader(response.Body, 1<<20+1))
	if e != nil {
		return e
	}
	if len(data) > 1<<20 {
		return errors.New("Discord response exceeded its limit")
	}
	return json.Unmarshal(data, dst)
}
func (a *App) discordIdentity(ctx context.Context, code, verifier string) (string, string, error) {
	form := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {a.cfg.DiscordRedirectURI}, "code_verifier": {verifier}}
	request, e := http.NewRequestWithContext(ctx, http.MethodPost, discordTokenURL, strings.NewReader(form.Encode()))
	if e != nil {
		return "", "", e
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.SetBasicAuth(a.cfg.DiscordClientID, a.cfg.DiscordClientSecret)
	response, e := a.discordClient().Do(request)
	if e != nil {
		return "", "", errors.New("Discord token exchange could not be completed")
	}
	var token struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		Scope       string `json:"scope"`
	}
	if e = boundedOAuthJSON(response, &token); e != nil || token.AccessToken == "" || !strings.EqualFold(token.TokenType, "Bearer") {
		return "", "", errors.New("Discord token exchange was rejected")
	}
	hasIdentify := false
	for _, scope := range strings.Fields(token.Scope) {
		if scope == "identify" {
			hasIdentify = true
		}
	}
	if !hasIdentify {
		return "", "", errors.New("Discord identify permission was not granted")
	}
	request, e = http.NewRequestWithContext(ctx, http.MethodGet, discordIdentityURL, nil)
	if e != nil {
		return "", "", e
	}
	request.Header.Set("Authorization", "Bearer "+token.AccessToken)
	response, e = a.discordClient().Do(request)
	if e != nil {
		return "", "", errors.New("Discord account verification could not be completed")
	}
	var profile struct {
		ID       string `json:"id"`
		Username string `json:"username"`
		Bot      bool   `json:"bot"`
	}
	if e = boundedOAuthJSON(response, &profile); e != nil || !discordIDPattern.MatchString(profile.ID) || profile.Bot {
		return "", "", errors.New("Discord account identity is invalid")
	}
	return profile.ID, profile.Username, nil
}
func (a *App) discordCallback(w http.ResponseWriter, r *http.Request) {
	if e := a.discordOAuthConfig(); e != nil {
		fail(w, 503, "DISCORD_OAUTH_UNAVAILABLE", e.Error())
		return
	}
	verifier, e := a.consumeDiscordState(r)
	a.oauthCookies(w, "", "", true)
	if e != nil {
		fail(w, 400, "OAUTH_STATE_REJECTED", e.Error())
		return
	}
	q := r.URL.Query()
	if q.Get("error") != "" {
		fail(w, 400, "DISCORD_AUTHORIZATION_DENIED", "Discord authorization was not completed")
		return
	}
	if len(q["code"]) != 1 || len(q.Get("code")) < 1 || len(q.Get("code")) > 2048 {
		fail(w, 400, "OAUTH_CODE_REJECTED", "Discord authorization code is missing or invalid")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	actor, username, e := a.discordIdentity(ctx, q.Get("code"), verifier)
	if e != nil {
		fail(w, 502, "DISCORD_IDENTITY_UNAVAILABLE", e.Error())
		return
	}
	if !a.allowedAdmin(actor) {
		fail(w, 403, "ADMIN_NOT_ALLOWED", "This Discord account is not allowed to administer this service")
		return
	}
	if _, e = a.newAdminSession(w, actor, "discord", username); e != nil {
		fail(w, 503, "SESSION_CREATION_FAILED", "Administrator session could not be persisted")
		return
	}
	http.Redirect(w, r, a.cookiePath(), http.StatusSeeOther)
}

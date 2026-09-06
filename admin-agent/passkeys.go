package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type passkeyOwner struct {
	id          string
	credentials []webauthn.Credential
}

func (u passkeyOwner) WebAuthnID() []byte {
	h := sha256.Sum256([]byte("cbte-admin-owner:" + u.id))
	return h[:]
}
func (u passkeyOwner) WebAuthnName() string                       { return u.id }
func (u passkeyOwner) WebAuthnDisplayName() string                { return "CBTE 管理者" }
func (u passkeyOwner) WebAuthnCredentials() []webauthn.Credential { return u.credentials }
func (a *App) passkeyRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /auth/passkeys/login/begin", a.passkeyLoginBegin)
	mux.HandleFunc("POST /auth/passkeys/login/finish", a.passkeyLoginFinish)
	mux.HandleFunc("GET /v1/account/passkeys", a.protect(a.passkeyList))
	mux.HandleFunc("POST /v1/account/passkeys/register/begin", a.protect(a.passkeyRegisterBegin))
	mux.HandleFunc("POST /v1/account/passkeys/register/finish", a.protect(a.passkeyRegisterFinish))
	mux.HandleFunc("DELETE /v1/account/passkeys/{credential}", a.protect(a.passkeyDelete))
}
func (a *App) passkeyStorage() error {
	_, e := a.store.db.Exec("CREATE TABLE IF NOT EXISTS passkeys(id TEXT PRIMARY KEY,owner TEXT NOT NULL,credential TEXT NOT NULL,label TEXT NOT NULL,created_at TEXT NOT NULL,last_used_at TEXT); CREATE TABLE IF NOT EXISTS passkey_sessions(id TEXT PRIMARY KEY,kind TEXT NOT NULL,owner TEXT NOT NULL,payload TEXT NOT NULL,expires_at TEXT NOT NULL)")
	return e
}
func (a *App) passkeyConfig(r *http.Request) (*webauthn.WebAuthn, error) {
	u, e := url.Parse(a.cfg.PublicURL)
	if e != nil || u.Hostname() == "" || (u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1"))) {
		return nil, errors.New("A configured HTTPS management origin is required")
	}
	origin := u.Scheme + "://" + u.Host
	if r.Header.Get("Origin") != origin {
		return nil, errors.New("Passkey origin does not match management origin")
	}
	return webauthn.New(&webauthn.Config{RPID: u.Hostname(), RPDisplayName: "CBTE 管理サポート", RPOrigins: []string{origin}, AuthenticatorSelection: protocol.AuthenticatorSelection{ResidentKey: protocol.ResidentKeyRequirementRequired, UserVerification: protocol.VerificationRequired}})
}
func (a *App) passkeyUser(actors ...string) (passkeyOwner, error) {
	actor := a.cfg.Owner
	if len(actors) > 0 {
		actor = actors[0]
	}
	u := passkeyOwner{id: actor}
	if !a.allowedAdmin(actor) {
		return u, errors.New("Passkey owner is not an allowed administrator")
	}
	if e := a.passkeyStorage(); e != nil {
		return u, e
	}
	rows, e := a.store.db.Query("SELECT credential FROM passkeys WHERE owner=? ORDER BY created_at,id", actor)
	if e != nil {
		return u, e
	}
	defer rows.Close()
	for rows.Next() {
		var raw string
		var c webauthn.Credential
		if e = rows.Scan(&raw); e != nil {
			return u, e
		}
		if e = json.Unmarshal([]byte(raw), &c); e != nil {
			return u, e
		}
		u.credentials = append(u.credentials, c)
	}
	return u, rows.Err()
}
func (a *App) savePasskeySession(kind string, s *webauthn.SessionData, actors ...string) (string, error) {
	actor := a.cfg.Owner
	if len(actors) > 0 {
		actor = actors[0]
	}
	if e := a.passkeyStorage(); e != nil {
		return "", e
	}
	_, _ = a.store.db.Exec("DELETE FROM passkey_sessions WHERE expires_at<?", now())
	var n int
	if e := a.store.db.QueryRow("SELECT COUNT(*) FROM passkey_sessions").Scan(&n); e != nil {
		return "", e
	}
	if n >= 100 && kind != "register" {
		return "", errors.New("Too many pending passkey ceremonies")
	}
	s.Expires = time.Now().UTC().Add(2 * time.Minute)
	id := randomID()
	_, e := a.store.db.Exec("INSERT INTO passkey_sessions(id,kind,owner,payload,expires_at) VALUES(?,?,?,?,?)", tokenHash(id), kind, actor, encode(s), s.Expires.Format(timestampLayout))
	return id, e
}
func (a *App) consumePasskeySession(id, kind string, actors ...string) (webauthn.SessionData, error) {
	actor := a.cfg.Owner
	if len(actors) > 0 {
		actor = actors[0]
	}
	var result webauthn.SessionData
	if len(id) != 48 {
		return result, errors.New("Invalid passkey ceremony")
	}
	tx, e := a.store.db.Begin()
	if e != nil {
		return result, e
	}
	defer tx.Rollback()
	var raw, expires string
	if e = tx.QueryRow("SELECT payload,expires_at FROM passkey_sessions WHERE id=? AND kind=? AND owner=?", tokenHash(id), kind, actor).Scan(&raw, &expires); e != nil {
		return result, errors.New("Passkey ceremony missing or consumed")
	}
	if _, e = tx.Exec("DELETE FROM passkey_sessions WHERE id=?", tokenHash(id)); e != nil {
		return result, e
	}
	if e = tx.Commit(); e != nil {
		return result, e
	}
	if expires < now() {
		return result, errors.New("Passkey ceremony expired")
	}
	e = json.Unmarshal([]byte(raw), &result)
	return result, e
}
func (a *App) passkeyRegisterBegin(w http.ResponseWriter, r *http.Request) {
	actor, _, _ := a.authenticate(r)
	wa, e := a.passkeyConfig(r)
	if e != nil {
		fail(w, 400, "PASSKEY_ORIGIN", e.Error())
		return
	}
	u, e := a.passkeyUser(actor)
	if e != nil {
		fail(w, 503, "PASSKEY_STORE", e.Error())
		return
	}
	if len(u.credentials) >= 10 {
		fail(w, 409, "PASSKEY_LIMIT", "At most ten owner passkeys")
		return
	}
	exclude := make([]protocol.CredentialDescriptor, 0, len(u.credentials))
	for _, c := range u.credentials {
		exclude = append(exclude, c.Descriptor())
	}
	opts, s, e := wa.BeginRegistration(u, webauthn.WithExclusions(exclude))
	if e != nil {
		fail(w, 400, "PASSKEY_BEGIN", e.Error())
		return
	}
	id, e := a.savePasskeySession("register", s, actor)
	if e != nil {
		fail(w, 503, "PASSKEY_STORE", e.Error())
		return
	}
	jsonResponse(w, 200, Object{"sessionId": id, "options": opts})
}
func (a *App) passkeyRegisterFinish(w http.ResponseWriter, r *http.Request) {
	actor, via, _ := a.authenticate(r)
	wa, e := a.passkeyConfig(r)
	if e != nil {
		fail(w, 400, "PASSKEY_ORIGIN", e.Error())
		return
	}
	s, e := a.consumePasskeySession(r.Header.Get("X-WebAuthn-Session"), "register", actor)
	if e != nil {
		fail(w, 400, "PASSKEY_SESSION", e.Error())
		return
	}
	u, e := a.passkeyUser(actor)
	if e != nil {
		fail(w, 503, "PASSKEY_STORE", e.Error())
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	c, e := wa.FinishRegistration(u, s, r)
	if e != nil {
		fail(w, 400, "PASSKEY_VERIFICATION", e.Error())
		return
	}
	id := base64.RawURLEncoding.EncodeToString(c.ID)
	label := strings.TrimSpace(r.Header.Get("X-Passkey-Label"))
	if label == "" {
		label = "管理者のパスキー"
	}
	if len(label) > 120 {
		label = label[:120]
	}
	tx, e := a.store.db.Begin()
	if e != nil {
		fail(w, 503, "PASSKEY_STORE", e.Error())
		return
	}
	defer tx.Rollback()
	if _, e = tx.Exec("INSERT INTO passkeys(id,owner,credential,label,created_at) VALUES(?,?,?,?,?)", id, actor, encode(c), label, now()); e == nil {
		e = a.auditAuthTx(tx, "admin.passkey.registered", actor, via, Object{"credentialId": id})
	}
	if e == nil {
		e = tx.Commit()
	}
	if e != nil {
		fail(w, 409, "PASSKEY_SAVE", e.Error())
		return
	}
	jsonResponse(w, 200, Object{"ok": true, "id": id, "label": label})
}
func (a *App) passkeyLoginBegin(w http.ResponseWriter, r *http.Request) {
	wa, e := a.passkeyConfig(r)
	if e != nil {
		fail(w, 400, "PASSKEY_ORIGIN", e.Error())
		return
	}
	if e = a.passkeyStorage(); e != nil {
		fail(w, 503, "PASSKEY_STORE", e.Error())
		return
	}
	count, e := a.allowedPasskeyCount()
	if e != nil {
		fail(w, 503, "PASSKEY_STORE", e.Error())
		return
	}
	if count == 0 {
		fail(w, 404, "PASSKEY_NOT_REGISTERED", "Register a passkey after password login")
		return
	}
	address := "passkey:" + clientAddress(r)
	var attempts int
	var last string
	_ = a.store.db.QueryRow("SELECT attempts,last_at FROM auth_attempts WHERE address=?", address).Scan(&attempts, &last)
	if t, err := time.Parse(time.RFC3339Nano, last); err != nil || time.Since(t) > 2*time.Minute {
		attempts = 0
	}
	if attempts >= 5 {
		fail(w, 429, "PASSKEY_RATE_LIMIT", "Wait before beginning another passkey login")
		return
	}
	_, _ = a.store.db.Exec("INSERT INTO auth_attempts(address,attempts,last_at) VALUES(?,?,?) ON CONFLICT(address) DO UPDATE SET attempts=excluded.attempts,last_at=excluded.last_at", address, attempts+1, now())
	opts, s, e := wa.BeginDiscoverableLogin(webauthn.WithUserVerification(protocol.VerificationRequired))
	if e != nil {
		fail(w, 400, "PASSKEY_BEGIN", e.Error())
		return
	}
	id, e := a.savePasskeySession("login", s, "@discoverable")
	if e != nil {
		fail(w, 503, "PASSKEY_STORE", e.Error())
		return
	}
	jsonResponse(w, 200, Object{"sessionId": id, "options": opts})
}
func (a *App) passkeyLoginFinish(w http.ResponseWriter, r *http.Request) {
	wa, e := a.passkeyConfig(r)
	if e != nil {
		fail(w, 400, "PASSKEY_ORIGIN", e.Error())
		return
	}
	s, e := a.consumePasskeySession(r.Header.Get("X-WebAuthn-Session"), "login", "@discoverable")
	if e != nil {
		fail(w, 400, "PASSKEY_SESSION", e.Error())
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	actor := ""
	c, e := wa.FinishDiscoverableLogin(func(rawID, userHandle []byte) (webauthn.User, error) {
		var owner string
		if e := a.store.db.QueryRow("SELECT owner FROM passkeys WHERE id=?", base64.RawURLEncoding.EncodeToString(rawID)).Scan(&owner); e != nil {
			return nil, errors.New("Unknown passkey")
		}
		u, e := a.passkeyUser(owner)
		if e != nil {
			return nil, e
		}
		if subtle.ConstantTimeCompare(u.WebAuthnID(), userHandle) != 1 {
			return nil, errors.New("Passkey user handle does not match its owner")
		}
		actor = owner
		return u, nil
	}, s, r)
	if e != nil {
		fail(w, 401, "PASSKEY_VERIFICATION", e.Error())
		return
	}
	if c.Authenticator.CloneWarning {
		fail(w, 401, "PASSKEY_COUNTER", "Authenticator counter verification failed")
		return
	}
	if !a.allowedAdmin(actor) {
		fail(w, 403, "ADMIN_NOT_ALLOWED", "Passkey owner is no longer allowed")
		return
	}
	if _, e = a.store.db.Exec("UPDATE passkeys SET credential=?,last_used_at=? WHERE id=? AND owner=?", encode(c), now(), base64.RawURLEncoding.EncodeToString(c.ID), actor); e != nil {
		fail(w, 503, "PASSKEY_STORE", e.Error())
		return
	}
	a.issueAdminSession(w, actor, "passkey", "")
}
func (a *App) issueOwnerSession(w http.ResponseWriter) {
	a.issueAdminSession(w, a.cfg.Owner, "password", "")
}
func (a *App) allowedPasskeyCount() (int, error) {
	rows, e := a.store.db.Query("SELECT owner FROM passkeys")
	if e != nil {
		return 0, e
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var owner string
		if e = rows.Scan(&owner); e != nil {
			return 0, e
		}
		if a.allowedAdmin(owner) {
			n++
		}
	}
	return n, rows.Err()
}
func (a *App) passkeyList(w http.ResponseWriter, r *http.Request) {
	actor, _, _ := a.authenticate(r)
	if e := a.passkeyStorage(); e != nil {
		fail(w, 503, "PASSKEY_STORE", e.Error())
		return
	}
	rows, e := a.store.db.Query("SELECT id,label,created_at,last_used_at FROM passkeys WHERE owner=? ORDER BY created_at", actor)
	if e != nil {
		fail(w, 503, "PASSKEY_STORE", e.Error())
		return
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		var id, label, created string
		var used sql.NullString
		if e = rows.Scan(&id, &label, &created, &used); e != nil {
			fail(w, 503, "PASSKEY_STORE", e.Error())
			return
		}
		items = append(items, Object{"id": id, "label": label, "createdAt": created, "lastUsedAt": nullable(used)})
	}
	if e = rows.Err(); e != nil {
		fail(w, 503, "PASSKEY_STORE", e.Error())
		return
	}
	jsonResponse(w, 200, Object{"items": items})
}
func (a *App) passkeyDelete(w http.ResponseWriter, r *http.Request) {
	actor, via, _ := a.authenticate(r)
	if e := a.passkeyStorage(); e != nil {
		fail(w, 503, "PASSKEY_STORE", e.Error())
		return
	}
	tx, e := a.store.db.Begin()
	if e != nil {
		fail(w, 503, "PASSKEY_STORE", e.Error())
		return
	}
	defer tx.Rollback()
	var owner string
	if e = tx.QueryRow("SELECT owner FROM passkeys WHERE id=?", r.PathValue("credential")).Scan(&owner); e != nil || owner != actor {
		fail(w, 404, "PASSKEY_NOT_FOUND", "Passkey not found for this administrator")
		return
	}
	rows, e := tx.Query("SELECT owner FROM passkeys")
	if e != nil {
		fail(w, 503, "PASSKEY_STORE", e.Error())
		return
	}
	count := 0
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			fail(w, 503, "PASSKEY_STORE", e.Error())
			return
		}
		if a.allowedAdmin(id) {
			count++
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		fail(w, 503, "PASSKEY_STORE", e.Error())
		return
	}
	password := a.cfg.PasswordHash
	var stored string
	e = tx.QueryRow("SELECT value FROM settings WHERE key='password_hash'").Scan(&stored)
	if e == nil {
		if e = json.Unmarshal([]byte(stored), &password); e != nil {
			fail(w, 503, "PASSKEY_STORE", "Recovery password state cannot be read")
			return
		}
	} else if !errors.Is(e, sql.ErrNoRows) {
		fail(w, 503, "PASSKEY_STORE", e.Error())
		return
	}
	if count <= 1 && password == "" {
		fail(w, 409, "LAST_LOGIN_METHOD", "Configure an independent recovery password or another administrator passkey first")
		return
	}
	if _, e = tx.Exec("DELETE FROM passkeys WHERE id=? AND owner=?", r.PathValue("credential"), actor); e == nil {
		e = a.auditAuthTx(tx, "admin.passkey.deleted", actor, via, Object{"credentialId": r.PathValue("credential")})
	}
	if e == nil {
		e = tx.Commit()
	}
	if e != nil {
		fail(w, 503, "PASSKEY_STORE", e.Error())
		return
	}
	jsonResponse(w, 200, Object{"ok": true})
}

package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"github.com/fxamacker/cbor/v2"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func passkeyRequest(t *testing.T, a *App, path string, input any, owner bool, session string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest("POST", path, strings.NewReader(encode(input)))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "https://admin.example.test")
	if owner {
		r.Header.Set("X-Admin-Agent-Token", a.cfg.Token)
	}
	if session != "" {
		r.Header.Set("X-WebAuthn-Session", session)
	}
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	return w
}
func b64(v []byte) string { return base64.RawURLEncoding.EncodeToString(v) }
func passkeyClientData(typ, challenge, origin string) []byte {
	b, _ := json.Marshal(Object{"type": typ, "challenge": challenge, "origin": origin})
	return b
}
func TestPasskeyCryptographicRegistrationAndLogin(t *testing.T) {
	a := testApp(t)
	a.cfg.PublicURL = "https://admin.example.test/ops/"
	a.cfg.BasePath = "/ops"
	denied := passkeyRequest(t, a, "/v1/account/passkeys/register/begin", Object{}, false, "")
	if denied.Code != 401 {
		t.Fatal("registration requires owner", denied.Code)
	}
	begin := passkeyRequest(t, a, "/v1/account/passkeys/register/begin", Object{}, true, "")
	if begin.Code != 200 {
		t.Fatal(begin.Body.String())
	}
	v := object(t, begin)
	opts := nested(nested(v, "options"), "publicKey")
	challenge := str(opts["challenge"])
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	credentialID := make([]byte, 32)
	_, _ = rand.Read(credentialID)
	cose, e := cbor.Marshal(map[int]any{1: 2, 3: -7, -1: 1, -2: key.X.FillBytes(make([]byte, 32)), -3: key.Y.FillBytes(make([]byte, 32))})
	if e != nil {
		t.Fatal(e)
	}
	rp := sha256.Sum256([]byte("admin.example.test"))
	auth := append([]byte{}, rp[:]...)
	auth = append(auth, 0x45, 0, 0, 0, 0)
	auth = append(auth, make([]byte, 16)...)
	auth = binary.BigEndian.AppendUint16(auth, uint16(len(credentialID)))
	auth = append(auth, credentialID...)
	auth = append(auth, cose...)
	att, e := cbor.Marshal(map[string]any{"fmt": "none", "attStmt": map[string]any{}, "authData": auth})
	if e != nil {
		t.Fatal(e)
	}
	creation := Object{"id": b64(credentialID), "rawId": b64(credentialID), "type": "public-key", "response": Object{"clientDataJSON": b64(passkeyClientData("webauthn.create", challenge, "https://admin.example.test")), "attestationObject": b64(att), "transports": []string{"internal"}}, "clientExtensionResults": Object{}}
	finish := passkeyRequest(t, a, "/v1/account/passkeys/register/finish", creation, true, str(v["sessionId"]))
	if finish.Code != 200 {
		t.Fatal(finish.Body.String())
	}
	replay := passkeyRequest(t, a, "/v1/account/passkeys/register/finish", creation, true, str(v["sessionId"]))
	if replay.Code != 400 {
		t.Fatal("registration challenge replay accepted")
	}
	loginBegin := passkeyRequest(t, a, "/auth/passkeys/login/begin", Object{}, false, "")
	if loginBegin.Code != 200 {
		t.Fatal(loginBegin.Body.String())
	}
	lv := object(t, loginBegin)
	challenge = str(nested(nested(lv, "options"), "publicKey")["challenge"])
	client := passkeyClientData("webauthn.get", challenge, "https://admin.example.test")
	clientHash := sha256.Sum256(client)
	assertionAuth := append([]byte{}, rp[:]...)
	assertionAuth = append(assertionAuth, 0x05, 0, 0, 0, 1)
	signed := append(append([]byte{}, assertionAuth...), clientHash[:]...)
	digest := sha256.Sum256(signed)
	signature, e := ecdsa.SignASN1(rand.Reader, key, digest[:])
	if e != nil {
		t.Fatal(e)
	}
	user := passkeyOwner{id: a.cfg.Owner}
	assertion := Object{"id": b64(credentialID), "rawId": b64(credentialID), "type": "public-key", "response": Object{"clientDataJSON": b64(client), "authenticatorData": b64(assertionAuth), "signature": b64(signature), "userHandle": b64(user.WebAuthnID())}, "clientExtensionResults": Object{}}
	login := passkeyRequest(t, a, "/auth/passkeys/login/finish", assertion, false, str(lv["sessionId"]))
	if login.Code != 200 {
		t.Fatal(login.Body.String())
	}
	if len(login.Result().Cookies()) != 1 || login.Result().Cookies()[0].Path != "/ops/" {
		t.Fatal("independent session cookie missing")
	}
	again := passkeyRequest(t, a, "/auth/passkeys/login/finish", assertion, false, str(lv["sessionId"]))
	if again.Code != 400 {
		t.Fatal("login assertion replay accepted")
	}
}
func TestPasskeyOriginExpiryAndWrongCeremony(t *testing.T) {
	a := testApp(t)
	a.cfg.PublicURL = "https://admin.example.test/ops/"
	r := httptest.NewRequest("POST", "/v1/account/passkeys/register/begin", strings.NewReader("{}"))
	r.Header.Set("X-Admin-Agent-Token", a.cfg.Token)
	r.Header.Set("Origin", "https://evil.example")
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatal("wrong origin accepted")
	}
	begin := passkeyRequest(t, a, "/v1/account/passkeys/register/begin", Object{}, true, "")
	v := object(t, begin)
	id := str(v["sessionId"])
	if _, e := a.consumePasskeySession(id, "login"); e == nil {
		t.Fatal("wrong ceremony accepted")
	}
	_, _ = a.store.db.Exec("UPDATE passkey_sessions SET expires_at=?", time.Now().UTC().Add(-time.Minute).Format(timestampLayout))
	if _, e := a.consumePasskeySession(id, "register"); e == nil {
		t.Fatal("expired ceremony accepted")
	}
	if _, e := a.consumePasskeySession(id, "register"); e == nil {
		t.Fatal("expired ceremony reusable")
	}
}

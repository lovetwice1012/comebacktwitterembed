package main

import (
	"database/sql"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func (a *App) allowedAdmin(id string) bool {
	if id == "" {
		return false
	}
	if len(a.cfg.AllowedUserIDs) == 0 {
		return id == a.cfg.Owner
	}
	for _, allowed := range a.cfg.AllowedUserIDs {
		if id == strings.TrimSpace(allowed) {
			return true
		}
	}
	return false
}
func (a *App) ensureAuthStorage() error {
	a.authOnce.Do(func() {
		rows, e := a.store.db.Query("PRAGMA table_info(sessions)")
		if e != nil {
			a.authStorageError = e
			return
		}
		columns := map[string]bool{}
		for rows.Next() {
			var cid, notnull, pk int
			var name, typ string
			var def any
			if e = rows.Scan(&cid, &name, &typ, &notnull, &def, &pk); e != nil {
				rows.Close()
				a.authStorageError = e
				return
			}
			columns[name] = true
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			a.authStorageError = e
			return
		}
		for _, name := range []string{"principal", "auth_method", "username"} {
			if !columns[name] {
				if _, e = a.store.db.Exec("ALTER TABLE sessions ADD COLUMN " + name + " TEXT NOT NULL DEFAULT ''"); e != nil {
					a.authStorageError = e
					return
				}
			}
		}
		_, a.authStorageError = a.store.db.Exec("CREATE TABLE IF NOT EXISTS discord_oauth_states(state_hash TEXT PRIMARY KEY,verifier_hash TEXT NOT NULL,redirect_uri TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL)")
	})
	return a.authStorageError
}
func (a *App) managementOrigin() string {
	u, e := url.Parse(a.cfg.PublicURL)
	if e != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return ""
	}
	return u.Scheme + "://" + u.Host
}
func (a *App) sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	return origin == "" || (a.managementOrigin() != "" && origin == a.managementOrigin())
}
func (a *App) auditAuthTx(tx *sql.Tx, kind, actor, via string, details Object) error {
	payload := Object{"id": randomID(), "kind": kind, "occurredAt": now(), "actor": actor, "initiatedVia": via, "details": details}
	_, e := tx.Exec("INSERT INTO events(id,run_id,guild_id,kind,occurred_at,persisted_at,payload) VALUES(?,'','',?,?,?,?)", payload["id"], kind, payload["occurredAt"], now(), encode(payload))
	return e
}
func (a *App) newAdminSession(w http.ResponseWriter, actor, method, username string) (Object, error) {
	if !a.allowedAdmin(actor) {
		return nil, errors.New("administrator is no longer allowed")
	}
	if e := a.ensureAuthStorage(); e != nil {
		return nil, e
	}
	if len(username) > 128 {
		username = username[:128]
	}
	token, csrf := randomID(), randomID()
	expiry := time.Now().UTC().Add(8 * time.Hour)
	tx, e := a.store.db.Begin()
	if e != nil {
		return nil, e
	}
	defer tx.Rollback()
	if _, e = tx.Exec("INSERT INTO sessions(hash,csrf,expires_at,principal,auth_method,username) VALUES(?,?,?,?,?,?)", tokenHash(token), csrf, expiry.Format(timestampLayout), actor, method, username); e == nil {
		e = a.auditAuthTx(tx, "admin.session.created", actor, "standalone", Object{"method": method})
	}
	if e == nil {
		e = tx.Commit()
	}
	if e != nil {
		return nil, e
	}
	http.SetCookie(w, &http.Cookie{Name: "cbte_admin_session", Value: token, Path: a.cookiePath(), HttpOnly: true, Secure: a.cfg.CookieSecure, SameSite: http.SameSiteStrictMode, Expires: expiry})
	return Object{"ok": true, "csrf": csrf, "owner": actor, "actor": actor, "authMethod": method, "user": Object{"id": actor, "username": username}, "expiresAt": expiry.Format(timestampLayout)}, nil
}
func (a *App) issueAdminSession(w http.ResponseWriter, actor, method, username string) {
	v, e := a.newAdminSession(w, actor, method, username)
	if e != nil {
		fail(w, 503, "SESSION_CREATION_FAILED", "Administrator session could not be persisted")
		return
	}
	jsonResponse(w, 200, v)
}

package main

import (
	"net/http/httptest"
	"testing"
)

func TestIncidentAcknowledgementPreservesBothActualAdministrators(t *testing.T) {
	a := oauthApp(t)
	for _, actor := range []string{firstAdmin, secondAdmin} {
		id, _, e := a.upsertIncident("audit:"+actor, "Fixture incident", Object{})
		if e != nil {
			t.Fatal(e)
		}
		issued := httptest.NewRecorder()
		session, e := a.newAdminSession(issued, actor, "discord", "fixture")
		if e != nil {
			t.Fatal(e)
		}
		w := principalRequest(a, "POST", "/v1/incidents/"+id+"/acknowledge", "", Object{}, cookieNamed(issued.Result().Cookies(), "cbte_admin_session"), str(session["csrf"]))
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		var acknowledged int
		if e = a.store.db.QueryRow("SELECT acknowledged FROM incidents WHERE id=?", id).Scan(&acknowledged); e != nil || acknowledged != 1 {
			t.Fatalf("acknowledgement was not saved: %d %v", acknowledged, e)
		}
		var principal, via string
		e = a.store.db.QueryRow("SELECT json_extract(payload,'$.actor'),json_extract(payload,'$.initiatedVia') FROM events WHERE kind='admin.incident.acknowledged' AND json_extract(payload,'$.details.incidentId')=?", id).Scan(&principal, &via)
		if e != nil || principal != actor || via != "standalone" {
			t.Fatalf("actual acknowledgement actor lost: %s %s %v", principal, via, e)
		}
	}
}

func TestIncidentAcknowledgementRollsBackWhenAuditCannotBeSaved(t *testing.T) {
	a := oauthApp(t)
	id, _, e := a.upsertIncident("audit-failure", "Fixture incident", Object{})
	if e != nil {
		t.Fatal(e)
	}
	var previous string
	if e = a.store.db.QueryRow("SELECT updated_at FROM incidents WHERE id=?", id).Scan(&previous); e != nil {
		t.Fatal(e)
	}
	_, e = a.store.db.Exec("CREATE TRIGGER reject_ack_audit BEFORE INSERT ON events WHEN NEW.kind='admin.incident.acknowledged' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END")
	if e != nil {
		t.Fatal(e)
	}
	w := principalRequest(a, "POST", "/v1/incidents/"+id+"/acknowledge", secondAdmin, Object{}, nil, "")
	if w.Code != 503 {
		t.Fatalf("failed audit reported success: %d %s", w.Code, w.Body)
	}
	var acknowledged int
	var updated string
	if e = a.store.db.QueryRow("SELECT acknowledged,updated_at FROM incidents WHERE id=?", id).Scan(&acknowledged, &updated); e != nil || acknowledged != 0 || updated != previous {
		t.Fatalf("acknowledgement escaped transaction rollback: %d %s %v", acknowledged, updated, e)
	}
	if missing := principalRequest(a, "POST", "/v1/incidents/missing/acknowledge", secondAdmin, Object{}, nil, ""); missing.Code != 404 {
		t.Fatal("missing incident returned incorrect acknowledgement")
	}
	var count int
	if e = a.store.db.QueryRow("SELECT COUNT(*) FROM events WHERE kind='admin.incident.acknowledged'").Scan(&count); e != nil || count != 0 {
		t.Fatal("audit record committed for an unacknowledged incident")
	}
}

package main

import (
	"net/http"
	"testing"
)

func TestRecoveryReceiptLookupIsReadOnlyAndBoundToActor(t *testing.T) {
	a := testApp(t)
	a.cfg.AllowedUserIDs = []string{a.cfg.Owner, "456"}
	input := Object{"targetNode": "oci", "expectedEpoch": 7, "reason": "fixture receipt only"}
	ac, _, e := a.store.enqueue("recovery.manual_switch", input, "fixture-recovery-key", a.cfg.Owner, "dashboard")
	if e != nil {
		t.Fatal(e)
	}
	if e = a.store.finish(ac.ID, "succeeded", Object{"manualSwitch": Object{"state": "scheduled"}}, nil); e != nil {
		t.Fatal(e)
	}
	w := request(t, a, "GET", "/v1/actions/by-key/fixture-recovery-key", nil)
	if w.Code != http.StatusOK || object(t, w)["id"] != ac.ID || object(t, w)["status"] != "succeeded" {
		t.Fatalf("receipt mismatch: %d %s", w.Code, w.Body.String())
	}
	other := principalRequest(a, "GET", "/v1/actions/by-key/fixture-recovery-key", "456", nil, nil, "")
	if other.Code != http.StatusNotFound {
		t.Fatalf("another actor can read this receipt: %s", other.Body.String())
	}
	missing := request(t, a, "GET", "/v1/actions/by-key/not-observed", nil)
	if missing.Code != http.StatusNotFound || nested(object(t, missing), "error")["code"] != "RECEIPT_NOT_OBSERVED" {
		t.Fatalf("missing receipt misclassified: %s", missing.Body.String())
	}
	var count int
	if e = a.store.db.QueryRow("SELECT COUNT(*) FROM actions").Scan(&count); e != nil || count != 1 {
		t.Fatalf("read lookup created an action: count=%d error=%v", count, e)
	}
}

func TestActionStatusFilterReceiptsCarryIntoInvestigation(t *testing.T) {
	a := testApp(t)
	for _, status := range []string{"queued", "running", "succeeded"} {
		ac, _, e := a.store.enqueue("url.inspect", Object{"url": "https://fixture.invalid/" + status}, "status-"+status, a.cfg.Owner, "dashboard")
		if e != nil {
			t.Fatal(e)
		}
		if status != "queued" {
			if e = a.store.finish(ac.ID, status, nil, nil); e != nil {
				t.Fatal(e)
			}
		}
	}
	w := request(t, a, "GET", "/v1/actions?status=running", nil)
	v := object(t, w)
	items, ok := v["items"].([]any)
	if w.Code != http.StatusOK || !ok || len(items) != 1 || items[0].(map[string]any)["status"] != "running" || nested(v, "appliedFilters")["status"] != "running" {
		t.Fatalf("status filter lost: %s", w.Body.String())
	}
}

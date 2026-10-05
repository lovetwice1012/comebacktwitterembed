package main

import (
	"fmt"
	"net/url"
	"testing"
	"time"
)

func TestInvestigationFiltersApplyBeforePaginationForBothRootReaders(t *testing.T) {
	for _, ready := range []int{0, 1} {
		t.Run(fmt.Sprint(ready), func(t *testing.T) {
			a := testApp(t)
			at := time.Now().UTC().Add(-time.Minute).Format(timestampLayout)
			for i := 0; i < 5; i++ {
				channel := "matching"
				if i%2 == 0 {
					channel = "other"
				}
				id := fmt.Sprintf("r%d", i)
				fields := Object{"id": id + "s", "runId": id, "kind": "request.started", "occurredAt": at, "guildId": "guild", "channelId": channel, "userId": "user", "messageId": "message"}
				if i == 1 {
					delete(fields, "channelId")
					fields["channel_id"] = channel
				}
				_, _, err := a.store.ingest([]Object{fields, {"id": id + "c", "runId": id, "kind": "request.completed", "occurredAt": at, "outcome": "E", "durationMs": 1234, "details": Object{"reason": "HTTP 429"}}})
				if err != nil {
					t.Fatal(err)
				}
			}
			if _, err := a.store.db.Exec("UPDATE request_roots_meta SET ready=? WHERE id=1", ready); err != nil {
				t.Fatal(err)
			}
			base := "/v1/runs?guildId=guild&channelId=matching&userId=user&messageId=message&outcome=E&limit=1"
			response := request(t, a, "GET", base, nil)
			if response.Code != 200 {
				t.Fatal(response.Body.String())
			}
			first := object(t, response)
			items := first["items"].([]any)
			if len(items) != 1 || items[0].(map[string]any)["id"] != "r3" || first["nextCursor"] == nil {
				t.Fatal(response.Body.String())
			}
			completion := items[0].(map[string]any)["completion"].(map[string]any)
			if completion["durationMs"] != float64(1234) {
				t.Fatal(completion)
			}
			response = request(t, a, "GET", base+"&cursor="+fmt.Sprint(first["nextCursor"]), nil)
			second := object(t, response)
			if len(second["items"].([]any)) != 1 || second["items"].([]any)[0].(map[string]any)["id"] != "r1" || second["nextCursor"] != nil {
				t.Fatal(response.Body.String())
			}
			response = request(t, a, "GET", "/v1/events?channelId=matching&userId=user&messageId=message", nil)
			if response.Code != 200 || len(object(t, response)["items"].([]any)) != 2 {
				t.Fatal(response.Body.String())
			}
			response = request(t, a, "GET", "/v1/runs?channelId="+url.QueryEscape("' OR 1=1 --"), nil)
			if response.Code != 200 || len(object(t, response)["items"].([]any)) != 0 {
				t.Fatal(response.Body.String())
			}
			response = request(t, a, "GET", "/v1/events/r1s", nil)
			if response.Code != 200 || object(t, response)["id"] != "r1s" {
				t.Fatal(response.Body.String())
			}
		})
	}
}

func TestInvestigationActionFiltersUseTargetsAndCreationTime(t *testing.T) {
	a := testApp(t)
	at := time.Now().UTC().Add(-time.Minute).Format(timestampLayout)
	for i, channel := range []string{"match", "other"} {
		_, err := a.store.db.Exec("INSERT INTO actions(id,idem,type,input,status,actor,via,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)", fmt.Sprint(i), fmt.Sprint(i), "settings.get", encode(Object{"guildId": "guild", "channelId": channel, "userId": "target", "messageId": "message"}), "succeeded", "actor", "test", at, at)
		if err != nil {
			t.Fatal(err)
		}
	}
	from := url.QueryEscape(time.Now().UTC().Add(-time.Hour).Format(timestampLayout))
	to := url.QueryEscape(time.Now().UTC().Format(timestampLayout))
	response := request(t, a, "GET", "/v1/actions?guildId=guild&channelId=match&userId=target&messageId=message&from="+from+"&to="+to, nil)
	if response.Code != 200 || len(object(t, response)["items"].([]any)) != 1 {
		t.Fatal(response.Body.String())
	}
	response = request(t, a, "GET", "/v1/actions?from=invalid", nil)
	if response.Code != 400 {
		t.Fatal(response.Body.String())
	}
	if response = request(t, a, "GET", "/v1/events/missing", nil); response.Code != 404 {
		t.Fatal(response.Body.String())
	}
	if response = request(t, a, "GET", "/v1/notifications/missing", nil); response.Code != 404 {
		t.Fatal(response.Body.String())
	}
}

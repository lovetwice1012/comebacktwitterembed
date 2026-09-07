package main

import "testing"

func TestShardAvailabilityNormalizesDiscordDisplayStatus(t *testing.T) {
	if online, availability := shardAvailability("Ready", false, true); online != true || availability != "online" {
		t.Fatalf("Ready status must win over stale boolean: online=%v availability=%s", online, availability)
	}
	if online, availability := shardAvailability("Identifying", true, true); online != false || availability != "offline" {
		t.Fatalf("Identifying status must win over stale boolean: online=%v availability=%s", online, availability)
	}
	if online, availability := shardAvailability("WaitingForGuilds", nil, true); online != false || availability != "offline" {
		t.Fatalf("WaitingForGuilds status was not normalized: online=%v availability=%s", online, availability)
	}
}

package main

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

func (a *App) measurementCoverage(ctx context.Context, from, to string, matching int) (Object, error) {
	var firstAt, lastAt sql.NullString
	var cursor, globalCount int64
	e := a.store.db.QueryRowContext(ctx, `SELECT COUNT(DISTINCT run_id),MIN(occurred_at),MAX(occurred_at) FROM events WHERE kind='request.started' AND run_id<>'' AND COALESCE(json_extract(payload,'$.triggerType'),json_extract(payload,'$.trigger_type'),'') NOT IN ('diagnostic','admin_operation')`).Scan(&globalCount, &firstAt, &lastAt)
	if e != nil {
		return nil, e
	}
	if e = a.store.db.QueryRowContext(ctx, "SELECT COALESCE(MAX(seq),0) FROM events").Scan(&cursor); e != nil {
		return nil, e
	}
	var heartbeatAt, heartbeatPersistedAt string
	var heartbeatAge any
	collectionState := "unobserved"
	e = a.store.db.QueryRowContext(ctx, "SELECT occurred_at,persisted_at FROM events WHERE kind IN ('heartbeat','bot.heartbeat','runtime.heartbeat') ORDER BY seq DESC LIMIT 1").Scan(&heartbeatAt, &heartbeatPersistedAt)
	if e != nil && !errors.Is(e, sql.ErrNoRows) {
		return nil, e
	}
	if e == nil {
		t, parseErr := time.Parse(time.RFC3339Nano, heartbeatAt)
		if parseErr == nil {
			age := time.Since(t).Seconds()
			heartbeatAge = age
			switch {
			case age < -30:
				collectionState = "clock_skew"
			case age <= 90:
				collectionState = "recent_heartbeat"
			default:
				collectionState = "heartbeat_stale"
			}
		}
	}
	measurementState, reason := "observed_records", "matching_production_records_saved"
	if matching == 0 {
		measurementState = "no_matching_requests"
		reason = "no_matching_saved_requests"
	}
	if globalCount == 0 {
		measurementState = "not_measured"
		reason = "no_production_request_records"
	} else if firstAt.Valid && to <= firstAt.String {
		measurementState = "not_measured"
		reason = "requested_period_predates_first_record"
	} else if matching == 0 && collectionState != "recent_heartbeat" {
		measurementState = "not_measured"
		reason = "no_matching_requests_and_collection_unverified"
	}
	return Object{"state": map[bool]string{true: "no_root_request_records", false: "instrumented_records_only"}[matching == 0], "measurementState": measurementState, "measurementReason": reason, "collectionState": collectionState, "observedMatchingRequests": matching, "recordedProductionRequests": globalCount, "firstRecordedRequestAt": nullable(firstAt), "latestRecordedRequestAt": nullable(lastAt), "periodStartsBeforeFirstRecord": firstAt.Valid && from < firstAt.String, "lastHeartbeatAt": optionalText(heartbeatAt), "lastHeartbeatPersistedAt": optionalText(heartbeatPersistedAt), "heartbeatAgeSeconds": heartbeatAge, "watermark": cursor, "historicalUninstrumentedData": "not_reconstructed", "missingCompletionAfterSeconds": max(600, int(a.cfg.WorkerTimeout.Seconds()*2)), "completeness": "not_proven", "countsRepresent": "saved_production_root_requests_only"}, nil
}
func optionalText(value string) any {
	if value == "" {
		return nil
	}
	return value
}

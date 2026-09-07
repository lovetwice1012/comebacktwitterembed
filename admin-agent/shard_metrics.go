package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const shardHeartbeatGrace = 45 * time.Second

func (a *App) shards(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	value, err := a.shardMetrics(ctx, time.Now())
	if err != nil {
		fail(w, 503, "SHARD_METRICS_QUERY_FAILED", err.Error())
		return
	}
	jsonResponse(w, 200, value)
}

// shardMetrics is deliberately built from the latest persisted runtime
// heartbeat and persisted request events.  It never turns a missing heartbeat
// into an "offline" claim and it keeps the two windows explicit: rolling one
// minute and the current Asia/Tokyo calendar day.
func (a *App) shardMetrics(ctx context.Context, at time.Time) (Object, error) {
	at = at.UTC()
	minuteStart := at.Add(-time.Minute)
	loc, err := time.LoadLocation("Asia/Tokyo")
	if err != nil {
		loc = time.FixedZone("Asia/Tokyo", 9*60*60)
	}
	local := at.In(loc)
	dayStart := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc).UTC()

	counts, err := a.shardProcessingCounts(ctx, dayStart, at, minuteStart)
	if err != nil {
		return nil, err
	}

	result := Object{
		"definitionVersion":    "shard-observation-v1",
		"timezone":             "Asia/Tokyo",
		"observedAt":           at.Format(timestampLayout),
		"processingLastMinute": counts.summaryMinute,
		"processingToday":      counts.summaryToday,
		"processingWindows": Object{
			"lastMinute": Object{"from": minuteStart.Format(timestampLayout), "to": at.Format(timestampLayout)},
			"today":      Object{"from": dayStart.Format(timestampLayout), "to": at.Format(timestampLayout)},
		},
		"items": []Object{},
		"notAvailable": []string{
			"Discord message views",
			"read receipts",
			"URL clicks",
			"link button clicks",
		},
	}

	var payload, occurred string
	err = a.store.db.QueryRowContext(ctx, `SELECT payload,occurred_at FROM events
        WHERE kind IN ('heartbeat','bot.heartbeat','runtime.heartbeat')
        ORDER BY seq DESC LIMIT 1`).Scan(&payload, &occurred)
	if err == nil {
		value, _ := decode(payload).(map[string]any)
		details := nested(value, "details")
		shards := details["shards"]
		if shards == nil {
			shards = value["shards"]
		}
		managerStatus := first(nested(details, "shard_summary"), "manager_status", "managerStatus")
		if managerStatus == "" {
			managerStatus = first(nested(value, "shard_summary"), "manager_status", "managerStatus")
		}
		result["managerStatus"] = nullableText(managerStatus)
		result["heartbeatAt"] = occurred
		if timestamp, parseErr := time.Parse(time.RFC3339Nano, occurred); parseErr == nil {
			age := at.Sub(timestamp).Seconds()
			result["heartbeatAgeSeconds"] = age
			switch {
			case age < -30:
				result["state"] = "clock_skew"
			case age <= shardHeartbeatGrace.Seconds():
				result["state"] = "recent_heartbeat"
			default:
				result["state"] = "heartbeat_stale"
			}
		} else {
			result["state"] = "invalid_timestamp"
		}
		gateway := nested(details, "gateway_events")
		if len(gateway) == 0 {
			gateway = nested(value, "gateway_events")
		}
		gatewayByShard := map[string]Object{}
		if rows, ok := gateway["by_shard"].([]any); ok {
			for _, raw := range rows {
				row, _ := raw.(map[string]any)
				id := shardID(row["shard_id"])
				if id == "" {
					id = shardID(row["shardId"])
				}
				if id != "" {
					gatewayByShard[id] = Object{
						"lastMinute": numberValue(row["last_minute"]),
						"last24h":    numberValue(row["last_24h"]),
					}
				}
			}
		}
		if rows, ok := shards.([]any); ok {
			for _, raw := range rows {
				row, _ := raw.(map[string]any)
				id := shardID(row["shard_id"])
				if id == "" {
					id = shardID(row["shardId"])
				}
				if id == "" {
					continue
				}
				status := first(row, "status", "state")
				online, available := shardAvailability(status, row["online"], result["state"] == "recent_heartbeat")
				item := Object{
					"shardId":       id,
					"status":        statusOrUnknown(status),
					"availability":  available,
					"online":        online,
					"pingMs":        numberValue(row["ping_ms"]),
					"lastPingAtMs":  numberValue(row["last_ping_at_ms"]),
					"observedAt":    occurred,
					"gatewayEvents": gatewayByShard[id],
				}
				result["items"] = append(result["items"].([]Object), item)
			}
		}
	} else if err != sql.ErrNoRows {
		return nil, err
	} else {
		result["state"] = "unobserved"
		result["heartbeatAt"] = nil
		result["heartbeatAgeSeconds"] = nil
		result["managerStatus"] = nil
	}

	items := result["items"].([]Object)
	byID := map[string]Object{}
	for _, item := range items {
		byID[item["shardId"].(string)] = item
	}
	for id, count := range counts.byShard {
		item := byID[id]
		if item == nil {
			item = Object{"shardId": id, "status": "unknown", "availability": "unknown", "online": nil, "observedAt": result["heartbeatAt"]}
			items = append(items, item)
			byID[id] = item
		}
		item["startedLastMinute"] = count.startedMinute
		item["completedLastMinute"] = count.completedMinute
		item["startedToday"] = count.startedToday
		item["completedToday"] = count.completedToday
	}
	for _, item := range items {
		if _, ok := item["startedLastMinute"]; !ok {
			item["startedLastMinute"] = 0
			item["completedLastMinute"] = 0
			item["startedToday"] = 0
			item["completedToday"] = 0
		}
	}
	// Keep stable numeric order so the dashboard does not jump when a shard
	// reconnects or when an unknown shard first appears in the event stream.
	sortShardObjects(items)
	result["items"] = items
	online, offline, unknown := 0, 0, 0
	for _, item := range items {
		switch item["availability"] {
		case "online":
			online++
		case "offline":
			offline++
		default:
			unknown++
		}
	}
	result["total"] = len(items)
	result["online"] = online
	result["offline"] = offline
	result["unknown"] = unknown
	return result, nil
}

type shardWindowCount struct {
	startedMinute, completedMinute int
	startedToday, completedToday   int
}
type shardProcessingCount struct {
	byShard       map[string]*shardWindowCount
	summaryMinute int
	summaryToday  int
}

func (a *App) shardProcessingCounts(ctx context.Context, dayStart, end, minuteStart time.Time) (shardProcessingCount, error) {
	result := shardProcessingCount{byShard: map[string]*shardWindowCount{}}
	rows, err := a.store.db.QueryContext(ctx, `SELECT kind,payload,occurred_at FROM events
        WHERE kind IN ('request.started','request.completed') AND occurred_at>=? AND occurred_at<?
        ORDER BY occurred_at,seq`, dayStart.Format(timestampLayout), end.Format(timestampLayout))
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var kind, payload, occurred string
		if err := rows.Scan(&kind, &payload, &occurred); err != nil {
			return result, err
		}
		at, err := time.Parse(time.RFC3339Nano, occurred)
		if err != nil {
			continue
		}
		value, _ := decode(payload).(map[string]any)
		trigger := first(value, "triggerType", "trigger_type")
		if trigger == "diagnostic" || trigger == "admin_operation" {
			continue
		}
		id := shardID(value["shard_id"])
		if id == "" {
			id = shardID(value["shardId"])
		}
		if id == "" {
			id = "unknown"
		}
		count := result.byShard[id]
		if count == nil {
			count = &shardWindowCount{}
			result.byShard[id] = count
		}
		minute := !at.Before(minuteStart)
		if kind == "request.started" {
			count.startedToday++
			if minute {
				count.startedMinute++
			}
		} else {
			count.completedToday++
			result.summaryToday++
			if minute {
				count.completedMinute++
				result.summaryMinute++
			}
		}
	}
	return result, rows.Err()
}

func shardID(value any) string {
	switch value := value.(type) {
	case string:
		value = strings.TrimSpace(value)
		if value != "" {
			return value
		}
	case float64:
		if value >= 0 && value == math.Trunc(value) {
			return strconv.FormatInt(int64(value), 10)
		}
	case json.Number:
		return value.String()
	case int:
		return strconv.Itoa(value)
	}
	return ""
}

func numberValue(value any) any {
	switch value := value.(type) {
	case nil:
		return nil
	case float64:
		if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
			return nil
		}
		if value == math.Trunc(value) {
			return int64(value)
		}
		return value
	case int, int64, uint64:
		return value
	default:
		return nil
	}
}

func statusOrUnknown(value string) string {
	if value == "" {
		return "unknown"
	}
	return value
}

func shardAvailability(status string, reported any, fresh bool) (any, string) {
	if !fresh {
		return nil, "unknown"
	}
	// discord.js Status is a bidirectional enum.  Older telemetry versions
	// persisted its display values (for example "Ready") while calculating
	// the boolean from the lowercase form, which produced contradictory
	// `status=Ready, online=false` rows.  Prefer a recognized status so the
	// durable row can be repaired without waiting for another Bot restart.
	normalized := strings.ToLower(strings.TrimSpace(status))
	normalized = strings.ReplaceAll(strings.ReplaceAll(normalized, "-", "_"), " ", "_")
	if normalized == "waitingforguilds" {
		normalized = "waiting_for_guilds"
	}
	switch normalized {
	case "ready", "online":
		return true, "online"
	case "connecting", "reconnecting", "disconnected", "idle", "nearly", "waiting_for_guilds", "identifying", "resuming", "offline":
		return false, "offline"
	}
	if value, ok := reported.(bool); ok {
		if value {
			return true, "online"
		}
		return false, "offline"
	}
	return nil, "unknown"
}

func nullableText(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func sortShardObjects(items []Object) {
	for i := 1; i < len(items); i++ {
		current := items[i]
		j := i - 1
		for ; j >= 0 && shardIDLess(current["shardId"].(string), items[j]["shardId"].(string)); j-- {
			items[j+1] = items[j]
		}
		items[j+1] = current
	}
}

func shardIDLess(left, right string) bool {
	li, le := strconv.Atoi(left)
	ri, re := strconv.Atoi(right)
	if le == nil && re == nil {
		return li < ri
	}
	return left < right
}

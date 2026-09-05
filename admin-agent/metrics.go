package main

import (
	"context"
	"database/sql"
	"math"
	"net/http"
	"sort"
	"time"
)

var outcomeNames = map[string]string{"F": "完全成功", "D": "代替成功", "P": "部分成功", "E": "処理失敗", "U": "取得対象の制約", "S": "設定による見送り", "C": "明示的取消", "I": "実行中", "X": "結果不明"}

func outcomeOf(v Object) string {
	s := first(v, "outcome", "resultCode", "outcome_code")
	if s == "" {
		s = first(nested(v, "details"), "outcome", "resultCode")
	}
	if _, ok := outcomeNames[s]; ok {
		return s
	}
	return "X"
}
func quantile(values []float64, q float64) any {
	if len(values) == 0 {
		return nil
	}
	sort.Float64s(values)
	return values[max(0, min(len(values)-1, int(math.Ceil(q*float64(len(values))))-1))]
}
func (a *App) metrics(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	from, to, e := dateFilter(r.URL.Query().Get("from"), r.URL.Query().Get("to"))
	if e != nil {
		fail(w, 400, "INVALID_FILTER", e.Error())
		return
	}
	where := "s.kind='request.started' AND s.run_id<>'' AND s.occurred_at>=? AND s.occurred_at<?"
	args := []any{from, to}
	if guild := r.URL.Query().Get("guildId"); guild != "" {
		where += " AND s.guild_id=?"
		args = append(args, guild)
	}
	rows, e := a.store.db.QueryContext(ctx, `SELECT s.run_id,s.occurred_at,s.guild_id,s.payload,c.payload FROM events s LEFT JOIN events c ON c.seq=(SELECT MAX(t.seq) FROM events t WHERE t.run_id=s.run_id AND t.kind='request.completed') WHERE `+where+` AND s.seq=(SELECT MIN(z.seq) FROM events z WHERE z.run_id=s.run_id AND z.kind='request.started') ORDER BY s.seq`, args...)
	if e != nil {
		fail(w, 503, "METRICS_QUERY_FAILED", e.Error())
		return
	}
	counts := map[string]int{}
	for k := range outcomeNames {
		counts[k] = 0
	}
	guilds, users, messages, contents, affected := map[string]bool{}, map[string]bool{}, map[string]bool{}, map[string]bool{}, map[string]bool{}
	byProvider := map[string]map[string]int{}
	durations := map[string][]float64{}
	var oldest *float64
	diagnostic, admin, missingGuild := 0, 0, 0
	for rows.Next() {
		var id, started, guild, payload string
		var completed sql.NullString
		if e := rows.Scan(&id, &started, &guild, &payload, &completed); e != nil {
			rows.Close()
			fail(w, 503, "METRICS_QUERY_FAILED", e.Error())
			return
		}
		s, _ := decode(payload).(map[string]any)
		trigger := first(s, "triggerType", "trigger_type")
		if trigger == "diagnostic" {
			diagnostic++
			continue
		}
		if trigger == "admin_operation" {
			admin++
			continue
		}
		outcome := "I"
		var c Object
		if completed.Valid {
			c, _ = decode(completed.String).(map[string]any)
			outcome = outcomeOf(c)
		} else if t, e := time.Parse(time.RFC3339Nano, started); e == nil {
			age := time.Since(t).Seconds() * 1000
			if oldest == nil || age > *oldest {
				oldest = &age
			}
			if age > float64(a.cfg.WorkerTimeout.Milliseconds()*2) && age > 600000 {
				outcome = "X"
			}
		}
		counts[outcome]++
		provider := first(s, "provider", "providerId", "provider_id")
		if provider == "" {
			provider = "unknown"
		}
		if byProvider[provider] == nil {
			byProvider[provider] = map[string]int{}
		}
		byProvider[provider][outcome]++
		if guild != "" {
			guilds[guild] = true
		}
		if trigger == "human_message" || trigger == "human_command" || trigger == "human_component" {
			if u := first(s, "userId", "user_id"); u != "" {
				users[u] = true
			}
			if msg := first(s, "messageId", "message_id"); msg != "" {
				messages[msg] = true
			}
		}
		if content := first(s, "contentId", "content_id", "canonicalUrl", "url"); content != "" {
			contents[provider+":"+content] = true
		}
		if outcome == "D" || outcome == "P" || outcome == "E" || outcome == "U" || outcome == "X" {
			if guild != "" {
				affected[guild] = true
			} else {
				missingGuild++
			}
		}
		if c != nil {
			duration, ok := c["durationMs"].(float64)
			if !ok {
				duration, ok = nested(c, "details")["durationMs"].(float64)
			}
			if ok && duration >= 0 {
				durations[outcome] = append(durations[outcome], duration)
			}
		}
	}
	if e := rows.Err(); e != nil {
		rows.Close()
		fail(w, 503, "METRICS_QUERY_FAILED", e.Error())
		return
	}
	rows.Close()
	total := 0
	for _, n := range counts {
		total += n
	}
	denom := counts["F"] + counts["D"] + counts["P"] + counts["E"] + counts["U"] + counts["X"]
	var ratio any
	if denom > 0 {
		ratio = float64(counts["F"]) / float64(denom)
	}
	latency := Object{}
	for outcome, vals := range durations {
		latency[outcome] = Object{"sampleCount": len(vals), "p50Ms": quantile(vals, .50), "p95Ms": quantile(vals, .95), "method": "exact_nearest_rank"}
	}
	coverage, e := a.measurementCoverage(ctx, from, to, total)
	if e != nil {
		fail(w, 503, "METRICS_COVERAGE_FAILED", e.Error())
		return
	}
	jsonResponse(w, 200, Object{"definitionVersion": "root-request-v1", "snapshotAt": now(), "from": from, "to": to, "timezone": "UTC (display Asia/Tokyo)", "requestCount": total, "outcomes": counts, "outcomeLabels": outcomeNames, "fullSuccess": Object{"numerator": counts["F"], "denominator": denom, "ratio": ratio, "formula": "F / (F+D+P+E+U+X)"}, "problemRequestCount": counts["D"] + counts["P"] + counts["E"] + counts["U"] + counts["X"], "skippedRequestCount": counts["S"], "affectedGuildCount": len(affected), "affectedUnknownGuildRequests": missingGuild, "activeGuildCount": len(guilds), "humanUserCount": len(users), "sharedMessageCount": len(messages), "sharedContentCount": len(contents), "oldestUnfinishedAgeMs": oldest, "latencyByOutcome": latency, "byProvider": byProvider, "excluded": Object{"diagnosticRequests": diagnostic, "adminRequests": admin}, "coverage": coverage, "notAvailable": []string{"Discord message views", "read receipts", "URL clicks", "link button clicks"}})
}
func nullable(s sql.NullString) any {
	if s.Valid {
		return s.String
	}
	return nil
}

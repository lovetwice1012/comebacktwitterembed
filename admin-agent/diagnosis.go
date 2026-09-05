package main

import (
	"context"
	"time"
)

// Provider alerts count completed root requests, never mixed internal events.
// Exact evidence IDs and observed outcomes accompany every rule result.
func (a *App) diagnoseProviderOutcomes(ctx context.Context, p Policy) {
	child, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	since := time.Now().UTC().Add(-5 * time.Minute).Format(timestampLayout)
	rows, e := a.store.db.QueryContext(child, `SELECT COALESCE(json_extract(s.payload,'$.provider'),json_extract(s.payload,'$.provider_id'),'unknown'),c.id,c.run_id,s.guild_id,COALESCE(json_extract(c.payload,'$.outcome'),json_extract(c.payload,'$.details.outcome'),'X') FROM events s JOIN events c ON c.seq=(SELECT MAX(t.seq) FROM events t WHERE t.run_id=s.run_id AND t.kind='request.completed') WHERE s.kind='request.started' AND s.occurred_at>=? AND s.seq=(SELECT MIN(z.seq) FROM events z WHERE z.run_id=s.run_id AND z.kind='request.started') AND COALESCE(json_extract(s.payload,'$.triggerType'),json_extract(s.payload,'$.trigger_type'),'') NOT IN ('diagnostic','admin_operation')`, since)
	if e != nil {
		return
	}
	type group struct {
		total, failed, successful int
		ids, runs                 []string
		guilds                    map[string]bool
	}
	groups := map[string]*group{}
	for rows.Next() {
		var provider, id, run, guild, outcome string
		if rows.Scan(&provider, &id, &run, &guild, &outcome) != nil {
			rows.Close()
			return
		}
		g := groups[provider]
		if g == nil {
			g = &group{guilds: map[string]bool{}}
			groups[provider] = g
		}
		g.total++
		if outcome == "E" || outcome == "P" || outcome == "D" || outcome == "X" {
			g.failed++
			g.ids = append(g.ids, id)
			g.runs = append(g.runs, run)
			if guild != "" {
				g.guilds[guild] = true
			}
		}
		if outcome == "F" {
			g.successful++
		}
	}
	if rows.Err() != nil {
		rows.Close()
		return
	}
	rows.Close()
	for provider, g := range groups {
		key := "provider.requests." + provider
		if g.failed >= 3 && g.total >= 5 && float64(g.failed)/float64(g.total) >= .3 {
			a.detect(key, "複数の展開要求で問題を確認: "+provider, Object{"ruleId": "root-request-errors-v1", "provider": provider, "from": since, "completedRequests": g.total, "problemRequests": g.failed, "confirmedFullSuccesses": g.successful, "affectedGuilds": len(g.guilds), "eventIds": g.ids, "runIds": g.runs, "claim": "The observed completed root-request cohort contains at least three technical/partial/fallback/unknown results and a problem ratio of at least 30%. This does not alone identify an upstream outage.", "unconfirmed": []string{"actual upstream response and parser cause", "Discord delivery versus provider retrieval", "instrumentation coverage"}, "nextActions": []string{"url.inspect", "diagnostics.db", "logs.read"}}, p)
		} else if g.failed == 0 && g.successful >= 3 {
			a.good(key, Object{"ruleId": "root-request-errors-v1", "provider": provider, "positiveCompletedRequests": g.successful, "scope": "Observed production root requests completed fully; retained five-minute cohort"})
		}
	}
}

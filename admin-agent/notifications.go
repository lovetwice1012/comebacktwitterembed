package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

func (a *App) deliverNotifications(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.sendOneNotification(ctx)
		}
	}
}
func (a *App) sendOneNotification(ctx context.Context) {
	var id, channel, payload string
	var attempts int
	e := a.store.db.QueryRow("SELECT id,channel,payload,attempts FROM outbox WHERE status='pending' AND next_at<=? ORDER BY created_at LIMIT 1", now()).Scan(&id, &channel, &payload, &attempts)
	if errors.Is(e, sql.ErrNoRows) {
		return
	}
	if e != nil {
		log.Printf("notification queue read failed: %v", e)
		return
	}
	target := a.cfg.PushWebhook
	content := payload
	if channel == "discord" {
		target = a.cfg.DiscordWebhook
		item, _ := decode(payload).(map[string]any)
		color := 0xE67E22
		if str(item["status"]) == "Resolved" {
			color = 0x2ECC71
		}
		embed := Object{
			"title":       str(item["title"]),
			"description": "サービスの状態に変化がありました。ご利用への影響がある場合は、ここでお知らせします。",
			"color":       color,
			"fields": []any{
				Object{"name": "状態", "value": str(item["status"]), "inline": true},
				Object{"name": "お知らせ", "value": str(item["title"]), "inline": false},
			},
		}
		body := Object{"username": a.cfg.DiscordNotificationName, "embeds": []any{embed}, "allowed_mentions": Object{"parse": []any{}}}
		if a.cfg.DiscordNotificationAvatar != "" {
			body["avatar_url"] = a.cfg.DiscordNotificationAvatar
		}
		content = encode(body)
		if !strings.Contains(target, "?") {
			target += "?wait=true"
		} else {
			target += "&wait=true"
		}
	}
	if target == "" {
		return
	}
	child, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(child, "POST", target, strings.NewReader(content))
	if e != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", id)
	client := http.Client{Timeout: 8 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
	res, e := client.Do(req)
	attempts++
	var response any
	problem := ""
	status := "pending"
	if e != nil {
		problem = "Notification transport error; remote receipt may be unknown (possible duplicate on retry)"
	} else {
		defer res.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
		response = Object{"httpStatus": res.StatusCode, "body": decode(string(b)), "receivedByUser": "not_observable"}
		if res.StatusCode >= 200 && res.StatusCode < 300 {
			status = "accepted"
		} else {
			problem = fmt.Sprintf("Notification endpoint returned HTTP %d", res.StatusCode)
		}
	}
	backoff := min(3600, 5*(1<<min(attempts, 9)))
	_, e = a.store.db.Exec("UPDATE outbox SET status=?,attempts=?,next_at=?,response=?,last_error=? WHERE id=?", status, attempts, time.Now().UTC().Add(time.Duration(backoff)*time.Second).Format(timestampLayout), encode(response), problem, id)
	if e != nil {
		log.Printf("notification receipt persistence failed: %v", e)
	}
}
func runWitness(ctx context.Context, cfg Config) error {
	target := env("ADMIN_WITNESS_TARGET", "")
	if target == "" {
		return errors.New("ADMIN_WITNESS_TARGET is required")
	}
	cfg.PublicURL = env("ADMIN_AGENT_PUBLIC_URL", strings.TrimSuffix(target, "healthz"))
	s, e := openStore(cfg.StateDir)
	if e != nil {
		return e
	}
	defer s.Close()
	a := newApp(cfg, s)
	go a.deliverNotifications(ctx)
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	failures := 0
	probe := func() {
		result := a.httpProbe(ctx, target)
		eventID := randomID()
		if _, _, e := s.ingest([]Object{{"id": eventID, "kind": "witness.probe", "occurredAt": now(), "details": result}}); e != nil {
			log.Printf("witness storage failed: %v", e)
			return
		}
		notifySystemd("WATCHDOG=1\nSTATUS=External probe persisted")
		if result["ok"] == true {
			failures = 0
			_ = a.recoverIncident("external.management.unreachable", Object{"scope": "Public management health endpoint is reachable; Bot functionality is not established by this probe.", "eventIds": []string{eventID}, "probe": result})
		} else {
			failures++
			if failures >= 4 {
				_, _, e := a.upsertIncident("external.management.unreachable", "管理デーモンへの外部到達性が失われました", Object{"claim": "Repeated public health probes failed; host power, network, tunnel and daemon failure have not been distinguished.", "eventIds": []string{eventID}, "probe": result, "failureCount": failures})
				if e != nil {
					log.Printf("witness incident write failed: %v", e)
				}
			}
		}
	}
	notifySystemd("READY=1\nSTATUS=Independent external witness running")
	probe()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			probe()
		}
	}
}

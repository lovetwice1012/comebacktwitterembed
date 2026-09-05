package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

type CatalogItem struct {
	Type         string `json:"type"`
	Label        string `json:"label"`
	Description  string `json:"description"`
	InputExample Object `json:"inputExample"`
	Mutating     bool   `json:"mutating"`
}

func catalog() []CatalogItem {
	return []CatalogItem{
		{"diagnostics.queries", "実行中の管理SQL", "登録された管理worker自身のSQLと期限を確認。", Object{"includeCompleted": false}, false},
		{"diagnostics.query.cancel", "管理SQLを中止", "登録queryIdと実行SQLの所有・一致を再検証して中止。任意SQL/接続IDは受け付けません。", Object{"queryId": "", "onlyIfOverdue": true}, true},
		{"provider.sources", "取得元一覧", "登録済みの取得元と一時的な切り替え状態を確認。", Object{}, false},
		{"provider.switch", "取得元を一時切り替え", "登録された取得元IDだけを期限付きで切り替え。", Object{"providerId": "twitter", "sourceId": "default", "ttlSeconds": 900, "expectedRevision": 0}, true},
		{"logs.boots", "OS起動履歴", "保持されているjournalの起動IDと期間を確認。", Object{}, false},
		{"reports.build", "詳細レポートを生成", "専用workerで完全なレポートを生成し、完成版を永続保存。", Object{"kind": "analytics", "filters": Object{}}, false},
		{"logs.previous_boot", "前回起動のログ", "前回OS起動のBot・DB・kernel・管理サービスログを確認。", Object{"source": "bot", "lines": 200}, false},
		{"analysis.status", "分析workerの状態", "独立分析サービスのsystemd状態を確認。", Object{}, false},
		{"analysis.restart", "分析workerを再起動", "分析処理だけを再起動。Botと管理コアは継続します。", Object{"expectedInvocationId": ""}, true},
		{"text.translate", "テキスト翻訳", "既存の翻訳機能で本文を翻訳します。LLMは使用しません。", Object{"text": "", "target": "ja"}, false},
		{"agent.status", "管理デーモンの状態", "独立した管理デーモンのsystemd状態。", Object{}, false},
		{"agent.restart", "管理デーモンを再起動", "独立executorが管理デーモンだけを再起動。画面から一時切断されます。", Object{"expectedInvocationId": ""}, true},
		{"database.status", "MySQLの状態", "固定されたmysql.serviceのsystemd状態。", Object{}, false},
		{"database.restart", "MySQLを再起動", "確認した起動IDを持つMySQLだけを明示的に再起動。DB操作への影響があります。", Object{"expectedInvocationId": ""}, true},
		{"capabilities", "対応機能を確認", "workerの実装済み操作・プロバイダー・コード版を確認。", Object{}, false},
		{"url.inspect", "URL実行検証", "実際の取得元と応答を記録し、展開payloadを生成。Discord送信は行わない。", Object{"url": "https://x.com/user/status/123", "guildId": "", "channelId": ""}, false},
		{"url.reparse", "保存応答の再解析", "保存済みHTTP応答を使いネットワーク取得なしで解析する。", Object{"url": "", "settings": Object{}, "httpAttempts": []any{}}, false},
		{"url.compare", "設定比較", "同じ保存応答に異なる設定を適用して出力差を表示。", Object{"url": "", "httpAttempts": []any{}, "baselineSettings": Object{}, "candidateSettings": Object{}}, false},
		{"message.resolve", "送信先の確認", "サーバー・チャンネル・権限をDiscord RESTで確認。", Object{"guildId": "", "channelId": ""}, false},
		{"message.send", "指定先へ送信", "サーバー/チャンネルIDへ本文、Embed、添付またはURL展開を送信。", Object{"guildId": "", "channelId": "", "mode": "manual", "payload": Object{"content": "", "allowedMentions": Object{"parse": []any{}}}, "purpose": "support"}, true},
		{"message.delete", "Bot投稿を削除", "対象チャンネルのBot自身の投稿を削除。", Object{"guildId": "", "channelId": "", "messageId": ""}, true},
		{"settings.catalog", "設定項目一覧", "プロバイダーごとの設定定義・既定値。", Object{}, false},
		{"settings.get", "設定を確認", "サーバーの全現在値と競合検出用hash。", Object{"guildId": "", "providerId": "twitter"}, false},
		{"settings.change", "設定を変更", "現在値のhashと照合して設定を変更。", Object{"guildId": "", "providerId": "twitter", "key": "", "value": nil, "expectedHash": ""}, true},
		{"settings.reset", "設定を初期化", "現在値と変更対象を確認して既定値に復元。", Object{"guildId": "", "providerId": "twitter", "expectedHash": ""}, true},
		{"settings.copy", "設定をコピー", "指定元のサーバー設定を対象サーバーへコピー。", Object{"guildId": "", "sourceGuildId": "", "providerId": "twitter", "expectedHash": ""}, true},
		{"autoextract.list", "自動展開一覧", "登録した自動展開と送信先を確認。", Object{"userId": ""}, false},
		{"autoextract.add", "自動展開を登録", "アカウントとWebhook送信先を登録。", Object{"guildId": "", "userId": "", "username": "", "webhookUrl": ""}, true},
		{"autoextract.delete", "自動展開を削除", "対象登録を明示して削除。", Object{"id": ""}, true},
		{"autoextract.update", "自動展開を変更", "登録の送信先・有効状態を変更。", Object{"id": "", "webhookUrl": "", "enabled": true}, true},
		{"autoextract.quota", "自動展開の利用枠", "登録者の追加利用枠を確認・変更。", Object{"userId": ""}, true},
		{"saved.list", "保存データ一覧", "ユーザーの保存済み投稿を確認。", Object{"userId": ""}, false},
		{"saved.read", "保存投稿を確認", "保存済み投稿の内容を確認。", Object{"userId": "", "tweetId": ""}, false},
		{"saved.save", "投稿を保存", "指定ユーザーに投稿を保存。", Object{"userId": "", "url": ""}, true},
		{"saved.delete", "保存データを削除", "明示した保存済み投稿を削除。", Object{"userId": "", "tweetId": ""}, true},
		{"saved.quota", "保存容量の上限", "使用容量と上限の確認・変更。", Object{"userId": ""}, true},
		{"access.list", "委任アクセス一覧", "ダッシュボード委任権限を確認。", Object{"guildId": ""}, false},
		{"access.set", "委任アクセスを設定", "対象ユーザーまたはロールへの委任権限を登録。", Object{"guildId": "", "targetType": "user", "targetId": "", "accessLevel": "view"}, true},
		{"access.delete", "委任アクセスを解除", "対象ユーザーまたはロールの委任権限を解除。", Object{"guildId": "", "targetType": "user", "targetId": ""}, true},
		{"diagnostics.collect", "技術診断を収集", "systemd状態、journal、OS圧迫状態とHTTP経路を期限内に収集。", Object{}, false},
		{"diagnostics.db", "DB診断", "Botと独立した接続でDB疎通・待機を確認。", Object{}, false},
		{"service.status", "Bot稼働状態", "固定されたBot unitの状態・起動ID・終了理由。", Object{}, false},
		{"service.start", "Botを起動", "固定されたBot unitの起動。既存jobとの競合を検査。", Object{}, true},
		{"service.stop", "Botを停止", "確認したInvocationIDを指定して停止。停止意図を監視policyに記録。", Object{"expectedInvocationId": ""}, true},
		{"service.restart", "Botを再起動", "同じInvocationIDを再検証し、回数制限付きで再起動。", Object{"expectedInvocationId": ""}, true},
		{"logs.read", "Botログ", "直近のunit journalを件数・期間・サイズ上限付きで取得。", Object{"lines": 200, "minutes": 60}, false},
		{"kernel.logs", "kernelログ", "OOM等を調べる直近kernel journal。", Object{"lines": 200, "minutes": 60}, false},
	}
}
func knownAction(typ string) bool {
	for _, c := range catalog() {
		if c.Type == typ {
			return true
		}
	}
	return false
}
func mutating(typ string) bool {
	for _, c := range catalog() {
		if c.Type == typ {
			return c.Mutating
		}
	}
	return true
}

type boundedBuffer struct {
	b         bytes.Buffer
	limit     int
	truncated bool
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	remaining := b.limit - b.b.Len()
	if remaining > 0 {
		_, _ = b.b.Write(p[:min(remaining, n)])
	}
	if n > remaining {
		b.truncated = true
	}
	return n, nil
}

func (a *App) work(ctx context.Context, reports bool) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-a.wake:
		}
		for {
			if reports {
				p, e := a.loadPolicy()
				if e != nil {
					break
				}
				until, _ := time.Parse(time.RFC3339Nano, p.ReportsPausedUntil)
				if time.Now().Before(until) {
					break
				}
			}
			condition := "type<>'reports.build'"
			if reports {
				condition = "type='reports.build'"
			}
			ac, e := scanAction(a.store.db.QueryRow("SELECT " + actionColumns + " FROM actions WHERE status='queued' AND " + condition + " ORDER BY created_at LIMIT 1"))
			if errors.Is(e, sql.ErrNoRows) {
				break
			}
			if e != nil {
				log.Printf("action queue read failed: %v", e)
				break
			}
			if ctx.Err() != nil {
				return
			}
			res, e := a.store.db.Exec("UPDATE actions SET status='running',updated_at=? WHERE id=? AND status='queued'", now(), ac.ID)
			if e != nil {
				log.Printf("action claim failed: %v", e)
				break
			}
			n, _ := res.RowsAffected()
			if n == 0 {
				continue
			}
			a.execute(ctx, ac)
		}
	}
}

func (a *App) execute(parent context.Context, ac Action) {
	input, _ := ac.Input.(map[string]any)
	if input == nil {
		input = Object{}
	}
	deadline := a.cfg.WorkerTimeout
	if ac.Type == "reports.build" {
		deadline = a.cfg.ReportTimeout
		if deadline == 0 {
			deadline = 660 * time.Second
		}
	}
	ctx, cancel := context.WithTimeout(parent, deadline)
	defer cancel()
	var data any
	var problem any
	status := "succeeded"
	if ac.Type == "diagnostics.collect" {
		data = a.collect(ctx, true)
	} else if strings.HasPrefix(ac.Type, "service.") || strings.HasPrefix(ac.Type, "agent.") || strings.HasPrefix(ac.Type, "analysis.") || strings.HasPrefix(ac.Type, "database.") || ac.Type == "logs.read" || ac.Type == "logs.previous_boot" || ac.Type == "logs.boots" || ac.Type == "kernel.logs" {
		if ac.Type == "service.stop" || ac.Type == "service.start" {
			desired := "running"
			if ac.Type == "service.stop" {
				desired = "stopped"
			}
			if _, e := a.store.db.Exec("UPDATE settings SET value=json_set(value,'$.desiredState',?,'$.revision',json_extract(value,'$.revision')+1) WHERE key='policy'", desired); e != nil {
				problem = Object{"code": "POLICY_SAVE_FAILED", "message": e.Error()}
			}
		}
		if problem == nil {
			var e error
			data, e = a.executor(ctx, ac.ID, ac.Type, input)
			if e != nil {
				problem = Object{"code": "EXECUTOR_FAILED", "message": e.Error()}
			}
		}
	} else {
		workerURL := a.cfg.WorkerURL
		if ac.Type == "reports.build" {
			workerURL = a.cfg.ReportWorkerURL
		}
		if (a.cfg.Worker == "" && workerURL == "") || (ac.Type == "reports.build" && workerURL == "") {
			problem = Object{"code": "WORKER_UNCONFIGURED", "message": "ADMIN_AGENT_WORKER has not been configured"}
		} else {
			out := &boundedBuffer{limit: 24 << 20}
			errout := &boundedBuffer{limit: 256 << 10}
			var exitErr error
			if workerURL != "" {
				req, e := http.NewRequestWithContext(ctx, "POST", workerURL, strings.NewReader(encode(Object{"actionId": ac.ID, "type": ac.Type, "input": input})))
				if e != nil {
					exitErr = e
				} else {
					req.Header.Set("Content-Type", "application/json")
					req.Header.Set("X-Admin-Agent-Token", a.cfg.Token)
					req.Header.Set("Authorization", "Bearer "+a.cfg.Token)
					client := http.Client{Timeout: deadline, CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
					res, e := client.Do(req)
					if e != nil {
						exitErr = errors.New("Independent analysis worker transport failed; response outcome unknown")
					} else {
						_, exitErr = io.Copy(out, io.LimitReader(res.Body, 25<<20))
						res.Body.Close()
						if res.StatusCode < 200 || res.StatusCode >= 300 {
							exitErr = fmt.Errorf("analysis worker HTTP %d", res.StatusCode)
						}
					}
				}
			} else {
				cmd := exec.CommandContext(ctx, a.cfg.Node, a.cfg.Worker)
				cmd.Dir = a.cfg.WorkerDir
				configureProcess(cmd)
				cmd.Stdin = strings.NewReader(encode(Object{"actionId": ac.ID, "type": ac.Type, "input": input}) + "\n")
				cmd.Stdout = out
				cmd.Stderr = errout
				exitErr = cmd.Run()
			}
			if out.truncated {
				problem = Object{"code": "WORKER_RESULT_LIMIT", "message": "Worker output exceeded 24 MiB; result cannot be assumed complete"}
				if mutating(ac.Type) {
					status = "unknown"
				}
			} else {
				var result struct {
					OK     bool     `json:"ok"`
					Data   any      `json:"data"`
					Error  any      `json:"error"`
					Events []Object `json:"events"`
				}
				e := json.Unmarshal(bytes.TrimSpace(out.b.Bytes()), &result)
				if e != nil {
					problem = Object{"code": "INVALID_WORKER_RESULT", "message": e.Error(), "exitError": errorString(exitErr), "stderr": errout.b.String(), "stderrTruncated": errout.truncated}
					if mutating(ac.Type) {
						status = "unknown"
					}
				} else {
					if len(result.Events) > 0 {
						if _, _, e = a.store.ingest(result.Events); e != nil {
							problem = Object{"code": "EVIDENCE_SAVE_FAILED", "message": e.Error()}
							status = "unknown"
						}
					}
					data = result.Data
					if !result.OK {
						problem = result.Error
						if problem == nil {
							problem = Object{"code": "WORKER_FAILED", "message": "Worker returned ok=false"}
						}
					} else if exitErr != nil {
						problem = Object{"code": "WORKER_EXIT_AFTER_RESULT", "message": exitErr.Error(), "stderr": errout.b.String()}
						if mutating(ac.Type) {
							status = "unknown"
						}
					}
				}
			}
		}
	}
	if ac.Type == "message.send" || ac.Type == "url.test_send" {
		d, _ := data.(map[string]any)
		switch str(d["outcome"]) {
		case "delivery_unknown":
			status = "unknown"
			problem = Object{"code": "DELIVERY_UNKNOWN", "message": "One or more Discord deliveries have unknown outcomes. Inspect the saved receipts before retrying."}
		case "partial_success":
			status = "failed"
			problem = Object{"code": "PARTIAL_DELIVERY", "message": "Only part of the requested Discord output was delivered. Successful message IDs are retained in the result."}
		case "failed":
			status = "failed"
			problem = Object{"code": "DELIVERY_FAILED", "message": "Discord delivery failed. API response and attempted payload are retained in the result."}
		}
	}
	if problem != nil && status == "succeeded" {
		status = "failed"
	}
	if p, ok := problem.(map[string]any); ok && (str(p["code"]) == "DELIVERY_UNKNOWN" || str(p["code"]) == "ACTION_OUTCOME_UNKNOWN") {
		status = "unknown"
	}
	if ctx.Err() != nil {
		problem = Object{"code": "ACTION_DEADLINE", "message": "Action deadline reached; inspect receipts before any retry"}
		if mutating(ac.Type) {
			status = "unknown"
		} else {
			status = "failed"
		}
	}
	if e := a.store.finish(ac.ID, status, data, problem); e != nil {
		log.Printf("action result persistence failed for %s: %v", ac.ID, e)
		return
	}
	if ac.Type == "reports.build" {
		if e := a.completeReport(ac.ID, status, data, problem); e != nil {
			log.Printf("report snapshot persistence failed: %v", e)
		}
	}
	_, _, e := a.store.ingest([]Object{{"id": randomID(), "runId": ac.ID, "kind": "admin.action.completed", "occurredAt": now(), "triggerType": "admin_operation", "actionId": ac.ID, "actionType": ac.Type, "status": status, "error": problem}})
	if e != nil {
		log.Printf("action event persistence failed: %v", e)
	}
}

func workerProblem(code string, e error) Object {
	return Object{"code": code, "message": fmt.Sprint(e)}
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AutomationApi } from "./rule-editor";

const button = "rounded border bg-background px-3 py-2 text-sm hover:bg-muted disabled:opacity-40";
const states: Record<string, string> = { pending: "送信待ち", held: "確認待ち", leased: "準備中", sending: "送信中", aggregated: "まとめ通知", sent: "送信済み", unknown: "送信結果不明", partial: "一部送信済み", failed: "失敗", expired: "期限切れ", cancelled: "取り消し済み", excluded: "送信対象外" };
const runStates: Record<string, string> = { ...states, waiting: "指定時刻まで待機中", flow_pending: "ルールを処理中" };
const runReasons: Record<string, string> = { EVENT_NOT_SELECTED: "この投稿は通知条件の対象外です。", ALL_MEMBERS_REVOKED: "対象の通知設定が変更されました。", RUN_REVOKED: "通知設定が変更されました。", FLOW_SNAPSHOT_LIMIT: "まとめる件数を確認してください。", AUTOMATION_SLOT_LIMIT: "現在のプランで使える通知枠を確認してください。", RATE_GATE_LIMIT: "通知件数の上限に達しました。", RATE_GATE_DEFERRED: "次に通知できる時刻を待っています。", DEADLINE_EXCEEDED: "配信期限を過ぎました。", DELAY_EXCEEDS_DEADLINE: "待機時刻が配信期限を過ぎています。", GRAPH_INPUT_LIMIT: "まとめる件数を確認してください。", FLOW_WAITING: "次の処理時刻を待っています。", FLOW_DESTINATION_MISSING: "通知先を選び直してください。", MONITOR_CHANGED: "通知設定が変更されました。", WORKFLOW_DELETED: "ルールの削除に伴い停止しました。" };
type Activity = { lastSentAtMs: number | null; nextDueAtMs: number | null };
type Job = { id: string; state: string; title?: string; url?: string; createdAtMs: number; updatedAtMs: number; sentSteps: number; messageId?: string; preview?: string; aggregateItems?: number; snapshotInvalid?: boolean };
type RuleRun = { id: string; state: string; event?: { title?: string; url?: string }; created_at_ms: number; trace?: { reason?: string }[] };
const date = (ms: number) => new Date(ms).toLocaleString("ja-JP");

export function MonitorDeliveryActivity({ api, kind, targetId, active = true }: { api: AutomationApi; kind: string; targetId: string; active?: boolean }) {
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [items, setItems] = useState<Job[]>([]), [activity, setActivity] = useState<Activity | null>(null), [cursor, setCursor] = useState<string | null>(null), [selected, setSelected] = useState<Job | null>(null);
  const [ruleRuns, setRuleRuns] = useState<RuleRun[]>([]), [ruleCursor, setRuleCursor] = useState<string | null>(null);
  const version = useRef(0), alive = useRef(true), detailHeading = useRef<HTMLHeadingElement>(null);
  const load = useCallback(async (after?: string) => {
    const request = ++version.current; setLoading(true); setError("");
    if (!after) { setItems([]); setActivity(null); setSelected(null); setCursor(null); setRuleRuns([]); setRuleCursor(null); }
    try {
      const result = await api(`jobs?targetKind=${encodeURIComponent(kind)}&targetId=${encodeURIComponent(targetId)}${after ? `&cursor=${encodeURIComponent(after)}` : ""}`);
      if (!alive.current || request !== version.current) return;
      setItems(previous => after ? [...previous, ...result.items] : result.items); setActivity(result.activity || null); setCursor(result.nextCursor);
      if (!after) { setRuleRuns(Array.isArray(result.ruleRuns) ? result.ruleRuns : []); setRuleCursor(result.ruleRunsNextCursor || null); }
    } catch { if (alive.current && request === version.current) setError("配信情報を読み込めませんでした。「配信情報を更新」で再試行してください。"); }
    finally { if (alive.current && request === version.current) setLoading(false); }
  }, [api, kind, targetId]);
  async function moreRuleRuns() {
    if (!ruleCursor) return;
    const request = ++version.current; setLoading(true); setError("");
    try {
      const result = await api(`excluded?targetKind=${encodeURIComponent(kind)}&targetId=${encodeURIComponent(targetId)}&afterId=${encodeURIComponent(ruleCursor)}`);
      if (!alive.current || request !== version.current) return;
      setRuleRuns(previous => [...previous, ...result.items]); setRuleCursor(result.nextCursor);
    } catch { if (alive.current && request === version.current) setError("ルールの処理履歴を読み込めませんでした。もう一度お試しください。"); }
    finally { if (alive.current && request === version.current) setLoading(false); }
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; version.current++; }; }, []);
  useEffect(() => { if (open && active) void load(); return () => { version.current++; }; }, [open, active, load]);
  useEffect(() => { if (selected && open && active) detailHeading.current?.focus(); }, [selected, open, active]);
  async function detail(job: Job) {
    const request = ++version.current; setLoading(true); setError("");
    try { const result = await api(`jobs/${encodeURIComponent(job.id)}`); if (alive.current && request === version.current) setSelected(result); }
    catch { if (alive.current && request === version.current) setError("配信内容を読み込めませんでした。通知を選び直してください。"); }
    finally { if (alive.current && request === version.current) setLoading(false); }
  }
  return <details className="monitor-delivery-activity" onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
    <summary>配信予定・履歴</summary>
    {open && <div className="space-y-3 pt-3">
      {activity && <dl className="text-sm"><div><dt>最終送信確認</dt><dd>{activity.lastSentAtMs == null ? "送信確認はまだありません" : date(activity.lastSentAtMs)}</dd></div>{activity.nextDueAtMs != null && <div><dt>送信待ちの予定時刻</dt><dd>{date(activity.nextDueAtMs)}</dd></div>}</dl>}
      <button type="button" className={button} disabled={loading || !active} onClick={() => void load()}>配信情報を更新</button>
      {loading && <p role="status">配信情報を読み込み中…</p>}{error && <p role="alert">{error}</p>}
      {!loading && !error && !items.length && !ruleRuns.length && <p role="status">配信履歴は0件です</p>}
      <ul aria-label="配信予定・履歴" className="space-y-2">{items.map(job => <li key={job.id}><button type="button" className={`${button} w-full text-left`} disabled={loading || !active} onClick={() => void detail(job)}><span>{states[job.state] || "状態を確認"}</span><span className="block break-words">{job.title || job.url || "通知"}</span><time className="block text-xs">{date(job.createdAtMs)}</time></button></li>)}</ul>
      {cursor && <button type="button" className={button} disabled={loading || !active} onClick={() => void load(cursor)}>履歴をさらに表示</button>}
      {!!ruleRuns.length && <section aria-label="ルールの処理履歴" className="space-y-2"><h4>ルールの処理履歴</h4><ul className="space-y-2">{ruleRuns.map(run => {
        const explanation = [...(run.trace || [])].reverse().find(entry => entry.reason)?.reason;
        return <li key={run.id} className="rounded border p-3 text-sm"><span>{runStates[run.state] || "状態を確認"}</span><p className="break-words">{run.event?.title || run.event?.url || "通知"}</p>{explanation && <p>{runReasons[explanation] || explanation}</p>}<time className="text-xs">{date(Number(run.created_at_ms))}</time></li>;
      })}</ul>{ruleCursor && <button type="button" className={button} disabled={loading || !active} onClick={() => void moreRuleRuns()}>ルールの処理履歴をさらに表示</button>}</section>}
      {selected && <section className="space-y-2 rounded border p-3" aria-label="配信内容"><h4 ref={detailHeading} tabIndex={-1}>配信内容</h4><p>{states[selected.state] || "状態を確認"}{selected.aggregateItems ? "（まとめ通知）" : ""}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm">{selected.preview}</pre>{["unknown", "partial"].includes(selected.state) && <p>Discordで送信結果を確認してください。</p>}<button type="button" className={button} onClick={() => setSelected(null)}>配信内容を閉じる</button></section>}
    </div>}
  </details>;
}

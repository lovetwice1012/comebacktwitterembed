"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Info, LockKeyhole } from "lucide-react";
import type { AutomationApi } from "./rule-editor";
import { valueLabels } from "./rule-labels";
import { automationErrorMessage } from "./automation-feedback";
import { ProcessingTrace } from "./processing-trace";
const button = "rounded border bg-background px-3 py-2 text-sm hover:bg-muted disabled:opacity-40";
const field = "rounded border bg-background px-3 py-2 text-sm";
const states: Record<string, string> = { pending: "送信待ち", held: "確認待ち", leased: "準備中", sending: "送信中", aggregated: "まとめ通知", sent: "送信済み", unknown: "送信結果不明", partial: "一部送信済み", failed: "失敗", expired: "期限切れ", cancelled: "取り消し済み", excluded: "送信対象外" };
const runStates: Record<string, string> = { ...states, waiting: "指定時刻まで待機中", flow_pending: "ルールを処理中" };
function traceReason(value?: string) {
  if (!value || !/^[A-Z][A-Z0-9_]+$/.test(value)) return value;
  return ({ FLOW_WAITING: "次の処理時刻を待っています。", GRAPH_INPUT_LIMIT: "通知内容が上限を超えています。ルールのまとめる件数を確認してください。" } as Record<string, string>)[value] || reasons[value] || value;
}
const reasons: Record<string, string> = { WORKFLOW_DELETED: "ルールの削除に伴い停止しました。", SEND_LEASE_EXPIRED: "Discordで送信結果を確認してください。", QUEUE_PLAN_INVALID: "配信内容を確認してください。", FLOW_MEMBERS_CANCELLED: "対象の通知が取り消されました。", FLOW_MEMBERSHIP_CHANGED: "通知内容を確認し直しています。", WORKFLOW_PAUSED: "詳細ルールが停止中です。", DEADLINE_EXCEEDED: "配信期限を過ぎました。", NO_DELIVERY_WINDOW: "期限内の通知可能時間がありません。", WAIT_FOR_WINDOW: "通知可能時間を待っています。", MONITOR_CHANGED: "通知設定が変更されました。", DESTINATION_DELETED: "通知先が削除されました。", DESTINATION_DISABLED: "通知先が停止中です。", DESTINATION_SCOPE_CHANGED: "通知先の公開範囲が変わりました。", RATE_GATE_LIMIT: "通知件数の上限に達しました。", RATE_GATE_DEADLINE: "通知件数の上限により期限を過ぎました。", RATE_GATE_DEFERRED: "通知件数の上限により待機中です。", PARENT_CANCELLED: "まとめ通知が取り消されました。" };
function reason(code?: string) {
  if (code === "AUTOMATION_SLOT_LIMIT") return "現在のプランではこの通知枠を利用できません。不要な通知を削除して利用枠を確認してください。";
  if (code === "AUTOMATION_RATE_LIMITED") return "この通知枠の送信上限に達したため、次に送信できる時刻まで待機しています。1通は実際に送信したメッセージ1件として数えます。";
  if (code === "AUTOMATION_RATE_LIMIT_UNAVAILABLE") return "通知件数の上限を確認できないため待機しています。時間をおいて自動で再確認します。";
  if (code === "AUTOMATION_NOTIFICATION_BATCH_LIMIT") return "1回の通知のメッセージ数が上限を超えています。通知内容を短くするか、まとめる件数を減らしてください。";
  if (["AUTOMATION_DELIVERY_RATE_LIMIT", "AUTOMATION_DELIVERY_SIZE_LIMIT"].includes(code || "")) return automationErrorMessage({ code });
  if (code === "AGGREGATE_SUPERSEDED") return "最新の内容に置き換えました。";
  if (code === "LEGACY_REVIEW_ENDED") return "旧版の配信内容と通知先を確認してください。";
  if (["SAFETY_VERIFIER_UNAVAILABLE", "SAFETY_CHECK_TIMEOUT", "SAFETY_CHECK_FAILED", "SAFETY_INVALID_ASSESSMENT", "SAFETY_DEPENDENCIES_UNAVAILABLE"].includes(code || "")) return "チェックに失敗しました。時間をおいて再試行してください。";
  if (code === "SAFETY_PACKAGE_REVOKED" || code === "SAFETY_DICTIONARY_REVOKED") return "共有ルール・辞書が停止中です。";
  return code?.startsWith("SAFETY_") ? "送信対象外です。内容と通知先を確認してください。" : code ? reasons[code] || "配信内容と通知先を確認してください。" : undefined;
}
type HistoryProps = { api: AutomationApi; canEdit: boolean; active?: boolean };
export function DeliveryHistory(props: HistoryProps) {
  const context = useRef({ api: props.api, generation: 0 });
  if (context.current.api !== props.api) context.current = { api: props.api, generation: context.current.generation + 1 };
  return <DeliveryHistoryView key={context.current.generation} {...props} />;
}
function DeliveryHistoryView({ api, canEdit, active = true }: HistoryProps) {
  const [state, setState] = useState(""), [items, setItems] = useState<any[]>([]), [cursor, setCursor] = useState<string | null>(null), [selected, setSelected] = useState<any>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [due, setDue] = useState(""), [excluded, setExcluded] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(true), [listError, setListError] = useState("");
  const [excludedCursor, setExcludedCursor] = useState<string | null>(null), [excludedLoading, setExcludedLoading] = useState(false), [excludedError, setExcludedError] = useState("");
  const excludedVersion = useRef(0);
  const [committedDetail, setCommittedDetail] = useState<string | null>(null);
  const listVersion = useRef(0), detailVersion = useRef(0), detailHeading = useRef<HTMLHeadingElement>(null), listHeading = useRef<HTMLHeadingElement>(null), root = useRef<HTMLElement>(null), returnJob = useRef("");
  const selectedRef = useRef(selected), activeRef = useRef(active); selectedRef.current = selected; activeRef.current = active;
  const stateRef = useRef(state); stateRef.current = state;
  const load = useCallback(async (after?: string) => {
    if (!activeRef.current) return;
    const version = ++listVersion.current, requestedState = stateRef.current; setLoading(true); setListError("");
    try { const result = await api(`jobs?state=${requestedState}${after ? `&cursor=${after}` : ""}`); if (!activeRef.current || version !== listVersion.current || requestedState !== stateRef.current) return; setItems(old => after ? [...old, ...result.items] : result.items); setCursor(result.nextCursor); }
    catch (cause: any) { if (activeRef.current && version === listVersion.current) setListError(cause.message); }
    finally { if (activeRef.current && version === listVersion.current) setLoading(false); }
  }, [api, state]);
  useEffect(() => { if (selected && active) { detailHeading.current?.focus(); detailHeading.current?.scrollIntoView?.({ block: "start" }); } }, [selected?.id, active]);
  const reloadDetail = useCallback(async () => {
    const item = selectedRef.current; if (!item || !activeRef.current) return;
    const version = ++detailVersion.current;
    try { const next = await api(`jobs/${item.id}`); if (activeRef.current && version === detailVersion.current && selectedRef.current?.id === item.id) { setSelected(next); setCommittedDetail(null); setError(""); } }
    catch (cause: any) { if (activeRef.current && version === detailVersion.current) setError(cause.message); }
  }, [api]);
  function closeDetail() { detailVersion.current++; setSelected(null); requestAnimationFrame(() => { const cards = [...(root.current?.querySelectorAll<HTMLButtonElement>("[data-job-id]") || [])]; const target = cards.find(node => node.dataset.jobId === returnJob.current) || cards[0] || listHeading.current; target?.focus(); target?.scrollIntoView?.({ block: "nearest" }); }); }
  async function openDetail(id: string) {
    const version = ++detailVersion.current; returnJob.current = id;
    try {
      const next = await api(`jobs/${id}`);
      if (!activeRef.current || version !== detailVersion.current) return;
      setSelected(next); setCommittedDetail(null); setDue(""); setError("");
    } catch (cause: any) { if (activeRef.current && version === detailVersion.current) setError(cause.message); }
  }
  const task = async (work: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await work(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  useEffect(() => { if (active) void load(); return () => { listVersion.current++; }; }, [load, active]);
  useEffect(() => { if (active) void reloadDetail(); return () => { detailVersion.current++; }; }, [reloadDetail, active]);
  async function loadExcluded(after?: string) {
    if (!activeRef.current) return;
    const request = ++excludedVersion.current; setExcludedLoading(true); setExcludedError("");
    try {
      const result = await api(`excluded${after ? `?afterId=${encodeURIComponent(after)}` : ""}`);
      if (!activeRef.current || request !== excludedVersion.current) return;
      setExcluded(previous => after ? [...(previous || []), ...result.items] : result.items); setExcludedCursor(result.nextCursor || null);
    } catch { if (activeRef.current && request === excludedVersion.current) setExcludedError("ルールの処理履歴を読み込めませんでした。もう一度読み込んでください。"); }
    finally { if (activeRef.current && request === excludedVersion.current) setExcludedLoading(false); }
  }
  useEffect(() => { if (!active) setExcludedLoading(false); return () => { excludedVersion.current++; }; }, [active, api]);
  async function change(action: string) {
    const item = selected;
    if (!item || committedDetail === item.id) return;
    const version = ++detailVersion.current;
    const result = await api(`jobs/${item.id}`, "PATCH", { action, expectedVersion: item.version, dueAtMs: action === "reschedule" ? new Date(due).getTime() : undefined });
    const current = () => activeRef.current && version === detailVersion.current && selectedRef.current?.id === item.id;
    const known = { ...item, ...result };
    setItems(previous => previous.map(row => row.id === item.id ? { ...row, ...result } : row));
    if (current()) { setSelected(known); setCommittedDetail(item.id); }
    setNotice(action === "reschedule" ? `${new Date(result.dueAtMs).toLocaleString()} に予約しました。` : action === "cancel" ? "配信を取り消しました。" : "配信を再試行します。");
    try { await load(); const next = await api(`jobs/${item.id}`); if (current()) { setSelected(next); setCommittedDetail(null); } }
    catch { if (current()) setError("配信の変更は保存済みです。［配信の詳細を更新］で最新の状態を確認してください。"); }
  }
  return <section hidden={!active} ref={root} className="space-y-4 rounded border bg-card p-4"><h2 ref={listHeading} tabIndex={-1} className="font-semibold">配信予定・履歴</h2>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
    <div hidden={!!selected}><div className="flex flex-wrap gap-2"><select className={field} aria-label="配信状態で絞り込み" value={state} onChange={e => setState(e.target.value)}><option value="">すべて</option>{Object.entries(states).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><button className={button} disabled={busy} onClick={() => void task(() => load())}>更新</button><button className={button} disabled={busy || excludedLoading} onClick={() => void loadExcluded()}>除外理由を確認</button></div>
    {excludedLoading && <p role="status">ルールの処理履歴を読み込み中…</p>}{excludedError && <div role="alert"><p>{excludedError}</p><button className={button} disabled={excludedLoading} onClick={() => void loadExcluded(excludedCursor || undefined)}>ルールの処理履歴を再読み込み</button></div>}
    {excluded && <details open className="rounded border p-3"><summary>ルールの処理履歴</summary>{excluded.map(row => <div key={row.id} className="mt-2 border-t py-2 text-sm"><p>{row.event.title || row.event.url || "通知"}</p>{row.state && <span>{runStates[row.state] || "処理状態を確認中"}</span>}<ProcessingTrace api={api} trace={row.trace} traceHistory={row.traceHistory} active={active} defaultOpen={!row.traceHistory?.indexed} label="処理記録を確認" reasonLabel={traceReason} /></div>)}{excludedCursor && !excludedError && <button className={button} disabled={excludedLoading} onClick={() => void loadExcluded(excludedCursor)}>ルールの処理履歴をさらに表示</button>}</details>}
    {loading && <p role="status">配信を読み込み中…</p>}{listError && <div role="alert"><p>{listError}</p><button className={button} onClick={() => void load()}>配信を再読み込み</button></div>}{!loading && !listError && <p role="status">{items.length}件{state ? "が条件に一致" : "の配信"}</p>}{!loading && !listError && !items.length && state && <button className={button} onClick={() => setState("")}>絞り込みを解除</button>}
    <div className="grid gap-2 md:grid-cols-2">{!loading && !listError && items.map(row => <button data-job-id={row.id} key={row.id} className="space-y-2 rounded border p-3 text-left" onClick={() => void openDetail(row.id)}><div className="automation-meta"><span>{states[row.state] || row.state}</span><span>{valueLabels[row.providerId] || row.providerId}</span><span>{row.ruleRevision ? `ルール版 ${row.ruleRevision}` : "通常通知"}</span></div><p className="break-all text-sm font-medium">{row.title || row.url || row.id}</p><p className="text-xs text-muted-foreground">{new Date(row.dueAtMs).toLocaleString()}</p>{row.errorCode && <p className="text-xs text-muted-foreground">{reason(row.errorCode)}</p>}</button>)}</div>{cursor && <button className={button} disabled={busy} onClick={() => void task(() => load(cursor))}>続きを読み込む</button>}</div>
    {selected && <div className="space-y-3 rounded border p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 ref={detailHeading} tabIndex={-1} className="font-semibold">配信の詳細</h3><div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => void task(reloadDetail)}>配信の詳細を更新</button><button className={button} onClick={closeDetail}>配信一覧に戻る</button></div></div><div className="automation-meta"><span>{states[selected.state]}</span><span>送信確認 {selected.sentSteps}件</span><span>{selected.aggregateItems ? selected.aggregateMode === "latest" ? `${selected.aggregateReceived || selected.aggregateItems}件から最新${selected.aggregateItems}件を通知` : `${selected.aggregateItems}件をまとめ通知` : "単独通知"}</span></div><pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-sm">{selected.preview}</pre>
      {selected.errorCode && <p className="text-sm">{reason(selected.errorCode)}</p>}
      <ProcessingTrace api={api} trace={selected.trace} traceHistory={selected.traceHistory} active={active} reasonLabel={traceReason} />
      {selected.parentJobId && <button className={button} onClick={() => void openDetail(selected.parentJobId)}>まとめ通知を開く</button>}
      {selected.scope === "guild" && !canEdit && <p className="automation-critical-note"><LockKeyhole size={16} aria-hidden="true" />配信の変更にはサーバーの編集権限が必要です。</p>}
      {!selected.parentJobId && (selected.scope !== "guild" || canEdit) && <fieldset disabled={busy || committedDetail === selected.id} className="space-y-3">{["pending", "held", "leased"].includes(selected.state) && <><label className="grid gap-2 text-sm">配信時刻（ブラウザの時刻）<input type="datetime-local" className={field + " max-w-sm"} value={due} onChange={e => setDue(e.target.value)} /></label><p className="automation-critical-note"><Info size={16} aria-hidden="true" />通知可能時間に合わせて予約します。</p><div className="flex flex-wrap gap-2"><button className={button} disabled={busy || !due} onClick={() => void task(() => change("reschedule"))}>配信を予約し直す</button><button className={button + " text-destructive"} disabled={busy} onClick={() => { if (confirm("この配信を取り消しますか？")) void task(() => change("cancel")); }}>配信を取り消す</button></div></>}{selected.state === "failed" && selected.sentSteps === 0 && !selected.snapshotInvalid && <button className={button} disabled={busy} onClick={() => { if (confirm("この通知の送信を再試行しますか？")) void task(() => change("retry")); }}>送信を再試行</button>}</fieldset>}
      {["unknown", "partial"].includes(selected.state) && <p className="automation-critical-note"><Info size={16} aria-hidden="true" />Discordで送信結果を確認してください。重複を防ぐため再送できません。</p>}
      <details><summary className="text-sm">取得時のデータ</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(selected.event, null, 2)}</pre></details>
      {selected.aggregateMode === "latest" && selected.aggregateReceived > 1 && <details><summary className="text-sm">まとめ通知の最初のイベント</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(selected.originalEvent, null, 2)}</pre></details>}
    </div>}
  </section>;
}

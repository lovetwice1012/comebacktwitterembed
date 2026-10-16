"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Circle } from "lucide-react";
import type { AutomationApi } from "./rule-editor";
import { valueLabels } from "./rule-labels";

const button = "rounded border bg-background px-3 py-2 text-sm hover:bg-muted disabled:opacity-40";
export type TraceHistory = { runId: string; indexed: boolean; firstPage: boolean; sourceRevision?: string; nextCursor?: string | null; totalEntries: number | null };
type Props = { api: AutomationApi; trace?: any[]; traceHistory?: TraceHistory; active?: boolean; label?: string; defaultOpen?: boolean; reasonLabel?: (reason: string) => string | undefined };
const outcomes: Record<string, string> = { scheduled: "配信予定", merged: "合流", excluded: "対象外", expired: "期限切れ", waiting: "待機中", wait: "待機中", failed: "失敗", complete: "処理済み" };
const reasons: Record<string, string> = { FLOW_WAITING: "次の処理時刻を待っています。", DEADLINE_EXCEEDED: "配信期限を過ぎました。", DELAY_EXCEEDS_DEADLINE: "待機時刻が配信期限を過ぎています。", PUBLISHED_AT_MISSING: "公開日時を取得できません。", EVENT_NOT_SELECTED: "この投稿は通知条件の対象外です。", MONITOR_CHANGED: "通知設定が変更されました。", WORKFLOW_DELETED: "ルールの削除に伴い停止しました。", FLOW_DESTINATION_MISSING: "通知先を選び直してください。", ALL_MEMBERS_REVOKED: "対象の通知設定が変更されました。", RUN_REVOKED: "通知設定が変更されました。", GRAPH_INPUT_LIMIT: "通知内容が上限を超えています。まとめる件数を確認してください。" };
const machineCode = (value: string) => /^[A-Z][A-Z0-9_]+$/.test(value);
function friendlyReason(value: string, label?: Props["reasonLabel"]) {
  const translated = label?.(value) || reasons[value] || value;
  return machineCode(translated) ? "処理内容を確認してください。" : translated;
}
function RecordData({ trace }: { trace: any }) {
  const [open, setOpen] = useState(false);
  return <details open={open} className="mt-2" onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}><summary>記録のデータ</summary>{open && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(trace, null, 2)}</pre>}</details>;
}
function Records({ items, reasonLabel }: { items: any[]; reasonLabel?: Props["reasonLabel"] }) {
  const members = new Map<string, number>();
  return <ol className="automation-trace space-y-2" aria-label="処理記録">{items.map((trace, index) => {
    const member = typeof trace.memberId === "string" ? trace.memberId : null;
    if (member && !members.has(member)) members.set(member, members.size + 1);
    return <li key={index} className="rounded border p-3 text-sm"><div className="flex flex-wrap items-center gap-2"><Circle size={12} aria-hidden="true" /><span>{typeof trace.nodeLabel === "string" ? trace.nodeLabel : `処理 ${index + 1}`}</span>{member && <span>対象 {members.get(member)}</span>}<span>{valueLabels[trace.outcome] || outcomes[trace.outcome] || "処理内容を確認"}</span></div>
      {typeof trace.reason === "string" && trace.reason && <p className="mt-1 whitespace-pre-wrap break-words">{friendlyReason(trace.reason, reasonLabel)}</p>}
      {Number.isFinite(trace.dueAtMs || trace.wakeAtMs) && <time>{new Date(trace.dueAtMs || trace.wakeAtMs).toLocaleString("ja-JP")}</time>}
      {Array.isArray(trace.detail) && trace.detail.length > 0 && <section className="mt-2 space-y-1" aria-label="一致した語"><p>一致した語 {trace.detail.length}件</p><ul>{trace.detail.map((match: any, matchIndex: number) => <li key={matchIndex} className="rounded bg-muted p-2"><p className="whitespace-pre-wrap break-words">{typeof match?.term === "string" ? match.term : JSON.stringify(match)}</p><div className="flex flex-wrap gap-2 text-xs">{Number.isFinite(match?.start) && Number.isFinite(match?.end) && <span>位置 {match.start}–{match.end}</span>}{typeof match?.category === "string" && <span>{match.category}</span>}</div></li>)}</ul></section>}
      <RecordData trace={trace} />
    </li>;
  })}</ol>;
}

export function ProcessingTrace(props: Props) {
  // A changed API means a different authenticated workspace. Replace the view
  // during render, before an effect or an old private request can paint data.
  const fingerprint = useMemo(() => JSON.stringify([props.traceHistory || null, props.trace || []]), [props.traceHistory, props.trace]);
  const boundary = useRef({ api: props.api, fingerprint, generation: 0 });
  if (boundary.current.api !== props.api || boundary.current.fingerprint !== fingerprint) boundary.current = { api: props.api, fingerprint, generation: boundary.current.generation + 1 };
  return <TraceView key={boundary.current.generation} {...props} />;
}
function TraceView({ api, trace = [], traceHistory, active = true, label = "処理の詳細", defaultOpen = false, reasonLabel }: Props) {
  const initialPage = traceHistory?.indexed && traceHistory.firstPage;
  const [items, setItems] = useState<any[]>(traceHistory?.indexed && !initialPage ? [] : trace);
  const [cursor, setCursor] = useState<string | null>(initialPage ? traceHistory.nextCursor || null : null);
  const [total, setTotal] = useState<number | null>(initialPage ? traceHistory.totalEntries : traceHistory?.indexed ? traceHistory.totalEntries : trace.length);
  const [revision, setRevision] = useState<string | undefined>(initialPage ? traceHistory.sourceRevision : undefined);
  const [canonical, setCanonical] = useState(!!initialPage), [complete, setComplete] = useState(initialPage ? !traceHistory.nextCursor : !traceHistory?.indexed);
  const [open, setOpen] = useState(defaultOpen), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [recovery, setRecovery] = useState<"first" | "continue" | "restart">("first");
  const version = useRef(0), alive = useRef(true), activeRef = useRef(active), pending = useRef(false);
  activeRef.current = active;
  useEffect(() => { alive.current = true; return () => { alive.current = false; version.current++; }; }, []);
  useEffect(() => { if (!active) { version.current++; pending.current = false; setLoading(false); } }, [active]);
  async function read(after?: string | null, restart = false) {
    if (!activeRef.current || !traceHistory?.runId || pending.current) return;
    const request = ++version.current, expected = restart || !after ? undefined : revision;
    pending.current = true; setLoading(true); setError(""); setRecovery(after ? "continue" : "first");
    if (restart) { setItems([]); setCursor(null); setTotal(null); setRevision(undefined); setComplete(false); setCanonical(false); }
    const current = () => alive.current && activeRef.current && version.current === request;
    try {
      const result = await api(`runs/${encodeURIComponent(traceHistory.runId)}/trace${after ? `?cursor=${encodeURIComponent(after)}` : ""}`);
      if (!current()) return;
      if (!Array.isArray(result.items) || result.items.some((item: any) => !item || typeof item.nodeId !== "string" || typeof item.outcome !== "string") || typeof result.sourceRevision !== "string" || !result.sourceRevision || typeof result.complete !== "boolean" || result.nextCursor != null && (typeof result.nextCursor !== "string" || !result.nextCursor) || result.complete !== (result.nextCursor == null) || result.totalEntries != null && (!Number.isSafeInteger(result.totalEntries) || result.totalEntries < 0)) throw new Error("INVALID_TRACE_RESPONSE");
      if (expected && expected !== result.sourceRevision) throw Object.assign(new Error("TRACE_CHANGED"), { code: "HISTORY_TRACE_CHANGED", status: 409 });
      setItems(previous => after ? [...previous, ...result.items] : result.items); setCursor(result.nextCursor || null); setRevision(result.sourceRevision); setTotal(result.totalEntries); setComplete(result.complete); setCanonical(true);
    } catch (cause: any) {
      if (!current()) return;
      if (cause?.code === "HISTORY_TRACE_CHANGED" || cause?.status === 409 || cause?.code === "INVALID_CURSOR") {
        setItems([]); setCursor(null); setRevision(undefined); setTotal(null); setComplete(false); setRecovery("restart"); setError("処理履歴が更新されています。先頭から読み直してください。");
      } else if ([401, 403, 404].includes(cause?.status)) {
        setItems([]); setCursor(null); setRevision(undefined); setTotal(null); setComplete(false); setRecovery("restart"); setError("この処理記録を確認できません。権限と登録状態を確認してください。");
      } else setError("処理記録を読み込めませんでした。もう一度読み込んでください。");
    } finally { if (current()) { pending.current = false; setLoading(false); } }
  }
  function toggle(event: React.ToggleEvent<HTMLDetailsElement>) {
    if (event.target !== event.currentTarget) return;
    const expanded = event.currentTarget.open; setOpen(expanded);
    if (expanded && traceHistory?.indexed && !canonical && !error) void read();
  }
  return <details open={open} hidden={!active} onToggle={toggle} className="space-y-2"><summary className="text-sm">{label}</summary>{open && <div className="space-y-2 pt-2">
    <p role="status">処理記録 {items.length}件{total != null && total !== items.length ? `（全${total}件）` : ""}</p>
    <Records items={items} reasonLabel={reasonLabel} />
    {loading && <p role="status">処理記録を読み込み中…</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" className={button} disabled={loading || !active} onClick={() => void read(recovery === "continue" ? cursor : undefined, recovery === "restart")}>{recovery === "restart" ? "処理記録を先頭から読み直す" : "処理記録を再読み込み"}</button></div>}
    {!error && traceHistory?.indexed && !canonical && !loading && <button type="button" className={button} disabled={!active} onClick={() => void read()}>処理記録を読み込む</button>}
    {!error && canonical && cursor && <button type="button" className={button} disabled={loading || !active} onClick={() => void read(cursor)}>処理記録の続きを読み込む</button>}
    {!error && canonical && complete && <p role="status">すべての処理記録を表示しました</p>}
    {!error && !traceHistory?.indexed && traceHistory?.runId && !canonical && <button type="button" className={button} disabled={loading || !active} onClick={() => void read()}>すべての処理記録を確認</button>}
  </div>}</details>;
}
